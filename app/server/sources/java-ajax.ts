/**
 * 常见 Legado `java.ajax` 正文规则的受限解释器。
 *
 * Legado 的 JS 规则理论上可以访问完整 Rhino/Java 运行时；Workers 没有 eval，
 * 也不可能安全照搬。这里只认一种常见形态：用 baseUrl/result 拼出 AJAX 地址，
 * 调 java.ajax 拿正文，再用若干 replaceAll 清理响应。这仍是一个兼容层，
 * 不是完整 JS 引擎；解析不过的规则会继续被拒绝，不会硬猜执行。
 */

export interface AjaxRuleContext {
  baseUrl: string;
  result: string;
  ajax: (url: string) => Promise<string>;
}

type Token =
  | { kind: "string"; value: string }
  | { kind: "regex"; pattern: string; flags: string }
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "punct"; value: string };

type Expr =
  | { type: "string"; value: string }
  | { type: "regex"; pattern: string; flags: string }
  | { type: "number"; value: number }
  | { type: "name"; name: string }
  | { type: "plus"; left: Expr; right: Expr }
  | { type: "member"; object: Expr; name: string }
  | { type: "call"; callee: Expr; args: Expr[] }
  | { type: "index"; object: Expr; index: Expr };

export class UnsupportedAjaxRuleError extends Error {}

const punct = new Set(["(", ")", "[", "]", ".", ",", "+", ";"]);

function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let at = 0;

  while (at < input.length) {
    const ch = input[at]!;
    if (/\s/.test(ch)) {
      at += 1;
      continue;
    }
    if (ch === "/" && input[at + 1] === "/") {
      at = input.indexOf("\n", at);
      if (at === -1) break;
      continue;
    }
    if (ch === "/" && input[at + 1] === "*") {
      const end = input.indexOf("*/", at + 2);
      if (end === -1) throw new UnsupportedAjaxRuleError("JS 注释未闭合");
      at = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      at += 1;
      let value = "";
      for (;;) {
        if (at >= input.length) throw new UnsupportedAjaxRuleError("字符串未闭合");
        const current = input[at]!;
        if (current === ch) {
          at += 1;
          break;
        }
        if (current === "\\") {
          const next = input[at + 1];
          if (next === undefined) throw new UnsupportedAjaxRuleError("字符串转义不完整");
          value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next;
          at += 2;
          continue;
        }
        value += current;
        at += 1;
      }
      out.push({ kind: "string", value });
      continue;
    }
    if (ch === "/") {
      at += 1;
      let pattern = "";
      let inClass = false;
      for (;;) {
        if (at >= input.length) throw new UnsupportedAjaxRuleError("正则未闭合");
        const current = input[at]!;
        if (current === "\\") {
          const next = input[at + 1];
          if (next === undefined) throw new UnsupportedAjaxRuleError("正则转义不完整");
          pattern += current + next;
          at += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) {
          at += 1;
          break;
        }
        pattern += current;
        at += 1;
      }
      const flags = input.slice(at).match(/^[gimsuy]*/)?.[0] ?? "";
      if (!/^(?:[gimsuy](?!.*[gimsuy]))*$/.test(flags)) {
        throw new UnsupportedAjaxRuleError("正则标志重复");
      }
      at += flags.length;
      out.push({ kind: "regex", pattern, flags });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const match = input.slice(at).match(/^\d+(?:\.\d+)?/);
      if (!match) throw new UnsupportedAjaxRuleError("数字无法解析");
      out.push({ kind: "number", value: Number(match[0]) });
      at += match[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const match = input.slice(at).match(/^[A-Za-z_$][\w$]*/);
      if (!match) throw new UnsupportedAjaxRuleError("标识符无法解析");
      out.push({ kind: "name", value: match[0] });
      at += match[0].length;
      continue;
    }
    if (punct.has(ch)) {
      out.push({ kind: "punct", value: ch });
      at += 1;
      continue;
    }
    throw new UnsupportedAjaxRuleError(`不支持的表达式字符：${ch}`);
  }
  return out;
}

class Parser {
  private at = 0;
  private expressionCount = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const expr = this.parsePlus();
    const terminator = this.peek();
    if (terminator?.kind === "punct" && terminator.value === ";") this.consume();
    if (this.at < this.tokens.length) throw new UnsupportedAjaxRuleError("表达式后面还有未支持代码");
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private consume(): Token {
    const token = this.peek();
    if (!token) throw new UnsupportedAjaxRuleError("表达式提前结束");
    this.at += 1;
    return token;
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token?.kind === "punct" && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.acceptPunct(value)) {
      throw new UnsupportedAjaxRuleError(`期望符号：${value}`);
    }
  }

  private parsePlus(): Expr {
    let left = this.parseChain();
    for (;;) {
      const operator = this.peek();
      if (!(operator?.kind === "punct" && operator.value === "+")) break;
      this.consume();
      left = { type: "plus", left, right: this.parseChain() };
    }
    return left;
  }

  private parseChain(): Expr {
    let expr = this.parseAtom();
    for (;;) {
      if (this.acceptPunct(".")) {
        const name = this.consume();
        if (name.kind !== "name") throw new UnsupportedAjaxRuleError("成员名必须是标识符");
        expr = { type: "member", object: expr, name: name.value };
        continue;
      }
      if (this.acceptPunct("(")) {
        const args: Expr[] = [];
        if (!this.acceptPunct(")")) {
          do {
            args.push(this.parsePlus());
          } while (this.acceptPunct(","));
          this.expectPunct(")");
        }
        expr = { type: "call", callee: expr, args };
        continue;
      }
      if (this.acceptPunct("[")) {
        const index = this.parsePlus();
        this.expectPunct("]");
        expr = { type: "index", object: expr, index };
        continue;
      }
      return expr;
    }
  }

  private parseAtom(): Expr {
    this.expressionCount += 1;
    if (this.expressionCount > 300) throw new UnsupportedAjaxRuleError("表达式过于复杂");

    const token = this.consume();
    if (token.kind === "string") return { type: "string", value: token.value };
    if (token.kind === "regex") {
      return { type: "regex", pattern: token.pattern, flags: token.flags };
    }
    if (token.kind === "number") return { type: "number", value: token.value };
    if (token.kind === "name") return { type: "name", name: token.value };
    if (token.kind === "punct" && token.value === "(") {
      const expr = this.parsePlus();
      this.expectPunct(")");
      return expr;
    }
    throw new UnsupportedAjaxRuleError("不支持的 JS 起始节点");
  }
}

function scriptOf(rule: string): string {
  const input = rule.trim();
  const wrapped = /^<js>([\s\S]*?)<\/js>$/i.exec(input);
  if (wrapped) return wrapped[1]!.trim();
  const at = /^@js:([\s\S]*)$/i.exec(input);
  if (at) return at[1]!.trim();
  throw new UnsupportedAjaxRuleError("不是整段 JS 规则");
}

function riskyRegex(pattern: string): boolean {
  return pattern.length > 300 || /\([^)]*[+*]\)[+*]/.test(pattern);
}

function javaReplaceAll(value: string, pattern: string, replacement: string): string {
  if (value.length > 500_000 || riskyRegex(pattern)) return value;
  try {
    return value.replace(new RegExp(pattern, "g"), replacement);
  } catch {
    return value;
  }
}

function toDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.join(",");
  throw new UnsupportedAjaxRuleError("表达式结果不是文本");
}

async function evalExpr(expr: Expr, context: AjaxRuleContext & { calls: number }): Promise<unknown> {
  switch (expr.type) {
    case "string":
      return expr.value;
    case "regex":
      return new RegExp(expr.pattern, expr.flags.replace("g", "").replace("y", ""));
    case "number":
      return expr.value;
    case "name":
      if (expr.name === "baseUrl") return context.baseUrl;
      if (expr.name === "result") return context.result;
      throw new UnsupportedAjaxRuleError(`不支持变量：${expr.name}`);
    case "plus":
      return toDisplay(await evalExpr(expr.left, context)) + toDisplay(await evalExpr(expr.right, context));
    case "member":
      if (expr.object.type === "name" && expr.object.name === "java" && expr.name === "ajax") return expr;
      if (expr.name === "length") {
        const value = await evalExpr(expr.object, context);
        if (typeof value === "string" || Array.isArray(value)) return value.length;
      }
      throw new UnsupportedAjaxRuleError(`不支持属性：${expr.name}`);
    case "index": {
      const value = await evalExpr(expr.object, context);
      const index = await evalExpr(expr.index, context);
      if ((Array.isArray(value) || typeof value === "string") && typeof index === "number") {
        return value[index];
      }
      throw new UnsupportedAjaxRuleError("下标只能用于文本或数组");
    }
    case "call":
      return evalCall(expr, context);
  }
}

async function evalCall(expr: Extract<Expr, { type: "call" }>, context: AjaxRuleContext & { calls: number }): Promise<unknown> {
  const callee = expr.callee;
  if (callee.type === "member" && callee.object.type === "name" && callee.object.name === "java" && callee.name === "ajax") {
    context.calls += 1;
    if (context.calls > 1) throw new UnsupportedAjaxRuleError("一条规则最多允许一次 java.ajax");
    const url = toDisplay(await evalExpr(expr.args[0]!, context));
    if (!/^https?:\/\//i.test(url)) throw new UnsupportedAjaxRuleError("java.ajax 只支持 http(s) 地址");
    return context.ajax(url);
  }
  if (callee.type === "name" && callee.name === "String") {
    return toDisplay(await evalExpr(expr.args[0]!, context));
  }
  if (callee.type !== "member") throw new UnsupportedAjaxRuleError("不支持的函数调用");

  const target = await evalExpr(callee.object, context);
  const args = await Promise.all(expr.args.map((arg) => evalExpr(arg, context)));
  if (typeof target !== "string") throw new UnsupportedAjaxRuleError(`不支持方法：${callee.name}`);

  switch (callee.name) {
    case "replace": {
      const [search, replacement] = args;
      if (search instanceof RegExp) return target.replace(search, toDisplay(replacement));
      return target.replace(toDisplay(search), toDisplay(replacement));
    }
    case "replaceAll": {
      const [search, replacement] = args;
      if (search instanceof RegExp) {
        return target.replace(new RegExp(search.source, search.flags.includes("g") ? search.flags : `${search.flags}g`), toDisplay(replacement));
      }
      return javaReplaceAll(target, toDisplay(search), toDisplay(replacement));
    }
    case "match": {
      const search = args[0];
      if (!(search instanceof RegExp)) throw new UnsupportedAjaxRuleError("match 只支持正则");
      return target.match(search);
    }
    case "trim":
      return target.trim();
    case "toString":
      return target;
    default:
      throw new UnsupportedAjaxRuleError(`不支持方法：${callee.name}`);
  }
}

export function isSupportedAjaxRule(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw.includes("java.ajax")) return false;
  try {
    const ast = new Parser(tokenize(scriptOf(raw))).parse();
    return usesSupportedNodes(ast);
  } catch {
    return false;
  }
}

function usesSupportedNodes(expr: Expr): boolean {
  switch (expr.type) {
    case "string":
    case "regex":
    case "number":
      return true;
    case "name":
      return expr.name === "baseUrl" || expr.name === "result" || expr.name === "java";
    case "plus":
      return usesSupportedNodes(expr.left) && usesSupportedNodes(expr.right);
    case "index":
      return usesSupportedNodes(expr.object) && usesSupportedNodes(expr.index);
    case "member": {
      const knownProperty =
        (expr.object.type === "name" && expr.object.name === "java" && expr.name === "ajax") ||
        expr.name === "length";
      const knownMethod = ["replace", "replaceAll", "match", "trim", "toString"].includes(expr.name);
      if (!knownProperty && !knownMethod) return false;
      return usesSupportedNodes(expr.object);
    }
    case "call": {
      const isAjax = expr.callee.type === "member" &&
        expr.callee.object.type === "name" &&
        expr.callee.object.name === "java" &&
        expr.callee.name === "ajax";
      if (!isAjax && !usesSupportedNodes(expr.callee)) return false;
      return expr.args.every(usesSupportedNodes);
    }
  }
}

export async function evalAjaxRule(
  rule: string,
  context: AjaxRuleContext
): Promise<string> {
  if (!isSupportedAjaxRule(rule)) throw new UnsupportedAjaxRuleError("这条 java.ajax 规则不受支持");
  const ast = new Parser(tokenize(scriptOf(rule))).parse();
  const value = await evalExpr(ast, { ...context, calls: 0 });
  return toDisplay(value);
}
