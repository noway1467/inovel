import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { auditLogs, authors, books, chapters, rankingSnapshots } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export type RankingType = "week" | "month" | "total";

export interface RankingEntry {
  bookId: string;
  title: string;
  authorName: string;
  wordCount: number;
  chapterCount: number;
  score: number;
}

export async function aggregateRanking(db: AppDb, type: RankingType, limit = 20): Promise<RankingEntry[]> {
  const chapterAgg = db
    .select({
      bookId: chapters.bookId,
      chapterCount: db.$count(chapters).as("chapterCount"),
    })
    .from(chapters)
    .where(eq(chapters.status, "published"))
    .groupBy(chapters.bookId)
    .as("chapter_agg");

  const rows = await db
    .select({
      bookId: books.id,
      title: books.title,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
      wordCount: books.wordCount,
      chapterCount: chapterAgg.chapterCount,
      updatedAt: books.updatedAt,
    })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .leftJoin(chapterAgg, eq(chapterAgg.bookId, books.id))
    .where(and(eq(books.status, "published"), isNull(books.deletedAt)))
    .orderBy(
      type === "total" ? desc(books.wordCount) : type === "week" ? desc(books.latestChapterAt) : desc(books.updatedAt)
    )
    .limit(limit);

  return rows.map((row, index) => ({
    bookId: row.bookId,
    title: row.title,
    authorName: row.authorName,
    wordCount: row.wordCount,
    chapterCount: row.chapterCount ?? 0,
    score: Math.max(0, 100 - index),
  }));
}

export async function getRankingBooks(db: AppDb, type: RankingType, limit = 20): Promise<RankingEntry[]> {
  const snapshot = await db
    .select({ id: rankingSnapshots.id, frozen: rankingSnapshots.frozen, payload: rankingSnapshots.payload })
    .from(rankingSnapshots)
    .where(eq(rankingSnapshots.type, type))
    .orderBy(desc(rankingSnapshots.createdAt))
    .limit(1)
    .get();
  if (snapshot && (snapshot.frozen || true)) {
    const payload = snapshot.payload as unknown;
    if (Array.isArray(payload) && payload.length > 0) {
      return payload as RankingEntry[];
    }
  }
  return aggregateRanking(db, type, limit);
}

export async function refreshRanking(db: AppDb, actorId: string, type: RankingType, frozen = false) {
  const entries = await aggregateRanking(db, type, 20);
  await db
    .insert(rankingSnapshots)
    .values({
      id: crypto.randomUUID(),
      type,
      period: type,
      payload: entries,
      frozen,
    })
    .onConflictDoNothing();
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "ranking.refresh",
    entityType: "ranking",
    entityId: type,
    before: null,
    after: { entries: entries.length, frozen },
    reason: "manual ranking refresh",
  });
  return { type, entries: entries.length, frozen };
}

export async function setRankingFrozen(db: AppDb, actorId: string, type: RankingType, frozen: boolean) {
  const latest = await db
    .select({ id: rankingSnapshots.id, frozen: rankingSnapshots.frozen })
    .from(rankingSnapshots)
    .where(eq(rankingSnapshots.type, type))
    .orderBy(desc(rankingSnapshots.createdAt))
    .limit(1)
    .get();
  if (!latest) throw new Error("请先刷新榜单快照");
  await db.update(rankingSnapshots).set({ frozen }).where(eq(rankingSnapshots.id, latest.id));
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "ranking.freeze",
    entityType: "ranking",
    entityId: type,
    before: { frozen: latest.frozen },
    after: { frozen },
    reason: "ranking freeze toggle",
  });
  return { type, frozen };
}
