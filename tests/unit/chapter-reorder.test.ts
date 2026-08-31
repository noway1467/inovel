import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asc } from "drizzle-orm";
import { chapters } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { deleteChaptersBatch, reorderChapters } from "~/server/creator/service";
import { listBookChapters, listBookTocMinimal } from "~/server/repositories/books";
import { createSqliteD1 } from "../helpers/sqlite-d1";

/**
 * 作品管理里拖动改序、批量删章，以及"目录跟着章节顺序走"。
 *
 * 用真迁移建库 + 真服务函数跑，不 mock：改序要动 sort_order 并重算作品的
 * 最新章节，批量删要清掉引用章节的阅读数据，这些都只有真跑一遍才作数。
 */

let db: AppDb;
let raw: DatabaseSync;

const userId = "user-1";
const authorId = "author-1";
const bookId = "book-1";
const otherUserId = "user-2";

function applyMigrations(target: DatabaseSync) {
  const dir = path.resolve(process.cwd(), "drizzle/migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) target.exec(trimmed);
    }
  }
}

function insertChapter(options: {
  id: string;
  sortOrder: number;
  volumeId?: string | null;
  title?: string;
  status?: string;
  wordCount?: number;
}) {
  const now = Date.now();
  raw
    .prepare(
      `INSERT INTO chapters (id, book_id, volume_id, title, sort_order, status, word_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      options.id,
      bookId,
      // 显式传 null 要能落成 NULL，不能被默认卷吃掉
      "volumeId" in options ? options.volumeId : "vol-1",
      options.title ?? options.id,
      options.sortOrder,
      options.status ?? "published",
      options.wordCount ?? 100,
      now,
      now
    );
}

/** 只看被测这本书的章节顺序；干扰用的别本书另有断言 */
async function orderedIds(target = bookId) {
  const rows = await db
    .select({ id: chapters.id, bookId: chapters.bookId })
    .from(chapters)
    .orderBy(asc(chapters.sortOrder));
  return rows.filter((row) => row.bookId === target).map((row) => row.id);
}

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  applyMigrations(raw);
  db = createDb(sqlite.d1);

  const now = Date.now();
  for (const [id, email] of [
    [userId, "a@test.local"],
    [otherUserId, "b@test.local"],
  ]) {
    raw
      .prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`
      )
      .run(id, id, email, now, now);
  }
  raw
    .prepare(
      `INSERT INTO authors (id, user_id, pen_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`
    )
    .run(authorId, userId, "作者甲", now, now);
  raw
    .prepare(
      `INSERT INTO books (id, title, slug, status, serial_status, word_count, author_id, created_at, updated_at)
       VALUES (?, ?, ?, 'published', 'ongoing', 0, ?, ?, ?)`
    )
    .run(bookId, "测试书", "test-book", authorId, now, now);
  raw
    .prepare(`INSERT INTO volumes (id, book_id, title, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("vol-1", bookId, "第一卷", 0, now);
  raw
    .prepare(`INSERT INTO volumes (id, book_id, title, sort_order, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("vol-2", bookId, "第二卷", 1, now);
});

describe("章节改序", () => {
  beforeEach(() => {
    // sort_order 故意不连续，验证改序是按现有槽位重贴而不是按下标硬算
    insertChapter({ id: "c1", sortOrder: 10 });
    insertChapter({ id: "c2", sortOrder: 20 });
    insertChapter({ id: "c3", sortOrder: 30 });
  });

  it("按传入顺序重贴现有 sort_order", async () => {
    const result = await reorderChapters(db, bookId, ["c3", "c1", "c2"], userId);
    expect(result).toEqual({ reordered: 3 });
    expect(await orderedIds()).toEqual(["c3", "c1", "c2"]);

    // 槽位原样复用，没有引入新的 sort_order 值
    const rows = await db
      .select({ sortOrder: chapters.sortOrder })
      .from(chapters)
      .orderBy(asc(chapters.sortOrder));
    expect(rows.map((row) => row.sortOrder)).toEqual([10, 20, 30]);
  });

  it("只重排传进来的那批，不碰其余章节", async () => {
    insertChapter({ id: "c4", sortOrder: 40 });
    // 只交换前两章，c3/c4 的位置必须原样不动
    await reorderChapters(db, bookId, ["c2", "c1"], userId);
    expect(await orderedIds()).toEqual(["c2", "c1", "c3", "c4"]);
  });

  it("顺序没变时不写库", async () => {
    expect(await reorderChapters(db, bookId, ["c1", "c2", "c3"], userId)).toEqual({ reordered: 0 });
    expect(await orderedIds()).toEqual(["c1", "c2", "c3"]);
  });

  it("改序后作品的最新章节跟着变", async () => {
    await reorderChapters(db, bookId, ["c3", "c1", "c2"], userId);
    const book = raw.prepare(`SELECT latest_chapter_id, word_count FROM books WHERE id = ?`).get(bookId) as {
      latest_chapter_id: string;
      word_count: number;
    };
    // 末位换成了 c2，"最新章节"必须重算，否则详情页还挂着 c3
    expect(book.latest_chapter_id).toBe("c2");
    expect(book.word_count).toBe(300);
  });

  it("列表里混进别的书或不存在的章节时整批拒绝", async () => {
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO books (id, title, slug, status, serial_status, word_count, author_id, created_at, updated_at)
         VALUES ('book-2', '另一本', 'other', 'draft', 'ongoing', 0, ?, ?, ?)`
      )
      .run(authorId, now, now);
    raw
      .prepare(
        `INSERT INTO chapters (id, book_id, volume_id, title, sort_order, status, word_count, created_at, updated_at)
         VALUES ('outsider', 'book-2', NULL, '外来章', 5, 'published', 10, ?, ?)`
      )
      .run(now, now);

    expect(await reorderChapters(db, bookId, ["c1", "outsider"], userId)).toBeNull();
    expect(await reorderChapters(db, bookId, ["c1", "nope"], userId)).toBeNull();
    // 拒绝就得是整批不动
    expect(await orderedIds()).toEqual(["c1", "c2", "c3"]);
    expect(await orderedIds("book-2")).toEqual(["outsider"]);
  });

  it("不是作者本人时拒绝", async () => {
    expect(await reorderChapters(db, bookId, ["c3", "c2", "c1"], otherUserId)).toBeNull();
    expect(await orderedIds()).toEqual(["c1", "c2", "c3"]);
  });
});

describe("批量删章", () => {
  beforeEach(() => {
    insertChapter({ id: "c1", sortOrder: 10 });
    insertChapter({ id: "c2", sortOrder: 20 });
    insertChapter({ id: "c3", sortOrder: 30 });
  });

  it("删掉选中的几章并重算作品统计", async () => {
    const result = await deleteChaptersBatch(db, bookId, ["c1", "c3"], userId);
    expect(result).toEqual({ deleted: 2 });
    expect(await orderedIds()).toEqual(["c2"]);

    const book = raw.prepare(`SELECT latest_chapter_id, word_count FROM books WHERE id = ?`).get(bookId) as {
      latest_chapter_id: string;
      word_count: number;
    };
    expect(book.latest_chapter_id).toBe("c2");
    expect(book.word_count).toBe(100);
  });

  it("清掉引用被删章节的阅读数据", async () => {
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO reading_progress (id, user_id, book_id, chapter_id, char_offset, chapter_progress, book_progress, updated_at)
         VALUES ('rp-1', ?, ?, 'c1', 120, 50, 30, ?)`
      )
      .run(userId, bookId, now);
    raw
      .prepare(
        `INSERT INTO reading_history (id, user_id, book_id, chapter_id, read_at) VALUES ('rh-1', ?, ?, 'c1', ?)`
      )
      .run(userId, bookId, now);
    raw
      .prepare(
        `INSERT INTO bookmarks (id, user_id, book_id, chapter_id, char_offset, created_at) VALUES ('bm-1', ?, ?, 'c1', 0, ?)`
      )
      .run(userId, bookId, now);

    await deleteChaptersBatch(db, bookId, ["c1"], userId);

    const progress = raw.prepare(`SELECT chapter_id, char_offset FROM reading_progress WHERE id = 'rp-1'`).get() as {
      chapter_id: string | null;
      char_offset: number;
    };
    // 进度保留但指针清空：书还在书架上，只是不再指向已删章节
    expect(progress.chapter_id).toBeNull();
    expect(progress.char_offset).toBe(0);
    expect(raw.prepare(`SELECT COUNT(*) c FROM reading_history`).get()).toEqual({ c: 0 });
    expect(raw.prepare(`SELECT COUNT(*) c FROM bookmarks`).get()).toEqual({ c: 0 });
  });

  it("只删本书的章节，别的书传进来也不动", async () => {
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO books (id, title, slug, status, serial_status, word_count, author_id, created_at, updated_at)
         VALUES ('book-2', '另一本', 'other', 'draft', 'ongoing', 0, ?, ?, ?)`
      )
      .run(authorId, now, now);
    raw
      .prepare(
        `INSERT INTO chapters (id, book_id, volume_id, title, sort_order, status, word_count, created_at, updated_at)
         VALUES ('outsider', 'book-2', NULL, '外来章', 5, 'published', 10, ?, ?)`
      )
      .run(now, now);

    expect(await deleteChaptersBatch(db, bookId, ["c1", "outsider"], userId)).toEqual({ deleted: 1 });
    expect(await orderedIds()).toEqual(["c2", "c3"]);
    // 别的书的章节必须还在
    expect(await orderedIds("book-2")).toEqual(["outsider"]);
  });

  it("不是作者本人时拒绝", async () => {
    expect(await deleteChaptersBatch(db, bookId, ["c1"], otherUserId)).toBeNull();
    expect(await orderedIds()).toEqual(["c1", "c2", "c3"]);
  });
});

describe("目录跟着章节顺序走", () => {
  it("章节改序后目录顺序一起变，不再由卷序决定", async () => {
    insertChapter({ id: "a1", sortOrder: 10, volumeId: "vol-1" });
    insertChapter({ id: "a2", sortOrder: 20, volumeId: "vol-1" });
    insertChapter({ id: "b1", sortOrder: 30, volumeId: "vol-2" });

    // 把第二卷的章节拖到最前面
    await reorderChapters(db, bookId, ["b1", "a1", "a2"], userId);

    const toc = await listBookChapters(db, bookId);
    expect(toc.flatMap((segment) => segment.chapters.map((chapter) => chapter.id))).toEqual([
      "b1",
      "a1",
      "a2",
    ]);
    // 顺序变了就得切成两段，卷名只是中间的分隔标题
    expect(toc.map((segment) => segment.title)).toEqual(["第二卷", "第一卷"]);

    const minimal = await listBookTocMinimal(db, bookId);
    expect(minimal.flatMap((segment) => segment.chapters.map((chapter) => chapter.id))).toEqual([
      "b1",
      "a1",
      "a2",
    ]);
  });

  it("没有卷的章节照样出现在目录里", async () => {
    insertChapter({ id: "n1", sortOrder: 10, volumeId: null });
    insertChapter({ id: "n2", sortOrder: 20, volumeId: null });

    const toc = await listBookChapters(db, bookId);
    // 原先按卷分组时这些章节会被整个丢掉，目录空白但书里有章
    expect(toc.flatMap((segment) => segment.chapters.map((chapter) => chapter.id))).toEqual([
      "n1",
      "n2",
    ]);
    expect(toc[0]?.title).toBe("正文");
  });

  it("同一卷被拆成两段时各自成段，段 id 不重名", async () => {
    insertChapter({ id: "a1", sortOrder: 10, volumeId: "vol-1" });
    insertChapter({ id: "b1", sortOrder: 20, volumeId: "vol-2" });
    insertChapter({ id: "a2", sortOrder: 30, volumeId: "vol-1" });

    const toc = await listBookChapters(db, bookId);
    expect(toc.map((segment) => segment.title)).toEqual(["第一卷", "第二卷", "第一卷"]);
    // 段 id 用作 React key 与目录抽屉的折叠状态，重名会让两段一起折叠
    expect(new Set(toc.map((segment) => segment.id)).size).toBe(3);
  });

  it("读者视角只出可读章节，作者预览带上草稿", async () => {
    insertChapter({ id: "p1", sortOrder: 10 });
    insertChapter({ id: "d1", sortOrder: 20, status: "draft" });

    const reader = await listBookChapters(db, bookId);
    expect(reader.flatMap((segment) => segment.chapters.map((chapter) => chapter.id))).toEqual(["p1"]);

    const author = await listBookChapters(db, bookId, true);
    expect(author.flatMap((segment) => segment.chapters.map((chapter) => chapter.id))).toEqual([
      "p1",
      "d1",
    ]);
  });
});
