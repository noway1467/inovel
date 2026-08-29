import { elementChildren, textNodeName, blockTextOf, type XmlNode } from "~/server/sources/xml";
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

/**
 * 每个节点的后代统计与剔噪副本，整棵树一次算完。
 *
 * 为什么必须预计算：探测要给**每个**元素打分，而打分要知道该元素子树的
 * 文字长度、链接文字长度，还要一份剔掉噪声的副本。现算的话，深度 d 处的
 * 文字会被 d 个祖先各算一遍，`pruneNoise` 更是每打一次分就把整棵子树重
 * 新拷一遍 —— 成本是 O(节点数 × 文字量 × 深度)。实测嵌套 14 层的章节页
 * 探测要 87ms，而 maxContentPages 是 20，一章正文就能烧掉近 2 秒 CPU，
 * 这是 Worker 报 1102 的一份。目录探测（toc-detect.ts）踩过同一个坑。
 *
 * 自底向上一次遍历，每个节点只累加直接子节点的结果，总成本 O(节点数)。
 */
interface NodeStats {
  /** 原树子树文字压缩空白后的长度（不实际拼字符串） */
  rawText: number;
  /** 原树子树里**后代** `<a>` 的文字总长（不含自己是 `<a>` 的情况） */
  rawLink: number;
  /** 剔噪副本的子树文字长度 */
  text: number;
  /** 剔噪副本里后代 `<a>` 的文字总长 */
  link: number;
  /**
   * 剔掉噪声子节点的副本。
   *
   * 正文容器里常混着「上一章 | 目录 | 下一章」的链接条、推荐位、脚本。
   * 直接取整个容器的文字会把它们当成段落。只按标签名、class/id 命名和
   * 链接密度剔除，保守起见不动内容结构 —— 正文里的 `<p>` 不会被误删。
   * 子树没被改动时与原节点共享子节点对象，副本总量仍是 O(节点数)。
   */
  pruned: XmlNode;
}

type StatsMap = Map<XmlNode, NodeStats>;

/** 拼接两段压缩空白的文字：中间多一个分隔空格，与 textOf 的结果对齐 */
function appendLength(total: number, add: number): number {
  if (add <= 0) return total;
  return total > 0 ? total + add + 1 : add;
}

/** 这个直接子节点是噪声吗？判据只看原树，与剔噪结果无关 */
function isNoiseChild(child: XmlNode, childStats: NodeStats | undefined): boolean {
  if (skipTags.has(child.name)) return true;
  const marker = `${child.attrs.class ?? ""} ${child.attrs.id ?? ""}`.trim();
  if (marker && noisePattern.test(marker)) return true;
  /**
   * 纯链接容器（`<div><a>下一章</a></div>`）不是正文。判据是"自己的文字
   * 几乎全在链接里"，这样正文中夹的少量站内链接不受影响。
   */
  const own = childStats?.rawText ?? 0;
  return own > 0 && (childStats?.rawLink ?? 0) / own > 0.8;
}

function analyze(root: XmlNode): StatsMap {
  const stats: StatsMap = new Map();

  /** 显式栈，避免深页面把递归栈打爆 */
  const order: XmlNode[] = [];
  const stack: XmlNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    order.push(node);
    for (const child of node.children) {
      if (child.name !== textNodeName) stack.push(child);
    }
  }

  // order 是先根序，倒着走就保证子节点先算完
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const node = order[i]!;
    let rawText = 0;
    let rawLink = 0;
    let text = 0;
    let link = 0;
    const keep: XmlNode[] = [];
    let changed = false;

    for (const child of node.children) {
      if (child.name === textNodeName) {
        const trimmed = child.text.replace(/\s+/g, " ").trim();
        rawText = appendLength(rawText, trimmed.length);
        text = appendLength(text, trimmed.length);
        keep.push(child);
        continue;
      }

      const childStats = stats.get(child);
      rawText = appendLength(rawText, childStats?.rawText ?? 0);
      rawLink += child.name === "a" ? (childStats?.rawText ?? 0) : (childStats?.rawLink ?? 0);

      if (isNoiseChild(child, childStats)) {
        changed = true;
        continue;
      }
      const prunedChild = childStats?.pruned ?? child;
      if (prunedChild !== child) changed = true;
      text = appendLength(text, childStats?.text ?? 0);
      link += child.name === "a" ? (childStats?.text ?? 0) : (childStats?.link ?? 0);
      keep.push(prunedChild);
    }

    // 子树一个节点都没剔掉时直接复用原节点，副本不必翻倍
    const pruned = changed ? { ...node, children: keep } : node;
    stats.set(node, { rawText, rawLink, text, link, pruned });
  }

  return stats;
}

/**
 * 正文至少得有这么多字，否则是简介或提示条。
 *
 * 门槛不能定高：分页正文的最后一页常只剩一两段，定在 120 会让那一页
 * 探不出东西，整章正文缺尾。60 字约合一个完整段落，而导航条、版权行
 * 这类短文本在 looksLikeProse 那一步就已经滤掉了。
 */
const minContentLength = 60;

function scoreContainer(stats: StatsMap, node: XmlNode): Candidate | null {
  if (skipTags.has(node.name)) return null;
  const own = stats.get(node);
  if (!own) return null;

  /**
   * 先用预计算的数字筛掉绝大多数容器，再去拼字符串。段落长度之和不可能
   * 超过子树文字总长，所以这道门槛不会漏掉本该入选的容器。
   */
  if (own.text < minContentLength) return null;

  const linkDensity = own.text > 0 ? own.link / own.text : 0;
  // 链接占一半以上的容器是列表或导航，不是正文
  if (linkDensity > 0.5) return null;

  const pruned = own.pruned;
  const paragraphs = toParagraphs(blockTextOf(pruned)).filter(looksLikeProse);
  if (paragraphs.length === 0) return null;

  const textLength = paragraphs.reduce((sum, line) => sum + line.length, 0);
  if (textLength < minContentLength) return null;

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
  const stats = analyze(root);
  const candidates: Candidate[] = [];

  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      if (skipTags.has(child.name)) continue;
      const scored = scoreContainer(stats, child);
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
