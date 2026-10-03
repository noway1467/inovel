import iconv from "iconv-lite";
import {
  parseRequestOptions,
  splitUrlAndOptions,
  type ParsedRequest,
} from "~/server/sources/url-options";

/** 只解释数字、page 与四则运算；不把第三方书源交给 eval/Function。 */
function pageExpression(expression: string, page: number): number | null {
  const source = expression.replace(/\bpage\b/gi, String(page)).replace(/\s+/g, "");
  if (!source || source.length > 128 || !/^[\d.()+*/%-]+$/.test(source)) return null;
  const tokens = source.match(/\d+(?:\.\d+)?|[()+*/%-]/g) ?? [];
  if (tokens.join("") !== source) return null;
  let at = 0;
  const atom = (): number => {
    const token = tokens[at++];
    if (token === "+") return atom();
    if (token === "-") return -atom();
    if (token === "(") {
      const value = sum();
      if (tokens[at++] !== ")") throw new Error("括号未闭合");
      return value;
    }
    if (!token || !/^\d/.test(token)) throw new Error("无效数字");
    return Number(token);
  };
  const product = (): number => {
    let value = atom();
    while (["*", "/", "%"].includes(tokens[at] ?? "")) {
      const operator = tokens[at++];
      const right = atom();
      value = operator === "*" ? value * right : operator === "/" ? value / right : value % right;
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (["+", "-"].includes(tokens[at] ?? "")) {
      const operator = tokens[at++];
      const right = product();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  try {
    const result = sum();
    return at === tokens.length && Number.isFinite(result) && Math.abs(result) <= 1e9
      ? result
      : null;
  } catch {
    return null;
  }
}

function encodeKeyword(value: string, charset = "utf-8"): string {
  const encoding = charset.trim().toLowerCase();
  if (encoding === "utf-8" || encoding === "utf8") return encodeURIComponent(value);
  if (!["gbk", "gb2312", "gb18030", "big5", "big5-hkscs", "shift_jis", "sjis"].includes(encoding)) {
    throw new Error(`不支持搜索字符编码：${charset}`);
  }
  return [...iconv.encode(value, encoding)]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /^[A-Za-z0-9_.!~*'()-]$/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

type TemplateContext = {
  keyword: string;
  page: number;
  charset?: string;
  baseUrl: string;
  mode?: "encoded" | "raw" | "json";
};

function fillTemplate(template: string, context: TemplateContext): string {
  const { keyword, page, charset, baseUrl, mode = "encoded" } = context;
  const textValue = (value: string) =>
    mode === "json" ? JSON.stringify(value).slice(1, -1) : value;
  const keyValue = () =>
    mode === "encoded" ? encodeKeyword(keyword, charset) : textValue(keyword);
  if (template.replace(/\{\{[\s\S]*?\}\}/g, "").includes("{{"))
    throw new Error("搜索模板括号未闭合");
  if (/^\s*(?:@js:|<js>|(?:var|let|const|function)\s)/i.test(template)) {
    throw new Error("搜索地址需要执行不支持的 JS");
  }
  // 旧版裸占位只替换独立标识符，不改掉 searchKeyword 参数名，也不二次处理用户输入。
  const legacy = template
    .replace(/(?<![\w{])searchKey(?![\w}])/g, "{{key}}")
    .replace(/(?<![\w{])searchPage(?![\w}])/g, "{{page}}");
  return legacy.replace(/\{\{([\s\S]*?)\}\}/g, (_all, raw: string) => {
    const expression = raw.trim();
    if (/^(key|searchKey)$/i.test(expression)) return keyValue();
    if (/^(baseUrl|source\.getKey\(\))$/.test(expression)) return textValue(baseUrl);
    if (/^encodeURIComponent\(\s*(key|searchKey)\s*\)$/.test(expression))
      return encodeURIComponent(keyword);
    const encoded = /^java\.encodeURI\(\s*(?:key|searchKey)\s*,\s*(['"])([^'"]+)\1\s*\)\s*;?$/.exec(
      expression
    );
    if (encoded) return encodeKeyword(keyword, encoded[2]);
    const number = pageExpression(expression, page);
    if (number !== null) return String(number);
    throw new Error("搜索模板包含不支持的表达式");
  });
}

/** 保留旧的纯 URL 构建入口；请求选项必须先拆开，不能一起塞给 new URL。 */
export function renderSearchUrl(template: string, keyword: string, page = 1): string {
  return fillTemplate(template, { keyword, page, baseUrl: "" });
}

/** 数据格式解析、插值、请求编码各做一遍，避免 JSON 被关键词中的引号破坏或表单被 & 注入。 */
export function buildSearchRequest(
  template: string,
  keyword: string,
  baseUrl: string,
  headers: Record<string, string> = {},
  page = 1
): ParsedRequest {
  const split = splitUrlAndOptions(template);
  const options = parseRequestOptions(split.optionsText);
  const context: TemplateContext = { keyword, page, baseUrl, charset: options.charset };
  const requestHeaders: Record<string, string> = {};
  for (const map of [headers, options.headers ?? {}]) {
    for (const [name, value] of Object.entries(map)) {
      if (/^(host|content-length|connection)$/i.test(name)) continue;
      requestHeaders[name.toLowerCase()] = fillTemplate(value, { ...context, mode: "raw" });
    }
  }
  let body = options.body;
  if (body !== undefined) {
    const isJson = /json/i.test(requestHeaders["content-type"] ?? "") || /^\s*[[{]/.test(body);
    body = fillTemplate(body, { ...context, mode: isJson ? "json" : "encoded" });
    if (isJson) {
      try {
        JSON.parse(body);
      } catch {
        throw new Error("搜索请求体不是合法 JSON");
      }
      requestHeaders["content-type"] ??= "application/json; charset=utf-8";
    } else {
      requestHeaders["content-type"] ??= "application/x-www-form-urlencoded";
    }
  }
  const urlTemplate = split.url.replace(
    /<([^,>]*),([^>]*)>/g,
    (_all, first: string, rest: string) => (page <= 1 ? first : rest)
  );
  const url = new URL(fillTemplate(urlTemplate, context), baseUrl).toString();
  if (!/^https?:\/\//i.test(url)) throw new Error("搜索地址仅支持 HTTP/HTTPS");
  return { url, options: { ...options, body, headers: requestHeaders } };
}

/** 导入与执行共用同一套判断，避免导入时放行、搜索时才发现根本无法处理。 */
export function supportsSearchRequest(template: string): boolean {
  try {
    buildSearchRequest(template, "测试", "https://example.com/");
    return true;
  } catch {
    return false;
  }
}
