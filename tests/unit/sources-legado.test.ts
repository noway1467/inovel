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

  /**
   * 缺目录规则不再拒源：页面结构还能探测出目录。
   * 有声源那类天生没目录的源仍然会在实际取目录时失败，但那是运行时的事，
   * 不该在导入阶段一刀切 —— 之前一刀切掉的里面混着大量本可用的源。
   */
  it("缺 chapterList 时转为探测模式，不拒源", () => {
    const result = convertLegadoSource({ ...validSource, ruleToc: {} });
    expect(result.config.tocMode).toBe("detect");
    expect(result.config.tocList).toBeNull();
    expect(result.warnings.join()).toMatch(/探测/);
    // 正文规则照常保留：探测出的章节仍按它抓正文
    expect(result.config.contentRule).toBe("id.content@html");
  });

  it("只给 chapterList 时，章节名与地址按裸属性名兜底", () => {
    // 真实书源里 chapterName/chapterUrl 常省略，实际就是取 text / href
    const result = convertLegadoSource({
      ...validSource,
      ruleToc: { chapterList: "class.listmain@tag.dd" },
    });
    expect(result.config.tocName).toBe("text");
    expect(result.config.tocUrl).toBe("href");
  });

  it("缺正文规则时报错", () => {
    expect(() => convertLegadoSource({ ...validSource, ruleContent: {} })).toThrow(/正文规则/);
  });

  it("正文规则无法降级时报错，不静默通过", () => {
    // 纯 JS 且内层没有可抢救的规则 —— 没有正文就读不了任何一章，必须拒
    expect(() =>
      convertLegadoSource({
        ...validSource,
        ruleContent: { content: "<js>result.text()</js>" },
      })
    ).toThrow(/正文规则无法翻译/);
  });

  it("目录规则需 JS 求值时转探测模式，仍可导入", () => {
    const result = convertLegadoSource({
      ...validSource,
      ruleToc: { ...validSource.ruleToc, chapterList: "{{java.ajax(url)}}" },
    });
    expect(result.config.tocMode).toBe("detect");
    expect(result.warnings.join()).toMatch(/目录规则不可用/);
  });

  /**
   * `+@js:` 是 Legado 列表规则的合并前缀。此前 JS 判别只看开头是否为
   * `@js:`，带前缀的会被当成选择器解析成碎片：源导入成功、目录永远为空
   * 且不报错。这是最难排查的一类失效，必须有回归。
   */
  it("+@js: 前缀的目录规则被识破，不当成选择器", () => {
    const result = convertLegadoSource({
      ...validSource,
      ruleToc: { ...validSource.ruleToc, chapterList: "+@js:(function(){return []})()" },
    });
    expect(result.config.tocMode).toBe("detect");
    expect(result.config.tocList).toBeNull();
  });

  it("CSS 头 + JS 尾的规则砍掉 JS 尾巴保留 CSS", () => {
    // JS 尾巴干的是去标签、解实体、删广告 —— 正文管线本来就做
    const result = convertLegadoSource({
      ...validSource,
      ruleContent: {
        content: "class.content@html@js:(function(){return String(result).trim()})()",
      },
    });
    expect(result.config.contentRule).toBe("class.content@html");
    expect(result.warnings.join()).toMatch(/JS 后处理/);
  });

  it("纯 JS 但内层是 java.getString('规则') 时取出内层规则", () => {
    const result = convertLegadoSource({
      ...validSource,
      ruleContent: {
        content:
          "@js:var c=java.getString('.mrx-cot@p@html');if(c&&c.length>50){result=c;}else{result='';}result",
      },
    });
    expect(result.config.contentRule).toBe(".mrx-cot@p@html");
    expect(result.warnings.join()).toMatch(/内层 CSS/);
  });

  it("JSONPath 目录规则现在可用（JSON 接口源）", () => {
    const result = convertLegadoSource({
      ...validSource,
      ruleToc: {
        chapterList: "$.data.chapters[*]",
        chapterName: "$.title",
        chapterUrl: "$.url",
      },
      ruleContent: { content: "$.data.content" },
    });
    expect(result.config.tocList).toBe("$.data.chapters[*]");
    expect(result.config.contentRule).toBe("$.data.content");
  });

  it("searchUrl 需要 JS 时只丢搜索能力，不拒整源", () => {
    const result = convertLegadoSource({
      ...validSource,
      searchUrl: '{{url=source.getKey();java.ajax(url)}}?kw={{key}}',
    });
    expect(result.config.searchUrl).toBeNull();
    expect(result.warnings.join()).toMatch(/搜索/);
    // 目录与正文照常保留
    expect(result.config.tocList).toBe("class.listmain@tag.dd");
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
    // 连正文规则都没有的源仍会被拒：那是硬门槛
    const bad = { bookSourceName: "坏源", bookSourceUrl: "https://b.example.com" };
    const result = parseLegadoJson(JSON.stringify([validSource, bad]));
    expect(result.converted).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.name).toBe("坏源");
    expect(result.failed[0]?.reason).toMatch(/正文规则/);
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

  /**
   * `{{page}}` 也必须替换掉。
   *
   * needsJsEvaluation 把它当纯文本占位而放行（确实不需要 JS），但此前这里
   * 不替换，地址里就留着字面量 `{{page}}`，请求必然 404 —— 合集里两成有
   * 搜索地址的源都是这种写法，表现为"搜索永远失败"，进而被验证判失败删掉。
   */
  it("替换 {{page}}，不把字面量留在地址里", () => {
    expect(buildSearchUrl("/s/{{key}}/{{page}}/", "修仙")).toBe(
      `/s/${encodeURIComponent("修仙")}/1/`
    );
    expect(buildSearchUrl("https://e.com/s?q={{key}}&p={{page}}", "abc")).toBe(
      "https://e.com/s?q=abc&p=1"
    );
    // 空格写法与大小写都要认
    expect(buildSearchUrl("/p/{{ page }}?s={{key}}", "abc")).toBe("/p/1?s=abc");
    expect(buildSearchUrl("/p/{{PAGE}}?s={{key}}", "abc")).toBe("/p/1?s=abc");
  });

  it("填完的地址里不再残留任何 {{}} 占位", () => {
    const built = buildSearchUrl("/s/{{key}}/{{page}}/", "修仙");
    expect(built).not.toMatch(/\{\{|\}\}/);
  });
});
