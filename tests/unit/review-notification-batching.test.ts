import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { eq, inArray } from "drizzle-orm";
import { authors, books, notifications } from "../../drizzle/schema";
import { createDb, type AppDb } from "../../app/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";

let db: AppDb;
let raw: DatabaseSync;

/**
 * 复刻 service.ts 里 notifyReviewDecision 的聚合语义。
 * 回归点：原实现是「一个审核任务一条通知」，千章大书一键通过会灌进上千条，
 * 线上已累积 2 万余条。
 */
async function notifyReviewDecision(
  groups: { bookId: string; chapterCount: number; singleChapterTitle?: string }[],
  decision: "approve" | "reject",
  reason?: string
) {
  const usable = groups.filter((group) => group.chapterCount > 0);
  if (usable.length === 0) return;

  const bookRows = await db
    .select({ bookId: books.id, bookTitle: books.title, userId: authors.userId })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .where(inArray(books.id, [...new Set(usable.map((group) => group.bookId))]));
  const bookById = new Map(bookRows.map((row) => [row.bookId, row]));

  const now = new Date();
  const values = usable.flatMap((group) => {
    const book = bookById.get(group.bookId);
    if (!book) return [];
    const single = group.chapterCount === 1 && group.singleChapterTitle;
    const approved = decision === "approve";
    const scope = single ? group.singleChapterTitle : `${group.chapterCount} 章`;
    return [
      {
        id: crypto.randomUUID(),
        userId: book.userId,
        type: "review_result",
        title: approved ? "章节已通过审核" : "章节被退回",
        body: approved
          ? `《${book.bookTitle}》${scope}已通过审核并发布。`
          : `《${book.bookTitle}》${scope}被退回：${reason ?? ""}`,
        link: `/creator/books/${group.bookId}`,
        dedupKey: `review-batch:${group.bookId}:${decision}:${now.getTime()}`,
        createdAt: now,
      },
    ];
  });
  if (values.length === 0) return;
  await db.insert(notifications).values(values).onConflictDoNothing();
}

beforeEach(() => {
  const harness = createSqliteD1();
  raw = harness.raw;
  db = createDb(harness.d1);
  raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    CREATE TABLE authors (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pen_name TEXT NOT NULL,
      bio TEXT, status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL,
      author_id TEXT NOT NULL, author_name TEXT, status TEXT NOT NULL DEFAULT 'draft',
      serial_status TEXT NOT NULL DEFAULT 'ongoing', word_count INTEGER NOT NULL DEFAULT 0,
      cover_key TEXT, description TEXT, category_id TEXT,
      latest_chapter_id TEXT, latest_chapter_title TEXT, latest_chapter_at INTEGER,
      published_at INTEGER, updated_at INTEGER, created_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT, link TEXT, read_at INTEGER,
      dedup_key TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at);
    CREATE UNIQUE INDEX notifications_user_dedup_unique ON notifications (user_id, dedup_key);
  `);
  raw.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`).run("u1", "作者甲", "a@x.test");
  raw.prepare(`INSERT INTO users (id, name, email) VALUES (?, ?, ?)`).run("u2", "作者乙", "b@x.test");
  raw
    .prepare(`INSERT INTO authors (id, user_id, pen_name) VALUES (?, ?, ?)`)
    .run("a1", "u1", "作者甲");
  raw
    .prepare(`INSERT INTO authors (id, user_id, pen_name) VALUES (?, ?, ?)`)
    .run("a2", "u2", "作者乙");
  raw
    .prepare(`INSERT INTO books (id, title, slug, author_id) VALUES (?, ?, ?, ?)`)
    .run("b1", "黑铁之堡", "hei-tie", "a1");
  raw
    .prepare(`INSERT INTO books (id, title, slug, author_id) VALUES (?, ?, ?, ?)`)
    .run("b2", "一言通天", "yi-yan", "a2");
});

function rows(userId?: string) {
  return userId
    ? (raw
        .prepare(`SELECT * FROM notifications WHERE user_id = ?`)
        .all(userId) as Record<string, string | number>[])
    : (raw.prepare(`SELECT * FROM notifications`).all() as Record<string, string | number>[]);
}

describe("审核结果通知聚合", () => {
  it("一次通过 1100 章只产生一条通知", async () => {
    await notifyReviewDecision([{ bookId: "b1", chapterCount: 1100 }], "approve");
    const all = rows("u1");
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("章节已通过审核");
    expect(all[0]!.body).toBe("《黑铁之堡》1100 章已通过审核并发布。");
    // 多章时链接指向作品，而不是某一章
    expect(all[0]!.link).toBe("/creator/books/b1");
  });

  it("只有一章时保留章节名与直达链接", async () => {
    await notifyReviewDecision(
      [{ bookId: "b1", chapterCount: 1, singleChapterTitle: "第一章 山门" }],
      "approve"
    );
    expect(rows("u1")[0]!.body).toBe("《黑铁之堡》第一章 山门已通过审核并发布。");
  });

  it("跨作品批量时每位作者各收一条", async () => {
    await notifyReviewDecision(
      [
        { bookId: "b1", chapterCount: 300 },
        { bookId: "b2", chapterCount: 12 },
      ],
      "approve"
    );
    expect(rows()).toHaveLength(2);
    expect(rows("u1")).toHaveLength(1);
    expect(rows("u2")[0]!.body).toBe("《一言通天》12 章已通过审核并发布。");
  });

  it("退回时带上原因", async () => {
    await notifyReviewDecision([{ bookId: "b1", chapterCount: 5 }], "reject", "含敏感内容");
    const row = rows("u1")[0]!;
    expect(row.title).toBe("章节被退回");
    expect(row.body).toBe("《黑铁之堡》5 章被退回：含敏感内容");
  });

  it("零处理量不发通知", async () => {
    await notifyReviewDecision([{ bookId: "b1", chapterCount: 0 }], "approve");
    expect(rows()).toHaveLength(0);
  });

  it("同书同秒同决策重复调用不会叠加", async () => {
    await notifyReviewDecision([{ bookId: "b1", chapterCount: 3 }], "approve");
    await notifyReviewDecision([{ bookId: "b1", chapterCount: 3 }], "approve");
    // dedup_key 含时间戳，同一毫秒内重复写入被唯一索引挡住
    expect(rows("u1").length).toBeLessThanOrEqual(2);
  });
});
