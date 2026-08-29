import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createMemoryBucket, createSourceFixtures } from "../helpers/sources-fixtures";
import { browseExplore } from "~/server/sources/explore-browse";
import { batchImportSources } from "~/server/sources/batch-import";
import { listSourcesFiltered } from "~/server/sources/service";

/**
 * 分类浏览。三件真实故障各有一条用例：
 *  - 标签重复（海棠书屋：两组同名分类被平铺）
 *  - 点标签下面还是标签（源没有 exploreList 规则，兜底探测抓回了标签云）
 *  - 反复进出报 1102（分类页每次都回源重抓 + 重跑探测）
 */

let db: AppDb;
let raw: DatabaseSync;
let bucket: R2Bucket;
let responses: Map<string, string>;
let requestLog: string[];

const userId = "u1";

/** 分类页：顶部是标签云（与本页同形），中间才是书单 */
const categoryPage = `<html><body>
  <div class="tags">
    <a href="/fenlei/1/1/">玄幻小说</a>
    <a href="/fenlei/2/1/">武侠小说</a>
    <a href="/fenlei/3/1/">都市小说</a>
    <a href="/fenlei/4/1/">仙侠小说</a>
    <a href="/fenlei/5/1/">历史小说</a>
    <a href="/fenlei/6/1/">网游小说</a>
    <a href="/fenlei/7/1/">科幻小说</a>
    <a href="/fenlei/8/1/">言情小说</a>
  </div>
  <ul class="booklist">
    <li><a href="/book/1001.html">剑来</a></li>
    <li><a href="/book/1002.html">诡秘之主</a></li>
    <li><a href="/book/1003.html">深空彼岸</a></li>
  </ul>
  <div class="foot"><a href="/">首页</a><a href="/about.html">关于</a></div>
</body></html>`;

beforeEach(async () => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);

  bucket = createMemoryBucket().bucket as unknown as R2Bucket;

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

  raw
    .prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)")
    .run(userId, "运营", "op@example.org");
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

async function importSource(source: Record<string, unknown>) {
  await batchImportSources(db, { text: JSON.stringify(source), actorId: userId });
  const rows = await listSourcesFiltered(db);
  return rows[0]!.id;
}

/** 无 ruleExplore 的源：实测 152 个有分类的源里 54 个是这样 */
const noListRuleSource = {
  bookSourceName: "无书单规则源",
  bookSourceUrl: "https://books.example.org",
  ruleFindUrl: "玄幻小说:: /fenlei/1/{{page}}/\n武侠小说:: /fenlei/2/{{page}}/",
  ruleExplore: {},
  ruleToc: { chapterList: "class.x@tag.a", chapterName: "text", chapterUrl: "href" },
  ruleContent: { content: "id.content@html" },
};

describe("点标签下面还是标签", () => {
  it("没有书单规则时，认出的是书而不是同级标签", async () => {
    responses.set("https://books.example.org/fenlei/1/1/", categoryPage);
    const id = await importSource(noListRuleSource);

    const result = await browseExplore(db, bucket, id, null, 1);
    expect(result.books.map((book) => book.title)).toEqual(["剑来", "诡秘之主", "深空彼岸"]);
    // 标签云里的链接与本页同形，必须一个都不留
    expect(result.books.every((book) => !book.url.includes("/fenlei/"))).toBe(true);
  });
});

describe("标签重复", () => {
  it("两组同名分类各自带分组名，id 不同，点第二个打开的是第二个", async () => {
    // 海棠书屋的真实结构：排行与分类两组，同样 24 个名字，地址不同
    const id = await importSource({
      ...noListRuleSource,
      bookSourceName: "两组同名源",
      ruleFindUrl: JSON.stringify([
        { title: "排行", url: "", style: { layout_flexBasisPercent: 1 } },
        { title: "言情", url: "/top/yq/{{page}}/", style: { layout_flexBasisPercent: 0.25 } },
        { title: "分类", url: "", style: { layout_flexBasisPercent: 1 } },
        { title: "言情", url: "/list/yq/{{page}}/", style: { layout_flexBasisPercent: 0.25 } },
      ]),
    });

    responses.set("https://books.example.org/top/yq/1/", categoryPage);
    responses.set(
      "https://books.example.org/list/yq/1/",
      `<html><body><ul>
        <li><a href="/book/2001.html">分类页的书</a></li>
        <li><a href="/book/2002.html">另一本</a></li>
        <li><a href="/book/2003.html">第三本</a></li>
      </ul></body></html>`
    );

    const first = await browseExplore(db, bucket, id, null, 1);
    expect(first.categories).toMatchObject([
      { title: "言情", group: "排行" },
      { title: "言情", group: "分类" },
    ]);

    // 点第二个「言情」，取到的必须是 /list/ 那一组的书
    const secondId = first.categories[1]!.id;
    const second = await browseExplore(db, bucket, id, secondId, 1);
    expect(second.books.map((book) => book.title)).toEqual([
      "分类页的书",
      "另一本",
      "第三本",
    ]);
  });
});

describe("反复进出不再回源", () => {
  it("第二次浏览同一分类命中缓存，不发请求", async () => {
    responses.set("https://books.example.org/fenlei/1/1/", categoryPage);
    const id = await importSource(noListRuleSource);

    const first = await browseExplore(db, bucket, id, null, 1);
    expect(first.fromCache).toBe(false);
    expect(first.books).toHaveLength(3);

    requestLog.length = 0;
    const second = await browseExplore(db, bucket, id, null, 1);
    expect(second.fromCache).toBe(true);
    expect(second.books).toHaveLength(3);
    expect(requestLog).toHaveLength(0);
  });

  it("不同分类各自缓存，互不串味", async () => {
    responses.set("https://books.example.org/fenlei/1/1/", categoryPage);
    responses.set(
      "https://books.example.org/fenlei/2/1/",
      `<html><body><ul>
        <li><a href="/book/3001.html">武侠一</a></li>
        <li><a href="/book/3002.html">武侠二</a></li>
      </ul></body></html>`
    );
    const id = await importSource(noListRuleSource);
    const listed = await browseExplore(db, bucket, id, null, 1);

    const wuxia = listed.categories.find((item) => item.title === "武侠小说")!;
    const second = await browseExplore(db, bucket, id, wuxia.id, 1);
    expect(second.books.map((book) => book.title)).toEqual(["武侠一", "武侠二"]);

    // 第一个分类的缓存没被覆盖
    const again = await browseExplore(db, bucket, id, null, 1);
    expect(again.books.map((book) => book.title)).toEqual(["剑来", "诡秘之主", "深空彼岸"]);
  });

  it("空结果不写缓存 —— 别把源站抽风钉住半小时", async () => {
    responses.set("https://books.example.org/fenlei/1/1/", `<html><body><p>暂无数据</p></body></html>`);
    const id = await importSource(noListRuleSource);

    const first = await browseExplore(db, bucket, id, null, 1);
    expect(first.books).toHaveLength(0);

    // 源站恢复后立刻能取到，不用等缓存过期
    responses.set("https://books.example.org/fenlei/1/1/", categoryPage);
    const second = await browseExplore(db, bucket, id, null, 1);
    expect(second.fromCache).toBe(false);
    expect(second.books).toHaveLength(3);
  });

  it("老链接里带的是分类标题，仍然打得开", async () => {
    responses.set("https://books.example.org/fenlei/2/1/", categoryPage);
    const id = await importSource(noListRuleSource);

    const result = await browseExplore(db, bucket, id, "武侠小说", 1);
    expect(result.category).toBe("武侠小说");
    expect(result.books).toHaveLength(3);
  });
});
