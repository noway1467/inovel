/**
 * 正文净化规则（书源的 replaceRegex）。
 *
 * 书源作者自己写好了清理规则，专治正文里的广告、"本章未完"、"一秒记住…"、
 * 页码标记这类删不掉的杂物。合集实测 600 源里 76 个带、扁平清单 50 源里 17 个带，
 * 而我们此前把这条规则整个丢掉了。
 *
 * ## 安全边界（重要）
 *
 * 这些正则来自第三方书源，跑在 Workers 上，而 JS 的正则没有超时机制：
 * 一条灾难性回溯的模式（`(a+)+$` 那类）配上长正文能把 CPU 烧穿，
 * 直接触发 Error 1102 —— 正是我们在别处极力避免的那个错误。
 *
 * 所以这里逐条设限：条数、模式长度、明显会回溯爆炸的形状一律拒收，
 * 编译或执行出错就跳过那一条而不是让整章失败。宁可少净化一条，
 * 不能让一个源的规则把整个 Worker 拖垮。
 */

export interface PurifyRule {
  pattern: string;
  replacement: string;
}

/** 单个源最多用几条规则。实测最多的源写了 10 条上下，20 足够且有余量。 */
const maxRules = 20;
/** 单条模式最长多少字符。超长的多半是把整段 JS 塞进来了。 */
const maxPatternLength = 300;
/** 正文超过这个长度就不跑净化：越长越容易被病态模式拖死 */
const maxTextLength = 500_000;

/**
 * 明显有灾难性回溯风险的形状。
 *
 * 判据是「量词套量词」：`(x+)+`、`(x*)*`、`(x+)*` 这类嵌套一旦不匹配，
 * 回溯路径随输入长度指数增长。宁可误拒几条，也不能让 Worker 卡死。
 */
const catastrophicShapes = [
  /\([^)]*[+*]\)[+*]/, // (a+)+ / (a*)*
  /\([^)]*\{\d+,\}\)[+*]/, // (a{2,})+
  /\[[^\]]*\][+*][^)]*\)[+*]/, // ([a-z]+)+ 变体
];

function isRiskyPattern(pattern: string): boolean {
  if (pattern.length > maxPatternLength) return true;
  return catastrophicShapes.some((shape) => shape.test(pattern));
}

/** 模式能否编译成正则；不能就整条丢掉 */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "gm");
  } catch {
    return null;
  }
}

/**
 * 解析 replaceRegex。四种真实格式都要认：
 *
 * 1. `##正则`              匹配即删
 * 2. `##正则##替换`         替换成给定文本
 * 3. `[{"pattern":…,"replacement":…}]`  JSON 对象数组
 * 4. `["正则1","正则2"]`    JSON 字符串数组，每条都是要删的
 *
 * 另外整段可能带 JS 尾（`##A##B@js:result.replace(...)`）：JS 部分执行不了，
 * 但前面的正则是有效的，砍掉尾巴保留主体 —— 与规则层对 JS 的处理一致。
 */
export function parsePurifyRules(raw: unknown): PurifyRule[] {
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text) return [];

  // JSON 数组形式
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => {
          if (typeof item === "string") return { pattern: item, replacement: "" };
          if (item && typeof item === "object") {
            const record = item as { pattern?: unknown; replacement?: unknown };
            if (typeof record.pattern === "string") {
              return {
                pattern: record.pattern,
                replacement: typeof record.replacement === "string" ? record.replacement : "",
              };
            }
          }
          return null;
        })
        .filter((item): item is PurifyRule => item !== null && Boolean(item.pattern.trim()))
        .slice(0, maxRules);
    } catch {
      return [];
    }
  }

  /**
   * `##` 形式。可能有多条，用换行分隔；每条自身又可能是 `##A##B`。
   * 先砍掉 JS 尾 —— 那部分我们执行不了，但前面的正则仍然有效。
   */
  const withoutJs = text.split(/@js:|<js>/i)[0] ?? "";
  return withoutJs
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const body = line.startsWith("##") ? line.slice(2) : line;
      const at = body.indexOf("##");
      if (at < 0) return { pattern: body, replacement: "" };
      return { pattern: body.slice(0, at), replacement: body.slice(at + 2) };
    })
    .filter((rule) => rule.pattern.trim().length > 0)
    .slice(0, maxRules);
}

/** 过滤掉编译不了或有回溯风险的规则，返回可安全执行的 */
export function safeRules(rules: PurifyRule[]): { rule: PurifyRule; regex: RegExp }[] {
  const out: { rule: PurifyRule; regex: RegExp }[] = [];
  for (const rule of rules) {
    if (isRiskyPattern(rule.pattern)) continue;
    const regex = compile(rule.pattern);
    if (!regex) continue;
    out.push({ rule, regex });
  }
  return out;
}

/**
 * 对整段正文套用净化规则。
 *
 * 单条规则执行抛错时只跳过那一条，不让整章失败 —— 净化是增益，
 * 不该因为一条坏规则读不了书。
 */
export function purifyText(text: string, raw: unknown): string {
  if (!text || text.length > maxTextLength) return text;
  const rules = safeRules(parsePurifyRules(raw));
  if (rules.length === 0) return text;

  let out = text;
  for (const { rule, regex } of rules) {
    try {
      out = out.replace(regex, rule.replacement);
    } catch {
      // 这一条不适用就跳过
    }
  }
  return out;
}

/** 逐段净化，净化后变空的段落丢掉 —— 整段都是广告的情况很常见 */
export function purifyParagraphs(paragraphs: string[], raw: unknown): string[] {
  const rules = safeRules(parsePurifyRules(raw));
  if (rules.length === 0) return paragraphs;

  const out: string[] = [];
  for (const paragraph of paragraphs) {
    let line = paragraph;
    for (const { rule, regex } of rules) {
      try {
        line = line.replace(regex, rule.replacement);
      } catch {
        // 跳过这一条
      }
    }
    const trimmed = line.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}
