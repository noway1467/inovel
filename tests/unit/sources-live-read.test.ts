import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { R2Bucket } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { contentSources } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createMemoryBucket, createSourceFixtures } from "../helpers/sources-fixtures";
import { getLiveChapter, getLiveToc } from "~/server/sources/live-read";
import { batchImportSources } from "~/server/sources/batch-import";
import { createSource, listSourcesFiltered } from "~/server/sources/service";

/**
 * 「搜到就能读」这条路：目录与正文现抓 + R2 缓存，
 * 不建 books/chapters、不经草稿与发布。
 */

let db: AppDb;
let raw: DatabaseSync;
let bucket: R2Bucket;
let responses: Map<string, string>;
let requestLog: string[];

const userId = "u1";

const bookSource = {
  bookSourceName: "示例源",
  bookSourceUrl: "https://novels.example.org",
  ruleToc: {
    chapterList: "class.listmain@tag.dd",
    chapterName: "tag.a@text",
    chapterUrl: "tag.a@href",
  },
  ruleContent: { content: "id.content@html" },
};

const tocHtml = `<html><body><div class="listmain"><dl>
  <dd><a href="/c/1">第一章 启程</a></dd>
  <dd><a href="/c/2">第二章 抵达</a></dd>
  <dd><a href="/c/3">第三章 归途</a></dd>
</dl></div></body></html>`;

const chapterHtml = `<html><body><div id="content"><p>正文首段</p><p>正文次段</p></div></body></html>`;

beforeEach(async () => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);

  const memory = createMemoryBucket();
  bucket = memory.bucket as unknown as R2Bucket;

  responses = new Map();
  requestLog = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestLog.push(url);
      const body = responses.get(url);
      if (body === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      );
    })
  );

  raw.prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)").run(userId, "运营", "op@example.org");
  await batchImportSources(db, { text: JSON.stringify(bookSource), actorId: userId });
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

async function sourceId() {
  const rows = await listSourcesFiltered(db);
  return rows[0]!.id;
}

describe("getLiveToc", () => {
  it("现抓目录，不建 books/chapters", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    const id = await sourceId();

    const toc = await getLiveToc(db, bucket, id, "https://novels.example.org/book/1");
    expect(toc.chapters.map((c) => c.title)).toEqual([
      "第一章 启程",
      "第二章 抵达",
      "第三章 归途",
    ]);
    // 相对地址补全成绝对地址
    expect(toc.chapters[0]?.key).toBe("https://novels.example.org/c/1");
    expect(toc.fromCache).toBe(false);

    // 关键：现抓不落库
    const books = raw.prepare("SELECT COUNT(*) c FROM books").get() as { c: number };
    const chapters = raw.prepare("SELECT COUNT(*) c FROM chapters").get() as { c: number };
    expect(books.c).toBe(0);
    expect(chapters.c).toBe(0);
  });

  it("第二次命中缓存，不再回源", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    const id = await sourceId();

    await getLiveToc(db, bucket, id, "https://novels.example.org/book/1");
    requestLog.length = 0;
    const second = await getLiveToc(db, bucket, id, "https://novels.example.org/book/1");

    expect(second.fromCache).toBe(true);
    expect(second.chapters).toHaveLength(3);
    expect(requestLog).toHaveLength(0);
  });

  it("不同书各自缓存，互不串味", async () => {
    responses.set("https://novels.example.org/book/1", tocHtml);
    responses.set(
      "https://novels.example.org/book/2",
      `<html><body><div class="listmain"><dl><dd><a href="/x/1">另一本第一章</a></dd></dl></div></body></html>`
    );
    const id = await sourceId();

    const first = await getLiveToc(db, bucket, id, "https://novels.example.org/book/1");
    const second = await getLiveToc(db, bucket, id, "https://novels.example.org/book/2");
    expect(first.chapters).toHaveLength(3);
    expect(second.chapters).toHaveLength(1);
    expect(second.chapters[0]?.title).toBe("另一本第一章");
  });

  it("目录顶上的「最新章节」预告块不占前几条", async () => {
    /**
     * 真实形态（35ge.info 斗罗大陆）：同一个 `<dl>` 里先挂 3 条倒序预告，
     * 再是正文目录，两段地址完全重叠。tocList 选择器分不开两段，而按地址
     * 去重是首次出现胜出 —— 不剥离的话目录第 1 条就是全书最后一章，
     * 用户点开书直接被剧透大结局。
     */
    responses.set(
      "https://novels.example.org/book/3",
      `<html><body><div class="listmain"><dl>
        <dt>《示例》最新章节</dt>
        <dd><a href="/c/3">第三章 归途</a></dd>
        <dd><a href="/c/2">第二章 抵达</a></dd>
        <dd><a href="/c/1">第一章 启程</a></dd>
        <dt>《示例》正文</dt>
        <dd><a href="/c/1">第一章 启程</a></dd>
        <dd><a href="/c/2">第二章 抵达</a></dd>
        <dd><a href="/c/3">第三章 归途</a></dd>
      </dl></div></body></html>`
    );
    const id = await sourceId();

    const toc = await getLiveToc(db, bucket, id, "https://novels.example.org/book/3");
    expect(toc.chapters.map((c) => c.title)).toEqual([
      "第一章 启程",
      "第二章 抵达",
      "第三章 归途",
    ]);
    // 预告块的章节仍在，只是不再重复占位
    expect(new Set(toc.chapters.map((c) => c.key)).size).toBe(3);
  });

  it("停用的源拒绝读取", async () => {
    const id = await sourceId();
    await db.update(contentSources).set({ status: "disabled" }).where(eq(contentSources.id, id));
    await expect(
      getLiveToc(db, bucket, id, "https://novels.example.org/book/1")
    ).rejects.toThrow(/未启用/);
  });

  it("源不存在时报错", async () => {
    await expect(getLiveToc(db, bucket, "不存在", "https://x.example.org/b")).rejects.toThrow(
      /源不存在/
    );
  });
});

describe("getLiveChapter", () => {
  it("现抓正文并分段", async () => {
    responses.set("https://novels.example.org/c/1", chapterHtml);
    const id = await sourceId();

    const chapter = await getLiveChapter(db, bucket, id, "https://novels.example.org/c/1");
    expect(chapter.paragraphs).toEqual(["正文首段", "正文次段"]);
    expect(chapter.fromCache).toBe(false);
  });

  it("第二次命中缓存", async () => {
    responses.set("https://novels.example.org/c/1", chapterHtml);
    const id = await sourceId();

    await getLiveChapter(db, bucket, id, "https://novels.example.org/c/1");
    requestLog.length = 0;
    const second = await getLiveChapter(db, bucket, id, "https://novels.example.org/c/1");

    expect(second.fromCache).toBe(true);
    expect(second.paragraphs).toEqual(["正文首段", "正文次段"]);
    expect(requestLog).toHaveLength(0);
  });

  it("抓不到时抛出可读错误", async () => {
    const id = await sourceId();
    await expect(
      getLiveChapter(db, bucket, id, "https://novels.example.org/c/404")
    ).rejects.toThrow();
  });
});

/**
 * 回归：kind="rules" 且 config 为空的源必然在使用时抛
 * 「规则配置不完整」。错误应该发生在创建时，而不是等到搜索。
 */
describe("规则源必须带规则", () => {
  it("手工登记无 config 的规则源被拒绝", async () => {
    await expect(
      createSource(db, {
        name: "空规则源",
        kind: "rules",
        endpoint: "https://empty.example.org",
        actorId: userId,
      })
    ).rejects.toThrow(/规则源需要完整规则/);
  });

  it("规则不全时报错并指出缺哪几项", async () => {
    await expect(
      createSource(db, {
        name: "半个规则源",
        kind: "rules",
        endpoint: "https://half.example.org",
        config: { tocList: "class.a" },
        actorId: userId,
      })
    ).rejects.toThrow(/tocName|tocUrl|contentRule/);
  });

  it("feed 类型不需要 config", async () => {
    await expect(
      createSource(db, {
        name: "订阅源",
        kind: "feed",
        endpoint: "https://feed.example.org/rss",
        actorId: userId,
      })
    ).resolves.toMatchObject({ status: "enabled" });
  });

  it("导入书源产生的规则源规则完整，可正常使用", async () => {
    const id = await sourceId();
    const row = await db.select().from(contentSources).where(eq(contentSources.id, id)).get();
    const config = row?.config as Record<string, unknown>;
    for (const key of ["tocList", "tocName", "tocUrl", "contentRule"]) {
      expect(typeof config[key]).toBe("string");
      expect((config[key] as string).length).toBeGreaterThan(0);
    }
  });
});
