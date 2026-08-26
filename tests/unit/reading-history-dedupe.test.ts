import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { readingHistory } from "../../drizzle/schema";
import { createDb, type AppDb } from "../../app/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";

const USER = "user-1";
const BOOK = "book-1";

let db: AppDb;
let raw: DatabaseSync;

/**
 * 复刻 recordHistory 的写入语义。
 * 回归点：旧实现是随机 UUID 主键 + onConflictDoNothing，冲突永不发生，
 * 每 5 秒一次的进度同步都插新行，线上单章已堆到 27 条。
 */
async function recordHistory(chapterId: string, chapterProgress: number, readAt: Date) {
  const values = {
    paragraphAnchor: `p-${chapterProgress}`,
    charOffset: 0,
    chapterProgress,
    bookProgress: chapterProgress,
    readAt,
  };
  await db
    .insert(readingHistory)
    .values({ id: crypto.randomUUID(), userId: USER, bookId: BOOK, chapterId, ...values })
    .onConflictDoUpdate({
      target: [readingHistory.userId, readingHistory.bookId, readingHistory.chapterId],
      set: values,
    });
}

beforeEach(() => {
  const harness = createSqliteD1();
  raw = harness.raw;
  db = createDb(harness.d1);
  raw.exec(`
    CREATE TABLE reading_history (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, book_id TEXT NOT NULL,
      chapter_id TEXT, paragraph_anchor TEXT,
      char_offset INTEGER NOT NULL DEFAULT 0,
      chapter_progress INTEGER NOT NULL DEFAULT 0,
      book_progress INTEGER NOT NULL DEFAULT 0,
      read_at INTEGER NOT NULL
    );
    CREATE INDEX reading_history_user_read_at_idx ON reading_history (user_id, read_at);
    CREATE UNIQUE INDEX reading_history_user_book_chapter_unique
      ON reading_history (user_id, book_id, chapter_id);
  `);
});

function rowsFor(chapterId: string) {
  return raw
    .prepare(`SELECT * FROM reading_history WHERE chapter_id = ?`)
    .all(chapterId) as Record<string, number | string>[];
}

describe("阅读历史去重", () => {
  it("同一章反复同步只保留一条，并更新到最新进度", async () => {
    const base = Date.UTC(2026, 7, 25, 10, 0, 0);
    for (let i = 1; i <= 30; i += 1) {
      await recordHistory("chapter-1", i, new Date(base + i * 5000));
    }

    const rows = rowsFor("chapter-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chapter_progress).toBe(30);
    expect(rows[0]!.paragraph_anchor).toBe("p-30");
    expect(Number(rows[0]!.read_at)).toBe(base + 30 * 5000);
  });

  it("不同章各自留一条", async () => {
    const at = new Date(Date.UTC(2026, 7, 25, 10, 0, 0));
    await recordHistory("chapter-1", 40, at);
    await recordHistory("chapter-2", 10, at);
    await recordHistory("chapter-1", 60, at);

    expect(rowsFor("chapter-1")).toHaveLength(1);
    expect(rowsFor("chapter-2")).toHaveLength(1);
    expect(rowsFor("chapter-1")[0]!.chapter_progress).toBe(60);
  });

  it("历史页按最近阅读排序，且一书一章不重复出现", async () => {
    const base = Date.UTC(2026, 7, 25, 10, 0, 0);
    await recordHistory("chapter-1", 20, new Date(base));
    await recordHistory("chapter-2", 30, new Date(base + 1000));
    await recordHistory("chapter-1", 50, new Date(base + 2000));

    const rows = raw
      .prepare(`SELECT chapter_id FROM reading_history WHERE user_id = ? ORDER BY read_at DESC`)
      .all(USER) as { chapter_id: string }[];
    expect(rows.map((row) => row.chapter_id)).toEqual(["chapter-1", "chapter-2"]);
  });
});
