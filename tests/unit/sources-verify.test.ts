import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { contentSources } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { batchImportSources } from "~/server/sources/batch-import";
import { listSourcesFiltered } from "~/server/sources/service";
import {
  aggregateSearch,
  keywordRelevance,
  matchesKeyword,
  preciseRelevance,
} from "~/server/sources/search";
import {
  getVerifyOverview,
  maxVerifyPerRun,
  purgeFailedSources,
  verifySources,
} from "~/server/sources/verify";

let db: AppDb;
let raw: DatabaseSync;
let responses: Map<string, string>;
/** 抓取延迟，用于观察并发；0 表示立即返回 */
let fetchLatencyMs: number;
/** 同时在飞的请求数峰值，用于断言验证是并发跑的 */
let peakInFlight: number;

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
  fetchLatencyMs = 0;
  peakInFlight = 0;
  let inFlight = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        if (fetchLatencyMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, fetchLatencyMs));
        }
        const body = responses.get(url);
        if (body === undefined) return new Response("nope", { status: 404 });
        return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
      } finally {
        inFlight -= 1;
      }
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

describe("keywordRelevance", () => {
  it("书名完全一致给最高分", () => {
    expect(keywordRelevance({ title: "剑来" }, "剑来")).toBe(4);
    // 标点与空白不影响"完全一致"的判定
    expect(keywordRelevance({ title: "《剑来》" }, "剑来")).toBe(4);
  });

  it("按精确程度递减：开头 > 包含 > 仅作者命中", () => {
    const startsWith = keywordRelevance({ title: "剑来传" }, "剑来");
    const contains = keywordRelevance({ title: "长夜之剑来了" }, "剑来");
    const authorOnly = keywordRelevance({ title: "无关书名", author: "剑来" }, "剑来");
    expect(startsWith).toBeGreaterThan(contains);
    expect(contains).toBeGreaterThan(authorOnly);
    expect(authorOnly).toBeGreaterThan(0);
  });

  it("不相关的给 0，matchesKeyword 据此剔除", () => {
    expect(keywordRelevance({ title: "都市之最强兵王" }, "剑来")).toBe(0);
    expect(matchesKeyword({ title: "都市之最强兵王" }, "剑来")).toBe(false);
  });

  it("精准命中的分档不低于 preciseRelevance", () => {
    // 客户端用这个门槛判断"要搜的书找到了，可以停"
    expect(keywordRelevance({ title: "剑来" }, "剑来")).toBeGreaterThanOrEqual(preciseRelevance);
    expect(keywordRelevance({ title: "剑来传" }, "剑来")).toBeGreaterThanOrEqual(preciseRelevance);
    // 只有作者碰巧命中的不该算精准，否则会过早停手
    expect(keywordRelevance({ title: "无关书名", author: "剑来" }, "剑来")).toBeLessThan(
      preciseRelevance
    );
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

  /**
   * 搜索能力被降级掉的源判为 skipped，而不是 failed。
   *
   * 规则适配器的 search 总是存在，对没有 searchUrl 的源会抛错 —— 此前这
   * 一抛就被判 failed，接着被「清理不可用的源」删掉。可这类源用详情页
   * 地址订阅完全能读，删掉是误伤，合集里是 48/244 的规模。
   */
  it("搜索需 JS 求值的源判为 skipped 而非 failed，不下结论", async () => {
    await batchImportSources(db, {
      text: JSON.stringify({
        ...bookSource("搜索需JS", "js.example.org"),
        // 搜索地址含 JS 调用 → 导入时被降级丢掉
        searchUrl: "{{java.ajax(source.getKey())}}/s?q={{key}}",
      }),
      actorId: userId,
    });

    const result = await verifySources(db, { delayMs: 0 });
    expect(result.totals.failed).toBe(0);
    expect(result.totals.skipped).toBe(1);
    expect(result.outcomes[0]?.status).toBe("skipped");
    expect(result.outcomes[0]?.message).toMatch(/无法自动验证/);

    const rows = await db.select().from(contentSources).all();
    expect(rows[0]?.verifyStatus).toBe("skipped");
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
    const list = Array.from(
      { length: maxVerifyPerRun + 4 },
      (_, i) => bookSource(`源${i}`, `v${i}.example.org`)
    );
    await batchImportSources(db, { text: JSON.stringify(list), actorId: userId });

    const result = await verifySources(db, { delayMs: 0 });
    // 上限跟着实现走，别在测试里写死数字
    expect(result.totals.checked).toBeLessThanOrEqual(maxVerifyPerRun);
    // 还有未测的源
    expect(result.totals.remaining).toBeGreaterThan(0);
  });

  it("多个源并发验证，不是一个个串着等", async () => {
    // 不同源是不同站点，礼貌延迟只对同站有意义；串行会让两百多个源跑十几分钟
    const list = Array.from({ length: 6 }, (_, i) => bookSource(`并发源${i}`, `p${i}.example.org`));
    await batchImportSources(db, { text: JSON.stringify(list), actorId: userId });
    const kw = encodeURIComponent("第一");
    for (let i = 0; i < 6; i++) {
      responses.set(
        `https://p${i}.example.org/search?q=${kw}`,
        searchHtml([{ title: "第一本书", href: "/b/1" }])
      );
      responses.set(`https://p${i}.example.org/b/1`, tocHtml(3));
    }
    fetchLatencyMs = 30;

    const result = await verifySources(db, { delayMs: 0 });

    expect(result.totals.checked).toBeGreaterThan(1);
    // 峰值并发 > 1 就说明没有退回串行
    expect(peakInFlight).toBeGreaterThan(1);
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

  /**
   * skipped 的源不能被清理掉。
   *
   * 这类源（搜索地址需 JS 求值）没法自动跑「搜索 → 取目录」，但用详情页
   * 地址订阅照样能读。此前它们在验证时会因 search 抛错被判 failed，
   * 一按「清理不可用的源」就全被删了 —— 合集里这是 48/244 的规模。
   */
  it("无法自动验证（skipped）的源不被清理", async () => {
    await batchImportSources(db, {
      text: JSON.stringify([
        bookSource("坏源", "bad.example.org"),
        bookSource("待人工", "manual.example.org"),
      ]),
      actorId: userId,
    });
    const sources = await listSourcesFiltered(db);
    const bad = sources.find((s) => s.name === "坏源")!;
    const manual = sources.find((s) => s.name === "待人工")!;

    await db
      .update(contentSources)
      .set({ verifyStatus: "failed" })
      .where(eq(contentSources.id, bad.id));
    await db
      .update(contentSources)
      .set({ verifyStatus: "skipped" })
      .where(eq(contentSources.id, manual.id));

    expect((await purgeFailedSources(db)).deleted).toBe(1);
    expect((await listSourcesFiltered(db)).map((s) => s.name)).toEqual(["待人工"]);
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
