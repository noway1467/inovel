import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { batchImportSources } from "~/server/sources/batch-import";
import { listSourcesFiltered } from "~/server/sources/service";
import { rulesAdapter } from "~/server/sources/adapters/rules";
import { contentSources } from "drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * 书源规则只刮到「最新章节」预告时要改跳目录页。
 *
 * 真实形态：tocList 选择器指向详情页上那块「最新章节」（源站给老读者的
 * 跳转入口，5~12 条倒序），规则「命中了」于是直接返回 —— 整本书只剩最新
 * 几章，第 1 条还是全书大结局。
 *
 * 上一轮修的是探测路径（剥预告段），规则路径压根走不到那儿：规则一有结果
 * 就 return，detectWithTocHop 永远够不着。这组用例锁住规则路径。
 */

let db: AppDb;
let raw: DatabaseSync;
let responses: Map<string, string>;
let requestLog: string[];

const userId = "u1";

/** 详情页：信息栏挂 5 条倒序预告，下面有「全部章节」入口 */
const detailPage = `<html><body>
  <div class="info"><h1>某本书</h1></div>
  <div class="update">
    <span>最新章节</span>
    <ul>
      <li><a href="/c/50.html">第五十章 大结局</a></li>
      <li><a href="/c/49.html">第四十九章 决战</a></li>
      <li><a href="/c/48.html">第四十八章 布局</a></li>
      <li><a href="/c/47.html">第四十七章 密谋</a></li>
      <li><a href="/c/46.html">第四十六章 归来</a></li>
    </ul>
  </div>
  <div class="more"><a href="/book/1/mulu.html">全部章节</a></div>
</body></html>`;

/** 真正的目录页：同样的 `.update ul li a` 结构装着全书 50 章 */
const tocPage = `<html><body>
  <div class="update">
    <ul>
      ${Array.from(
        { length: 50 },
        (_, i) => `<li><a href="/c/${i + 1}.html">第${i + 1}章 章节标题</a></li>`
      ).join("")}
    </ul>
  </div>
</body></html>`;

const source = {
  bookSourceName: "预告块源",
  bookSourceUrl: "https://teaser.example.org",
  ruleToc: {
    // 选择器在详情页上只命中那 5 条预告
    chapterList: "class.update@tag.li",
    chapterName: "tag.a@text",
    chapterUrl: "tag.a@href",
  },
  ruleContent: { content: "id.content@html" },
};

beforeEach(async () => {
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
      if (body === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      );
    })
  );

  raw
    .prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)")
    .run(userId, "运营", "op@example.org");
  await batchImportSources(db, { text: JSON.stringify(source), actorId: userId });
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

async function ctx() {
  const rows = await listSourcesFiltered(db);
  const row = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.id, rows[0]!.id))
    .get();
  return {
    db,
    endpoint: row!.endpoint,
    config: (row!.config as Record<string, unknown>) ?? {},
    countRequest: () => {},
  };
}

describe("规则只刮到预告块时跳目录页", () => {
  it("拿到全书 50 章，而不是最新 5 章", async () => {
    responses.set("https://teaser.example.org/book/1/", detailPage);
    responses.set("https://teaser.example.org/book/1/mulu.html", tocPage);

    const chapters = await rulesAdapter.listChapters(await ctx(), {
      externalId: "https://teaser.example.org/book/1/",
    });

    expect(chapters).toHaveLength(50);
    expect(chapters[0]?.title).toBe("第1章 章节标题");
    expect(chapters.at(-1)?.title).toBe("第50章 章节标题");
  });

  it("第 1 条不是大结局", async () => {
    responses.set("https://teaser.example.org/book/1/", detailPage);
    responses.set("https://teaser.example.org/book/1/mulu.html", tocPage);

    const chapters = await rulesAdapter.listChapters(await ctx(), {
      externalId: "https://teaser.example.org/book/1/",
    });
    expect(chapters[0]?.title).not.toContain("大结局");
  });

  it("跳过去反而更少时保留原结果，不倒退", async () => {
    // 目录页坏了只剩 2 条，此时应保留详情页刮到的 5 条
    responses.set("https://teaser.example.org/book/1/", detailPage);
    responses.set(
      "https://teaser.example.org/book/1/mulu.html",
      `<html><body><div class="update"><ul>
        <li><a href="/c/1.html">第1章 章节标题</a></li>
        <li><a href="/c/2.html">第2章 章节标题</a></li>
      </ul></div></body></html>`
    );

    const chapters = await rulesAdapter.listChapters(await ctx(), {
      externalId: "https://teaser.example.org/book/1/",
    });
    expect(chapters).toHaveLength(5);
  });

  it("规则已经抓到完整目录时不多跳一次", async () => {
    // 详情页本身就是完整目录（50 条），不该再去 /mulu.html
    responses.set("https://teaser.example.org/book/2/", tocPage);

    const chapters = await rulesAdapter.listChapters(await ctx(), {
      externalId: "https://teaser.example.org/book/2/",
    });
    expect(chapters).toHaveLength(50);
    expect(requestLog.filter((url) => url.includes("mulu"))).toHaveLength(0);
  });

  it("页面上没有目录入口时不白发请求", async () => {
    responses.set(
      "https://teaser.example.org/book/3/",
      `<html><body><div class="update"><ul>
        <li><a href="/c/1.html">第1章 短篇</a></li>
        <li><a href="/c/2.html">第2章 短篇</a></li>
        <li><a href="/c/3.html">第3章 短篇</a></li>
      </ul></div></body></html>`
    );

    const chapters = await rulesAdapter.listChapters(await ctx(), {
      externalId: "https://teaser.example.org/book/3/",
    });
    expect(chapters).toHaveLength(3);
    // 只打了详情页那一次
    expect(requestLog).toEqual(["https://teaser.example.org/book/3/"]);
  });
});
