import { elementChildren, textNodeName, blockTextOf, textOf, type XmlNode } from "~/server/sources/xml";
import { toParagraphs } from "~/server/sources/types";

/**
 * 通用正文探测：不依赖书源规则，直接从页面结构认出正文容器。
 *
 * ## 为什么需要它
 *
 * 正文规则原先是硬门槛：翻译不了就整源拒收。实测 600 个真实书源里有 35 个
 * 正文规则是真 JS（AES 解密、Jsoup 调用、正则拼 HTML），它们的搜索与目录
 * 规则大多是好的 —— 只因为正文一项就整源丢掉，用户看到的就是"很多源用不了"。
 *
 * 而正文页恰恰是最好探测的一类页面：整页最大的一坨连续文字就是正文。
 * 这跟目录探测（toc-detect.ts）是一个思路 —— 结构比规则稳定，站点改版
 * 规则会失效，但"正文是页面上文字最多的容器"不会变。
 *
 * 探测结果同时兼作运行时兜底：规则还在但选择器已失配时（改版后很常见），
 * 与其抛"正文规则未命中内容"，不如探一次给出真正文。
 *
 * ## 边界
 *
 * 不做全文摘录式的清理（那需要更强的启发式，容易反而删掉正文）。
 * 只做两件事：挑出正文容器、去掉容器内明显的非正文节点（导航、脚本、
 * 上一章/下一章链接条）。剩下的交给既有的净化规则与段落切分。
 */

/** 一定不是正文的标签 */
const skipTags = new Set([
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "iframe",
  "select",
  "button",
  "textarea",
]);

/**
 * class/id 里带这些词的容器不是正文。
 *
 * 只用于排除候选容器本身，不影响它的祖先 —— 有的站正文容器外层就叫
 * `content-wrapper`，按祖先排除会把正文一起丢掉。
 */
const noisePattern =
  /(^|[-_])(nav|menu|header|footer|sidebar|side|ad|ads|advert|banner|comment|reply|share|related|recommend|copyright|breadcrumb|pager|pagination|toolbar|tips)([-_]|$)/i;

/** 正文容器的 class/id 常见命名，命中给加分 */
const contentHintPattern =
  /(content|contents|chaptercontent|booktext|booktxt|nr_body|nr1|txt|text|article|readcontent|showtxt|htmlcontent|chapter[-_]?content)/i;

/**
 * 一段文字像不像正文。
 *
 * 中文正文段落有个稳定特征：足够长且含标点。导航条、版权行、章节标题
 * 都很短，广告词则几乎没有句读。
 */
function looksLikeProse(line: string): boolean {
  if (line.length < 12) return false;
  return /[。！？；，、“”"'…—]/.test(line) || line.length >= 40;
}

interface Candidate {
  node: XmlNode;
  score: number;
  paragraphs: string[];
}

/** 容器内链接文字总长，用于算链接密度 */
function linkTextLength(node: XmlNode): number {
  let total = 0;
  const walk = (current: XmlNode) => {
    for (const child of elementChildren(current)) {
      if (child.name === "a") {
        total += textOf(child).length;
        continue;
      }
      walk(child);
    }
  };
  walk(node);
  return total;
}

/**
 * 复制一份剔掉噪声子节点的容器。
 *
 * 正文容器里常混着「上一章 | 目录 | 下一章」的链接条、推荐位、脚本。
 * 直接取整个容器的文字会把它们当成段落。这里只在**直接后代**层面剔除，
 * 保守起见不递归深挖 —— 正文里的 `<p>` 不会被误删。
 */
function pruneNoise(node: XmlNode): XmlNode {
  const keep: XmlNode[] = [];
  for (const child of node.children) {
    if (child.name === textNodeName) {
      keep.push(child);
      continue;
    }
    if (skipTags.has(child.name)) continue;
    const marker = `${child.attrs.class ?? ""} ${child.attrs.id ?? ""}`.trim();
    if (marker && noisePattern.test(marker)) continue;
    /**
     * 纯链接容器（`<div><a>下一章</a></div>`）不是正文。判据是"自己的文字
     * 几乎全在链接里"，这样正文中夹的少量站内链接不受影响。
     */
    const own = textOf(child).length;
    if (own > 0 && linkTextLength(child) / own > 0.8) continue;
    keep.push(pruneNoise(child));
  }
  return { ...node, children: keep };
}

function scoreContainer(node: XmlNode): Candidate | null {
  if (skipTags.has(node.name)) return null;

  const pruned = pruneNoise(node);
  const paragraphs = toParagraphs(blockTextOf(pruned)).filter(looksLikeProse);
  if (paragraphs.length === 0) return null;

  const textLength = paragraphs.reduce((sum, line) => sum + line.length, 0);
  /**
   * 正文至少得有这么多字，否则是简介或提示条。
   *
   * 门槛不能定高：分页正文的最后一页常只剩一两段，定在 120 会让那一页
   * 探不出东西，整章正文缺尾。60 字约合一个完整段落，而导航条、版权行
   * 这类短文本在 looksLikeProse 那一步就已经滤掉了。
   */
  if (textLength < 60) return null;

  const linkLength = linkTextLength(pruned);
  const allText = textOf(pruned).length;
  const linkDensity = allText > 0 ? linkLength / allText : 0;
  // 链接占一半以上的容器是列表或导航，不是正文
  if (linkDensity > 0.5) return null;

  let score = textLength * (1 - linkDensity);

  const marker = `${node.attrs.class ?? ""} ${node.attrs.id ?? ""}`.trim();
  if (marker && contentHintPattern.test(marker)) score *= 1.5;
  if (marker && noisePattern.test(marker)) score *= 0.3;

  /**
   * `<p>` 分段的容器更可能是正文主体，而不是把正文包在里面的外层 div。
   * 外层容器文字总量相同甚至更多，靠这一项才能选中更贴身的那个。
   */
  const paragraphTags = elementChildren(pruned).filter((child) => child.name === "p").length;
  if (paragraphTags >= 3) score *= 1.2;

  return { node, score, paragraphs };
}

/**
 * 从页面里探测正文段落。
 *
 * @param root 解析后的章节页
 * @returns 段落数组；认不出正文时返回空数组
 */
export function detectContentParagraphs(root: XmlNode): string[] {
  const candidates: Candidate[] = [];

  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      if (skipTags.has(child.name)) continue;
      const scored = scoreContainer(child);
      if (scored) candidates.push(scored);
      walk(child);
    }
  };
  walk(root);

  if (candidates.length === 0) return [];

  /**
   * 取分最高的。嵌套容器会同时入选（正文 div 和它的父容器），
   * 上面的 `<p>` 加权与噪声降权已经让更贴身的那个胜出；
   * 同分时取段落更少的 —— 那是更内层、更干净的容器。
   */
  candidates.sort((a, b) => b.score - a.score || a.paragraphs.length - b.paragraphs.length);
  return candidates[0]?.paragraphs ?? [];
}
