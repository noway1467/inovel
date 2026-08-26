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
