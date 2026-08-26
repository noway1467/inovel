import { decodeXmlEntities, stripBom, textNodeName, type XmlNode } from "~/server/sources/xml";

/**
 * 容错 HTML 解析 + CSS 子集查询。
 *
 * 为什么不用 HTMLRewriter：它是流式的，天然适合"改写"，但书源规则要做的是
 * "先选出章节列表容器，再对每个 li 分别取 a@text 和 a@href" —— 这种按项
 * 嵌套提取用流式接口写起来极易出错，而且离开 Workers 运行时就没法单测。
 *
 * 复用 xml.ts 的 XmlNode 结构，额外处理 HTML 的三件麻烦事：
 * 空元素（<br> 不闭合）、原始文本元素（script/style 内不解析标签）、
 * 隐式闭合（<li>a<li>b 里第一个 li 自动关闭）。
 */

const voidElements = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const rawTextElements = new Set(["script", "style", "textarea", "title"]);

/** 遇到 key 标签时，自动闭合仍开着的这些标签 */
const implicitClose: Record<string, Set<string>> = {
  li: new Set(["li"]),
  p: new Set(["p"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  tr: new Set(["tr", "td", "th"]),
  option: new Set(["option"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
};

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // 依次匹配：双引号、单引号、无引号、以及只有名字没有值的布尔属性
  const pattern = /([:\w.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const key = match[1];
    if (!key) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attrs[key.toLowerCase()] = decodeXmlEntities(value);
  }
  return attrs;
}

export function parseHtml(input: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let cursor = 0;
  // 去掉可能存在的 BOM，否则首个标签匹配不到
  const source = stripBom(input);

  const pushText = (chunk: string) => {
    if (!chunk) return;
    const current = stack[stack.length - 1];
    if (!current) return;
    const value = decodeXmlEntities(chunk);
    current.children.push({ name: textNodeName, attrs: {}, children: [], text: value });
    current.text += value;
  };

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) {
      pushText(source.slice(cursor));
      break;
    }
    if (open > cursor) pushText(source.slice(cursor, open));

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      const raw = end === -1 ? source.slice(open + 9) : source.slice(open + 9, end);
      const current = stack[stack.length - 1];
      if (current) {
        current.children.push({ name: textNodeName, attrs: {}, children: [], text: raw });
        current.text += raw;
      }
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", open) || source.startsWith("<?", open)) {
      const end = source.indexOf(">", open);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }

    const close = source.indexOf(">", open);
    if (close === -1) {
      pushText(source.slice(open));
      break;
    }
    const inner = source.slice(open + 1, close);

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]?.name === name) {
          stack.length = i;
          break;
        }
      }
      cursor = close + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const spaceAt = body.search(/\s/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).trim().toLowerCase();
    if (!name) {
      cursor = close + 1;
      continue;
    }
    const attrs = spaceAt === -1 ? {} : parseAttrs(body.slice(spaceAt));

    // 隐式闭合：<li>甲<li>乙 中，遇到第二个 li 要先关掉第一个
    const toClose = implicitClose[name];
    if (toClose) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        const openName = stack[i]?.name;
        if (openName && toClose.has(openName)) {
          stack.length = i;
          break;
        }
        // 只向上找紧邻的同类标签，遇到容器就停
        if (openName && !toClose.has(openName)) break;
      }
    }

    const node: XmlNode = { name, attrs, children: [], text: "" };
    stack[stack.length - 1]?.children.push(node);

    if (selfClosing || voidElements.has(name)) {
      cursor = close + 1;
      continue;
    }

    // script/style 内部不能当标签解析，直接找到对应结束标签
    if (rawTextElements.has(name)) {
      const endTag = `</${name}`;
      const endAt = source.toLowerCase().indexOf(endTag, close + 1);
      const raw = endAt === -1 ? source.slice(close + 1) : source.slice(close + 1, endAt);
      if (raw) {
        node.children.push({ name: textNodeName, attrs: {}, children: [], text: raw });
        node.text += raw;
      }
      if (endAt === -1) {
        cursor = source.length;
      } else {
        const endClose = source.indexOf(">", endAt);
        cursor = endClose === -1 ? source.length : endClose + 1;
      }
      continue;
    }

    stack.push(node);
    cursor = close + 1;
  }

  return root;
}

/** 元素的 class 列表 */
function classList(node: XmlNode): string[] {
  const raw = node.attrs.class ?? "";
  return raw.split(/\s+/).filter(Boolean);
}

interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; value?: string; op?: "=" | "*=" | "^=" | "$=" }[];
  /** :eq(n) / :nth-child 简化支持，负数表示从后往前 */
  index?: number;
}

interface CompoundSelector {
  /** 组合子：" " 后代，">" 直接子 */
  combinator: " " | ">";
  selector: SimpleSelector;
}

function parseSimple(raw: string): SimpleSelector {
  const selector: SimpleSelector = { classes: [], attrs: [] };
  let rest = raw;

  // :eq(3) / :first / :last
  rest = rest.replace(/:eq\((-?\d+)\)/g, (_m, n: string) => {
    selector.index = Number.parseInt(n, 10);
    return "";
  });
  rest = rest.replace(/:first\b/g, () => {
    selector.index = 0;
    return "";
  });
  rest = rest.replace(/:last\b/g, () => {
    selector.index = -1;
    return "";
  });

  // [attr], [attr=value], [attr*=value]
  rest = rest.replace(/\[([\w:-]+)(?:([*^$]?=)"?([^\]"]*)"?)?\]/g, (_m, name: string, op: string, value: string) => {
    selector.attrs.push({
      name: name.toLowerCase(),
      op: (op as SimpleSelector["attrs"][number]["op"]) || undefined,
      value: op ? value : undefined,
    });
    return "";
  });

  const pattern = /([#.]?)([\w-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(rest))) {
    const prefix = match[1];
    const value = match[2];
    if (!value) continue;
    if (prefix === "#") selector.id = value;
    else if (prefix === ".") selector.classes.push(value);
    else selector.tag = value.toLowerCase();
  }
  return selector;
}

function parseSelector(raw: string): CompoundSelector[] {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const parts: CompoundSelector[] = [];
  let pendingCombinator: " " | ">" = " ";
  for (const token of tokens) {
    if (token === ">") {
      pendingCombinator = ">";
      continue;
    }
    // 允许 a>b 不带空格
    const segments = token.split(">").filter(Boolean);
    segments.forEach((segment, i) => {
      parts.push({
        combinator: i === 0 ? pendingCombinator : ">",
        selector: parseSimple(segment),
      });
    });
    pendingCombinator = " ";
  }
  return parts;
}

function matchesSimple(node: XmlNode, selector: SimpleSelector): boolean {
  if (node.name === textNodeName || node.name === "#root") return false;
  if (selector.tag && node.name !== selector.tag) return false;
  if (selector.id && node.attrs.id !== selector.id) return false;
  if (selector.classes.length) {
    const list = classList(node);
    if (!selector.classes.every((cls) => list.includes(cls))) return false;
  }
  for (const attr of selector.attrs) {
    const actual = node.attrs[attr.name];
    if (actual === undefined) return false;
    if (attr.value === undefined) continue;
    if (attr.op === "=" && actual !== attr.value) return false;
    if (attr.op === "*=" && !actual.includes(attr.value)) return false;
    if (attr.op === "^=" && !actual.startsWith(attr.value)) return false;
    if (attr.op === "$=" && !actual.endsWith(attr.value)) return false;
  }
  return true;
}

function elementsOf(node: XmlNode): XmlNode[] {
  return node.children.filter((child) => child.name !== textNodeName);
}

function descendants(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    for (const child of elementsOf(current)) {
      out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

function applyIndex(nodes: XmlNode[], index: number | undefined): XmlNode[] {
  if (index === undefined) return nodes;
  const resolved = index < 0 ? nodes.length + index : index;
  const picked = nodes[resolved];
  return picked ? [picked] : [];
}

/** CSS 子集查询：标签、#id、.class、后代、直接子、属性、:eq/:first/:last */
export function queryAll(root: XmlNode, selectorText: string): XmlNode[] {
  // 逗号分组
  const groups = selectorText.split(",").map((s) => s.trim()).filter(Boolean);
  if (groups.length > 1) {
    const seen = new Set<XmlNode>();
    const out: XmlNode[] = [];
    for (const group of groups) {
      for (const node of queryAll(root, group)) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      }
    }
    return out;
  }

  const parts = parseSelector(selectorText);
  if (parts.length === 0) return [];

  let current: XmlNode[] = [root];
  for (const part of parts) {
    const next: XmlNode[] = [];
    const seen = new Set<XmlNode>();
    for (const scope of current) {
      const candidates = part.combinator === ">" ? elementsOf(scope) : descendants(scope);
      for (const candidate of candidates) {
        if (matchesSimple(candidate, part.selector) && !seen.has(candidate)) {
          seen.add(candidate);
          next.push(candidate);
        }
      }
    }
    current = applyIndex(next, part.selector.index);
    if (current.length === 0) return [];
  }
  return current;
}

export function queryFirst(root: XmlNode, selectorText: string): XmlNode | null {
  return queryAll(root, selectorText)[0] ?? null;
}

/** 序列化元素的内部 HTML，供 @html 规则使用 */
export function innerHtml(node: XmlNode): string {
  let out = "";
  for (const child of node.children) {
    if (child.name === textNodeName) {
      out += child.text;
      continue;
    }
    const attrs = Object.entries(child.attrs)
      .map(([key, value]) => ` ${key}="${value}"`)
      .join("");
    if (voidElements.has(child.name)) {
      out += `<${child.name}${attrs}>`;
    } else {
      out += `<${child.name}${attrs}>${innerHtml(child)}</${child.name}>`;
    }
  }
  return out;
}
