import { describe, expect, it } from "vitest";
import {
  blockTextOf,
  childrenNamed,
  decodeXmlEntities,
  findAll,
  findFirst,
  parseXml,
  textOf,
} from "~/server/sources/xml";

describe("decodeXmlEntities", () => {
  it("解命名实体与数字实体", () => {
    expect(decodeXmlEntities("a&amp;b")).toBe("a&b");
    expect(decodeXmlEntities("&lt;p&gt;")).toBe("<p>");
    expect(decodeXmlEntities("&#20320;&#22909;")).toBe("你好");
    expect(decodeXmlEntities("&#x4f60;&#x597d;")).toBe("你好");
  });

  it("无法识别的实体原样保留，不吞字符", () => {
    expect(decodeXmlEntities("&unknownentity;")).toBe("&unknownentity;");
  });
});

describe("parseXml", () => {
  it("解析嵌套元素与属性", () => {
    const root = parseXml(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>第一章</title><link href="/c/1" rel="alternate"/></entry></feed>`
    );
    const entry = findFirst(root, "entry");
    expect(entry).not.toBeNull();
    expect(textOf(findFirst(entry!, "title"))).toBe("第一章");
    expect(findFirst(entry!, "link")?.attrs.href).toBe("/c/1");
    expect(findFirst(entry!, "link")?.attrs.rel).toBe("alternate");
  });

  it("CDATA 原样保留，不做实体解引用", () => {
    const root = parseXml(`<description><![CDATA[<b>粗体</b> & 符号]]></description>`);
    expect(findFirst(root, "description")?.text).toBe("<b>粗体</b> & 符号");
  });

  it("跳过注释、声明与处理指令", () => {
    const root = parseXml(`<!-- 注释 --><?xml-stylesheet href="x"?><a>值</a>`);
    expect(findAll(root, "a")).toHaveLength(1);
    expect(textOf(findFirst(root, "a"))).toBe("值");
  });

  it("自闭合标签不会吃掉后续兄弟节点", () => {
    const root = parseXml(`<r><a/><b>二</b></r>`);
    const r = findFirst(root, "r")!;
    expect(r.children.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("容忍未按序闭合的脏 feed", () => {
    const root = parseXml(`<ul><li>一<li>二</ul>`);
    expect(findAll(root, "li").length).toBeGreaterThanOrEqual(1);
  });

  it("findAll 大小写不敏感，childrenNamed 只取直接子元素", () => {
    const root = parseXml(`<Feed><Entry><Entry>嵌套</Entry></Entry></Feed>`);
    expect(findAll(root, "entry")).toHaveLength(2);
    const feed = findFirst(root, "feed")!;
    expect(childrenNamed(feed, "entry")).toHaveLength(1);
  });

  it("textOf 拼接后代文本并压缩空白", () => {
    const root = parseXml(`<t>前  <em>中</em>\n 后</t>`);
    expect(textOf(findFirst(root, "t"))).toBe("前 中 后");
  });
});

describe("blockTextOf", () => {
  it("按块级标签保留换行，供正文分段", () => {
    const root = parseXml(`<div><p>第一段</p><p>第二段</p></div>`);
    const text = blockTextOf(findFirst(root, "div"));
    const paragraphs = text.split("\n").map((s) => s.trim()).filter(Boolean);
    expect(paragraphs).toEqual(["第一段", "第二段"]);
  });

  it("br 也算断行", () => {
    const root = parseXml(`<div>甲<br/>乙</div>`);
    const paragraphs = blockTextOf(findFirst(root, "div"))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(paragraphs).toEqual(["甲", "乙"]);
  });
});
