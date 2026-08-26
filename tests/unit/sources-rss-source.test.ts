import { describe, expect, it } from "vitest";
import {
  RssConversionError,
  convertRssSource,
  parseRssSourceJson,
} from "~/server/sources/rss-source";

/**
 * 订阅源字段与书源完全不同，必须单独一套转换。
 * 下面两个样本对应实测见到的两种形态。
 */

/** 形态一：只有地址、没有列表规则（原 App 里是直接开网页的书签） */
const bookmarkStyle = {
  sourceName: "源仓库(官方纯净)",
  sourceUrl: "http://example-repo.test",
  sourceGroup: "1",
  singleUrl: true,
  enableJs: true,
  enabled: true,
};

/** 形态二：带文章列表规则，可当"列表页 + 正文页"抓 */
const ruleStyle = {
  sourceName: "某站更新",
  sourceUrl: "https://feed.example.org/latest",
  ruleArticles: "class.article-list@tag.li",
  ruleTitle: "tag.a@text",
  ruleLink: "tag.a@href",
  ruleContent: "id.content@html",
};

describe("convertRssSource", () => {
  it("无列表规则时按标准 RSS/Atom 地址接入，并给出提示", () => {
    const result = convertRssSource(bookmarkStyle);
    expect(result.kind).toBe("feed");
    expect(result.config).toBeNull();
    expect(result.name).toBe("源仓库(官方纯净)");
    expect(result.endpoint).toBe("http://example-repo.test");
    expect(result.warnings.join()).toMatch(/书签|标准 RSS/);
  });

  it("有列表规则时映射到 toc/content 规则", () => {
    const result = convertRssSource(ruleStyle);
    expect(result.kind).toBe("rules");
    expect(result.config?.tocList).toBe("class.article-list@tag.li");
    expect(result.config?.tocName).toBe("tag.a@text");
    expect(result.config?.tocUrl).toBe("href".length ? "tag.a@href" : "");
    expect(result.config?.contentRule).toBe("id.content@html");
    // 订阅源没有搜索概念
    expect(result.config?.searchUrl).toBeNull();
  });

  it("标题与链接规则可省略，按裸属性名兜底", () => {
    const result = convertRssSource({
      sourceName: "省略规则",
      sourceUrl: "https://feed.example.org/x",
      ruleArticles: "class.list@tag.li",
      ruleContent: "id.c@html",
    });
    expect(result.config?.tocName).toBe("text");
    expect(result.config?.tocUrl).toBe("href");
  });

  it("缺名称或地址时报错", () => {
    expect(() => convertRssSource({ sourceUrl: "https://a.test" })).toThrow(/sourceName/);
    expect(() => convertRssSource({ sourceName: "甲" })).toThrow(/sourceUrl/);
  });

  it("列表规则需要 JS 求值时明确报错", () => {
    expect(() =>
      convertRssSource({ ...ruleStyle, ruleArticles: "<js>result.list()</js>" })
    ).toThrow(/JS 求值/);
  });

  it("正文规则不可用时退回 ruleDescription", () => {
    const result = convertRssSource({
      ...ruleStyle,
      ruleContent: "<js>x</js>",
      ruleDescription: "class.desc@text",
    });
    expect(result.config?.contentRule).toBe("class.desc@text");
    expect(result.warnings.join()).toMatch(/描述|ruleDescription/);
  });

  it("既无正文规则也无描述时报错", () => {
    expect(() =>
      convertRssSource({
        sourceName: "无正文",
        sourceUrl: "https://feed.example.org/x",
        ruleArticles: "class.list@tag.li",
      })
    ).toThrow(/无法取到内容/);
  });

  it("非对象输入报错", () => {
    expect(() => convertRssSource(null)).toThrow(RssConversionError);
    expect(() => convertRssSource("字符串")).toThrow(RssConversionError);
  });
});

describe("parseRssSourceJson", () => {
  it("支持单个对象与数组", () => {
    expect(parseRssSourceJson(JSON.stringify(bookmarkStyle)).converted).toHaveLength(1);
    expect(parseRssSourceJson(JSON.stringify([bookmarkStyle, ruleStyle])).converted).toHaveLength(2);
  });

  it("坏的单条不影响其余，失败原因单独返回", () => {
    const result = parseRssSourceJson(
      JSON.stringify([ruleStyle, { sourceName: "缺地址" }])
    );
    expect(result.converted).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe("缺地址");
  });

  it("非法 JSON 与空数组报错", () => {
    expect(() => parseRssSourceJson("{ 坏")).toThrow(/合法 JSON/);
    expect(() => parseRssSourceJson("[]")).toThrow(/没有订阅源/);
  });
});
