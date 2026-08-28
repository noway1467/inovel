/**
 * Legado 的「地址 + 选项」语法与其中几种窄变量求值。
 *
 * 书源里不少目录/正文地址不是普通 GET，而是这种形态：
 *
 *   {{java.put("url",baseUrl); "https://ixdzs8.com/novel/clist/"}},{
 *     "body": "bid={{baseUrl.match(/(\d+).$/)[1]}}",
 *     "headers": { "X-Requested-With": "XMLHttpRequest" },
 *     "method": "POST"
 *   }
 *
 * 也就是源站「完整目录」按钮背后的接口 —— 目录是一次 POST 拿回来的 JSON。
 * 这类源此前一律判「需要 JS」被降级，只能从详情页刮到最新几章
 * （实测某本书 570 章只拿到 9 章）。
 *
 * ## 为什么不上 JS 引擎
 *
 * Workers 里没有可用的沙箱，塞一个解释器进来风险和体积都不划算。但实际用到的
 * JS 只有三种窄模式，都是纯字符串操作：
 *
 *  1. `java.put("k", baseUrl)` —— 把 baseUrl 存进变量表，返回值取分号后的字面量
 *  2. `baseUrl.match(/正则/)[n]` —— 从地址里取出书号
 *  3. `@get:{k}` —— 把存过的变量读回来
 *
 * 只认这三种，其它照旧判「需要 JS」。宁可少支持一类源，不要算出个错地址
 * 然后抓回一堆 404。
 */

export interface RequestOptions {
  method: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  charset?: string;
}

export interface ParsedRequest {
  url: string;
  options: RequestOptions;
}

/**
 * 把 `地址,{选项}` 拆开。
 *
 * 逗号不能简单 split —— 地址本身可能含逗号，选项里更是到处有。
 * 判据是「第一个后面紧跟 { 的逗号」，且该 { 一直延伸到字符串末尾。
 */
export function splitUrlAndOptions(raw: string): { url: string; optionsText: string | null } {
  const text = raw.trim();
  const at = text.search(/,\s*\{/);
  if (at < 0) return { url: text, optionsText: null };
  const optionsText = text.slice(at + 1).trim();
  // 选项必须是个完整对象，否则那个逗号只是地址的一部分
  if (!optionsText.startsWith("{") || !optionsText.endsWith("}")) {
    return { url: text, optionsText: null };
  }
  return { url: text.slice(0, at).trim(), optionsText };
}

/**
 * 解析选项对象。
 *
 * 真实书源里这段常常不是严格 JSON：body 的值用单引号包着
 * （`"body": '{"chapterId":123}'`），JSON.parse 直接报错。所以先按严格 JSON 试，
 * 失败再退回逐字段正则取值 —— 只取我们用得上的四个字段。
 */
export function parseRequestOptions(optionsText: string | null): RequestOptions {
  const fallback: RequestOptions = { method: "GET" };
  if (!optionsText) return fallback;

  try {
    const parsed = JSON.parse(optionsText) as Record<string, unknown>;
    return normalizeOptions(parsed);
  } catch {
    // 单引号 body 之类的非严格 JSON：逐字段取
    const pick = (key: string): string | undefined => {
      const match = new RegExp(`["']${key}["']\\s*:\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(optionsText);
      return match?.[2];
    };
    const method = pick("method")?.toUpperCase() === "POST" ? "POST" : "GET";
    const body = pick("body");
    const charset = pick("charset");

    // headers 是个嵌套对象，单独抓出来再按键值扫
    const headersText = /["']headers["']\s*:\s*\{([\s\S]*?)\}/i.exec(optionsText)?.[1];
    const headers: Record<string, string> = {};
    if (headersText) {
      const pattern = /["']([^"']+)["']\s*:\s*["']([\s\S]*?)["']/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(headersText)) !== null) {
        if (match[1] && match[2] !== undefined) headers[match[1]] = match[2];
      }
    }

    return {
      method,
      ...(body ? { body } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(charset ? { charset } : {}),
    };
  }
}

function normalizeOptions(parsed: Record<string, unknown>): RequestOptions {
  const method = String(parsed.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const headers: Record<string, string> = {};
  if (parsed.headers && typeof parsed.headers === "object") {
    for (const [key, value] of Object.entries(parsed.headers as Record<string, unknown>)) {
      if (typeof value === "string") headers[key] = value;
    }
  }
  return {
    method,
    ...(typeof parsed.body === "string" ? { body: parsed.body } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(typeof parsed.charset === "string" ? { charset: parsed.charset } : {}),
  };
}

/** 变量表：`java.put` 存进去，`@get:{k}` 读回来 */
export type VarStore = Map<string, string>;

/**
 * `{{java.put("k", baseUrl); "字面量"}}` —— 存变量并返回分号后的字面量。
 *
 * 这是书源里最常见的一种写法：把当前书的地址存下来，稍后拼章节地址时读回。
 */
const putPattern =
  /^java\.put\(\s*["']([^"']+)["']\s*,\s*baseUrl\s*\)\s*;\s*["']([^"']*)["']\s*$/;

/** `baseUrl.match(/正则/)[n]` —— 从地址里取一段（通常是书号） */
const matchPattern = /^baseUrl\.match\(\s*\/(.+?)\/([gimsuy]*)\s*\)\s*\[\s*(\d+)\s*\]$/;

/**
 * 求值一个 `{{...}}` 表达式。认不出就返回 null，由调用方判定「需要 JS」。
 *
 * @param expr 花括号里的内容
 * @param baseUrl 当前书的地址
 * @param vars 变量表，java.put 会写入
 */
export function evalNarrowExpression(
  expr: string,
  baseUrl: string,
  vars: VarStore
): string | null {
  const trimmed = expr.trim();

  const put = putPattern.exec(trimmed);
  if (put?.[1] !== undefined) {
    vars.set(put[1], baseUrl);
    return put[2] ?? "";
  }

  const matched = matchPattern.exec(trimmed);
  if (matched?.[1] !== undefined) {
    try {
      const regex = new RegExp(matched[1], matched[2] ?? "");
      const result = regex.exec(baseUrl);
      const index = Number(matched[3]);
      return result?.[index] ?? "";
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * 套用一个地址模板：替换 `{{...}}` 与 `@get:{k}`。
 *
 * 认不出的表达式让整个模板作废（返回 null）—— 半套出来的地址必然是错的，
 * 抓回来只会是 404 或别人的书。
 */
export function applyTemplate(
  template: string,
  context: { baseUrl: string; vars: VarStore; extra?: Record<string, string> }
): string | null {
  let failed = false;

  // 先处理 @get:{k}：读回 java.put 存的变量
  let out = template.replace(/@get:\{([^}]+)\}/g, (_all, key: string) => {
    const value = context.vars.get(key.trim());
    if (value === undefined) {
      failed = true;
      return "";
    }
    return value;
  });
  if (failed) return null;

  out = out.replace(/\{\{([\s\S]*?)\}\}/g, (all, rawExpr: string) => {
    const expr = rawExpr.trim();

    // 调用方给的直接替换值（如 JSONPath 取出的 ordernum）
    if (context.extra && expr in context.extra) return context.extra[expr]!;

    const narrow = evalNarrowExpression(expr, context.baseUrl, context.vars);
    if (narrow !== null) return narrow;

    failed = true;
    return all;
  });

  return failed ? null : out;
}

/**
 * 模板里的表达式我们是否都认得 —— 导入时判断该源要不要降级。
 *
 * 注意这里问的不是"现在能不能算出值"，而是"运行时认不认得"。两类占位在
 * 转换阶段必然没有值，但运行时有：
 *
 *  - `@get:{k}` 读的变量由另一条规则的 java.put 存入（目录地址规则存、
 *    章节地址规则读），转换时那条规则还没执行
 *  - `{{$.x}}` 读的是目录条目里的字段，要等真的取回目录才有
 *
 * 早先按"空变量表能否套出结果"来判，把这两类全判成不支持 —— 于是目录走
 * JSON 接口的源仍旧整组降级，白做了 POST 支持。
 */
export function templateIsSupported(
  template: string,
  sampleBaseUrl = "https://example.com/read/1/"
): boolean {
  // 先把运行时才有值的占位替换成样例，只校验剩下的表达式
  const probe = template
    .replace(/@get:\{[^}]+\}/g, "https://example.com/read/1/")
    .replace(/\{\{\s*\$\.[^}]*\}\}/g, "1");
  return applyTemplate(probe, { baseUrl: sampleBaseUrl, vars: new Map() }) !== null;
}
