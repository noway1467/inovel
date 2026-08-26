/**
 * JSONPath 子集。真实书源里约 6% 用 JSONPath 取 JSON 接口的数据，
 * 而这类源恰恰是最稳定的（不依赖 HTML 结构）。
 *
 * 支持：$ 根、.key、[n]（负数从后取）、[*] 全部、..key 深度搜索、
 * 以及 $.a.b[0].c 这类混合链。不支持过滤表达式 [?(...)]。
 */

export type JsonValue = unknown;

type Step =
  | { kind: "key"; name: string }
  | { kind: "index"; at: number }
  | { kind: "all" }
  | { kind: "deep"; name: string };

export class JsonPathError extends Error {}

export function isJsonPath(rule: string): boolean {
  return rule.trim().startsWith("$");
}

export function parseJsonPath(raw: string): Step[] {
  let rest = raw.trim();
  if (!rest.startsWith("$")) throw new JsonPathError(`JSONPath 必须以 $ 开头：${raw}`);
  rest = rest.slice(1);

  const steps: Step[] = [];
  while (rest.length > 0) {
    // 深度搜索 ..key
    if (rest.startsWith("..")) {
      const match = /^\.\.([\w-]+)/.exec(rest);
      if (!match?.[1]) throw new JsonPathError(`无法解析深度搜索：${rest}`);
      steps.push({ kind: "deep", name: match[1] });
      rest = rest.slice(match[0].length);
      continue;
    }
    // .key
    if (rest.startsWith(".")) {
      const match = /^\.([\w-]+|\*)/.exec(rest);
      if (!match?.[1]) throw new JsonPathError(`无法解析字段：${rest}`);
      steps.push(match[1] === "*" ? { kind: "all" } : { kind: "key", name: match[1] });
      rest = rest.slice(match[0].length);
      continue;
    }
    // [n] / [*] / ['key']
    if (rest.startsWith("[")) {
      const end = rest.indexOf("]");
      if (end === -1) throw new JsonPathError(`括号未闭合：${rest}`);
      const body = rest.slice(1, end).trim();
      if (body === "*") {
        steps.push({ kind: "all" });
      } else if (/^-?\d+$/.test(body)) {
        steps.push({ kind: "index", at: Number.parseInt(body, 10) });
      } else if (/^['"].*['"]$/.test(body)) {
        steps.push({ kind: "key", name: body.slice(1, -1) });
      } else {
        throw new JsonPathError(`不支持的下标表达式：[${body}]`);
      }
      rest = rest.slice(end + 1);
      continue;
    }
    throw new JsonPathError(`无法解析 JSONPath 片段：${rest}`);
  }
  return steps;
}

function collectDeep(value: JsonValue, name: string, out: JsonValue[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectDeep(item, name, out);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(record)) {
      if (key === name) out.push(child);
      collectDeep(child, name, out);
    }
  }
}

/** 求值成节点数组；单值结果也包成一个元素的数组，调用方统一处理 */
export function evalJsonPath(root: JsonValue, raw: string): JsonValue[] {
  const steps = parseJsonPath(raw);
  let current: JsonValue[] = [root];

  for (const step of steps) {
    const next: JsonValue[] = [];
    for (const value of current) {
      if (step.kind === "key") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const child = (value as Record<string, JsonValue>)[step.name];
          if (child !== undefined) next.push(child);
        } else if (Array.isArray(value)) {
          // 对数组取字段时，逐项取（书源里常见的隐式展开）
          for (const item of value) {
            if (item && typeof item === "object") {
              const child = (item as Record<string, JsonValue>)[step.name];
              if (child !== undefined) next.push(child);
            }
          }
        }
        continue;
      }
      if (step.kind === "index") {
        if (!Array.isArray(value)) continue;
        const at = step.at < 0 ? value.length + step.at : step.at;
        if (at >= 0 && at < value.length) next.push(value[at]);
        continue;
      }
      if (step.kind === "all") {
        if (Array.isArray(value)) next.push(...value);
        else if (value && typeof value === "object") {
          next.push(...Object.values(value as Record<string, JsonValue>));
        }
        continue;
      }
      // deep
      collectDeep(value, step.name, next);
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

/** JSON 值转成展示用字符串；对象/数组返回空串（书源不会拿它们当文本） */
export function jsonValueToText(value: JsonValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    // 正文常见形态：段落字符串数组
    return value
      .filter((item) => typeof item === "string" || typeof item === "number")
      .join("\n")
      .trim();
  }
  return "";
}
