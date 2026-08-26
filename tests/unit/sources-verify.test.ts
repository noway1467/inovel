import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { contentSources } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { batchImportSources } from "~/server/sources/batch-import";
import { listSourcesFiltered } from "~/server/sources/service";
import { aggregateSearch, matchesKeyword } from "~/server/sources/search";
import { getVerifyOverview, purgeFailedSources, verifySources } from "~/server/sources/verify";

let db: AppDb;
let raw: DatabaseSync;
let responses: Map<string, string>;

const userId = "u1";

function bookSource(name: string, host: string) {
  return {
    bookSourceName: name,
    bookSourceUrl: `https://${host}`,
    searchUrl: `https://${host}/search?q={{key}}`,
    ruleSearch: {
      bookList: "class.result",
      name: "tag.h3@text",
      author: "class.author@text",
      bookUrl: "tag.a@href",
    },
    ruleToc: {
      chapterList: "class.listmain@tag.dd",
      chapterName: "tag.a@text",
      chapterUrl: "tag.a@href",
    },
    ruleContent: { content: "id.content@html" },
  };
}

function searchHtml(entries: { title: string; author?: string; href: string }[]) {
  return `<html><body>${entries
    .map(
      (e) =>
        `<div class="result"><h3>${e.title}</h3><span class="author">${e.author ?? ""}</span><a href="${e.href}">进</a></div>`
    )
    .join("")}</body></html>`;
}

function tocHtml(count: number) {
  const items = Array.from(
    { length: count },
    (_, i) => `<dd><a href="/c/${i + 1}">第${i + 1}章</a></dd>`
  ).join("");
  return `<html><body><div class="listmain"><dl>${items}</dl></div></body></html>`;
}

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);

  responses = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = responses.get(url);
      if (body === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      );
    })
  );
  raw.prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)").run(userId, "运营", "op@e.org");
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

describe("matchesKeyword", () => {
  it("书名或作者包含关键字时通过", () => {
    expect(matchesKeyword({ title: "剑来" }, "剑来")).toBe(true);
    expect(matchesKeyword({ title: "长夜余火" }, "余火")).toBe(true);
    expect(matchesKeyword({ title: "某本书", author: "烽火戏诸侯" }, "烽火")).toBe(true);
  });

  it("完全无关的结果被剔除", () => {
    expect(matchesKeyword({ title: "都市之最强兵王" }, "剑来")).toBe(false);
    expect(matchesKeyword({ title: "热门推荐榜" }, "剑来")).toBe(false);
  });

  it("忽略空白与标点差异", () => {
    expect(matchesKeyword({ title: "剑 来" }, "剑来")).toBe(true);
    expect(matchesKeyword({ title: "《剑来》" }, "剑来")).toBe(true);
    expect(matchesKeyword({ title: "剑来（精校版）" }, "剑来")).toBe(true);
  });

  it("英文大小写不敏感", () => {
    expect(matchesKeyword({ title: "The Hobbit" }, "hobbit")).toBe(true);
  });

  it("空格分词后逐词命中也算匹配", () => {
    expect(matchesKeyword({ title: "剑来传奇" }, "剑 传奇")).toBe(true);
  });

  it("空关键字放行，不误杀", () => {
    expect(matchesKeyword({ title: "任意书" }, "")).toBe(true);
    expect(matchesKeyword({ title: "任意书" }, "   ")).toBe(true);
  });
});

describe("搜索精确匹配", () => {
  it("源回吐热门榜时，无关结果被过滤掉", async () => {
    await batchImportSources(db, {
      text: JSON.stringify(bookSource("不做匹配的源", "loose.example.org")),
      actorId: userId,
    });
    const kw = encodeURIComponent("剑来");
    // 典型的坏源行为：不管搜什么都返回一整页热门
    responses.set(
      `https://loose.example.org/search?q=${kw}`,
      searchHtml([
        { title: "剑来", href: "/b/1" },
        { title: "都市之最强兵王", href: "/b/2" },
        { title: "总裁的替身新娘", href: "/b/3" },
        { title: "热门推荐", href: "/b/4" },
      ])
    );

    const result = await aggregateSearch(db, "剑来");
    expect(result.books).toHaveLength(1);
    expect(result.books[0]?.title).toBe("剑来");
  });

  it("全部无关时记下原因，便于分辨坏源", async () => {
    await batchImportSources(db, {
      text: JSON.stringify(bookSource("答非所问的源", "noise.example.org")),
      actorId: userId,
    });
    const kw = encodeURIComponent("剑来");
    responses.set(
      `https://noise.example.org/search?q=${kw}`,
      searchHtml([
        { title: "都市之最强兵王", href: "/b/2" },
        { title: "总裁的替身新娘", href: "/b/3" },
      ])
    );

    const result = await aggregateSearch(db, "剑来");
    expect(result.books).toHaveLength(0);
    expect(result.outcomes[0]?.message).toMatch(/与关键字无关/);
  });
});

describe("verifySources", () => {
  it("能搜到且能取目录的源判为可用", async () => {
    await batchImportSources(db, {
      text: JSON.stringify(bookSource("好源", "good.example.org")),
      actorId: userId,
    });
    const kw = encodeURIComponent("第一");
    responses.set(
      `https://good.example.org/search?q=${kw}`,
      searchHtml([{ title: "第一序列", href: "/b/1" }])
    );
    responses.set("https://good.example.org/b/1", tocHtml(20));

    const result = await verifySources(db, { delayMs: 0 });
    expect(result.totals.ok).toBe(1);
    expect(result.outcomes[0]?.status).toBe("ok");
    expect(result.outcomes[0]?.tocChapters).toBe(20);

    const rows = await db.select().from(contentSources).all();
    expect(rows[0]?.verifyStatus).toBe("ok");
    expect(rows[0]?.verifyTocChapters).toBe(20);
    expect(rows[0]?.verifiedAt).toBeTruthy();
  });

  it("搜不到的源判为不可用", async () => {
    await batchImportSources(db, {
      text: JSON.stringify(bookSource("搜不到", "empty.example.org")),
      actorId: userId,
    });
    // 搜索地址不在 responses 里 → 404
    const result = await verifySources(db, { delayMs: 0 });
    expect(result.totals.failed).toBe(1);
    expect(result.outcomes[0]?.message).toMatch(/搜索失败/);
  });

  it("能搜到但取不到目录的源判为不可用，并说明卡在哪一步", async () => {
    await batchImportSources(db, {
      text: JSON.stringify(bookSource("半坏源", "half.example.org")),
      actorId: userId,
    });
    const kw = encodeURIComponent("第一");
    responses.set(
      `https://half.example.org/search?q=${kw}`,
      searchHtml([{ title: "第一序列", href: "/b/1" }])
    );
    // 详情页 404

    const result = await verifySources(db, { delayMs: 0 });
    expect(result.totals.failed).toBe(1);
    // 区分"压根搜不到"和"能搜不能读"，排查时需要
    expect(result.outcomes[0]?.message).toMatch(/能搜到书但取目录失败/);
    expect(result.outcomes[0]?.searchHits).toBe(1);
  });

  it("源返回一堆无关结果时也判为不可用", async () => {
    await batchImportSources(db, {
      text: JSON.stringify(bookSource("答非所问", "noise2.example.org")),
      actorId: userId,
    });
    const kw = encodeURIComponent("第一");
    responses.set(
      `https://noise2.example.org/search?q=${kw}`,
      searchHtml([{ title: "毫无关系的书", href: "/b/9" }])
    );

    const result = await verifySources(db, { delayMs: 0 });
    expect(result.totals.failed).toBe(1);
    expect(result.outcomes[0]?.message).toMatch(/均与关键字无关/);
  });

  it("单次验证的源数有上限", async () => {
    const list = Array.from({ length: 12 }, (_, i) => bookSource(`源${i}`, `v${i}.example.org`));
    await batchImportSources(db, { text: JSON.stringify(list), actorId: userId });

    const result = await verifySources(db, { delayMs: 0 });
    expect(result.totals.checked).toBeLessThanOrEqual(5);
    // 还有未测的源
    expect(result.totals.remaining).toBeGreaterThan(0);
  });

  it("分批推进能把所有源验完", async () => {
    const list = Array.from({ length: 12 }, (_, i) => bookSource(`源${i}`, `w${i}.example.org`));
    await batchImportSources(db, { text: JSON.stringify(list), actorId: userId });

    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 10) break;
      const result = await verifySources(db, { delayMs: 0 });
      if (result.totals.checked === 0 || result.totals.remaining === 0) break;
    }

    const untested = await listSourcesFiltered(db, { verifyStatus: "untested" });
    expect(untested).toHaveLength(0);
  });

  it("只验指定的源", async () => {
    await batchImportSources(db, {
      text: JSON.stringify([
        bookSource("甲", "a.example.org"),
        bookSource("乙", "b.example.org"),
      ]),
      actorId: userId,
    });
    const sources = await listSourcesFiltered(db);
    const target = sources.find((s) => s.name === "甲")!;

    const result = await verifySources(db, { sourceIds: [target.id], delayMs: 0 });
    expect(result.totals.checked).toBe(1);
    expect(result.outcomes[0]?.sourceName).toBe("甲");
  });
});

describe("purgeFailedSources", () => {
  it("只删验证失败的源，可用与未测的保留", async () => {
    await batchImportSources(db, {
      text: JSON.stringify([
        bookSource("好源", "keep.example.org"),
        bookSource("坏源", "drop.example.org"),
        bookSource("未测", "untested.example.org"),
      ]),
      actorId: userId,
    });
    const sources = await listSourcesFiltered(db);
    const good = sources.find((s) => s.name === "好源")!;
    const bad = sources.find((s) => s.name === "坏源")!;

    await db
      .update(contentSources)
      .set({ verifyStatus: "ok" })
      .where(eq(contentSources.id, good.id));
    await db
      .update(contentSources)
      .set({ verifyStatus: "failed" })
      .where(eq(contentSources.id, bad.id));

    const result = await purgeFailedSources(db);
    expect(result.deleted).toBe(1);

    const left = await listSourcesFiltered(db);
    expect(left.map((s) => s.name).sort()).toEqual(["好源", "未测"]);
  });

  it("没有失败源时返回 0，不误删", async () => {
    await batchImportSources(db, {
      text: JSON.stringify(bookSource("好源", "only.example.org")),
      actorId: userId,
    });
    expect((await purgeFailedSources(db)).deleted).toBe(0);
    expect(await listSourcesFiltered(db)).toHaveLength(1);
  });
});

describe("getVerifyOverview", () => {
  it("按验证结果分类计数", async () => {
    await batchImportSources(db, {
      text: JSON.stringify([
        bookSource("甲", "o1.example.org"),
        bookSource("乙", "o2.example.org"),
        bookSource("丙", "o3.example.org"),
      ]),
      actorId: userId,
    });
    const sources = await listSourcesFiltered(db);
    await db
      .update(contentSources)
      .set({ verifyStatus: "ok" })
      .where(eq(contentSources.id, sources[0]!.id));
    await db
      .update(contentSources)
      .set({ verifyStatus: "failed" })
      .where(eq(contentSources.id, sources[1]!.id));

    const overview = await getVerifyOverview(db);
    expect(overview.ok).toBe(1);
    expect(overview.failed).toBe(1);
    expect(overview.untested).toBe(1);
  });
});
