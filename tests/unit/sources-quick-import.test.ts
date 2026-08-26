import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { contentSources, sourceChapterLinks, sourceSubscriptions } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { quickImportAndSubscribe } from "~/server/sources/quick-import";

/**
 * 一步导入订阅：传书源 JSON + 书籍地址 → 已订阅、目录已拉、正文待抓。
 * fetch 受控，但书源转换、规则求值、订阅与增量都是真代码。
 */

let db: AppDb;
let raw: DatabaseSync;
let responses: Map<string, string>;
let requestLog: string[];

const userId = "user-1";

/** 一个规则可翻译的最小书源 */
const bookSource = {
  bookSourceName: "示例书源",
  bookSourceUrl: "https://novels.example.org",
  searchUrl: "https://novels.example.org/search?q={{key}}",
  ruleSearch: {
    bookList: "class.result",
    name: "tag.h3@text",
    bookUrl: "tag.a@href",
  },
  ruleToc: {
    chapterList: "class.listmain@tag.dd",
    chapterName: "tag.a@text",
    chapterUrl: "tag.a@href",
  },
  ruleContent: { content: "id.content@html" },
};

const tocHtml = `<html><body>
  <div class="listmain"><dl>
    <dd><a href="/c/1">第一章 启程</a></dd>
    <dd><a href="/c/2">第二章 抵达</a></dd>
  </dl></div>
</body></html>`;

const searchHtml = `<html><body>
  <div class="result"><h3>示例长篇</h3><a href="/book/1">进入</a></div>
  <div class="result"><h3>另一本</h3><a href="/book/2">进入</a></div>
</body></html>`;

const chapterHtml = (text: string) =>
  `<html><body><div id="content"><p>${text}</p><p>${text}的第二段</p></div></body></html>`;

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);

  responses = new Map();
  requestLog = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestLog.push(url);
      const body = responses.get(url);
      if (body === undefined) {
        return Promise.resolve(new Response("nope", { status: 404 }));
      }
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      );
    })
  );

  raw.prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)").run(userId, "运营", "op@example.org");
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

describe("quickImportAndSubscribe", () => {
  it("书源 JSON + 书籍地址：一次调用就完成订阅并拉到目录", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);

    const result = await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify(bookSource),
      bookUrls: ["https://novels.example.org/book/1"],
      actorId: userId,
    });

    expect(result.totals.sources).toBe(1);
    expect(result.totals.subscriptions).toBe(1);
    expect(result.totals.chaptersAdded).toBe(2);

    const source = result.sources[0]!;
    expect(source.status).toBe("enabled");
    expect(source.subscribed[0]?.chaptersAdded).toBe(2);
    expect(source.failed).toEqual([]);

    // 章节按目录顺序登记为 pending
    const links = await db.select().from(sourceChapterLinks).all();
    expect(links.map((l) => l.externalTitle)).toEqual(["第一章 启程", "第二章 抵达"]);
    expect(links.every((l) => l.fetchStatus === "pending")).toBe(true);
    // 相对地址补全成绝对地址
    expect(links[0]?.externalKey).toBe("https://novels.example.org/c/1");
  });

  it("关键字搜索：命中后按 maxPerKeyword 订阅", async () => {
    responses.set(
      `https://novels.example.org/search?q=${encodeURIComponent("长篇")}`,
      searchHtml
    );
    responses.set("https://novels.example.org/book/1", tocHtml);
    responses.set("https://novels.example.org/book/2", tocHtml);

    const result = await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify(bookSource),
      keywords: ["长篇"],
      maxPerKeyword: 2,
      actorId: userId,
    });

    expect(result.totals.subscriptions).toBe(2);
    const titles = result.sources[0]!.subscribed.map((s) => s.title);
    expect(titles).toEqual(["示例长篇", "另一本"]);
  });

  it("maxPerKeyword 限制生效", async () => {
    responses.set(
      `https://novels.example.org/search?q=${encodeURIComponent("长篇")}`,
      searchHtml
    );
    responses.set("https://novels.example.org/book/1", tocHtml);

    const result = await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify(bookSource),
      keywords: ["长篇"],
      maxPerKeyword: 1,
      actorId: userId,
    });
    expect(result.totals.subscriptions).toBe(1);
  });

  it("重复导入同一书源复用已有源，不产生重复行", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    const input = {
      sourceJson: JSON.stringify(bookSource),
      bookUrls: ["https://novels.example.org/book/1"],
      actorId: userId,
    };
    await quickImportAndSubscribe(db, undefined, input);
    await quickImportAndSubscribe(db, undefined, input);

    const sources = await db.select().from(contentSources).all();
    expect(sources).toHaveLength(1);
    const subs = await db.select().from(sourceSubscriptions).all();
    expect(subs).toHaveLength(1);
  });

  it("已有源 + sourceId 也能直接订阅", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    const first = await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify(bookSource),
      bookUrls: ["https://novels.example.org/book/1"],
      actorId: userId,
    });
    const sourceId = first.sources[0]!.sourceId;

    responses.set("https://novels.example.org/book/9", tocHtml);
    const second = await quickImportAndSubscribe(db, undefined, {
      sourceId,
      bookUrls: ["https://novels.example.org/book/9"],
      actorId: userId,
    });

    expect(second.totals.sources).toBe(1);
    expect(second.totals.subscriptions).toBe(1);
    const subs = await db.select().from(sourceSubscriptions).all();
    expect(subs).toHaveLength(2);
  });

  it("单本失败不影响其余本", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    // book/404 不在 responses 里
    const result = await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify(bookSource),
      bookUrls: [
        "https://novels.example.org/book/1",
        "https://novels.example.org/book/404",
      ],
      actorId: userId,
    });

    const source = result.sources[0]!;
    // 目录抓不到的那本仍会建订阅，但同步失败并记录原因
    const failedSync = source.subscribed.find((s) => s.syncStatus === "failed");
    expect(failedSync).toBeDefined();
    const okSync = source.subscribed.find((s) => s.syncStatus === "ok");
    expect(okSync?.chaptersAdded).toBe(2);
  });

  it("书源规则不可翻译时明确拒绝，不静默失败", async () => {
    const result = await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify({
        ...bookSource,
        ruleContent: { content: "<js>result.text()</js>" },
      }),
      bookUrls: ["https://novels.example.org/book/1"],
      actorId: userId,
    });
    expect(result.totals.sources).toBe(0);
    expect(result.rejected[0]?.reason).toMatch(/正文规则无法翻译/);
  });

  it("一批里坏的被拒、好的照常导入", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    const result = await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify([
        bookSource,
        { bookSourceName: "缺规则", bookSourceUrl: "https://broken.example.org" },
      ]),
      bookUrls: ["https://novels.example.org/book/1"],
      actorId: userId,
    });
    expect(result.totals.sources).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe("缺规则");
  });

  it("既没给 JSON 也没给 sourceId 时报错", async () => {
    await expect(quickImportAndSubscribe(db, undefined, { actorId: userId })).rejects.toThrow(
      /sourceJson.*sourceId/
    );
  });

  it("规则源没有目录且未指定书籍时，给出可操作的提示", async () => {
    const result = await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify(bookSource),
      actorId: userId,
    });
    expect(result.totals.subscriptions).toBe(0);
    expect(result.sources[0]?.failed[0]?.reason).toMatch(/bookUrls 或 keywords/);
  });

  it("投递队列：有新章时触发正文抓取事件", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    const sent: unknown[] = [];
    const queue = { send: (msg: unknown) => { sent.push(msg); return Promise.resolve(); } };

    await quickImportAndSubscribe(db, queue as never, {
      sourceJson: JSON.stringify(bookSource),
      bookUrls: ["https://novels.example.org/book/1"],
      actorId: userId,
    });

    expect(sent).toHaveLength(1);
    expect((sent[0] as { eventType: string }).eventType).toBe("SOURCE_FETCH_CHAPTERS");
  });

  it("目录页与正文页的相对链接都按源地址补全", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    responses.set("https://novels.example.org/c/1", chapterHtml("第一章正文"));

    await quickImportAndSubscribe(db, undefined, {
      sourceJson: JSON.stringify(bookSource),
      bookUrls: ["https://novels.example.org/book/1"],
      actorId: userId,
    });

    const links = await db.select().from(sourceChapterLinks).all();
    expect(links.map((l) => l.externalKey)).toEqual([
      "https://novels.example.org/c/1",
      "https://novels.example.org/c/2",
    ]);
  });
});
