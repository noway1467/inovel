import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertLegadoSource, normalizeFlatSource, parseLegadoJson } from "~/server/sources/legado";

/** normalizeFlatSource 就地补字段，字面量会被推断得太窄，用它自己的参数类型标注 */
type FlatInput = Parameters<typeof normalizeFlatSource>[0];

/**
 * 老版扁平格式书源（`flyersoft: true` 那一代）。
 *
 * 真实来源：yckceo 清单 shuyuans/json/id/1213（50 个源，49 个是扁平格式）。
 * 我们原先只读嵌套格式（`ruleContent.content`），这份清单一个都进不来 ——
 * 而且失败理由是"缺少正文规则"，看起来像书源本身残缺，实际是格式没认。
 */

const fixture = readFileSync("tests/fixtures/legado-flat-sources.json", "utf8");

describe("normalizeFlatSource", () => {
  it("把扁平键摊成嵌套键", () => {
    const raw = {
      bookSourceName: "测试源",
      bookSourceUrl: "https://example.com",
      ruleSearchUrl: "/search?q={{key}}",
      ruleSearchList: ".item",
      ruleSearchName: "a@text",
      ruleSearchNoteUrl: "a@href",
      ruleBookName: "h1@text",
      ruleBookAuthor: ".author@text",
      ruleChapterUrl: "{{$.}}list.html",
      ruleChapterList: "dl@dd",
      ruleChapterName: "a@text",
      ruleContentUrl: "a@href",
      ruleBookContent: "#content@html",
      ruleContentUrlNext: ".next@href",
      ruleChapterUrlNext: ".pager@href",
    };
    normalizeFlatSource(raw);

    expect(raw).toMatchObject({
      searchUrl: "/search?q={{key}}",
      ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
      ruleBookInfo: { name: "h1@text", author: ".author@text", tocUrl: "{{$.}}list.html" },
      ruleToc: {
        chapterList: "dl@dd",
        chapterName: "a@text",
        // 关键：ruleContentUrl 是目录行里的章节链接，不是正文地址
        chapterUrl: "a@href",
        nextTocUrl: ".pager@href",
      },
      ruleContent: { content: "#content@html", nextContentUrl: ".next@href" },
    });
  });

  it("ruleContentUrl 与 ruleChapterUrl 不能搞反", () => {
    // 这一对的命名和语义是反的，搞反会让每个扁平源的目录全空。
    // 依据：ruleChapterList + ruleChapterName + ruleContentUrl 是"列表/章名/链接"一组，
    // 而 ruleChapterUrl 写的是拼目录页地址的模板。
    const raw: FlatInput = {
      ruleChapterUrl: "{{$.}}list.html",
      ruleContentUrl: "a@href",
    };
    normalizeFlatSource(raw);
    expect(raw.ruleToc?.chapterUrl).toBe("a@href");
    expect(raw.ruleBookInfo?.tocUrl).toBe("{{$.}}list.html");
  });

  it("嵌套字段已有值时不被扁平键覆盖", () => {
    const raw = {
      ruleContent: { content: "嵌套优先@html" },
      ruleBookContent: "扁平@html",
      ruleToc: { chapterList: "嵌套列表" },
      ruleChapterList: "扁平列表",
    };
    normalizeFlatSource(raw);
    expect(raw.ruleContent.content).toBe("嵌套优先@html");
    expect(raw.ruleToc.chapterList).toBe("嵌套列表");
  });

  it("空字符串与缺失的扁平键不写进去", () => {
    const raw: FlatInput = { ruleBookContent: "  ", ruleChapterList: "" };
    normalizeFlatSource(raw);
    expect(raw.ruleContent?.content).toBeUndefined();
    expect(raw.ruleToc?.chapterList).toBeUndefined();
  });
});

describe("扁平格式走完整转换", () => {
  it("扁平源能转出可用配置", () => {
    const result = convertLegadoSource({
      bookSourceName: "扁平测试",
      bookSourceUrl: "https://example.com",
      ruleSearchUrl: "/s?q={{key}}",
      ruleSearchList: ".book_list a",
      ruleChapterList: ".book_list@li@a",
      ruleChapterName: "text",
      ruleContentUrl: "href",
      ruleBookContent: ".read_chapterDetail@html",
    });
    expect(result.name).toBe("扁平测试");
    expect(result.config.contentRule).toBe(".read_chapterDetail@html");
    expect(result.config.tocList).toBe(".book_list@li@a");
    expect(result.config.tocName).toBe("text");
    expect(result.config.tocUrl).toBe("href");
  });

  it("只有扁平正文规则、没有目录规则时转探测模式而不是拒源", () => {
    const result = convertLegadoSource({
      bookSourceName: "只有正文",
      bookSourceUrl: "https://example.com",
      ruleBookContent: "#content@html",
    });
    expect(result.config.tocMode).toBe("detect");
    expect(result.config.contentRule).toBe("#content@html");
  });
});

describe("真实清单（50 源 / 49 扁平）", () => {
  const result = parseLegadoJson(fixture);

  it("大部分能导入，而不是全军覆没", () => {
    // 改动前：0 个。扁平格式不认，全部报"缺少正文规则"
    expect(result.converted.length).toBeGreaterThanOrEqual(35);
    expect(result.converted.length + result.failed.length).toBe(50);
  });

  it("剩下的拒绝理由都正当（真需 JS 引擎 / XPath / 确实没正文）", () => {
    for (const f of result.failed) {
      expect(f.reason).toMatch(/JS 规则|XPath|缺少正文规则/);
    }
  });

  it("转出来的源带着能用的正文规则", () => {
    for (const c of result.converted) {
      expect(c.config.contentRule).toBeTruthy();
      expect(typeof c.config.contentRule).toBe("string");
    }
  });

  it("番茄小说123 这个源的目录三件套映射正确", () => {
    const s = result.converted.find((c) => c.endpoint.includes("fqxs123"));
    expect(s).toBeDefined();
    expect(s!.config.tocList).toBe("dl@dd!0");
    expect(s!.config.tocName).toBe("a@text");
    expect(s!.config.tocUrl).toBe("a@href");
    expect(s!.config.contentRule).toBe("#chaptercontent@html");
  });
});
