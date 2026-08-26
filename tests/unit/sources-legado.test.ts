import { describe, expect, it } from "vitest";
import {
  LegadoConversionError,
  buildSearchUrl,
  convertLegadoSource,
  parseLegadoJson,
} from "~/server/sources/legado";

/** 一个结构完整、规则可翻译的最小书源 */
const validSource = {
  bookSourceName: "示例源",
  bookSourceUrl: "https://books.example.com",
  searchUrl: "https://books.example.com/search?q={{key}}",
  ruleSearch: {
    bookList: "class.result-item",
    name: "tag.h3@text",
    author: "class.author@text",
    bookUrl: "tag.a@href",
  },
  ruleBookInfo: {
    name: "class.book-title@text",
    author: "class.book-author@text",
    intro: "class.intro@text",
    coverUrl: "class.cover@tag.img@src",
  },
  ruleToc: {
    chapterList: "class.listmain@tag.dd",
    chapterName: "tag.a@text",
    chapterUrl: "tag.a@href",
  },
  ruleContent: {
    content: "id.content@html",
  },
};

describe("convertLegadoSource", () => {
  it("转换完整书源并保留规则", () => {
    const result = convertLegadoSource(validSource);
    expect(result.name).toBe("示例源");
    expect(result.endpoint).toBe("https://books.example.com");
    expect(result.config.tocList).toBe("class.listmain@tag.dd");
    expect(result.config.contentRule).toBe("id.content@html");
    expect(result.config.baseUrl).toBe("https://books.example.com");
    expect(result.warnings).toEqual([]);
  });

  it("缺名称或地址时报错", () => {
    expect(() => convertLegadoSource({ ...validSource, bookSourceName: "" })).toThrow(
      LegadoConversionError
    );
    expect(() => convertLegadoSource({ ...validSource, bookSourceUrl: undefined })).toThrow(
      /bookSourceUrl/
    );
  });

  it("缺目录规则时报错：增量更新的最低要求", () => {
    expect(() => convertLegadoSource({ ...validSource, ruleToc: {} })).toThrow(/目录规则/);
    expect(() =>
      convertLegadoSource({ ...validSource, ruleToc: { chapterList: "class.x" } })
    ).toThrow(/目录规则/);
  });

  it("缺正文规则时报错", () => {
    expect(() => convertLegadoSource({ ...validSource, ruleContent: {} })).toThrow(/正文规则/);
  });

  it("目录或正文用了 JS 规则时报错而非静默通过", () => {
    expect(() =>
      convertLegadoSource({
        ...validSource,
        ruleContent: { content: "<js>result.text()</js>" },
      })
    ).toThrow(/正文规则无法翻译/);
    expect(() =>
      convertLegadoSource({
        ...validSource,
        ruleToc: { ...validSource.ruleToc, chapterList: "$.data.chapters" },
      })
    ).toThrow(/目录列表规则无法翻译/);
  });

  it("可选规则不可翻译时降级为警告，不阻断导入", () => {
    const result = convertLegadoSource({
      ...validSource,
      ruleBookInfo: { ...validSource.ruleBookInfo, intro: "<js>x</js>" },
    });
    expect(result.config.infoIntro).toBeNull();
    expect(result.warnings.join()).toMatch(/详情简介/);
  });

  it("非对象输入报错", () => {
    expect(() => convertLegadoSource(null)).toThrow(LegadoConversionError);
    expect(() => convertLegadoSource("字符串")).toThrow(LegadoConversionError);
  });
});

describe("parseLegadoJson", () => {
  it("支持单个对象与数组", () => {
    expect(parseLegadoJson(JSON.stringify(validSource)).converted).toHaveLength(1);
    expect(parseLegadoJson(JSON.stringify([validSource, validSource])).converted).toHaveLength(2);
  });

  it("一条坏规则不毁掉整批，失败原因单独返回", () => {
    const bad = { bookSourceName: "坏源", bookSourceUrl: "https://b.example.com" };
    const result = parseLegadoJson(JSON.stringify([validSource, bad]));
    expect(result.converted).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe("坏源");
    expect(result.failed[0]?.reason).toMatch(/目录规则/);
  });

  it("非法 JSON 与空数组报错", () => {
    expect(() => parseLegadoJson("{ 坏")).toThrow(/合法 JSON/);
    expect(() => parseLegadoJson("[]")).toThrow(/没有书源/);
  });
});

describe("buildSearchUrl", () => {
  it("填充占位符并做 URL 编码", () => {
    expect(buildSearchUrl("https://e.com/s?q={{key}}", "修仙")).toBe(
      `https://e.com/s?q=${encodeURIComponent("修仙")}`
    );
    expect(buildSearchUrl("https://e.com/s?q={{searchKey}}", "abc")).toBe("https://e.com/s?q=abc");
  });
});
