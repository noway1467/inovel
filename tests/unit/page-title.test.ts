import { describe, expect, it } from "vitest";
import { pageMeta, pageTitle, siteName } from "~/lib/page-title";

describe("pageTitle", () => {
  it("只给页面名时补上站名", () => {
    expect(pageTitle("搜索")).toBe(`搜索 · ${siteName}`);
  });

  it("章节页按「章节 · 书名 · 站名」由具体到宽泛排", () => {
    expect(pageTitle("第一章 开端", "剑来")).toBe(`第一章 开端 · 剑来 · ${siteName}`);
  });

  it("什么都不给时至少是站名，不会留下空标题", () => {
    expect(pageTitle()).toBe(siteName);
  });

  it("丢掉空值：目录没抓到时章节名缺失，标题自然退化成书名", () => {
    expect(pageTitle(null, "剑来")).toBe(`剑来 · ${siteName}`);
    expect(pageTitle(undefined, "剑来")).toBe(`剑来 · ${siteName}`);
    expect(pageTitle("", "剑来")).toBe(`剑来 · ${siteName}`);
    // 只有空白的书名同样算缺失，不能拼出 " · 悦读"
    expect(pageTitle("  ", "  ")).toBe(siteName);
  });

  it("压掉抓来的书名里的换行和连续空格", () => {
    expect(pageTitle(" 第一章\n\t开端 ", "剑  来")).toBe(
      `第一章 开端 · 剑 来 · ${siteName}`
    );
  });
});

describe("pageMeta", () => {
  it("没有描述时只出标题一项", () => {
    expect(pageMeta("搜索 · 悦读")).toEqual([{ title: "搜索 · 悦读" }]);
  });

  it("有描述时补一条 description", () => {
    expect(pageMeta("剑来 · 悦读", "烽火戏诸侯的长篇小说。")).toEqual([
      { title: "剑来 · 悦读" },
      { name: "description", content: "烽火戏诸侯的长篇小说。" },
    ]);
  });

  it("空描述不写标签：每页同一句废话对搜索结果是负担", () => {
    expect(pageMeta("剑来 · 悦读", "")).toEqual([{ title: "剑来 · 悦读" }]);
    expect(pageMeta("剑来 · 悦读", "   \n ")).toEqual([{ title: "剑来 · 悦读" }]);
    expect(pageMeta("剑来 · 悦读", null)).toEqual([{ title: "剑来 · 悦读" }]);
  });

  it("描述里的换行压成空格，简介多是从源站抓来的", () => {
    expect(pageMeta("剑来 · 悦读", "第一句。\n\n第二句。")).toEqual([
      { title: "剑来 · 悦读" },
      { name: "description", content: "第一句。 第二句。" },
    ]);
  });
});
