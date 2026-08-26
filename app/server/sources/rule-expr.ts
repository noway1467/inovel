import { innerHtml, queryAll } from "~/server/sources/html";
import {
  evalJsonPath,
  isJsonPath,
  jsonValueToText,
  type JsonValue,
} from "~/server/sources/json-path";
import { textNodeName, textOf, type XmlNode } from "~/server/sources/xml";

/**
 * 规则表达式求值，兼容开源阅读（Legado）书源方言。
 *
 * 支持：
 *   class.listmain@tag.dd@tag.a@text   点号方言 + @ 链
 *   @css:.chapters li a@href           显式 CSS
 *   #content@html                      id 简写
 *   tag.div.2@text                     同名标签取第 3 个（0 基）
 *   em.-1@text                         负索引从后取
 *   option!0@value                     排除第 0 个（支持 !0,2 与 !0:2 区间）
 *   img@data-original||img@src         || 备选：前者取空则用后者
 *   $.data.list[0].name                JSONPath，用于 JSON 接口源
 *   ...@text##第\d+章\s*##              尾部正则清洗
 *
 * 不支持：<js> 求值（Workers 里没有安全沙箱）、XPath。
 */

export type ExtractTarget =
  | { kind: "text" }
  | { kind: "textNodes" }
  | { kind: "html" }
  | { kind: "attr"; name: string }
  | { kind: "element" };

/** 被求值的文档：HTML 树或 JSON 值 */
export type RuleDoc =
  | { kind: "html"; node: XmlNode }
  | { kind: "json"; value: JsonValue };

export function htmlDoc(node: XmlNode): RuleDoc {
  return { kind: "html", node };
}

export function jsonDoc(value: JsonValue): RuleDoc {
  return { kind: "json", value };
}

/** || 分隔出的一个备选分支 */
export interface SingleRule {
  selector: string;
  target: ExtractTarget;
  /** 非空时走 JSONPath 分支 */
  jsonPath: string | null;
  /** !n 排除的下标，负数表示从后计 */
  excludeIndexes: number[];
}

export interface ParsedRule {
  /** 按顺序尝试，第一个有结果的生效 */
  alternatives: SingleRule[];
  cleanups: { pattern: RegExp; replacement: string }[];
}

export class UnsupportedRuleError extends Error {}

const attrTargets: Record<string, ExtractTarget> = {
  text: { kind: "text" },
  textnodes: { kind: "textNodes" },
  html: { kind: "html" },
  all: { kind: "html" },
  content: { kind: "html" },
  owntext: { kind: "text" },
};

/** 解析 !0,2 与 !0:2 形式的排除下标 */
function parseExclusions(raw: string): { body: string; excludes: number[] } {
  const excludes: number[] = [];
  const body = raw.replace(/!(-?\d+(?::-?\d+)?(?:,-?\d+(?::-?\d+)?)*)/g, (_m, spec: string) => {
    for (const part of spec.split(",")) {
      if (part.includes(":")) {
        const [fromRaw, toRaw] = part.split(":");
        const from = Number.parseInt(fromRaw ?? "", 10);
        const to = Number.parseInt(toRaw ?? "", 10);
        if (Number.isFinite(from) && Number.isFinite(to)) {
          const lo = Math.min(from, to);
          const hi = Math.max(from, to);
          for (let i = lo; i <= hi; i += 1) excludes.push(i);
        }
        continue;
      }
      const at = Number.parseInt(part, 10);
      if (Number.isFinite(at)) excludes.push(at);
    }
    return "";
  });
  return { body, excludes };
}

/** 点号方言的一段翻译成 CSS：class.name.2 → .name:eq(2) */
function segmentToCss(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return "";

  /**
   * `.name.2` / `#id.2` 形态：末段是纯数字时表示序号，不是第二个 class。
   *
   * 此前原样透传，CSS 会理解成「同时具有 name 和 2 两个 class」——
   * 永远选不中，而且不报错。真实书源里 `.chapter.1@tag.li`
   * `.section-list.1@a` 都是这种写法，是「目录规则未命中」的一类根因。
   */
  const indexedCss = /^([.#][\w-]+)\.(-?\d+)$/.exec(trimmed);
  if (indexedCss) {
    return `${indexedCss[1]}:eq(${Number.parseInt(indexedCss[2] ?? "0", 10)})`;
  }

  // 已经是 CSS 形态（含 . # [ 前缀或组合子）时原样返回
  if (/^[.#[]/.test(trimmed) || /[>+\s,]/.test(trimmed)) return trimmed;

  const parts = trimmed.split(".");
  const head = parts[0]?.toLowerCase() ?? "";
  const name = parts[1] ?? "";
  const indexPart = parts[2];
  const index = indexPart !== undefined ? Number.parseInt(indexPart, 10) : undefined;
  const suffix = index !== undefined && Number.isFinite(index) ? `:eq(${index})` : "";

  switch (head) {
    case "class":
      return name ? `.${name}${suffix}` : "";
    case "id":
      return name ? `#${name}${suffix}` : "";
    case "tag":
      return name ? `${name}${suffix}` : "";
    case "children":
      return `> *${suffix}`;
    case "text":
      /**
       * text.关键字 = 「文本包含该串的节点」，jsoup 的 :containsOwn 方言。
       *
       * 这是分页规则里最常见的形态（`text.下一页@href` 在真实合集里
       * 出现频率最高）。此前直接抛错，等于分页功能整体不可用。
       * 译成 :contains，由 CSS 引擎做文本匹配。
       */
      return name ? `*:contains(${name})${suffix}` : "";
    default:
      // 裸标签名，可能带索引：div.2 / em.-1
      if (parts.length >= 2 && Number.isFinite(Number.parseInt(parts[1] ?? "", 10))) {
        return `${head}:eq(${Number.parseInt(parts[1] ?? "0", 10)})`;
      }
      return trimmed;
  }
}

function parseCleanups(raw: string): { body: string; cleanups: ParsedRule["cleanups"] } {
  const cleanups: ParsedRule["cleanups"] = [];
  let body = raw;
  const marker = body.indexOf("##");
  if (marker !== -1) {
    const tail = body.slice(marker + 2);
    body = body.slice(0, marker);
    const segments = tail.split("##");
    for (let i = 0; i < segments.length; i += 2) {
      const pattern = segments[i];
      if (!pattern) continue;
      try {
        cleanups.push({ pattern: new RegExp(pattern, "g"), replacement: segments[i + 1] ?? "" });
      } catch {
        throw new UnsupportedRuleError(`正则不合法：${pattern}`);
      }
    }
  }
  return { body, cleanups };
}

/** 解析单个备选分支（不含 || 与 ##） */
function parseSingle(input: string): SingleRule {
  const trimmed = input.trim();
  if (!trimmed) throw new UnsupportedRuleError("规则分支为空");

  // JSONPath 分支：整段就是路径，可选 @text 之类的尾巴无意义，直接用路径
  if (isJsonPath(trimmed)) {
    return { selector: "", target: { kind: "text" }, jsonPath: trimmed, excludeIndexes: [] };
  }

  const { body: withoutExcludes, excludes } = parseExclusions(trimmed);

  let working = withoutExcludes.trim();
  let explicitCss = false;
  if (working.startsWith("@css:")) {
    working = working.slice(5).trim();
    explicitCss = true;
  }

  const segments = working.split("@").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) throw new UnsupportedRuleError(`规则无法解析：${input}`);

  let target: ExtractTarget = { kind: "text" };
  const last = segments[segments.length - 1] ?? "";
  const lastLower = last.toLowerCase();
  if (attrTargets[lastLower]) {
    target = attrTargets[lastLower]!;
    segments.pop();
  } else if (/^(href|src|title|alt|value|content|data-[\w-]+)$/i.test(last)) {
    target = { kind: "attr", name: lastLower };
    segments.pop();
  } else if (lastLower.startsWith("attr.")) {
    target = { kind: "attr", name: last.slice(5).toLowerCase() };
    segments.pop();
  }

  const selector = explicitCss
    ? segments.join(" ")
    : segments.map(segmentToCss).filter(Boolean).join(" ");

  return { selector, target, jsonPath: null, excludeIndexes: excludes };
}

export function parseRule(raw: string): ParsedRule {
  const input = (raw ?? "").trim();
  if (!input) throw new UnsupportedRuleError("规则为空");

  if (input.includes("<js>") || input.startsWith("@js:") || input.includes("{{") ) {
    throw new UnsupportedRuleError("不支持 JS 规则（<js> 或 {{}} 模板），请改用 CSS 或 JSONPath");
  }
  if (input.startsWith("//") || input.startsWith("@xpath:") || input.startsWith("@XPath:")) {
    throw new UnsupportedRuleError("不支持 XPath 规则，请改用 CSS 规则");
  }

  // 先剥清洗段，再拆 || —— 否则 ## 里的正则可能含 |
  const { body, cleanups } = parseCleanups(input);
  const branches = body
    .split("||")
    .map((s) => s.trim())
    .filter(Boolean);
  if (branches.length === 0) throw new UnsupportedRuleError(`规则无法解析：${raw}`);

  /**
   * 单个分支不支持时丢弃它，只要还有分支可用就不算失败 —— 这正是 ||
   * 的语义。真实合集里就有 `text.关键字@href||tag.a.0@href` 这种：
   * 前者用了不支持的文本筛选，后者是能用的普通选择器，整条判失败等于
   * 白白丢掉一个可用的源。
   */
  const alternatives: SingleRule[] = [];
  let lastError: Error | null = null;
  for (const branch of branches) {
    try {
      alternatives.push(parseSingle(branch));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (alternatives.length === 0) {
    throw lastError ?? new UnsupportedRuleError(`规则无法解析：${raw}`);
  }
  return { alternatives, cleanups };
}

function applyCleanups(value: string, cleanups: ParsedRule["cleanups"]): string {
  let out = value;
  for (const { pattern, replacement } of cleanups) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}

/** 只取直接文本子节点，用于 @textNodes */
function directText(node: XmlNode): string {
  return node.children
    .filter((child) => child.name === textNodeName)
    .map((child) => child.text.trim())
    .filter(Boolean)
    .join("\n");
}

export function extractFrom(node: XmlNode, target: ExtractTarget): string {
  switch (target.kind) {
    case "text":
      return textOf(node);
    case "textNodes":
      return directText(node);
    case "html":
      return innerHtml(node);
    case "attr":
      return node.attrs[target.name] ?? "";
    case "element":
      return textOf(node);
  }
}

function applyExclusions<T>(items: T[], excludes: number[]): T[] {
  if (excludes.length === 0) return items;
  const resolved = new Set(excludes.map((at) => (at < 0 ? items.length + at : at)));
  return items.filter((_, index) => !resolved.has(index));
}

/** 求出一个分支命中的节点（HTML）或值（JSON） */
function evalBranchNodes(doc: RuleDoc, rule: SingleRule): RuleDoc[] {
  if (rule.jsonPath) {
    if (doc.kind !== "json") return [];
    const values = applyExclusions(evalJsonPath(doc.value, rule.jsonPath), rule.excludeIndexes);
    return values.map((value) => jsonDoc(value));
  }
  if (doc.kind !== "html") return [];
  const nodes = rule.selector ? queryAll(doc.node, rule.selector) : [doc.node];
  return applyExclusions(nodes, rule.excludeIndexes).map((node) => htmlDoc(node));
}

function extractDoc(doc: RuleDoc, target: ExtractTarget): string {
  if (doc.kind === "json") return jsonValueToText(doc.value);
  return extractFrom(doc.node, target);
}

/** 求值成单个字符串，按 || 顺序取第一个非空结果 */
export function evalRuleOne(doc: RuleDoc, rule: string): string {
  const parsed = parseRule(rule);
  for (const branch of parsed.alternatives) {
    const nodes = evalBranchNodes(doc, branch);
    const first = nodes[0];
    if (!first) continue;
    const value = applyCleanups(extractDoc(first, branch.target), parsed.cleanups);
    // || 的语义是"前者取空则用后者"，所以空串要继续尝试下一分支
    if (value) return value;
  }
  return "";
}

/** 求值成字符串数组，按 || 顺序取第一个有结果的分支 */
export function evalRuleAll(doc: RuleDoc, rule: string): string[] {
  const parsed = parseRule(rule);
  for (const branch of parsed.alternatives) {
    const nodes = evalBranchNodes(doc, branch);
    const values = nodes
      .map((node) => applyCleanups(extractDoc(node, branch.target), parsed.cleanups))
      .filter((value) => value.length > 0);
    if (values.length > 0) return values;
  }
  return [];
}

/** 求值成节点列表，供"列表规则 + 每项子规则"的嵌套提取 */
export function evalRuleNodes(doc: RuleDoc, rule: string): RuleDoc[] {
  const parsed = parseRule(rule);
  for (const branch of parsed.alternatives) {
    const nodes = evalBranchNodes(doc, branch);
    if (nodes.length > 0) return nodes;
  }
  return [];
}

/** 规则是否可被本引擎理解 */
export function canParseRule(rule: string): boolean {
  try {
    parseRule(rule);
    return true;
  } catch {
    return false;
  }
}

