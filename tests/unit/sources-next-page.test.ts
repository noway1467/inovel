import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { parseHtml } from "~/server/sources/html";
import { detectNextPageUrl } from "~/server/sources/toc-detect";
import { rulesAdapter } from "~/server/sources/adapters/rules";

/**
 * 「下一页」通用探测：书源没写 nextContentUrl、或那条规则要 JS 求值时的兜底。
 * 没有它，这类源每章只能拿到第一页，正文被截断。
 */

const base = "https://novels.example.org/c/1.html";

describe("detectNextPageUrl", () => {
  it("认出「下一页」链接", () => {
    const html = `<div><a href="/c/1_2.html">下一页</a></div>`;
    expect(detectNextPageUrl(parseHtml(html), base)).toBe(
      "https://novels.example.org/c/1_2.html"
    );
  });

  it("认出「下页」「下一頁」等写法", () => {
    expect(detectNextPageUrl(parseHtml(`<a href="/x_2.html">下页</a>`), base)).toBe(
      "https://novels.example.org/x_2.html"
    );
    expect(detectNextPageUrl(parseHtml(`<a href="/y_2.html">下一頁</a>`), base)).toBe(
      "https://novels.example.org/y_2.html"
    );
  });

  it("认出英文 next page", () => {
    expect(detectNextPageUrl(parseHtml(`<a href="/p2">Next Page</a>`), base)).toBe(
      "https://novels.example.org/p2"
    );
  });

  /**
   * 关键区分：「下一章」是章节边界，误当成「下一页」会把两章正文
   * 拼成一章，读起来就是章节错乱。
   */
  it("绝不把「下一章」当成下一页", () => {
    const html = `<div><a href="/c/2.html">下一章</a></div>`;
    expect(detectNextPageUrl(parseHtml(html), base)).toBeNull();
  });

  it("同时有下一页与下一章时只取下一页", () => {
    const html = `<div>
      <a href="/c/2.html">下一章</a>
      <a href="/c/1_2.html">下一页</a>
    </div>`;
    expect(detectNextPageUrl(parseHtml(html), base)).toBe(
      "https://novels.example.org/c/1_2.html"
    );
  });

  it("没有分页链接时返回 null", () => {
    expect(detectNextPageUrl(parseHtml(`<div><a href="/">首页</a></div>`), base)).toBeNull();
    expect(detectNextPageUrl(parseHtml(""), base)).toBeNull();
  });

  it("跳过锚点与 javascript 链接", () => {
    const html = `<a href="#next">下一页</a><a href="javascript:next()">下一页</a>`;
    expect(detectNextPageUrl(parseHtml(html), base)).toBeNull();
  });

  it("指向自身的链接不算下一页（防死循环）", () => {
    const html = `<a href="/c/1.html">下一页</a>`;
    expect(detectNextPageUrl(parseHtml(html), base)).toBeNull();
  });
});

describe("正文分页：规则缺失时用通用探测兜底", () => {
  let db: AppDb;
  let raw: DatabaseSync;
  let responses: Map<string, string>;

  const config = {
    tocList: "class.listmain@tag.dd",
    tocName: "tag.a@text",
    tocUrl: "tag.a@href",
    contentRule: "id.content@html",
  };

  const page = (text: string, extra = "") =>
    `<html><body><div id="content"><p>${text}</p></div>${extra}</body></html>`;

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    raw.close();
  });

  const ctx = () => ({
    db,
    endpoint: "https://novels.example.org",
    config,
    countRequest: () => {},
  });

  it("没有 nextContentUrl 规则时，靠探测把三页拼完整", async () => {
    responses.set(
      "https://novels.example.org/c/1.html",
      page("第一页", `<a href="/c/1_2.html">下一页</a>`)
    );
    responses.set(
      "https://novels.example.org/c/1_2.html",
      page("第二页", `<a href="/c/1_3.html">下一页</a>`)
    );
    // 末页只有「下一章」，不该被当成下一页
    responses.set(
      "https://novels.example.org/c/1_3.html",
      page("第三页", `<a href="/c/2.html">下一章</a>`)
    );

    const result = await rulesAdapter.fetchChapter(ctx(), {
      externalKey: "https://novels.example.org/c/1.html",
    });
    expect(result.paragraphs).toEqual(["第一页", "第二页", "第三页"]);
  });

  it("末页只有「下一章」时正确停止，不把下一章拼进来", async () => {
    responses.set(
      "https://novels.example.org/c/1.html",
      page("本章正文", `<a href="/c/2.html">下一章</a>`)
    );
    responses.set("https://novels.example.org/c/2.html", page("下一章正文"));

    const result = await rulesAdapter.fetchChapter(ctx(), {
      externalKey: "https://novels.example.org/c/1.html",
    });
    expect(result.paragraphs).toEqual(["本章正文"]);
    expect(result.paragraphs).not.toContain("下一章正文");
  });

  it("书源规则优先于通用探测", async () => {
    // 规则指向 _rule 页，页面里的「下一页」指向 _detect 页
    responses.set(
      "https://novels.example.org/c/1.html",
      page("首页", `<a href="/c/1_detect.html">下一页</a><a href="/c/1_rule.html">继续</a>`)
    );
    responses.set("https://novels.example.org/c/1_rule.html", page("按规则取到的第二页"));
    responses.set("https://novels.example.org/c/1_detect.html", page("按探测取到的第二页"));

    const result = await rulesAdapter.fetchChapter(
      {
        db,
        endpoint: "https://novels.example.org",
        config: { ...config, nextContentUrl: "text.继续@href" },
        countRequest: () => {},
      },
      { externalKey: "https://novels.example.org/c/1.html" }
    );
    expect(result.paragraphs).toContain("按规则取到的第二页");
    expect(result.paragraphs).not.toContain("按探测取到的第二页");
  });

  it("分页成环时不死循环", async () => {
    responses.set(
      "https://novels.example.org/c/1.html",
      page("甲", `<a href="/c/1_2.html">下一页</a>`)
    );
    // 第二页的「下一页」又指回第一页
    responses.set(
      "https://novels.example.org/c/1_2.html",
      page("乙", `<a href="/c/1.html">下一页</a>`)
    );

    const result = await rulesAdapter.fetchChapter(ctx(), {
      externalKey: "https://novels.example.org/c/1.html",
    });
    expect(result.paragraphs).toEqual(["甲", "乙"]);
  });
});
