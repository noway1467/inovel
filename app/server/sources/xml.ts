/**
 * 极简 XML 解析器。
 *
 * Workers 运行时没有 DOMParser，而 OPDS（Atom）与 RSS 都是 XML。
 * 引一个完整解析库对这点需求太重，这里只实现订阅场景需要的子集：
 * 元素树、属性、文本、CDATA、实体解引用。不支持命名空间前缀区分
 * （feed 里 `dc:creator` 直接当作标签名 "dc:creator"），也不做 DTD。
 */

/** 文本节点的伪标签名。混排在 children 里以保留文档顺序。 */
export const textNodeName = "#text";

export interface XmlNode {
  /** 标签名，保留原始大小写与命名空间前缀；文本节点为 #text */
  name: string;
  attrs: Record<string, string>;
  /**
   * 子节点，元素与文本按原文顺序混排。
   * 必须保序：`前<em>中</em>后` 若把文本单独攒成一个字段，
   * 拼接时会变成"前后中"，块级换行也无法插在正确位置。
   */
  children: XmlNode[];
  /** 本元素的直接文本（含 CDATA）拼接，便于取 <title> 这类简单值 */
  text: string;
}

const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  /**
   * 零宽与方向标记。数值形式（&#8206;）本来就能解，命名形式不解就原样留在
   * 文本里 —— 章节名会变成「摆烂爱豆&zwnj;被&zwj;操…」这种样子。
   *
   * 有的站专门往标题与正文里插这些不可见字符来干扰抓取和关键字匹配，
   * 解成空串正好把它们清掉。
   */
  zwj: "",
  zwnj: "",
  lrm: "",
  rlm: "",
  shy: "",
  // 常见排版实体，小说站正文里出现频率很高
  emsp: " ",
  ensp: " ",
  thinsp: " ",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  hellip: "…",
  middot: "·",
};

export function decodeXmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    const named = namedEntities[body.toLowerCase()];
    return named ?? match;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([:\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? "";
    if (key) attrs[key] = decodeXmlEntities(value);
  }
  return attrs;
}

const bomCodeUnit = 0xfeff;

/**
 * 去掉开头的 BOM。用码位比较而不是正则字面量：
 * BOM 直接写进正则会成为源码里的不可见字符。
 */
export function stripBom(input: string): string {
  return input.charCodeAt(0) === bomCodeUnit ? input.slice(1) : input;
}

/** 解析成根节点。畸形输入尽量容错，返回已解析出的部分。 */
export function parseXml(input: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let cursor = 0;

  const source = stripBom(input);

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) {
      pushText(stack, source.slice(cursor), true);
      break;
    }
    if (open > cursor) pushText(stack, source.slice(cursor, open), true);

    // CDATA 原样收录，不做实体解引用
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      const raw = end === -1 ? source.slice(open + 9) : source.slice(open + 9, end);
      pushText(stack, raw, false);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    // 注释、声明、处理指令一律跳过
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", open) || source.startsWith("<!", open)) {
      const end = source.indexOf(">", open);
      cursor = end === -1 ? source.length : end + 1;
      continue;
    }

    const close = source.indexOf(">", open);
    if (close === -1) break;
    const inner = source.slice(open + 1, close);

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      // 就近闭合：容忍标签未按序关闭的脏 feed
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
    const spaceAt = body.search(/[\s]/);
    const name = (spaceAt === -1 ? body : body.slice(0, spaceAt)).trim();
    const attrs = spaceAt === -1 ? {} : parseAttrs(body.slice(spaceAt));
    const node: XmlNode = { name, attrs, children: [], text: "" };
    stack[stack.length - 1]?.children.push(node);
    if (!selfClosing) stack.push(node);
    cursor = close + 1;
  }

  return root;
}

/**
 * 文本既作为 #text 子节点入 children（保序），也累加到父元素的 text 字段
 * （便于 <title> 这类只有文本的元素直接取值）。
 */
function pushText(stack: XmlNode[], chunk: string, decode: boolean) {
  const current = stack[stack.length - 1];
  if (!current || !chunk) return;
  const value = decode ? decodeXmlEntities(chunk) : chunk;
  if (!value) return;
  current.children.push({ name: textNodeName, attrs: {}, children: [], text: value });
  current.text += value;
}

/** 深度优先找出所有同名元素 */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const target = name.toLowerCase();
  const found: XmlNode[] = [];
  const walk = (current: XmlNode) => {
    for (const child of current.children) {
      if (child.name === textNodeName) continue;
      if (child.name.toLowerCase() === target) found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

/** 只要元素子节点，剔掉 #text */
export function elementChildren(node: XmlNode): XmlNode[] {
  return node.children.filter((child) => child.name !== textNodeName);
}

export function findFirst(node: XmlNode, name: string): XmlNode | null {
  return findAll(node, name)[0] ?? null;
}

/** 直接子元素，不递归 */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  const target = name.toLowerCase();
  return node.children.filter((child) => child.name.toLowerCase() === target);
}

/**
 * 元素及其后代的全部文本，压缩空白。
 *
 * 空白压缩只在最外层做一次。原先每层递归都跑一遍 `replace(/\s+/g)`，
 * 深度 d 处的文字要被重扫 d 遍 —— 章节页嵌套十几层时这是实测的热点，
 * 也是 Worker 报 1102 的一份成因。分段先攒进数组再统一压缩，结果不变。
 */
export function textOf(node: XmlNode | null): string {
  if (!node) return "";
  if (node.name === textNodeName) return node.text;
  const parts: string[] = [];
  // 按 children 顺序遍历，元素与文本混排时才不会错序
  const walk = (current: XmlNode) => {
    for (const child of current.children) {
      if (child.name === textNodeName) parts.push(child.text);
      else walk(child);
    }
  };
  walk(node);
  // join 已经把每段隔开，`前<em>中</em>后` 不会粘成一个词
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 保留换行的文本提取，用于正文段落切分 */
export function blockTextOf(node: XmlNode | null): string {
  if (!node) return "";
  const blockTags = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "blockquote"]);
  const parts: string[] = [];
  const walk = (current: XmlNode) => {
    for (const child of current.children) {
      if (child.name === textNodeName) {
        if (child.text.trim()) parts.push(child.text.trim());
        continue;
      }
      const tag = child.name.toLowerCase();
      // br 是空元素，本身就是断点，不需要前后各插一次
      if (tag === "br") {
        parts.push("\n");
        continue;
      }
      const isBlock = blockTags.has(tag);
      if (isBlock) parts.push("\n");
      walk(child);
      if (isBlock) parts.push("\n");
    }
  };
  walk(node);
  return parts
    .join(" ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
