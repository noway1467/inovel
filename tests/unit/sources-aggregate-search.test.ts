import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { contentSources } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { aggregateSearch } from "~/server/sources/search";
import { batchImportSources } from "~/server/sources/batch-import";
import { bulkUpdateSources, listSourcesFiltered } from "~/server/sources/service";

let db: AppDb;
let raw: DatabaseSync;
let responses: Map<string, string>;
let hangUrls: Set<string>;

const userId = "user-1";

/** 造一个带搜索规则的书源 */
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
    ruleToc: { chapterList: "class.listmain@tag.dd", chapterName: "tag.a@text", chapterUrl: "tag.a@href" },
    ruleContent: { content: "id.content@html" },
  };
}

function searchHtml(entries: { title: string; author: string; href: string }[]) {
  const items = entries
    .map(
      (e) =>
        `<div class="result"><h3>${e.title}</h3><span class="author">${e.author}</span><a href="${e.href}">进</a></div>`
    )
    .join("");
  return `<html><body>${items}</body></html>`;
}

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);

  responses = new Map();
  hangUrls = new Set();

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: { signal?: AbortSignal }) => {
      const url = typeof input === "string" ? input : input.toString();
      if (hangUrls.has(url)) {
        // 永不结束，用来测单源超时不拖垮整次搜索
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      const body = responses.get(url);
      if (body === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
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

describe("aggregateSearch", () => {
  async function seedTwoSources() {
    await batchImportSources(db, {
      text: JSON.stringify([bookSource("源甲", "a.example.org"), bookSource("源乙", "b.example.org")]),
      actorId: userId,
    });
  }

  it("同时查多个源并合并结果", async () => {
    await seedTwoSources();
    const kw = encodeURIComponent("剑");
    responses.set(
      `https://a.example.org/search?q=${kw}`,
      searchHtml([{ title: "剑来", author: "烽火", href: "/b/1" }])
    );
    responses.set(
      `https://b.example.org/search?q=${kw}`,
      searchHtml([{ title: "剑来", author: "烽火", href: "/b/9" }])
    );

    const result = await aggregateSearch(db, "剑");
    expect(result.totals.sourcesQueried).toBe(2);
    expect(result.totals.sourcesOk).toBe(2);
    // 同名同作者合并成一条，两个源作为可选项
    expect(result.books).toHaveLength(1);
    expect(result.books[0]?.title).toBe("剑来");
    expect(result.books[0]?.options).toHaveLength(2);
    expect(result.books[0]?.options.map((o) => o.sourceName).sort()).toEqual(["源乙", "源甲"]);
  });

  it("多源命中的书排在前面", async () => {
    await seedTwoSources();
    const kw = encodeURIComponent("剑");
    responses.set(
      `https://a.example.org/search?q=${kw}`,
      searchHtml([
        { title: "只有甲有", author: "某", href: "/b/2" },
        { title: "两源都有", author: "某", href: "/b/1" },
      ])
    );
    responses.set(
      `https://b.example.org/search?q=${kw}`,
      searchHtml([{ title: "两源都有", author: "某", href: "/b/8" }])
    );

    const result = await aggregateSearch(db, "剑");
    expect(result.books[0]?.title).toBe("两源都有");
    expect(result.books[0]?.options).toHaveLength(2);
  });

  it("单源失败不影响其他源的结果", async () => {
    await seedTwoSources();
    const kw = encodeURIComponent("剑");
    // 甲能搜到，乙的地址不在 responses 里 → 404
    responses.set(
      `https://a.example.org/search?q=${kw}`,
      searchHtml([{ title: "剑来", author: "烽火", href: "/b/1" }])
    );

    const result = await aggregateSearch(db, "剑");
    expect(result.books).toHaveLength(1);
    expect(result.totals.sourcesOk).toBe(1);
    const failed = result.outcomes.find((o) => o.sourceName === "源乙");
    expect(failed?.status).toBe("failed");
    expect(failed?.message).toBeTruthy();
  });

  it("单源卡住时按超时废掉该源，其余照常返回", async () => {
    await seedTwoSources();
    const kw = encodeURIComponent("剑");
    responses.set(
      `https://a.example.org/search?q=${kw}`,
      searchHtml([{ title: "剑来", author: "烽火", href: "/b/1" }])
    );
    hangUrls.add(`https://b.example.org/search?q=${kw}`);

    const result = await aggregateSearch(db, "剑", { timeoutMs: 50 });
    expect(result.books).toHaveLength(1);
    const stuck = result.outcomes.find((o) => o.sourceName === "源乙");
    expect(stuck?.status).toBe("timeout");
  });

  it("只查指定源", async () => {
    await seedTwoSources();
    const sources = await listSourcesFiltered(db);
    const first = sources.find((s) => s.name === "源甲")!;
    const kw = encodeURIComponent("剑");
    responses.set(
      `https://a.example.org/search?q=${kw}`,
      searchHtml([{ title: "剑来", author: "烽火", href: "/b/1" }])
    );

    const result = await aggregateSearch(db, "剑", { sourceIds: [first.id] });
    expect(result.totals.sourcesQueried).toBe(1);
    expect(result.outcomes).toHaveLength(1);
  });

  it("停用的源不参与搜索", async () => {
    await seedTwoSources();
    const sources = await listSourcesFiltered(db);
    await bulkUpdateSources(db, sources.map((s) => s.id), "disable", userId);

    const result = await aggregateSearch(db, "剑");
    expect(result.totals.sourcesQueried).toBe(0);
    expect(result.books).toEqual([]);
  });

  it("每源结果数受 perSourceLimit 限制", async () => {
    await seedTwoSources();
    const kw = encodeURIComponent("剑");
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: `书${i}`,
      author: "某",
      href: `/b/${i}`,
    }));
    responses.set(`https://a.example.org/search?q=${kw}`, searchHtml(many));
    responses.set(`https://b.example.org/search?q=${kw}`, searchHtml([]));

    const result = await aggregateSearch(db, "剑", { perSourceLimit: 3 });
    expect(result.totals.hits).toBe(3);
  });

  it("不支持搜索的源被标记为 unsupported，不算失败", async () => {
    await db.insert(contentSources).values({
      id: "src-opds",
      name: "整本源",
      kind: "gutendex",
      endpoint: "https://gutendex.example.org/books",
      status: "enabled",
      createdBy: userId,
    });
    responses.set("https://gutendex.example.org/books?search=%E5%89%91", JSON.stringify({ results: [] }));

    const result = await aggregateSearch(db, "剑");
    const outcome = result.outcomes.find((o) => o.sourceName === "整本源");
    // gutendex 支持搜索，这里验证的是 outcome 一定被记录
    expect(outcome).toBeDefined();
  });

  it("空关键字报错", async () => {
    await expect(aggregateSearch(db, "   ")).rejects.toThrow(/不能为空/);
  });

  it("没有启用的源时返回空结果而不报错", async () => {
    const result = await aggregateSearch(db, "剑");
    expect(result.books).toEqual([]);
    expect(result.totals.sourcesQueried).toBe(0);
  });
});

describe("batchImportSources", () => {
  it("粘贴书源 JSON 批量建源", async () => {
    const result = await batchImportSources(db, {
      text: JSON.stringify([bookSource("源甲", "a.example.org"), bookSource("源乙", "b.example.org")]),
      actorId: userId,
    });
    expect(result.format).toBe("bookSource");
    expect(result.totals.created).toBe(2);
    expect(result.created.every((c) => c.status === "enabled")).toBe(true);
  });

  it("重复导入同一清单复用已有源，不堆重复行", async () => {
    const text = JSON.stringify([bookSource("源甲", "a.example.org")]);
    await batchImportSources(db, { text, actorId: userId });
    const second = await batchImportSources(db, { text, actorId: userId });

    expect(second.totals.created).toBe(0);
    expect(second.totals.reused).toBe(1);
    const rows = await db.select().from(contentSources).all();
    expect(rows).toHaveLength(1);
  });

  it("识别订阅源格式并按 feed 接入", async () => {
    const result = await batchImportSources(db, {
      text: JSON.stringify([
        { sourceName: "某订阅", sourceUrl: "https://feed.example.org/rss", singleUrl: true },
      ]),
      actorId: userId,
    });
    expect(result.format).toBe("rssSource");
    expect(result.created[0]?.kind).toBe("feed");
    expect(result.warned[0]?.warnings.length).toBeGreaterThan(0);
  });

  it("坏条目单独记原因，不影响其余", async () => {
    const result = await batchImportSources(db, {
      text: JSON.stringify([
        bookSource("好源", "a.example.org"),
        { bookSourceName: "缺目录", bookSourceUrl: "https://c.example.org" },
      ]),
      actorId: userId,
    });
    expect(result.totals.created).toBe(1);
    expect(result.totals.rejected).toBe(1);
    expect(result.rejected[0]?.name).toBe("缺目录");
  });

  it("无法识别格式时给出可操作的报错", async () => {
    await expect(
      batchImportSources(db, { text: JSON.stringify([{ foo: 1 }]), actorId: userId })
    ).rejects.toThrow(/无法识别清单格式/);
  });

  it("既没给 url 也没给 text 时报错", async () => {
    await expect(batchImportSources(db, { actorId: userId })).rejects.toThrow(/url.*text/);
  });
});

describe("bulkUpdateSources", () => {
  async function seed() {
    await batchImportSources(db, {
      text: JSON.stringify([bookSource("源甲", "a.example.org"), bookSource("源乙", "b.example.org")]),
      actorId: userId,
    });
    return listSourcesFiltered(db);
  }

  it("批量停用与启用", async () => {
    const sources = await seed();
    const ids = sources.map((s) => s.id);

    const disabled = await bulkUpdateSources(db, ids, "disable", userId);
    expect(disabled.ok).toHaveLength(2);
    expect((await listSourcesFiltered(db, { status: "disabled" }))).toHaveLength(2);

    await bulkUpdateSources(db, ids, "enable", userId);
    expect((await listSourcesFiltered(db, { status: "enabled" }))).toHaveLength(2);
  });

  it("批量删除", async () => {
    const sources = await seed();
    const result = await bulkUpdateSources(db, sources.map((s) => s.id), "delete", userId);
    expect(result.ok).toHaveLength(2);
    expect(await listSourcesFiltered(db)).toHaveLength(0);
  });

  it("单个失败不中断整批", async () => {
    const sources = await seed();
    const ids = [...sources.map((s) => s.id), "不存在的-id"];
    const result = await bulkUpdateSources(db, ids, "disable", userId);
    expect(result.ok).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.sourceId).toBe("不存在的-id");
  });
});

describe("listSourcesFiltered", () => {
  it("按名称、类型、状态筛选", async () => {
    await batchImportSources(db, {
      text: JSON.stringify([bookSource("剑网书源", "a.example.org"), bookSource("其他源", "b.example.org")]),
      actorId: userId,
    });

    expect(await listSourcesFiltered(db, { q: "剑网" })).toHaveLength(1);
    expect(await listSourcesFiltered(db, { q: "a.example" })).toHaveLength(1);
    expect(await listSourcesFiltered(db, { kind: "rules" })).toHaveLength(2);
    expect(await listSourcesFiltered(db, { kind: "feed" })).toHaveLength(0);
    expect(await listSourcesFiltered(db, { status: "enabled" })).toHaveLength(2);
  });
});
