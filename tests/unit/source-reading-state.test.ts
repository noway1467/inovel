import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import {
  getSourceReadingState,
  listRecentSourceBooks,
  listShelvedSourceBooks,
  recordSourceProgress,
  setSourceShelved,
} from "~/server/services/source-reading";

let db: AppDb;
let raw: DatabaseSync;

const userId = "u1";
const book = {
  sourceId: "src-1",
  bookUrl: "http://example.org/guzhenren/",
  bookTitle: "蛊真人",
  sourceName: "示例源",
  chapterCount: 1200,
};

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  db = createDb(sqlite.d1);
  raw.exec(`
    CREATE TABLE user (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      email text NOT NULL
    );
    CREATE TABLE source_reading_state (
      id text PRIMARY KEY NOT NULL,
      user_id text NOT NULL,
      source_id text NOT NULL,
      book_url text NOT NULL,
      book_title text NOT NULL,
      source_name text,
      shelved integer DEFAULT false NOT NULL,
      last_chapter_key text,
      last_chapter_title text,
      last_chapter_index integer,
      last_page_index integer DEFAULT 0 NOT NULL,
      chapter_count integer,
      last_read_at integer,
      added_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX source_reading_state_user_book_unique
      ON source_reading_state (user_id, source_id, book_url);
  `);
  raw.prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)").run(userId, "读者", "r@e.org");
});

afterEach(() => {
  raw.close();
});

describe("在线源书架与进度", () => {
  it("没读过也没收藏过时返回 null", async () => {
    expect(await getSourceReadingState(db, userId, book.sourceId, book.bookUrl)).toBeNull();
  });

  it("记录进度后能读回读到哪一章第几页", async () => {
    await recordSourceProgress(db, userId, book, {
      chapterKey: "http://example.org/c/2.html",
      chapterTitle: "第二章",
      chapterIndex: 1,
      pageIndex: 7,
    });

    const state = await getSourceReadingState(db, userId, book.sourceId, book.bookUrl);
    expect(state?.lastChapterKey).toBe("http://example.org/c/2.html");
    expect(state?.lastChapterTitle).toBe("第二章");
    expect(state?.lastChapterIndex).toBe(1);
    expect(state?.lastPageIndex).toBe(7);
    expect(state?.chapterCount).toBe(1200);
    expect(state?.lastReadAt).toBeTruthy();
  });

  it("同一本书反复记进度只留一行，覆盖为最新位置", async () => {
    await recordSourceProgress(db, userId, book, { chapterKey: "c1", chapterIndex: 0, pageIndex: 1 });
    await recordSourceProgress(db, userId, book, { chapterKey: "c9", chapterIndex: 8, pageIndex: 3 });

    const rows = raw.prepare("SELECT * FROM source_reading_state").all();
    expect(rows).toHaveLength(1);
    const state = await getSourceReadingState(db, userId, book.sourceId, book.bookUrl);
    expect(state?.lastChapterKey).toBe("c9");
    expect(state?.lastPageIndex).toBe(3);
  });

  it("加入书架不影响已记录的进度", async () => {
    await recordSourceProgress(db, userId, book, { chapterKey: "c5", chapterIndex: 4, pageIndex: 2 });
    await setSourceShelved(db, userId, book, true);

    const state = await getSourceReadingState(db, userId, book.sourceId, book.bookUrl);
    expect(state?.shelved).toBe(true);
    // 关键：收藏动作不能把读到哪清掉
    expect(state?.lastChapterKey).toBe("c5");
    expect(state?.lastPageIndex).toBe(2);
  });

  it("移出书架保留进度", async () => {
    await setSourceShelved(db, userId, book, true);
    await recordSourceProgress(db, userId, book, { chapterKey: "c3", chapterIndex: 2, pageIndex: 5 });
    await setSourceShelved(db, userId, book, false);

    const state = await getSourceReadingState(db, userId, book.sourceId, book.bookUrl);
    expect(state?.shelved).toBe(false);
    expect(state?.lastChapterKey).toBe("c3");
    expect(state?.lastPageIndex).toBe(5);
  });

  it("先收藏后读，进度记录不会把书踢出书架", async () => {
    await setSourceShelved(db, userId, book, true);
    await recordSourceProgress(db, userId, book, { chapterKey: "c1", chapterIndex: 0, pageIndex: 0 });

    const state = await getSourceReadingState(db, userId, book.sourceId, book.bookUrl);
    expect(state?.shelved).toBe(true);
  });

  it("目录章数取不到时不覆盖已存的值", async () => {
    await recordSourceProgress(db, userId, book, { chapterKey: "c1" });
    // 第二次没拿到目录（chapterCount 为 null）
    await recordSourceProgress(
      db,
      userId,
      { ...book, chapterCount: null },
      { chapterKey: "c2" }
    );

    const state = await getSourceReadingState(db, userId, book.sourceId, book.bookUrl);
    expect(state?.chapterCount).toBe(1200);
  });

  it("书架只列已收藏的书", async () => {
    await setSourceShelved(db, userId, book, true);
    await recordSourceProgress(
      db,
      userId,
      { ...book, bookUrl: "http://example.org/other/", bookTitle: "另一本" },
      { chapterKey: "x1" }
    );

    const shelved = await listShelvedSourceBooks(db, userId);
    expect(shelved.map((row) => row.bookTitle)).toEqual(["蛊真人"]);
  });

  it("最近阅读只列读过的，纯收藏未读的不算", async () => {
    // 只收藏没读
    await setSourceShelved(db, userId, book, true);
    // 读过另一本
    await recordSourceProgress(
      db,
      userId,
      { ...book, bookUrl: "http://example.org/other/", bookTitle: "读过的" },
      { chapterKey: "x1" }
    );

    const recent = await listRecentSourceBooks(db, userId);
    expect(recent.map((row) => row.bookTitle)).toEqual(["读过的"]);
  });

  it("不同源上的同名书各记一份", async () => {
    await recordSourceProgress(db, userId, book, { chapterKey: "a1", pageIndex: 1 });
    await recordSourceProgress(
      db,
      userId,
      { ...book, sourceId: "src-2" },
      { chapterKey: "b1", pageIndex: 9 }
    );

    const first = await getSourceReadingState(db, userId, "src-1", book.bookUrl);
    const second = await getSourceReadingState(db, userId, "src-2", book.bookUrl);
    expect(first?.lastPageIndex).toBe(1);
    expect(second?.lastPageIndex).toBe(9);
  });

  it("缺 sourceId 或 bookUrl 时直接返回 null，不去查库", async () => {
    expect(await getSourceReadingState(db, userId, "", book.bookUrl)).toBeNull();
    expect(await getSourceReadingState(db, userId, book.sourceId, "")).toBeNull();
  });
});
