import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  evalNarrowExpression,
  parseRequestOptions,
  splitUrlAndOptions,
  templateIsSupported,
  type VarStore,
} from "~/server/sources/url-options";

/**
 * Legado 的「地址 + 选项」语法与窄变量求值。
 *
 * 真实来源：爱下电子书8（ixdzs8.com）。这个源的完整目录（570 章）藏在
 * POST /novel/clist/ 后面 —— 就是源站那个「完整目录」按钮。此前一律判
 * 「需要 JS」降级，只能从详情页刮到 9 章。
 */

/** 该源目录地址规则的原文 */
const ixdzsTocRule =
  '{{java.put("url",baseUrl);\n\t"https://ixdzs8.com/novel/clist/"}},{\n' +
  '  "body": "bid={{baseUrl.match(/(\\d+).$/)[1]}}",\n' +
  '  "headers": {\n' +
  '    "User-Agent": "Mozilla/5.0 (Linux; Android 9) Mobile Safari/537.36",\n' +
  '    "X-Requested-With": "XMLHttpRequest",\n' +
  '    "Referer":"{{baseUrl}}"\n' +
  "    },\n" +
  '  "method": "POST"\n' +
  "}";

describe("splitUrlAndOptions", () => {
  it("拆开地址与选项", () => {
    const { url, optionsText } = splitUrlAndOptions(ixdzsTocRule);
    expect(url).toContain("java.put");
    expect(url).not.toContain('"method"');
    expect(optionsText).toContain('"method": "POST"');
  });

  it("没有选项时原样返回", () => {
    expect(splitUrlAndOptions("https://example.com/list")).toEqual({
      url: "https://example.com/list",
      optionsText: null,
    });
  });

  it("地址里的逗号不会被误当成分隔符", () => {
    const raw = "https://example.com/a,b/list";
    expect(splitUrlAndOptions(raw).url).toBe(raw);
  });

  it("后面跟的不是完整对象时不拆", () => {
    const raw = "https://example.com/x,{不完整";
    expect(splitUrlAndOptions(raw).optionsText).toBeNull();
  });
});

describe("parseRequestOptions", () => {
  it("解析真实源的选项（body 用双引号，严格 JSON）", () => {
    const { optionsText } = splitUrlAndOptions(ixdzsTocRule);
    const options = parseRequestOptions(optionsText);
    expect(options.method).toBe("POST");
    expect(options.body).toContain("bid=");
    expect(options.headers?.["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  it("body 用单引号时也能解（非严格 JSON，书源里很常见）", () => {
    const text = `{ "body": '{"chapterId":123,"bookId":"456"}', "method": "POST" }`;
    const options = parseRequestOptions(text);
    expect(options.method).toBe("POST");
    expect(options.body).toBe('{"chapterId":123,"bookId":"456"}');
  });

  it("非严格 JSON 里的 headers 也能取出来", () => {
    const text = `{ 'method': 'POST', 'headers': { 'X-A': 'a', 'X-B': 'b' } }`;
    const options = parseRequestOptions(text);
    expect(options.headers).toEqual({ "X-A": "a", "X-B": "b" });
  });

  it("没有选项默认 GET", () => {
    expect(parseRequestOptions(null)).toEqual({ method: "GET" });
    expect(parseRequestOptions("{}").method).toBe("GET");
  });

  it("charset 能取出来（gbk 站的 POST 需要）", () => {
    expect(parseRequestOptions('{"charset":"gbk","method":"POST"}').charset).toBe("gbk");
  });
});

describe("evalNarrowExpression", () => {
  it("java.put 存下 baseUrl 并返回字面量", () => {
    const vars: VarStore = new Map();
    const out = evalNarrowExpression(
      'java.put("url",baseUrl);\n\t"https://ixdzs8.com/novel/clist/"',
      "https://ixdzs8.com/read/65688/",
      vars
    );
    expect(out).toBe("https://ixdzs8.com/novel/clist/");
    expect(vars.get("url")).toBe("https://ixdzs8.com/read/65688/");
  });

  it("baseUrl.match 取出书号", () => {
    const out = evalNarrowExpression(
      "baseUrl.match(/(\\d+).$/)[1]",
      "https://ixdzs8.com/read/65688/",
      new Map()
    );
    expect(out).toBe("65688");
  });

  it("认不出的表达式返回 null，不硬猜", () => {
    expect(evalNarrowExpression("java.ajax(url)", "https://x.com/", new Map())).toBeNull();
    expect(evalNarrowExpression("java.digestHex(s,'SHA-1')", "https://x.com/", new Map())).toBeNull();
    expect(evalNarrowExpression("source.getKey()", "https://x.com/", new Map())).toBeNull();
  });

  it("坏正则不抛错", () => {
    expect(evalNarrowExpression("baseUrl.match(/([unclosed/)[1]", "https://x.com/", new Map())).toBeNull();
  });
});

describe("applyTemplate", () => {
  it("完整套出 ixdzs8 的目录地址与 body", () => {
    const baseUrl = "https://ixdzs8.com/read/65688/";
    const vars: VarStore = new Map();
    const { url, optionsText } = splitUrlAndOptions(ixdzsTocRule);

    const resolved = applyTemplate(url, { baseUrl, vars });
    expect(resolved).toBe("https://ixdzs8.com/novel/clist/");

    const options = parseRequestOptions(optionsText);
    const body = applyTemplate(options.body!, { baseUrl, vars });
    expect(body).toBe("bid=65688");
  });

  it("@get: 读回 java.put 存的变量", () => {
    const vars: VarStore = new Map([["url", "https://ixdzs8.com/read/65688/"]]);
    // 该源的章节地址规则：@get:{url}p{{$.ordernum}}.html
    const out = applyTemplate("@get:{url}p{{ordernum}}.html", {
      baseUrl: "",
      vars,
      extra: { ordernum: "12" },
    });
    expect(out).toBe("https://ixdzs8.com/read/65688/p12.html");
  });

  it("变量没存过就作废，不给半个地址", () => {
    expect(applyTemplate("@get:{missing}x.html", { baseUrl: "", vars: new Map() })).toBeNull();
  });

  it("有一个表达式认不出就整条作废", () => {
    const out = applyTemplate("{{java.ajax(x)}}/list", {
      baseUrl: "https://x.com/",
      vars: new Map(),
    });
    expect(out).toBeNull();
  });

  it("没有占位的普通地址原样返回", () => {
    expect(applyTemplate("https://x.com/list.html", { baseUrl: "", vars: new Map() })).toBe(
      "https://x.com/list.html"
    );
  });
});

describe("templateIsSupported", () => {
  it("ixdzs8 的目录地址现在算受支持", () => {
    const { url } = splitUrlAndOptions(ixdzsTocRule);
    expect(templateIsSupported(url)).toBe(true);
  });

  it("真需要 JS 引擎的仍然不受支持", () => {
    // 爱下电子的另一个源：正文要 SHA-1 签名 + java.ajax
    expect(templateIsSupported("{{java.digestHex(s,'SHA-1')}}")).toBe(false);
    expect(templateIsSupported("{{source.getKey()}}/chapter/content")).toBe(false);
  });
});
