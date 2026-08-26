import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import {
  UnsupportedRuleError,
  evalRuleAll,
  evalRuleNodes,
  evalRuleOne,
  parseRule,
} from "~/server/sources/rule-expr";
import { textOf } from "~/server/sources/xml";

const html = `
  <div class="listmain">
    <dl>
      <dd><a href="/c/1">第1章 开端</a></dd>
      <dd><a href="/c/2">第2章 转折</a></dd>
      <dd><a href="/c/3">第3章 收束</a></dd>
    </dl>
  </div>
  <div id="content">
    <p>第一段文字</p>
    <p>第二段文字</p>
  </div>
  <div class="info"><span class="author">某位作者</span></div>`;

const root = parseHtml(html);

describe("parseRule 方言翻译", () => {
  it("点号方言译成 CSS", () => {
    expect(parseRule("class.listmain@tag.dd@tag.a@text").selector).toBe(".listmain dd a");
    expect(parseRule("id.content@tag.p@text").selector).toBe("#content p");
  });

  it("索引段译成 :eq", () => {
    expect(parseRule("class.item.2@text").selector).toBe(".item:eq(2)");
    expect(parseRule("tag.div.0@text").selector).toBe("div:eq(0)");
  });

  it("显式 @css: 原样使用", () => {
    expect(parseRule("@css:.chapters li a@href").selector).toBe(".chapters li a");
  });

  it("识别提取目标", () => {
    expect(parseRule("tag.a@href").target).toEqual({ kind: "attr", name: "href" });
    expect(parseRule("id.content@html").target).toEqual({ kind: "html" });
    expect(parseRule("id.content@textNodes").target).toEqual({ kind: "textNodes" });
    expect(parseRule("tag.img@attr.data-src").target).toEqual({ kind: "attr", name: "data-src" });
    // 没有显式目标时默认取文本
    expect(parseRule("class.author").target).toEqual({ kind: "text" });
  });

  it("解析 ##正则##替换 清洗段", () => {
    const rule = parseRule("class.title@text##第\\d+章\\s*##");
    expect(rule.cleanups).toHaveLength(1);
    expect(rule.selector).toBe(".title");
  });

  it("不支持的方言明确报错，不静默出错", () => {
    expect(() => parseRule("<js>result")).toThrow(UnsupportedRuleError);
    expect(() => parseRule("$.data.list")).toThrow(UnsupportedRuleError);
    expect(() => parseRule("//div[@class]")).toThrow(UnsupportedRuleError);
    expect(() => parseRule("text.简介@text")).toThrow(UnsupportedRuleError);
    expect(() => parseRule("")).toThrow(UnsupportedRuleError);
  });
});

describe("规则求值", () => {
  it("evalRuleOne 取第一个命中", () => {
    expect(evalRuleOne(root, "class.listmain@tag.dd@tag.a@text")).toBe("第1章 开端");
    expect(evalRuleOne(root, "class.author@text")).toBe("某位作者");
    expect(evalRuleOne(root, "class.listmain@tag.dd@tag.a@href")).toBe("/c/1");
  });

  it("evalRuleAll 取全部命中", () => {
    expect(evalRuleAll(root, "class.listmain@tag.dd@tag.a@text")).toEqual([
      "第1章 开端",
      "第2章 转折",
      "第3章 收束",
    ]);
    expect(evalRuleAll(root, "id.content@tag.p@text")).toEqual(["第一段文字", "第二段文字"]);
  });

  it("清洗段生效", () => {
    expect(evalRuleAll(root, "class.listmain@tag.dd@tag.a@text##第\\d+章\\s*##")).toEqual([
      "开端",
      "转折",
      "收束",
    ]);
  });

  it("evalRuleNodes 支持列表 + 每项子规则的嵌套提取", () => {
    const items = evalRuleNodes(root, "class.listmain@tag.dd");
    expect(items).toHaveLength(3);
    const pairs = items.map((item) => ({
      title: evalRuleOne(item, "tag.a@text"),
      href: evalRuleOne(item, "tag.a@href"),
    }));
    expect(pairs).toEqual([
      { title: "第1章 开端", href: "/c/1" },
      { title: "第2章 转折", href: "/c/2" },
      { title: "第3章 收束", href: "/c/3" },
    ]);
  });

  it("选不中返回空值而不抛错", () => {
    expect(evalRuleOne(root, "class.nothing@text")).toBe("");
    expect(evalRuleAll(root, "class.nothing@text")).toEqual([]);
  });

  it("@html 保留标签，可再解析出段落", () => {
    const inner = evalRuleOne(root, "id.content@html");
    expect(inner).toContain("<p>");
    const paragraphs = evalRuleAll(parseHtml(inner), "tag.p@text");
    expect(paragraphs).toEqual(["第一段文字", "第二段文字"]);
  });

  it("@textNodes 只取直接文本，忽略子元素", () => {
    const mixed = parseHtml(`<div class="m">直接文字<span>子元素文字</span></div>`);
    expect(evalRuleOne(mixed, "class.m@textNodes")).toBe("直接文字");
    expect(textOf(mixed).includes("子元素文字")).toBe(true);
  });
});
