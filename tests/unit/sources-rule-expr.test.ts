import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import {
  UnsupportedRuleError,
  canParseRule,
  evalRuleAll,
  evalRuleNodes,
  evalRuleOne,
  htmlDoc,
  jsonDoc,
  parseRule,
} from "~/server/sources/rule-expr";

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
  <div class="info"><span class="author">某位作者</span></div>
  <img class="cover" src="/fallback.jpg">
  <select><option value="p1">第1页</option><option value="p2">第2页</option></select>`;

const doc = htmlDoc(parseHtml(html));
const first = (rule: string) => parseRule(rule).alternatives[0]!;

describe("parseRule 方言翻译", () => {
  it("点号方言译成 CSS", () => {
    expect(first("class.listmain@tag.dd@tag.a@text").selector).toBe(".listmain dd a");
    expect(first("id.content@tag.p@text").selector).toBe("#content p");
  });

  it("索引段译成 :eq，支持负索引", () => {
    expect(first("class.item.2@text").selector).toBe(".item:eq(2)");
    expect(first("tag.div.0@text").selector).toBe("div:eq(0)");
    expect(first("em.-1@text").selector).toBe("em:eq(-1)");
  });

  it("显式 @css: 原样使用", () => {
    expect(first("@css:.chapters li a@href").selector).toBe(".chapters li a");
  });

  it("识别提取目标", () => {
    expect(first("tag.a@href").target).toEqual({ kind: "attr", name: "href" });
    expect(first("id.content@html").target).toEqual({ kind: "html" });
    expect(first("id.content@textNodes").target).toEqual({ kind: "textNodes" });
    expect(first("tag.img@attr.data-src").target).toEqual({ kind: "attr", name: "data-src" });
    expect(first("tag.img@data-original").target).toEqual({ kind: "attr", name: "data-original" });
    expect(first("class.author").target).toEqual({ kind: "text" });
  });

  it("解析 ##正则##替换 清洗段", () => {
    const rule = parseRule("class.title@text##第\\d+章\\s*##");
    expect(rule.cleanups).toHaveLength(1);
    expect(rule.alternatives[0]?.selector).toBe(".title");
  });

  it("|| 拆成多个备选分支", () => {
    const rule = parseRule("img@data-original||img@src");
    expect(rule.alternatives).toHaveLength(2);
    expect(rule.alternatives[0]?.target).toEqual({ kind: "attr", name: "data-original" });
    expect(rule.alternatives[1]?.target).toEqual({ kind: "attr", name: "src" });
  });

  it("清洗段先剥离，不会被 || 拆错", () => {
    const rule = parseRule("a@text||b@text##第\\d+章##");
    expect(rule.alternatives).toHaveLength(2);
    expect(rule.cleanups).toHaveLength(1);
  });

  it("!n 解析成排除下标，支持逗号与区间", () => {
    expect(first("option!0@value").excludeIndexes).toEqual([0]);
    expect(first("option!0,2@value").excludeIndexes).toEqual([0, 2]);
    expect(first("option!0:2@value").excludeIndexes).toEqual([0, 1, 2]);
    expect(first("option!-1@value").excludeIndexes).toEqual([-1]);
  });

  it("JSONPath 走独立分支", () => {
    const rule = first("$.data.list[0].name");
    expect(rule.jsonPath).toBe("$.data.list[0].name");
    expect(rule.selector).toBe("");
  });

  it("不支持的方言明确报错，不静默出错", () => {
    expect(() => parseRule("<js>result")).toThrow(UnsupportedRuleError);
    expect(() => parseRule("//div[@class]")).toThrow(UnsupportedRuleError);
    expect(() => parseRule("")).toThrow(UnsupportedRuleError);
    // {{}} 模板需要 JS 求值
    expect(() => parseRule("{{url=source.getKey()}}?q={{key}}")).toThrow(UnsupportedRuleError);
  });

  it("text.关键字 译成 :contains（分页规则最常见形态）", () => {
    expect(first("text.下一页@href").selector).toBe("*:contains(下一页)");
    expect(first("text.下一章@href").target).toEqual({ kind: "attr", name: "href" });
  });

  /**
   * 回归：`.chapter.1` 本意是「第 2 个 .chapter」，而非「同时有
   * chapter 与 1 两个 class」。此前原样透传给 CSS，永远选不中且不报错，
   * 是「目录规则未命中任何章节」的一类根因。
   */
  it(".class.N 译成序号，而不是两个 class", () => {
    expect(first(".chapter.1@tag.li").selector).toBe(".chapter:eq(1) li");
    expect(first(".section-list.1@a").selector).toBe(".section-list:eq(1) a");
    expect(first("#list.2@a").selector).toBe("#list:eq(2) a");
  });

  it("真正的多 class 选择器不被误判", () => {
    // 末段不是纯数字，应保持多 class 语义
    expect(first(".item.hot@a").selector).toBe(".item.hot a");
  });

  it("canParseRule 不抛错，返回布尔", () => {
    expect(canParseRule("class.a@text")).toBe(true);
    expect(canParseRule("<js>x</js>")).toBe(false);
  });
});

describe("HTML 规则求值", () => {
  it("evalRuleOne 取第一个命中", () => {
    expect(evalRuleOne(doc, "class.listmain@tag.dd@tag.a@text")).toBe("第1章 开端");
    expect(evalRuleOne(doc, "class.author@text")).toBe("某位作者");
    expect(evalRuleOne(doc, "class.listmain@tag.dd@tag.a@href")).toBe("/c/1");
  });

  it("evalRuleAll 取全部命中", () => {
    expect(evalRuleAll(doc, "class.listmain@tag.dd@tag.a@text")).toEqual([
      "第1章 开端",
      "第2章 转折",
      "第3章 收束",
    ]);
  });

  it("清洗段生效", () => {
    expect(evalRuleAll(doc, "class.listmain@tag.dd@tag.a@text##第\\d+章\\s*##")).toEqual([
      "开端",
      "转折",
      "收束",
    ]);
  });

  it("|| 备选：前者取空时用后者", () => {
    // cover 上没有 data-original，应回落到 src
    expect(evalRuleOne(doc, "class.cover@data-original||class.cover@src")).toBe("/fallback.jpg");
  });

  it("|| 备选：前者有值时不用后者", () => {
    expect(evalRuleOne(doc, "class.cover@src||class.author@text")).toBe("/fallback.jpg");
  });

  it("!n 排除指定下标", () => {
    // 排除第 0 个 option，只剩第 2 页
    expect(evalRuleAll(doc, "tag.option!0@value")).toEqual(["p2"]);
    expect(evalRuleAll(doc, "tag.option@value")).toEqual(["p1", "p2"]);
  });

  it("!-1 排除最后一个", () => {
    expect(evalRuleAll(doc, "class.listmain@tag.dd@tag.a!-1@text")).toEqual([
      "第1章 开端",
      "第2章 转折",
    ]);
  });

  it("evalRuleNodes 支持列表 + 每项子规则的嵌套提取", () => {
    const items = evalRuleNodes(doc, "class.listmain@tag.dd");
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
    expect(evalRuleOne(doc, "class.nothing@text")).toBe("");
    expect(evalRuleAll(doc, "class.nothing@text")).toEqual([]);
    expect(evalRuleNodes(doc, "class.nothing")).toEqual([]);
  });

  it("@html 保留标签，可再解析出段落", () => {
    const inner = evalRuleOne(doc, "id.content@html");
    expect(inner).toContain("<p>");
    expect(evalRuleAll(htmlDoc(parseHtml(inner)), "tag.p@text")).toEqual([
      "第一段文字",
      "第二段文字",
    ]);
  });

  it("@textNodes 只取直接文本，忽略子元素", () => {
    const mixed = htmlDoc(parseHtml(`<div class="m">直接文字<span>子元素文字</span></div>`));
    expect(evalRuleOne(mixed, "class.m@textNodes")).toBe("直接文字");
  });

  it("JSONPath 规则作用在 HTML 文档上返回空，不报错", () => {
    expect(evalRuleOne(doc, "$.data.name")).toBe("");
  });
});

describe("JSON 规则求值", () => {
  const api = jsonDoc({
    code: 1,
    data: {
      list: [
        { name: "第一本", author: "甲", url: "/b/1" },
        { name: "第二本", author: "乙", url: "/b/2" },
      ],
      chapters: ["段落一", "段落二", "段落三"],
    },
  });

  it("按路径取单值", () => {
    expect(evalRuleOne(api, "$.data.list[0].name")).toBe("第一本");
    expect(evalRuleOne(api, "$.data.list[-1].name")).toBe("第二本");
  });

  it("[*] 取全部", () => {
    expect(evalRuleAll(api, "$.data.list[*].name")).toEqual(["第一本", "第二本"]);
  });

  it("对数组取字段时隐式展开", () => {
    expect(evalRuleAll(api, "$.data.list.author")).toEqual(["甲", "乙"]);
  });

  it("字符串数组拼成多段文本", () => {
    expect(evalRuleOne(api, "$.data.chapters")).toBe("段落一\n段落二\n段落三");
  });

  it("evalRuleNodes 返回 JSON 子文档，可继续嵌套取值", () => {
    const items = evalRuleNodes(api, "$.data.list[*]");
    expect(items).toHaveLength(2);
    expect(evalRuleOne(items[0]!, "$.name")).toBe("第一本");
    expect(evalRuleOne(items[1]!, "$.url")).toBe("/b/2");
  });

  it("路径不存在时返回空", () => {
    expect(evalRuleOne(api, "$.data.missing")).toBe("");
    expect(evalRuleAll(api, "$.nope[*]")).toEqual([]);
  });

  it("|| 在 JSON 上同样生效", () => {
    expect(evalRuleOne(api, "$.data.missing||$.data.list[0].name")).toBe("第一本");
  });

  it("CSS 规则作用在 JSON 文档上返回空，不报错", () => {
    expect(evalRuleOne(api, "class.foo@text")).toBe("");
  });

  it("深度搜索 ..key", () => {
    expect(evalRuleAll(api, "$..name")).toEqual(["第一本", "第二本"]);
  });
});
