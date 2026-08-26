import { and, desc, eq, inArray } from "drizzle-orm";
import { bookmarks, readingHistory, readingPreferences, readingProgress } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export interface ProgressInput {
  bookId: string;
  chapterId: string | null;
  paragraphAnchor: string | null;
  charOffset: number;
  chapterProgress: number;
  bookProgress: number;
  version?: number;
  deviceId?: string | null;
  updatedAt: string;
}

function serializeProgress(row: typeof readingProgress.$inferSelect) {
  return {
    bookId: row.bookId,
    chapterId: row.chapterId,
    paragraphAnchor: row.paragraphAnchor,
    charOffset: row.charOffset,
    chapterProgress: row.chapterProgress,
    bookProgress: row.bookProgress,
    version: row.version,
    deviceId: row.deviceId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getProgress(db: AppDb, userId: string, bookId: string) {
  const row = await db
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), eq(readingProgress.bookId, bookId)))
    .get();
  return row ? serializeProgress(row) : null;
}

/** 批量取多本书的阅读进度，避免书架等列表页逐本查询。ID 分块避开 D1 绑定参数上限。 */
export async function getProgressForBooks(db: AppDb, userId: string, bookIds: string[]) {
  const unique = [...new Set(bookIds)];
  const result = new Map<string, ReturnType<typeof serializeProgress>>();
  const chunkSize = 90;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const rows = await db
      .select()
      .from(readingProgress)
      .where(
        and(
          eq(readingProgress.userId, userId),
          inArray(readingProgress.bookId, unique.slice(i, i + chunkSize))
        )
      );
    for (const row of rows) result.set(row.bookId, serializeProgress(row));
  }
  return result;
}

export async function syncProgress(db: AppDb, userId: string, input: ProgressInput) {
  const existing = await getProgress(db, userId, input.bookId);
  const incomingAt = new Date(input.updatedAt).getTime();

  if (existing) {
    const serverAt = new Date(existing.updatedAt).getTime();
    if (serverAt > incomingAt) {
      return { status: "conflict" as const, progress: existing };
    }

    const values = {
      chapterId: input.chapterId,
      paragraphAnchor: input.paragraphAnchor,
      charOffset: input.charOffset,
      chapterProgress: Math.min(100, Math.max(0, input.chapterProgress)),
      bookProgress: Math.min(100, Math.max(0, input.bookProgress)),
      deviceId: input.deviceId ?? null,
      updatedAt: new Date(input.updatedAt),
    };

    const updated = await db
      .update(readingProgress)
      .set({ ...values, version: existing.version + 1 })
      .where(
        and(
          eq(readingProgress.userId, userId),
          eq(readingProgress.bookId, input.bookId),
          eq(readingProgress.version, input.version ?? existing.version)
        )
      )
      .returning()
      .get();

    if (updated) {
      await recordHistory(db, userId, input);
      return { status: "saved" as const, progress: serializeProgress(updated) };
    }

    // 版本冲突但时间更新：按较新位置覆盖
    const forced = await db
      .update(readingProgress)
      .set({ ...values, version: existing.version + 1 })
      .where(and(eq(readingProgress.userId, userId), eq(readingProgress.bookId, input.bookId)))
      .returning()
      .get();
    if (forced) {
      await recordHistory(db, userId, input);
      return { status: "saved" as const, progress: serializeProgress(forced) };
    }
  } else {
    const inserted = await db
      .insert(readingProgress)
      .values({
        id: crypto.randomUUID(),
        userId,
        bookId: input.bookId,
        chapterId: input.chapterId,
        paragraphAnchor: input.paragraphAnchor,
        charOffset: input.charOffset,
        chapterProgress: Math.min(100, Math.max(0, input.chapterProgress)),
        bookProgress: Math.min(100, Math.max(0, input.bookProgress)),
        deviceId: input.deviceId ?? null,
        updatedAt: new Date(input.updatedAt),
      })
      .returning()
      .get();
    if (inserted) {
      await recordHistory(db, userId, input);
      return { status: "saved" as const, progress: serializeProgress(inserted) };
    }
  }

  return { status: "error" as const, progress: existing };
}

/**
 * 同一 (用户, 书, 章) 只保留一条历史。
 *
 * 原来用随机 UUID 主键 + onConflictDoNothing，冲突永远不发生，
 * 每 5 秒一次的进度同步都会插新行（线上单章已堆到 27 条），
 * 白耗 D1 写入又让历史页翻来覆去是同一章。
 */
async function recordHistory(db: AppDb, userId: string, input: ProgressInput) {
  const readAt = new Date();
  const values = {
    paragraphAnchor: input.paragraphAnchor,
    charOffset: input.charOffset,
    chapterProgress: Math.min(100, Math.max(0, input.chapterProgress)),
    bookProgress: Math.min(100, Math.max(0, input.bookProgress)),
    readAt,
  };

  await db
    .insert(readingHistory)
    .values({
      id: crypto.randomUUID(),
      userId,
      bookId: input.bookId,
      chapterId: input.chapterId,
      ...values,
    })
    .onConflictDoUpdate({
      target: [readingHistory.userId, readingHistory.bookId, readingHistory.chapterId],
      set: values,
    });
}

export async function savePreferences(
  db: AppDb,
  userId: string,
  input: Partial<typeof readingPreferences.$inferInsert>
) {
  const existing = await db
    .select({ id: readingPreferences.id })
    .from(readingPreferences)
    .where(eq(readingPreferences.userId, userId))
    .get();

  const values = { ...input, userId, updatedAt: new Date() };
  if (existing) {
    return db
      .update(readingPreferences)
      .set(values)
      .where(eq(readingPreferences.userId, userId))
      .returning()
      .get();
  }
  return db.insert(readingPreferences).values({ id: crypto.randomUUID(), ...values }).returning().get();
}

export async function getPreferences(db: AppDb, userId: string) {
  return db.select().from(readingPreferences).where(eq(readingPreferences.userId, userId)).get();
}

export async function addBookmark(
  db: AppDb,
  userId: string,
  input: { bookId: string; chapterId: string | null; paragraphAnchor: string | null; charOffset: number; excerpt?: string }
) {
  return db
    .insert(bookmarks)
    .values({
      id: crypto.randomUUID(),
      userId,
      bookId: input.bookId,
      chapterId: input.chapterId,
      paragraphAnchor: input.paragraphAnchor,
      charOffset: input.charOffset,
      excerpt: input.excerpt?.slice(0, 120) ?? null,
    })
    .returning()
    .get();
}

export async function listBookmarks(db: AppDb, userId: string, limit = 50) {
  return db
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt))
    .limit(limit);
}

