import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb, type AppDb } from "../../app/server/db";
import {
  getChapterIdByIndex,
  getChapterNavigation,
  listBookTocMinimal,
} from "../../app/server/repositories/books";
import { createChapterFixtures, createSqliteD1 } from "../helpers/sqlite-d1";

const BOOK = "book-1";
const OTHER_BOOK = "book-2";

let db: AppDb;
let raw: DatabaseSync;

function insertChapter(options: {
  id: string;
  bookId?: string;
  volumeId?: string;
  sortOrder: number;
  status?: string;
  deletedAt?: number | null;
  title?: string;
}) {
  raw
    .prepare(
      `INSERT INTO chapters (id, book_id, volume_id, title, sort_order, status, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      options.id,
      options.bookId ?? BOOK,
      options.volumeId ?? "vol-1",
      options.title ?? `第 ${options.sortOrder} 章`,
      options.sortOrder,
      options.status ?? "published",
      options.deletedAt ?? null
    );
}

beforeEach(() => {
  const harness = createSqliteD1();
  raw = harness.raw;
  db = createDb(harness.d1);
  createChapterFixtures(raw);

  raw
    .prepare(`INSERT INTO volumes (id, book_id, title, sort_order) VALUES (?, ?, ?, ?)`)
    .run("vol-1", BOOK, "第一卷", 0);
  raw
    .prepare(`INSERT INTO volumes (id, book_id, title, sort_order) VALUES (?, ?, ?, ?)`)
    .run("vol-2", BOOK, "第二卷", 1);

  // 卷一 1..3，卷二 4..5；sort_order 故意不连续，验证不是靠下标硬算
  insertChapter({ id: "c1", sortOrder: 10 });
  insertChapter({ id: "c2", sortOrder: 20 });
  insertChapter({ id: "c3", sortOrder: 30 });
  insertChapter({ id: "c4", sortOrder: 40, volumeId: "vol-2" });
  insertChapter({ id: "c5", sortOrder: 50, volumeId: "vol-2" });
  // 干扰数据：别的书、软删除、未发布，都不该出现在导航里
  insertChapter({ id: "other", bookId: OTHER_BOOK, sortOrder: 15 });
  insertChapter({ id: "deleted", sortOrder: 25, deletedAt: 1 });
  insertChapter({ id: "draft", sortOrder: 35, status: "draft" });
});

describe("阅读页章节导航（替代整表目录）", () => {
  it("给出上一章/下一章与全书序号", async () => {
    const nav = await getChapterNavigation(db, BOOK, 30);
    expect(nav.prev?.id).toBe("c2");
    expect(nav.next?.id).toBe("c4");
    expect(nav.currentIndex).toBe(2);
    expect(nav.totalChapters).toBe(5);
  });

  it("首章无上一章，末章无下一章", async () => {
    const first = await getChapterNavigation(db, BOOK, 10);
    expect(first.prev).toBeNull();
    expect(first.next?.id).toBe("c2");
    expect(first.currentIndex).toBe(0);

    const last = await getChapterNavigation(db, BOOK, 50);
    expect(last.prev?.id).toBe("c4");
    expect(last.next).toBeNull();
    expect(last.currentIndex).toBe(4);
  });

  it("跳过软删除、未发布与其他作品的章节", async () => {
    const nav = await getChapterNavigation(db, BOOK, 20);
    // 若未过滤，上一章会落到 sort_order=15 的其他作品章节
    expect(nav.prev?.id).toBe("c1");
    // 若未过滤，下一章会落到 sort_order=25 的软删除章节
    expect(nav.next?.id).toBe("c3");
    expect(nav.totalChapters).toBe(5);
  });

  it("序号与章节 ID 双向对应，可支撑进度条跳章", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    for (const [index, id] of ids.entries()) {
      expect(await getChapterIdByIndex(db, BOOK, index)).toBe(id);
    }
    expect(await getChapterIdByIndex(db, BOOK, 5)).toBeNull();
    expect(await getChapterIdByIndex(db, BOOK, -1)).toBeNull();
  });

  it("currentIndex 与 getChapterIdByIndex 自洽", async () => {
    const nav = await getChapterNavigation(db, BOOK, 40);
    expect(await getChapterIdByIndex(db, BOOK, nav.currentIndex)).toBe("c4");
  });

  it("作者预览时纳入未发布章节，读者视角则排除", async () => {
    // draft 的 sort_order=35，位于 c3(30) 与 c4(40) 之间
    const reader = await getChapterNavigation(db, BOOK, 30);
    expect(reader.next?.id).toBe("c4");
    expect(reader.totalChapters).toBe(5);

    const author = await getChapterNavigation(db, BOOK, 30, true);
    expect(author.next?.id).toBe("draft");
    expect(author.totalChapters).toBe(6);
    // 软删除章节即便在预览视角也不该出现
    const authorAtC1 = await getChapterNavigation(db, BOOK, 10, true);
    expect(authorAtC1.next?.id).toBe("c2");

    expect(await getChapterIdByIndex(db, BOOK, 3, true)).toBe("draft");
    expect(await getChapterIdByIndex(db, BOOK, 3)).toBe("c4");
  });

  it("精简目录按卷分组且只含可读章节", async () => {
    const toc = await listBookTocMinimal(db, BOOK);
    expect(toc.map((volume) => volume.title)).toEqual(["第一卷", "第二卷"]);
    expect(toc[0]?.chapters.map((chapter) => chapter.id)).toEqual(["c1", "c2", "c3"]);
    expect(toc[1]?.chapters.map((chapter) => chapter.id)).toEqual(["c4", "c5"]);
    // 精简：抽屉只需要 id + title
    expect(Object.keys(toc[0]!.chapters[0]!).sort()).toEqual(["id", "title"]);
  });
});
