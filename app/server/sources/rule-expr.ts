import { innerHtml, queryAll } from "~/server/sources/html";
import { textNodeName, textOf, type XmlNode } from "~/server/sources/xml";

/**
 * 规则表达式求值，兼容开源阅读（Legado）书源的选择器方言。
 *
 * 支持的形态：
 *   class.listmain@tag.dd@tag.a@text     经典点号方言 + @ 链式
 *   @css:.chapters li a@href             显式 CSS
 *   #content@html                        id 简写
 *   tag.div.2@text                       同名标签取第 3 个（0 基）
 *   ...@text##第\d+章\s*##                尾部 ##正则##替换 清洗
 *
 * 不支持（遇到时明确报错，不静默出错）：JS 表达式 `<js>`、JSONPath `$.`、
 * XPath `//`。这些在书源里通常用于反爬对抗，超出本地规则引擎范畴。
 */

export type ExtractTarget =
  | { kind: "text" }
  | { kind: "textNodes" }
  | { kind: "html" }
  | { kind: "attr"; name: string }
  | { kind: "element" };

export interface ParsedRule {
  /** 翻译后的 CSS 选择器；空串表示作用于当前节点自身 */
  selector: string;
  target: ExtractTarget;
  /** ##pattern##replacement 清洗，可多段 */
  cleanups: { pattern: RegExp; replacement: string }[];
}

export class UnsupportedRuleError extends Error {}

const attrTargets: Record<string, ExtractTarget> = {
  text: { kind: "text" },
  textnodes: { kind: "textNodes" },
  html: { kind: "html" },
  all: { kind: "html" },
  content: { kind: "html" },
  ownText: { kind: "text" },
};

/** 点号方言的一段翻译成 CSS：class.name.2 → .name:eq(2) */
function segmentToCss(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return "";
  // 已经是 CSS 形态（含 . # [ 前缀或组合子）时原样返回
  if (/^[.#[]/.test(trimmed) || /[>\s,]/.test(trimmed)) return trimmed;

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
      // text.关键字 是"包含该文本的节点"，CSS 无对应能力
      throw new UnsupportedRuleError(`不支持按文本内容筛选：${trimmed}`);
    default:
      // 裸标签名，可能带索引：div.2
      if (parts.length >= 2 && Number.isFinite(Number.parseInt(parts[1] ?? "", 10))) {
        return `${head}:eq(${Number.parseInt(parts[1] ?? "0", 10)})`;
      }
      return trimmed;
  }
}

function parseCleanups(raw: string): { body: string; cleanups: ParsedRule["cleanups"] } {
  const cleanups: ParsedRule["cleanups"] = [];
  let body = raw;
  // 形如 ##pattern##replacement 或 ##pattern
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

export function parseRule(raw: string): ParsedRule {
  const input = (raw ?? "").trim();
  if (!input) throw new UnsupportedRuleError("规则为空");

  if (input.includes("<js>") || input.startsWith("@js:")) {
    throw new UnsupportedRuleError("不支持 JS 规则（<js>），请改用 CSS 规则");
  }
  if (input.startsWith("$.") || input.startsWith("@json:")) {
    throw new UnsupportedRuleError("不支持 JSONPath 规则");
  }
  if (input.startsWith("//") || input.startsWith("@xpath:")) {
    throw new UnsupportedRuleError("不支持 XPath 规则，请改用 CSS 规则");
  }

  const { body, cleanups } = parseCleanups(input);

  let working = body.trim();
  let explicitCss = false;
  if (working.startsWith("@css:")) {
    working = working.slice(5).trim();
    explicitCss = true;
  }

  // 拆 @ 链。显式 CSS 时只把最后一段当提取目标，前面整体是选择器。
  const segments = working.split("@").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) throw new UnsupportedRuleError(`规则无法解析：${raw}`);

  let target: ExtractTarget = { kind: "text" };
  const last = segments[segments.length - 1] ?? "";
  const lastLower = last.toLowerCase();
  if (attrTargets[lastLower]) {
    target = attrTargets[lastLower]!;
    segments.pop();
  } else if (/^(href|src|title|alt|value|data-[\w-]+|content)$/i.test(last)) {
    target = { kind: "attr", name: lastLower };
    segments.pop();
  } else if (lastLower.startsWith("attr.")) {
    target = { kind: "attr", name: last.slice(5).toLowerCase() };
    segments.pop();
  }

  const selector = explicitCss
    ? segments.join(" ")
    : segments.map(segmentToCss).filter(Boolean).join(" ");

  return { selector, target, cleanups };
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

/** 求值成单个字符串，取第一个命中 */
export function evalRuleOne(root: XmlNode, rule: string): string {
  const parsed = parseRule(rule);
  const nodes = parsed.selector ? queryAll(root, parsed.selector) : [root];
  const first = nodes[0];
  if (!first) return "";
  return applyCleanups(extractFrom(first, parsed.target), parsed.cleanups);
}

/** 求值成字符串数组，全部命中 */
export function evalRuleAll(root: XmlNode, rule: string): string[] {
  const parsed = parseRule(rule);
  const nodes = parsed.selector ? queryAll(root, parsed.selector) : [root];
  return nodes
    .map((node) => applyCleanups(extractFrom(node, parsed.target), parsed.cleanups))
    .filter((value) => value.length > 0);
}

/** 求值成节点列表，供"列表规则 + 每项子规则"的嵌套提取 */
export function evalRuleNodes(root: XmlNode, rule: string): XmlNode[] {
  const parsed = parseRule(rule);
  return parsed.selector ? queryAll(root, parsed.selector) : [root];
}
