import { elementChildren, textNodeName, textOf, type XmlNode } from "~/server/sources/xml";
import { resolveUrl } from "~/server/sources/types";

/**
 * 通用目录探测：不依赖书源规则，直接从页面结构认出章节列表。
 *
 * 为什么需要它：书源规则常年失修，站点一改版 tocList 就选不中。
 * 上一版的兜底是「把页面正文按字数切章」，但目录页上根本没有正文，
 * 切出来的是简介碎片 —— 等于给了一堆读不了的假章节。
 *
 * 正确的兜底是找目录本身：小说站的目录页几乎都是「一个容器里一堆
 * 指向章节的链接」，这个结构比任何规则都稳定。做法是给每个候选容器
 * 打分，取分最高的那个。
 */

export interface DetectedChapter {
  title: string;
  url: string;
}

/**
 * 「下一页」链接的文字。
 *
 * 必须与「下一章」严格区分：下一页是同一章的续页，要拼进当前章正文；
 * 下一章是章节边界，拼进去会把两章混成一章。
 */
const nextPageTexts = ["下一页", "下页", "下一頁", "next page", "next"];
const nextChapterTexts = ["下一章", "下章", "下一節", "下一节", "next chapter"];

/**
 * 从页面里探测「下一页」地址。
 *
 * 用于书源没写 nextContentUrl、或那条规则需要 JS 求值的情况 ——
 * 这类源占比不小，没有兜底就只能看到每章的第一页。
 *
 * @param currentUrl 当前页地址，用于补全相对链接并排除自指
 */
export function detectNextPageUrl(root: XmlNode, currentUrl: string): string | null {
  const links: { text: string; href: string }[] = [];
  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      if (child.name === "a") {
        const href = child.attrs.href ?? "";
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          links.push({ text: textOf(child).trim().toLowerCase(), href });
        }
      }
      walk(child);
    }
  };
  walk(root);

  for (const link of links) {
    // 先排除「下一章」：它和「下一页」文字相近，混淆会把两章拼在一起
    if (nextChapterTexts.some((word) => link.text.includes(word))) continue;
    if (!nextPageTexts.some((word) => link.text.includes(word))) continue;

    const resolved = resolveUrl(currentUrl, link.href);
    if (resolved === currentUrl) continue;
    return resolved;
  }
  return null;
}

/**
 * base64 解码。Workers 与 Node 都有全局 atob。
 *
 * 章节地址是纯 ASCII 路径，用不上 UTF-8 还原；解不开就返回 null，
 * 由调用方当作「这不是 base64」处理。
 */
function decodeBase64(value: string): string | null {
  // 先排除明显不是的：长度不合法、含非 base64 字符
  if (value.length < 8 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const decoded = atob(value);
    // 解出来必须是可打印 ASCII，否则只是碰巧符合字符集的随机串
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** 解出来的串像不像章节地址 */
function looksLikePath(value: string): boolean {
  if (!/\d/.test(value)) return false;
  return /^(?:https?:\/\/|\/)/.test(value) || /\.html?(?:$|[?#])/i.test(value);
}

/**
 * 探测「地址被混淆」的目录。
 *
 * 有一类聚合站刻意不让爬：目录页每个 <a href> 都指向书籍首页（诱饵），
 * 真地址 base64 编码后塞在随机命名的 data-* 里（`data-co4af27b="L2Jvb2sv…"`），
 * 章节名也在 data-* 里，DOM 顺序还是打乱的、真顺序由另一个数字 data-* 给出。
 *
 * 这种页面上面的 detectChapterList 会全军覆没：所有 href 相同，去重后
 * 只剩一章。但结构本身是规律的 —— 一组同类节点，每个都带「一个能解成
 * 路径的 base64 属性」。按这个特征认，不需要 JS 引擎。
 */
export function detectObfuscatedChapters(root: XmlNode, pageUrl: string): DetectedChapter[] {
  interface Row {
    url: string;
    title: string;
    order: number;
    domIndex: number;
  }

  /** 同一组的判定：标签名 + class 组合一致 */
  const groups = new Map<string, Row[]>();
  let domIndex = 0;

  /** 节点上最后一个纯数字 data-*。靠前的常是 DOM 序（data-id），真顺序在后面。 */
  const orderOf = (node: XmlNode): number | null => {
    let found: number | null = null;
    for (const [key, value] of Object.entries(node.attrs)) {
      if (!key.startsWith("data-") || !/^\d+$/.test(value)) continue;
      found = Number.parseInt(value, 10);
    }
    return found;
  };

  const walk = (node: XmlNode, ancestors: XmlNode[]) => {
    for (const child of elementChildren(node)) {
      let url: string | null = null;
      let title = "";

      for (const [key, value] of Object.entries(child.attrs)) {
        if (!value) continue;
        // 只看 data-*：href/class 那些是诱饵或样式
        if (!key.startsWith("data-")) continue;
        const decoded = decodeBase64(value);
        if (decoded && looksLikePath(decoded)) {
          if (!url) url = decoded;
          continue;
        }
        if (/^\d+$/.test(value)) continue;
        // 既不是 base64 也不是数字的 data-*，是章节名
        if (!title && value.trim().length >= 2 && value.length <= 200) title = value.trim();
      }

      if (url) {
        /**
         * 真顺序常写在外层 <li> 上，而地址在里层 <a> 上，所以要往上找。
         * 就近优先：自己有就用自己的，没有再逐级向上。
         */
        let order = orderOf(child);
        for (let i = ancestors.length - 1; order === null && i >= 0; i -= 1) {
          order = orderOf(ancestors[i]!);
        }

        /**
         * 名字优先取 data-*，节点文本只作兜底 —— 与地址同理。
         *
         * 这类页面的可见文字是按 DOM 顺序写死的占位（「章节 01」「章节 02」…），
         * 而 DOM 顺序是打乱的：排在首位的那条文字写着「章节 01」，真实序号却是 9。
         * 直接用它，读者看到的章节编号会与阅读顺序互相矛盾。data-* 里才是
         * 真名字（且带正确序号前缀），书源自己的 JS 也是先读 data-* 再退回文本。
         */
        const key = `${child.name}.${child.attrs.class ?? ""}`;
        const list = groups.get(key) ?? [];
        list.push({
          url,
          title: title || textOf(child).trim(),
          order: order ?? domIndex,
          domIndex,
        });
        groups.set(key, list);
        domIndex += 1;
      }
      walk(child, [...ancestors, child]);
    }
  };
  walk(root, []);

  // 取最大的一组：目录是页面上这类节点最多的地方
  let best: Row[] = [];
  for (const rows of groups.values()) {
    if (rows.length > best.length) best = rows;
  }
  if (best.length < 5) return [];

  /**
   * 按真顺序排。数字 data-* 缺失时退回 DOM 序；同序号时用 DOM 序稳定排序，
   * 否则章节顺序在两次抓取间可能抖动，增量同步会重复插章。
   */
  const sorted = [...best].sort((a, b) =>
    a.order === b.order ? a.domIndex - b.domIndex : a.order - b.order
  );

  const seen = new Set<string>();
  const chapters: DetectedChapter[] = [];
  for (const row of sorted) {
    const url = resolveUrl(pageUrl, row.url);
    if (seen.has(url)) continue;
    seen.add(url);
    chapters.push({ title: row.title || `第 ${chapters.length + 1} 章`, url });
  }
  return chapters;
}

/** 藏在属性里的目录地址，常见形态是 /redirect/..?u=<编码后的真地址> */
function unwrapRedirect(raw: string): string {
  const match = raw.match(/[?&]u=([^&]+)/);
  if (!match?.[1]) return raw;
  try {
    const decoded = decodeURIComponent(match[1]);
    return /^https?:\/\//i.test(decoded) ? decoded : raw;
  } catch {
    return raw;
  }
}

/** 目录页链接的文字特征 */
const tocLinkTexts = ["目录", "查看更多", "全部章节", "章节列表", "所有章节", "catalog"];

/**
 * 从详情页找目录页地址。
 *
 * 用于 infoTocUrl 规则需要 JS 求值、被降级丢掉的源：详情页上没有章节列表，
 * 不跳这一步探测器只会在详情页上空转。聚合站还会把目录地址放在
 * `data-cata` 这类属性里而不是 href，所以属性也要看。
 *
 * @param pageUrl 当前详情页地址，用于补全相对链接并排除自指
 */
export function detectTocPageUrl(root: XmlNode, pageUrl: string): string | null {
  const attrCandidates: string[] = [];
  const textCandidates: string[] = [];

  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      for (const [key, value] of Object.entries(child.attrs)) {
        if (!value || key === "href") continue;
        // 属性名或值里带 catalog/目录 特征的，才是目录地址
        const looksToc =
          /cata|catalog|chapter|toc/i.test(key) || /catalog|\/chapter|mulu/i.test(value);
        if (looksToc && /^(?:https?:\/\/|\/)/.test(value)) attrCandidates.push(value);
      }
      if (child.name === "a") {
        const href = child.attrs.href ?? "";
        const text = textOf(child).trim().toLowerCase();
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          if (tocLinkTexts.some((word) => text.includes(word))) textCandidates.push(href);
        }
      }
      walk(child);
    }
  };
  walk(root);

  // 属性优先：聚合站的 href 往往是详情页诱饵，data-* 才指向真目录
  for (const raw of [...attrCandidates, ...textCandidates]) {
    const resolved = resolveUrl(pageUrl, unwrapRedirect(raw));
    if (resolved !== pageUrl) return resolved;
  }
  return null;
}

/** 链接文字像章节名的模式，命中越多越可能是目录 */
const chapterTitlePatterns = [
  /第\s*[\d一二三四五六七八九十百千零〇]+\s*[章节回话卷篇]/,
  /^\s*\d{1,4}\s*[、.．:：]/,
  /^(?:序章|楔子|前言|后记|终章|尾声|番外)/,
  /^chapter\s+\d+/i,
];

/** 明显不是章节的链接文字 */
const noiseTitles = new Set([
  "首页", "书架", "登录", "注册", "搜索", "分类", "排行", "上一页", "下一页",
  "返回", "目录", "加入书架", "开始阅读", "最新章节", "下载", "举报", "反馈",
  "手机版", "电脑版", "网站地图", "免责声明", "联系我们", "会员中心",
]);

/** 章节链接地址常见形态：含数字，且不是站点导航 */
function looksLikeChapterUrl(href: string): boolean {
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return false;
  if (/^(mailto|tel):/i.test(href)) return false;
  // 章节地址几乎总带数字（章节 id 或序号）
  return /\d/.test(href);
}

function titleScore(title: string): number {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 60) return 0;
  if (noiseTitles.has(trimmed)) return -2;
  for (const pattern of chapterTitlePatterns) {
    if (pattern.test(trimmed)) return 2;
  }
  // 不匹配模式但长度像章节名的，给弱分
  return trimmed.length >= 2 && trimmed.length <= 40 ? 1 : 0;
}

interface Candidate {
  container: XmlNode;
  links: { title: string; href: string }[];
  score: number;
}

/** 收集容器内的直接链接（含其后代 a，但不跨越嵌套的候选容器） */
function collectLinks(container: XmlNode): { title: string; href: string }[] {
  const links: { title: string; href: string }[] = [];
  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      if (child.name === "a") {
        const href = child.attrs.href ?? "";
        links.push({ title: textOf(child), href });
        continue;
      }
      walk(child);
    }
  };
  walk(container);
  return links;
}

/**
 * 给容器打分。
 *
 * 分数 = 命中章节名模式的链接数 * 2 + 疑似章节链接数
 * 同时要求链接密度足够高（目录容器里几乎全是链接，导航栏则夹杂大量文字）。
 */
function scoreContainer(container: XmlNode): Candidate | null {
  const links = collectLinks(container).filter((link) => looksLikeChapterUrl(link.href));
  // 少于这么多链接不像目录
  if (links.length < 5) return null;

  let score = 0;
  let strong = 0;
  for (const link of links) {
    const points = titleScore(link.title);
    score += points;
    if (points >= 2) strong += 1;
  }
  if (score <= 0) return null;

  // 链接密度：容器纯文本里，链接文字应占大头
  const allText = textOf(container).length;
  const linkText = links.reduce((sum, link) => sum + link.title.length, 0);
  const density = allText > 0 ? linkText / allText : 0;
  if (density < 0.4) score = Math.floor(score * 0.3);

  // 强命中占比高时加权：整屏都是"第N章"的容器几乎必然是目录
  if (strong >= links.length * 0.5) score += strong;

  return { container, links, score };
}

/**
 * 从页面里探测章节目录。
 *
 * @param root 解析后的页面
 * @param pageUrl 页面地址，用于把相对链接补全
 */
export function detectChapterList(root: XmlNode, pageUrl: string): DetectedChapter[] {
  const candidates: Candidate[] = [];

  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      if (child.name !== textNodeName) {
        const scored = scoreContainer(child);
        if (scored) candidates.push(scored);
      }
      walk(child);
    }
  };
  walk(root);

  if (candidates.length === 0) return [];

  /**
   * 取分最高的。同分时取链接更多的 —— 嵌套容器会同时入选
   * （ul 和它的父 div），链接数相同时外层 div 的文本更杂，
   * 前面的密度惩罚已经把它压下去了。
   */
  candidates.sort((a, b) => (b.score - a.score) || (b.links.length - a.links.length));
  const best = candidates[0];
  if (!best) return [];

  const seen = new Set<string>();
  const chapters: DetectedChapter[] = [];
  for (const link of best.links) {
    const title = link.title.trim();
    if (!title || noiseTitles.has(title)) continue;
    const url = resolveUrl(pageUrl, link.href);
    if (seen.has(url)) continue;
    seen.add(url);
    chapters.push({ title, url });
  }
  return chapters;
}
