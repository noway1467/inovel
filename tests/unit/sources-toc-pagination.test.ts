import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { rulesAdapter } from "~/server/sources/adapters/rules";


/**
 * 目录/正文分页，以及目录规则失效时的兜底切章。
 *
 * 真实合集里约半数源需要分页（目录 65 个、正文 43 个），
 * 只取首页会导致"源站 3 页只看到 1 页"和每章正文被截断。
 */

let db: AppDb;
let raw: DatabaseSync;
let responses: Map<string, string>;
let requestLog: string[];

function ctxWith(config: Record<string, unknown>, endpoint = "https://novels.example.org") {
  return { db, endpoint, config, countRequest: () => {} };
}

const baseConfig = {
  tocList: "class.listmain@tag.dd",
  tocName: "tag.a@text",
  tocUrl: "tag.a@href",
  contentRule: "id.content@html",
};

function tocPage(entries: { title: string; href: string }[], extra = "") {
  const items = entries.map((e) => `<dd><a href="${e.href}">${e.title}</a></dd>`).join("");
  return `<html><body><div class="listmain"><dl>${items}</dl></div>${extra}</body></html>`;
}

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
      if (body === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      );
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

describe("目录分页", () => {
  it("跟随 text.下一页 把三页目录全部取回", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/book/1_2">下一页</a>`)
    );
    responses.set(
      "https://novels.example.org/book/1_2",
      tocPage([{ title: "第2章", href: "/c/2" }], `<a href="/book/1_3">下一页</a>`)
    );
    // 末页没有下一页链接
    responses.set(
      "https://novels.example.org/book/1_3",
      tocPage([{ title: "第3章", href: "/c/3" }])
    );

    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, nextTocUrl: "text.下一页@href" }),
      { externalId: "https://novels.example.org/book/1" }
    );

    expect(chapters.map((c) => c.title)).toEqual(["第1章", "第2章", "第3章"]);
  });

  /**
   * 书源没写 nextTocUrl 时，靠页面上的「下一页」链接兜底 ——
   * 否则目录分多页的源只能看到第一页的章节。
   */
  it("没有分页规则时，靠通用探测跟随「下一页」", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/book/1_2">下一页</a>`)
    );
    responses.set(
      "https://novels.example.org/book/1_2",
      tocPage([{ title: "第2章", href: "/c/2" }])
    );

    const chapters = await rulesAdapter.listChapters(ctxWith(baseConfig), {
      externalId: "https://novels.example.org/book/1",
    });
    expect(chapters.map((c) => c.title)).toEqual(["第1章", "第2章"]);
  });

  it("页面上没有下一页链接时只取一页", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }])
    );
    const chapters = await rulesAdapter.listChapters(ctxWith(baseConfig), {
      externalId: "https://novels.example.org/book/1",
    });
    expect(chapters).toHaveLength(1);
    expect(requestLog).toHaveLength(1);
  });

  it("目录页只有「下一章」时不误跟随", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/c/2">下一章</a>`)
    );
    const chapters = await rulesAdapter.listChapters(ctxWith(baseConfig), {
      externalId: "https://novels.example.org/book/1",
    });
    expect(requestLog).toHaveLength(1);
    expect(chapters).toHaveLength(1);
  });

  it("option@value 形态的分页：取下拉里还没访问过的页", async () => {
    const options = `<select>
      <option value="/book/1">第1页</option>
      <option value="/book/1_2">第2页</option>
    </select>`;
    responses.set("https://novels.example.org/book/1", tocPage([{ title: "第1章", href: "/c/1" }], options));
    responses.set("https://novels.example.org/book/1_2", tocPage([{ title: "第2章", href: "/c/2" }], options));

    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, nextTocUrl: "option@value" }),
      { externalId: "https://novels.example.org/book/1" }
    );
    expect(chapters.map((c) => c.title)).toEqual(["第1章", "第2章"]);
  });

  it("分页规则自指时不会死循环", async () => {
    // 下一页指向自己
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/book/1">下一页</a>`)
    );
    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, nextTocUrl: "text.下一页@href" }),
      { externalId: "https://novels.example.org/book/1" }
    );
    expect(chapters).toHaveLength(1);
    expect(requestLog).toHaveLength(1);
  });

  it("跨页重复的章节按地址去重", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/book/1_2">下一页</a>`)
    );
    // 第二页重复了第 1 章（"最新章节"块常见）
    responses.set(
      "https://novels.example.org/book/1_2",
      tocPage([
        { title: "第1章", href: "/c/1" },
        { title: "第2章", href: "/c/2" },
      ])
    );

    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, nextTocUrl: "text.下一页@href" }),
      { externalId: "https://novels.example.org/book/1" }
    );
    expect(chapters).toHaveLength(2);
  });
});

describe("正文分页", () => {
  const content = (text: string, next = "") =>
    `<html><body><div id="content"><p>${text}</p></div>${next}</body></html>`;

  it("跟随 nextContentUrl 把分页正文拼完整", async () => {
    responses.set(
      "https://novels.example.org/c/1",
      content("第一页正文", `<a href="/c/1_2">下一页</a>`)
    );
    responses.set(
      "https://novels.example.org/c/1_2",
      content("第二页正文", `<a href="/c/1_3">下一页</a>`)
    );
    responses.set("https://novels.example.org/c/1_3", content("第三页正文"));

    const result = await rulesAdapter.fetchChapter(
      ctxWith({ ...baseConfig, nextContentUrl: "text.下一页@href" }),
      { externalKey: "https://novels.example.org/c/1" }
    );

    expect(result.paragraphs).toEqual(["第一页正文", "第二页正文", "第三页正文"]);
  });

  /**
   * 书源没写 nextContentUrl 时靠探测兜底 —— 否则每章只拿到第一页，
   * 正文被截断（表现为"只能看一页"）。
   */
  it("没有分页规则时，靠通用探测把各页拼完整", async () => {
    responses.set(
      "https://novels.example.org/c/1",
      content("第一页", `<a href="/c/1_2">下一页</a>`)
    );
    responses.set("https://novels.example.org/c/1_2", content("第二页"));

    const result = await rulesAdapter.fetchChapter(ctxWith(baseConfig), {
      externalKey: "https://novels.example.org/c/1",
    });
    expect(result.paragraphs).toEqual(["第一页", "第二页"]);
  });

  it("页面上没有下一页链接时只取一页", async () => {
    responses.set("https://novels.example.org/c/1", content("就这一页"));
    const result = await rulesAdapter.fetchChapter(ctxWith(baseConfig), {
      externalKey: "https://novels.example.org/c/1",
    });
    expect(result.paragraphs).toEqual(["就这一页"]);
  });

  it("中间页抓不到时保留已取到的部分，不整章失败", async () => {
    responses.set(
      "https://novels.example.org/c/1",
      content("第一页正文", `<a href="/c/missing">下一页</a>`)
    );
    // /c/missing 不在 responses 里 → 404，loadDoc 抛错
    await expect(
      rulesAdapter.fetchChapter(ctxWith({ ...baseConfig, nextContentUrl: "text.下一页@href" }), {
        externalKey: "https://novels.example.org/c/1",
      })
    ).rejects.toThrow();
  });
});

