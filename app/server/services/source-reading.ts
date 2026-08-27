import { and, desc, eq } from "drizzle-orm";
import { sourceReadingState } from "drizzle/schema";
import type { AppDb } from "~/server/db";

/**
 * 在线源书籍的书架与阅读进度。
 *
 * 在线源的书不入 books 表，所以复用不了 shelf_items / reading_progress
 * （那两张表的 book_id 外键指向 books）。这里用 (userId, sourceId, bookUrl)
 * 作键，把「在不在书架」和「读到哪」放在一行里 —— 两者键相同、生命周期相同，
 * 拆两张表只是多一次查询。
 *
 * 书架状态与进度刻意分开字段：移出书架不该丢掉读到哪一章。
 */

export interface SourceBookRef {
  sourceId: string;
  bookUrl: string;
  bookTitle: string;
  sourceName?: string | null;
  chapterCount?: number | null;
}

export interface SourceReadPosition {
  chapterKey: string;
  chapterTitle?: string | null;
  chapterIndex?: number | null;
  pageIndex?: number | null;
}

/** 取某本在线源书籍的书架/进度状态；没读过也没收藏过时返回 null */
export async function getSourceReadingState(
  db: AppDb,
  userId: string,
  sourceId: string,
  bookUrl: string
) {
  if (!userId || !sourceId || !bookUrl) return null;
  const row = await db
    .select()
    .from(sourceReadingState)
    .where(
      and(
        eq(sourceReadingState.userId, userId),
        eq(sourceReadingState.sourceId, sourceId),
        eq(sourceReadingState.bookUrl, bookUrl)
      )
    )
    .get();
  return row ?? null;
}

/**
 * 记录读到哪一章第几页。
 *
 * upsert 命中唯一索引，省掉先查后写。不动 shelved —— 读一章不等于要收藏，
 * 但已收藏的书也不能因为记进度被踢出书架。
 */
export async function recordSourceProgress(
  db: AppDb,
  userId: string,
  book: SourceBookRef,
  position: SourceReadPosition
): Promise<void> {
  const now = new Date();
  await db
    .insert(sourceReadingState)
    .values({
      id: crypto.randomUUID(),
      userId,
      sourceId: book.sourceId,
      bookUrl: book.bookUrl,
      bookTitle: book.bookTitle,
      sourceName: book.sourceName ?? null,
      chapterCount: book.chapterCount ?? null,
      shelved: false,
      lastChapterKey: position.chapterKey,
      lastChapterTitle: position.chapterTitle ?? null,
      lastChapterIndex: position.chapterIndex ?? null,
      lastPageIndex: position.pageIndex ?? 0,
      lastReadAt: now,
      addedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [sourceReadingState.userId, sourceReadingState.sourceId, sourceReadingState.bookUrl],
      set: {
        bookTitle: book.bookTitle,
        sourceName: book.sourceName ?? null,
        // 目录章数偶尔取不到，别用 null 覆盖掉已经存过的值
        ...(book.chapterCount != null ? { chapterCount: book.chapterCount } : {}),
        lastChapterKey: position.chapterKey,
        lastChapterTitle: position.chapterTitle ?? null,
        lastChapterIndex: position.chapterIndex ?? null,
        lastPageIndex: position.pageIndex ?? 0,
        lastReadAt: now,
        updatedAt: now,
      },
    });
}

/** 加入/移出书架。进度字段一概不动。 */
export async function setSourceShelved(
  db: AppDb,
  userId: string,
  book: SourceBookRef,
  shelved: boolean
): Promise<void> {
  const now = new Date();
  await db
    .insert(sourceReadingState)
    .values({
      id: crypto.randomUUID(),
      userId,
      sourceId: book.sourceId,
      bookUrl: book.bookUrl,
      bookTitle: book.bookTitle,
      sourceName: book.sourceName ?? null,
      chapterCount: book.chapterCount ?? null,
      shelved,
      lastPageIndex: 0,
      addedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [sourceReadingState.userId, sourceReadingState.sourceId, sourceReadingState.bookUrl],
      set: {
        shelved,
        bookTitle: book.bookTitle,
        sourceName: book.sourceName ?? null,
        ...(book.chapterCount != null ? { chapterCount: book.chapterCount } : {}),
        updatedAt: now,
      },
    });
}

/** 书架里的在线源书籍，最近读过的排前面 */
export async function listShelvedSourceBooks(db: AppDb, userId: string, limit = 100) {
  return db
    .select()
    .from(sourceReadingState)
    .where(and(eq(sourceReadingState.userId, userId), eq(sourceReadingState.shelved, true)))
    .orderBy(desc(sourceReadingState.lastReadAt), desc(sourceReadingState.updatedAt))
    .limit(limit)
    .all();
}

/** 读过的在线源书籍，用于「最近阅读」 */
export async function listRecentSourceBooks(db: AppDb, userId: string, limit = 50) {
  const rows = await db
    .select()
    .from(sourceReadingState)
    .where(eq(sourceReadingState.userId, userId))
    .orderBy(desc(sourceReadingState.lastReadAt))
    .limit(limit)
    .all();
  // lastReadAt 为空的是只收藏没读过的，不算"最近阅读"
  return rows.filter((row) => row.lastReadAt != null);
}
