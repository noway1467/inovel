import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import { detectChapterList } from "~/server/sources/toc-detect";

/**
 * 通用目录探测：不依赖书源规则，从页面结构认出章节列表。
 *
 * 这是规则失效时的兜底。上一版兜底是「把页面正文按字数切章」，
 * 但目录页上没有正文，切出来的是简介碎片，产出一堆点开就报错的假章节。
 * 探测真实目录得到的是带真实地址的章节，正文照常能回源。
 */

const base = "https://novels.example.org/book/1";

function chapterLinks(count: number, prefix = "第") {
  return Array.from(
    { length: count },
    (_, i) => `<dd><a href="/c/${i + 1}.html">${prefix}${i + 1}章 标题${i + 1}</a></dd>`
  ).join("");
}

describe("detectChapterList", () => {
  it("从典型目录页认出章节列表", () => {
    const html = `<html><body>
      <div class="nav"><a href="/">首页</a><a href="/rank">排行</a></div>
      <div class="listmain"><dl>${chapterLinks(12)}</dl></div>
    </body></html>`;

    const chapters = detectChapterList(parseHtml(html), base);
    expect(chapters).toHaveLength(12);
    expect(chapters[0]?.title).toContain("第1章");
    // 相对地址补全成绝对地址，正文才能回源
    expect(chapters[0]?.url).toBe("https://novels.example.org/c/1.html");
  });

  it("避开导航栏，选中真正的目录容器", () => {
    const html = `<html><body>
      <nav><a href="/p1">首页</a><a href="/p2">书架</a><a href="/p3">登录</a>
        <a href="/p4">注册</a><a href="/p5">搜索</a><a href="/p6">分类</a></nav>
      <ul id="chapters">${chapterLinks(20)}</ul>
    </body></html>`;

    const chapters = detectChapterList(parseHtml(html), base);
    expect(chapters).toHaveLength(20);
    // 导航项不该出现在结果里
    expect(chapters.some((c) => c.title === "首页")).toBe(false);
    expect(chapters.some((c) => c.title === "登录")).toBe(false);
  });

  it("链接太少时不误判", () => {
    const html = `<html><body>
      <div><a href="/c/1.html">第1章</a><a href="/c/2.html">第2章</a></div>
    </body></html>`;
    expect(detectChapterList(parseHtml(html), base)).toEqual([]);
  });

  it("纯导航页面返回空，不硬凑结果", () => {
    const html = `<html><body>
      <div><a href="/a1">首页</a><a href="/a2">书架</a><a href="/a3">登录</a>
        <a href="/a4">注册</a><a href="/a5">搜索</a><a href="/a6">分类</a>
        <a href="/a7">排行</a><a href="/a8">下载</a></div>
    </body></html>`;
    expect(detectChapterList(parseHtml(html), base)).toEqual([]);
  });

  it("识别序章/楔子/番外这类非数字标题", () => {
    const html = `<html><body><div class="list">
      <a href="/c/0.html">楔子</a>
      <a href="/c/1.html">序章 开端</a>
      ${chapterLinks(8)}
      <a href="/c/99.html">番外 后来</a>
    </div></body></html>`;

    const chapters = detectChapterList(parseHtml(html), base);
    const titles = chapters.map((c) => c.title);
    expect(titles).toContain("楔子");
    expect(titles).toContain("番外 后来");
  });

  it("识别「1、标题」这类编号形态", () => {
    const items = Array.from(
      { length: 10 },
      (_, i) => `<li><a href="/c/${i}.html">${i + 1}、章节标题${i + 1}</a></li>`
    ).join("");
    const chapters = detectChapterList(parseHtml(`<ul>${items}</ul>`), base);
    expect(chapters).toHaveLength(10);
  });

  it("识别英文 Chapter N", () => {
    const items = Array.from(
      { length: 8 },
      (_, i) => `<li><a href="/c/${i}.html">Chapter ${i + 1}</a></li>`
    ).join("");
    const chapters = detectChapterList(parseHtml(`<ul>${items}</ul>`), base);
    expect(chapters).toHaveLength(8);
  });

  it("按地址去重：目录页常有「最新章节」重复块", () => {
    const html = `<html><body>
      <div class="latest">
        <a href="/c/10.html">第10章 最新</a><a href="/c/9.html">第9章</a>
        <a href="/c/8.html">第8章</a><a href="/c/7.html">第7章</a>
        <a href="/c/6.html">第6章</a>
      </div>
      <div class="listmain">${chapterLinks(10)}
        <a href="/c/10.html">第10章 最新</a>
      </div>
    </body></html>`;

    const chapters = detectChapterList(parseHtml(html), base);
    const urls = chapters.map((c) => c.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("跳过锚点与 javascript 链接", () => {
    const html = `<html><body><div class="list">
      <a href="#top">回到顶部</a>
      <a href="javascript:void(0)">展开</a>
      ${chapterLinks(10)}
    </div></body></html>`;
    const chapters = detectChapterList(parseHtml(html), base);
    expect(chapters.every((c) => !c.url.includes("#top"))).toBe(true);
    expect(chapters.every((c) => !c.url.includes("javascript"))).toBe(true);
  });

  it("章节地址必须带数字，纯文字导航链接被排除", () => {
    const html = `<html><body><div class="list">
      ${chapterLinks(10)}
      <a href="/about">关于本站</a>
      <a href="/contact">联系我们</a>
    </div></body></html>`;
    const chapters = detectChapterList(parseHtml(html), base);
    expect(chapters.some((c) => c.url.includes("/about"))).toBe(false);
  });

  it("空页面与畸形 HTML 返回空数组，不抛错", () => {
    expect(detectChapterList(parseHtml(""), base)).toEqual([]);
    expect(detectChapterList(parseHtml("<div><a href=/c/1>未闭合"), base)).toEqual([]);
  });

  it("探测出的章节都有真实可访问地址（与切正文兜底的关键区别）", () => {
    const html = `<div class="listmain">${chapterLinks(10)}</div>`;
    const chapters = detectChapterList(parseHtml(html), base);
    for (const chapter of chapters) {
      expect(chapter.url).toMatch(/^https?:\/\//);
    }
  });
});
