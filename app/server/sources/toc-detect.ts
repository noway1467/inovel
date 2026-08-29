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
 * 纯符号翻页按钮。
 *
 * 分页器常常只有一个 `>`（7kbook 目录页就是这样），文字里找不到「下一页」。
 * 必须同时排除后退符号，否则会往回翻。
 *
 * 「末页/尾页」刻意不认：那是跳到最后一页，跟着走会跳过中间所有页。
 */
const nextGlyphTexts = [">", "»", "›", "→", ">>", "▶", "➔"];
const prevGlyphTexts = ["<", "«", "‹", "←", "<<", "◀", "上一页", "上页", "上一章"];

/**
 * 从地址里拆出「章节基名 + 页码」。
 *
 * 支持两种常见分页写法：
 *  - 文件名后缀：`155832.html` / `155832_2.html` / `155832-2.html`
 *  - 查询串：`?page=2` / `?p=2`
 *
 * 不带页码的算第 1 页，这样「首页 → 第 2 页」也能比出递增关系。
 */
function pageIndexOf(url: string): { base: string; index: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // 基名统一去掉分页参数，这样「无参数的首页」和「?page=2」能比出同一个基名
  const base = new URL(parsed.href);
  let index: number | null = null;
  for (const key of ["page", "p"]) {
    const value = parsed.searchParams.get(key);
    if (index === null && value && /^\d{1,4}$/.test(value)) index = Number(value);
    base.searchParams.delete(key);
  }
  if (index !== null) return { base: base.href, index };

  // 再看文件名后缀：`155832_2.html` / `155832-2.html`
  const match = base.pathname.match(/^(.*?)(?:[_-](\d{1,4}))?(\.[a-z0-9]+)$/i);
  if (match?.[1]) {
    const [, stem, page, ext] = match;
    base.pathname = `${stem}${ext}`;
    return { base: base.href, index: page ? Number(page) : 1 };
  }

  // 既没有分页参数也没有可拆的文件名（`/read` 这类）：算第 1 页
  return { base: base.href, index: 1 };
}

/**
 * candidate 是不是 current 同一章的后续页。
 *
 * 为什么需要按地址判断：有一类站整章只有一个翻页按钮，文字始终写「下一章」，
 * 由站点自己决定它指向下一页还是真的下一章 —— 也就是用户说的
 * 「人家是有判断是否还有下一页」。只看文字必然把每章截成第一页。
 *
 * 地址能分出来：基名相同、页码递增就是同一章的续页
 * （`155832.html` → `155832_2.html` → `155832_3.html`）；
 * 基名一变就是真的章节边界（`155832_3.html` → `155833.html`）。
 */
export function isSameChapterNextPage(currentUrl: string, candidateUrl: string): boolean {
  /**
   * 目录形式的地址（`/0/143/`）直接排除。
   *
   * 那是目录页而不是正文页，「同一章的下一页」无从谈起；而它拆出来的基名
   * 就是目录本身、页码算第 1 页，于是目录里任何一个章节地址都会被误判成
   * 「续页」（`/0/143/` → `/0/143/155833.html`），第一章还没读就跳走。
   * 目录翻页交给数字分页器那一轮。
   */
  try {
    if (new URL(currentUrl).pathname.endsWith("/")) return false;
  } catch {
    return false;
  }

  const current = pageIndexOf(currentUrl);
  const candidate = pageIndexOf(candidateUrl);
  if (!current || !candidate) return false;
  if (current.base !== candidate.base) return false;
  /**
   * 必须正好加一。翻页是一页一页走的，跨度大于 1 的同模板地址是
   * 「末页/尾页」那类跳转链接（`index_2.html` 页面上的 `index_20.html`），
   * 跟着走会跳过中间十几页内容。
   */
  return candidate.index === current.index + 1;
}

/** 两个地址是否在同一目录下。分页页面必然是同级兄弟，用来挡住跳站/跳书的链接。 */
function sameDirectory(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.origin !== ub.origin) return false;
    const dir = (u: URL) => u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
    return dir(ua) === dir(ub);
  } catch {
    return false;
  }
}

/**
 * 数字分页器：`1 2 3 … 20` 这种一排页码链接。
 *
 * 这是中文小说站目录分页最常见的形态，而且**整排都没有「下一页」字样**
 * （7kbook 目录页就是 `<a class="page-link" href="index_2.html">2</a>` 这样），
 * 按文字找永远找不到，结果只能拿到第一页 —— 斗破苍穹 1907 章只看到 113 章。
 *
 * 认法：把「文字是纯数字」的链接按地址模板分组（前缀 + 数字 + 后缀），
 * 同一模板下凑够两个页码就当分页器，然后取「当前页码 + 1」那个。
 *
 * 关键约束是模板里数字前必须有分隔符（`_` `-` `/` `=`）。否则章节列表
 * （`/0/143/155832.html`、`155833.html`…）也符合「同模板 + 连续数字」，
 * 会把下一章当成下一页。
 */
function numericPagerNext(
  links: { text: string; href: string }[],
  currentUrl: string
): string | null {
  interface Group {
    prefix: string;
    suffix: string;
    members: Map<number, string>;
  }
  const groups = new Map<string, Group>();

  for (const link of links) {
    if (!/^\d{1,4}$/.test(link.text)) continue;
    const resolved = resolveUrl(currentUrl, link.href);
    if (!sameDirectory(currentUrl, resolved)) continue;

    // 取地址里最后一段数字当页码位，前后切成模板
    const match = resolved.match(/^(.*\D)(\d{1,4})(\D*)$/);
    if (!match) continue;
    const [, prefix, digits, suffix] = match;
    if (!prefix || Number(digits) !== Number(link.text)) continue;
    // 数字前必须是分隔符，否则是章节号而非页码
    if (!/[_\-/=]$/.test(prefix)) continue;

    const templateKey = `${prefix} ${suffix ?? ""}`;
    const group = groups.get(templateKey) ?? {
      prefix,
      suffix: suffix ?? "",
      members: new Map<number, string>(),
    };
    group.members.set(Number(link.text), resolved);
    groups.set(templateKey, group);
  }

  for (const group of groups.values()) {
    if (group.members.size < 2) continue;

    /**
     * 当前是第几页。两种情形：
     *  - 当前地址就符合模板（`index_2.html`）：直接取出那个数字
     *  - 当前是目录形式（`/0/143/`）：站点把第 1 页放在目录地址上，算第 1 页
     */
    let currentIndex: number | null = null;
    if (currentUrl.startsWith(group.prefix) && currentUrl.endsWith(group.suffix)) {
      const middle = currentUrl.slice(group.prefix.length, currentUrl.length - group.suffix.length);
      if (/^\d{1,4}$/.test(middle)) currentIndex = Number(middle);
    }
    if (currentIndex === null) {
      try {
        if (new URL(currentUrl).pathname.endsWith("/") && group.members.has(1)) currentIndex = 1;
      } catch {
        /* 地址不合法，交给后面的轮次 */
      }
    }
    if (currentIndex === null) continue;

    const next = group.members.get(currentIndex + 1);
    if (next && next !== currentUrl) return next;
  }
  return null;
}

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

  // 第一轮：按文字认。写明「下一页」的最可信，且要排除「下一章」——
  // 两者文字相近，混淆会把两章拼成一章。
  for (const link of links) {
    if (nextChapterTexts.some((word) => link.text.includes(word))) continue;
    if (!nextPageTexts.some((word) => link.text.includes(word))) continue;

    const resolved = resolveUrl(currentUrl, link.href);
    if (resolved === currentUrl) continue;
    return resolved;
  }

  /**
   * 第二轮：数字分页器。放在地址形状之前 ——
   * 「一排连续页码 + 当前页 +1」是比地址形状更强的证据，
   * 而目录页上两者可能同时成立。
   */
  const byPager = numericPagerNext(links, currentUrl);
  if (byPager) return byPager;

  /**
   * 第三轮：按地址形状认。
   *
   * 有一类站（品书小说、7kbook 等）整章只有一个翻页按钮，文字恒为「下一章」，
   * 指向下一页还是下一章由站点自己判断。第一轮会把这种链接全部丢掉，
   * 于是每章只剩第一页。这里只认「基名相同、页码递增」的地址，
   * 真正的章节边界（基名变了）仍然被挡在外面。
   */
  for (const link of links) {
    const resolved = resolveUrl(currentUrl, link.href);
    if (resolved === currentUrl) continue;
    if (isSameChapterNextPage(currentUrl, resolved)) return resolved;
  }

  /**
   * 第四轮：纯符号翻页按钮（`>` `»` `→`）。
   *
   * 放最后是因为符号最含糊：必须排除后退符号，并要求目标是同目录的兄弟页面，
   * 否则容易跟去别的书或站外。「末页」类链接不认 —— 跟着走会跳过中间所有页。
   */
  for (const link of links) {
    if (prevGlyphTexts.some((glyph) => link.text.includes(glyph))) continue;
    if (!nextGlyphTexts.includes(link.text)) continue;

    const resolved = resolveUrl(currentUrl, link.href);
    if (resolved === currentUrl) continue;
    if (sameDirectory(currentUrl, resolved)) return resolved;
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
const tocLinkTexts = [
  "完整目录",
  "全部目录",
  "目录",
  "查看更多",
  "全部章节",
  "章节列表",
  "所有章节",
  "catalog",
];

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

/**
 * 「最新章节」小标题的文字。命中它之后的链接要丢掉。
 *
 * 这是详情页/目录页的标准配件：源站在正文目录之上再挂一份"最近更新的 N 章"
 * 方便老读者跳转。对我们却是纯负担 —— 那几条与正文目录完全重复，
 * 且是倒序的，混进目录后既把排版搞乱，又让同一章出现两次。
 */
const latestSectionTexts = [
  "最新章节",
  "最新更新",
  "最近更新",
  "最新章",
  "最近章节",
  "latest chapter",
  "recent chapter",
];

/** 「全部章节」小标题：命中它说明最新章节块结束了，后面才是真目录。 */
const fullSectionTexts = ["全部章节", "完整目录", "章节目录", "章节列表", "正文", "目录", "all chapter"];

function matchesSection(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

/**
 * 丢掉开头那段「最新章节」预告。
 *
 * 预告块与正文目录是同一批章节的重复入口，且几乎总是倒序。按地址去重时
 * 保留首次出现，于是预告抢在正文之前 —— 35ge 的斗罗大陆就是这样：目录
 * 第 1 条是「第二百三十六章 大结局，最后一个条件（全书完）」，点开书直接
 * 被剧透，而正文末尾的同一章反倒被当成重复丢掉了。
 *
 * 判据不看标签也不看文案，只用位置关系：预告必然排在正文目录**之前**，
 * 且它每一条的地址在后面都会再出现一次。所以从头丢掉「地址在后面还会
 * 出现」的那一段，遇到第一条「唯一、或已是最后一次出现」的条目就停。
 *
 * 这样既不会删掉任何唯一章节，也不重排顺序。正文目录内部若仍有重复地址，
 * 交给调用方原有的去重。
 */
export function stripLeadingDuplicates<T>(items: T[], keyOf: (item: T) => string): T[] {
  const lastIndex = new Map<string, number>();
  items.forEach((item, index) => lastIndex.set(keyOf(item), index));

  let start = 0;
  while (start < items.length && (lastIndex.get(keyOf(items[start]!)) ?? start) > start) {
    start += 1;
  }

  /**
   * 剩得太少说明「开头都是重复」这个读法不成立（整页只有预告块、或页面把
   * 目录整份渲染了两遍且很短），原样返回比裁到空好。
   */
  return items.length - start >= 3 ? items.slice(start) : items;
}

/** 节点自身的直接文字，不含任何子元素（也就不含链接文字） */
function directText(node: XmlNode): string {
  let out = "";
  for (const child of node.children) {
    if (child.name === textNodeName) out += child.text;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * 每个节点的后代统计，整棵树一次算完。
 *
 * 为什么必须预计算：探测要给**每个**元素打分，而打分要知道该元素子树的
 * 文字长度和链接数。递归现算的话，深度 d 处的文字会被它的 d 个祖先各算
 * 一遍，还各做一次 `replace(/\s+/g)` —— 成本是 O(文字量 × 深度²)。
 * 实测嵌套 8 层、1900 章的目录页，探测要 3476ms；而 maxTocPages 是 30，
 * 一本书的冷启动就能烧掉几十秒 CPU，正是 Worker 报 1102 的直接原因。
 *
 * 自底向上一次遍历，每个节点只累加直接子节点的结果，总成本 O(节点数)。
 */
interface NodeStats {
  /** 子树文字压缩空白后的长度（不实际拼字符串） */
  textLength: number;
  /** 子树里 <a> 的个数 */
  linkCount: number;
}

type StatsMap = Map<XmlNode, NodeStats>;

function buildStats(root: XmlNode): StatsMap {
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
    let textLength = 0;
    let linkCount = node.name === "a" ? 1 : 0;

    for (const child of node.children) {
      if (child.name === textNodeName) {
        const trimmed = child.text.replace(/\s+/g, " ").trim();
        if (trimmed) textLength += trimmed.length + (textLength > 0 ? 1 : 0);
        continue;
      }
      const childStats = stats.get(child);
      if (!childStats) continue;
      if (childStats.textLength > 0) {
        textLength += childStats.textLength + (textLength > 0 ? 1 : 0);
      }
      linkCount += childStats.linkCount;
    }

    stats.set(node, { textLength, linkCount });
  }

  return stats;
}

function textLengthOf(stats: StatsMap, node: XmlNode): number {
  return stats.get(node)?.textLength ?? 0;
}

/** 后代里有几个 <a>（不含自己） */
function countLinks(stats: StatsMap, node: XmlNode): number {
  const own = stats.get(node)?.linkCount ?? 0;
  return node.name === "a" ? own - 1 : own;
}

/**
 * 收集容器内的直接链接（含其后代 a，但不跨越嵌套的候选容器）。
 *
 * 按 DOM 顺序走，并顺带认出「最新章节」小标题：命中之后的链接标成 skip，
 * 直到遇见「全部章节」这类标题才恢复。kxdu 那类站把两块塞在同一个 `<ul>` 里
 * （`<h1>最新章节</h1>` + 9 条倒序 + `<h1>全部章节</h1>` + 1683 条正序），
 * 不分区就会把倒序那 9 条混进目录 —— 它们与正文目录重复，排序后还会插到
 * 第 5~15 章之间，同一章出现两次。
 */
function collectLinks(
  container: XmlNode,
  stats: StatsMap
): { title: string; href: string; skip: boolean }[] {
  const links: { title: string; href: string; skip: boolean }[] = [];
  let inLatest = false;

  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      if (child.name === "a") {
        const href = child.attrs.href ?? "";
        // 有些站把真标题放在 title/alt/data-*，可见文字只是编号或空壳；
        // 只有这些都拿不到时，上层才会生成兜底标题。
        const title =
          textOf(child).trim() ||
          child.attrs.title?.trim() ||
          child.attrs.alt?.trim() ||
          child.attrs["data-title"]?.trim() ||
          child.attrs["aria-label"]?.trim() ||
          "";
        links.push({ title, href, skip: inLatest });
        continue;
      }

      /**
       * 小标题的判据是「自己不含任何链接、文字很短」，而不是标签名。
       * 各站写法差得很远：`<h1>`、`<dt>`、`<div class="top_t">`、`<span>` 都见过，
       * 按标签名认必然漏。含链接的节点不算标题 —— 那是列表项本身。
       *
       * 先查预计算的长度与链接数，只有真短且无链接时才去拼字符串 ——
       * 整棵树的绝大多数节点都在这一步被挡掉。
       */
      const childStats = stats.get(child);
      const shortEnough = (childStats?.textLength ?? 0) <= 50;
      const linkFree = (childStats?.linkCount ?? 0) === 0;
      const text = shortEnough && linkFree ? textOf(child).trim() : "";
      if (text) {
        if (matchesSection(text, latestSectionTexts)) {
          inLatest = true;
          continue;
        }
        if (matchesSection(text, fullSectionTexts)) {
          inLatest = false;
          continue;
        }
      }

      /**
       * 标签与链接写在同一行的形态，详情页的信息栏几乎都是这样：
       *
       *     <p>最新章节：<a href="…">第二百三十六章 大结局（全书完）</a></p>
       *
       * 上面那轮认不出它 —— 节点自身含链接，按判据不算小标题。于是这条
       * 「最新章节」链接以正常条目混进来，还因为位于页面最上方而在按地址
       * 去重时胜出：35ge 的斗罗大陆目录第 1 条就成了大结局。
       *
       * 只认「自身直接文字命中且**只有一个**链接」，并且只跳过这一个节点、
       * 不切换 inLatest —— 信息栏是零散一行，不是一段区块。
       */
      if (countLinks(stats, child) === 1) {
        const own = directText(child);
        if (own && own.length <= 20 && matchesSection(own, latestSectionTexts)) {
          const wasInLatest = inLatest;
          inLatest = true;
          walk(child);
          inLatest = wasInLatest;
          continue;
        }
      }

      walk(child);
    }
  };
  walk(container);

  /**
   * 分区判断可能误伤：有的详情页只有「最新章节」一块，没有正文目录标题。
   * 这时全丢会把目录清空，比留着重复条目更糟。所以只在「留下的仍是大头」
   * 时才采用分区结果，否则退回全量，交给上层的「跳目录页」继续找。
   */
  const kept = links.filter((link) => !link.skip);
  if (kept.length >= 5 && kept.length * 2 >= links.length) return kept;
  return links.map((link) => ({ ...link, skip: false }));
}

/**
 * 给容器打分。
 *
 * 分数 = 命中章节名模式的链接数 * 2 + 疑似章节链接数
 * 同时要求链接密度足够高（目录容器里几乎全是链接，导航栏则夹杂大量文字）。
 */
function scoreContainer(container: XmlNode, stats: StatsMap): Candidate | null {
  /**
   * 先按预计算的链接数挡一道：整棵树里绝大多数元素连 5 个链接都没有，
   * 挡掉它们就不必进 collectLinks 走子树。
   */
  if ((stats.get(container)?.linkCount ?? 0) < 5) return null;

  const links = collectLinks(container, stats).filter((link) => looksLikeChapterUrl(link.href));
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
  const allText = textLengthOf(stats, container);
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
  const stats = buildStats(root);

  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      if (child.name !== textNodeName) {
        const scored = scoreContainer(child, stats);
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

  /**
   * 先按 DOM 顺序留全，剥掉开头的重复预告段之后才去重。
   *
   * 顺序不能颠倒：先去重的话，预告块（在前）会把正文目录里的同一章挤掉，
   * 「哪些是重复的」这个信息也随之丢失，剥离便无从下手。
   */
  const ordered: DetectedChapter[] = [];
  for (const link of best.links) {
    const title = link.title.trim();
    if (!title || noiseTitles.has(title)) continue;
    ordered.push({ title, url: resolveUrl(pageUrl, link.href) });
  }

  const seen = new Set<string>();
  const chapters: DetectedChapter[] = [];
  for (const item of stripLeadingDuplicates(ordered, (entry) => entry.url)) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    chapters.push(item);
  }
  return sortDetectedChapters(keepDominantShape(chapters, pageUrl));
}

/** 绝不可能是章节页的后缀：下载包、安装包、文档 */
const nonPageExtensions =
  /\.(zip|rar|7z|tar|gz|apk|ipa|exe|dmg|pkg|epub|mobi|azw3?|pdf|txt|doc|docx|jpg|jpeg|png|gif|mp3|mp4|m4a)(?:$|[?#])/i;

/**
 * 把地址抽象成「形状」，用于识别同一批章节。
 *
 * 做法是把路径里的数字段换成 `#`：`/read/65688/p12.html` 与
 * `/read/65688/p570.html` 都变成 `/read/#/p#.html`，而 `/sort/1/`、
 * `/author/xxx`、`/65688.zip` 各自不同。同一本书的章节地址必然同形。
 */
function urlShape(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\d+/g, "#")}`;
  } catch {
    return null;
  }
}

/**
 * 只保留占主导的那一种地址形状。
 *
 * 起因：探测器原先只要求「地址含数字」，于是分类页 `/sort/1/`、作者页、
 * TXT 下载 `.zip`、安卓 `.apk`、iTunes 商店链接全被当成章节 —— 实测某本书
 * 探出 35 条，真章节只有 9 条，点开全是垃圾内容。而黑名单式的过滤永远补不完
 * （「立即阅读」「TXT下载」「iPhone」…… 每个站的花样都不一样）。
 *
 * 结构化判据更可靠：真目录里的章节地址共享同一种形状，杂链的形状五花八门。
 * 按形状分组取最大的那组，顺带挡掉跨站链接和非页面后缀。
 */
function keepDominantShape(chapters: DetectedChapter[], pageUrl: string): DetectedChapter[] {
  if (chapters.length < 3) return chapters;

  let host: string;
  try {
    host = new URL(pageUrl).host;
  } catch {
    return chapters;
  }

  // 先去掉一定不是章节的：跨站、下载包
  const sameSite = chapters.filter((item) => {
    if (nonPageExtensions.test(item.url)) return false;
    const shape = urlShape(item.url);
    return shape !== null && shape.startsWith(host);
  });
  if (sameSite.length < 3) return sameSite.length > 0 ? sameSite : chapters;

  const groups = new Map<string, DetectedChapter[]>();
  for (const item of sameSite) {
    const shape = urlShape(item.url)!;
    const group = groups.get(shape) ?? [];
    group.push(item);
    groups.set(shape, group);
  }

  /**
   * 按数量取最大会选错。
   *
   * 实测这本书的详情页上：推荐书区块是 12 条 `/read/<别的书id>/`，
   * 真章节只有 9 条 `/read/65688/pN.html` —— 光比数量，推荐书赢。
   *
   * 两个更强的信号：
   *  - 章节地址在**当前页所在目录之下**（`/read/65688/` → `/read/65688/p1.html`），
   *    而推荐的是别的书，路径分叉了
   *  - 标题符合章节模式（`第五百六十五章 …`）
   * 两者都占权重，数量只作最后的平手判据。
   */
  let pagePath = "";
  try {
    const parsed = new URL(pageUrl);
    pagePath = parsed.pathname.replace(/[^/]*$/, ""); // 去掉文件名，留目录
  } catch {
    pagePath = "";
  }

  const scored = [...groups.values()].map((group) => {
    const underPage =
      pagePath.length > 1
        ? group.filter((item) => {
            try {
              return new URL(item.url).pathname.startsWith(pagePath);
            } catch {
              return false;
            }
          }).length
        : 0;
    const chapterish = group.filter((item) =>
      chapterTitlePatterns.some((pattern) => pattern.test(item.title))
    ).length;
    // 同目录与像章节的标题各占大头，数量只在前两者持平时起作用
    const score = underPage * 3 + chapterish * 3 + group.length;
    return { group, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best2 = scored[0]?.group;
  if (!best2) return sameSite;

  /**
   * 选出的组太小就不敢裁：说明这页本来就不是规整的目录（详情页常只挂几条
   * 最新章节）。宁可多给几条让上层的「跳目录页」探测继续找，也不要裁到空。
   */
  return best2.length >= 3 ? best2 : sameSite;
}

/**
 * 恢复源站章节顺序。
 *
 * 详情页常先放“最新五章”再放“正文第一章起”。DOM 顺序会把 15,14,12 排在 1,2,3 前面；
 * 多数标题带“第 N 章”，这是比 DOM 和自增章节 id 更可靠的业务顺序。无编号章节保留
 * 源站 DOM 相对顺序；同序号重复时用地址里的数字做稳定 tiebreaker。
 */
function sortDetectedChapters(chapters: DetectedChapter[]): DetectedChapter[] {
  const numbered = chapters.map((chapter, domIndex) => ({
    chapter,
    domIndex,
    number: chapterOrdinal(chapter.title),
    urlNumber: largestUrlNumber(chapter.url),
  }));
  const withNumber = numbered.filter((item) => item.number !== null);
  if (withNumber.length < 3 || withNumber.length < chapters.length * 0.6) return chapters;

  /**
   * DOM 顺序本来就对时不要重排。
   *
   * 长篇里「第N章」会重来：外传、番外、第二部都从第一章起编号，同一个序号
   * 出现两三次是常态（斗破苍穹 1683 章里有 70 个重复序号）。这种页面按序号
   * 排会把相隔上千章的同号章节拧在一起，正文顺序全乱 —— 而它的 DOM 顺序
   * 恰恰是源站的真实顺序。
   *
   * 判据是相邻逆序对的比例：真正需要重排的「最新 N 章倒序在前」形态，
   * 逆序密集（那一段每一步都在下降）；卷次重编号只在换卷处降一次，实测
   * 1645 个相邻对里只有 14 处（0.85%）。10% 把两者分得很开。
   */
  const ordinals = withNumber.map((item) => item.number!);
  let inversions = 0;
  for (let i = 1; i < ordinals.length; i += 1) {
    if (ordinals[i]! < ordinals[i - 1]!) inversions += 1;
  }
  if (ordinals.length > 1 && inversions / (ordinals.length - 1) < 0.1) return chapters;

  return numbered
    .sort((a, b) =>
      (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) ||
      (a.urlNumber ?? a.domIndex) - (b.urlNumber ?? b.domIndex) ||
      a.domIndex - b.domIndex
    )
    .map((item) => item.chapter);
}

const cnDigit = new Map<string, number>([
  ["零", 0], ["〇", 0], ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4],
  ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9],
]);
const cnUnit = new Map<string, number>([
  ["十", 10], ["百", 100], ["千", 1000], ["万", 10000],
]);

/** 只服务排序，不要求覆盖所有中文数字写法；解不出就保留 DOM 顺序。 */
function parseCnNumber(raw: string): number | null {
  const arabic = raw.match(/^\d+$/);
  if (arabic) return Number(raw);

  let total = 0;
  let section = 0;
  let current = 0;
  for (const char of raw) {
    const digit = cnDigit.get(char);
    if (digit !== undefined) {
      current = current * 10 + digit;
      continue;
    }
    const unit = cnUnit.get(char);
    if (unit === undefined) return null;
    if (current === 0 && unit === 10) current = 1;
    section += current * unit;
    current = 0;
    if (unit >= 10000) {
      total = (total + section) * 1;
      section = 0;
    }
  }
  return total + section + current;
}

function chapterOrdinal(title: string): number | null {
  const match = /第\s*([0-9〇零一二三四五六七八九十百千两]+)\s*[章节回卷集部篇]/.exec(title);
  if (!match?.[1]) return null;
  return parseCnNumber(match[1]!);
}

function largestUrlNumber(url: string): number | null {
  const values = [...url.matchAll(/\d+/g)].map((match) => Number(match[0]));
  return values.length > 0 ? Math.max(...values) : null;
}
