import {
  delay,
  guardedFetch,
  paginationDelayMs,
  politeDelayMs,
} from "~/server/sources/fetch-guard";
import { parseHtml } from "~/server/sources/html";
import { buildSearchUrl, degradeJsRule, type RulesConfig } from "~/server/sources/legado";
import {
  canParseRule,
  evalRuleAll,
  evalRuleNodes,
  evalRuleOne,
  htmlDoc,
  jsonDoc,
  type RuleDoc,
} from "~/server/sources/rule-expr";
import {
  resolveUrl,
  toParagraphs,
  type SourceAdapter,
  type SourceBook,
  type SourceChapter,
} from "~/server/sources/types";
import { blockTextOf } from "~/server/sources/xml";
import {
  detectChapterList,
  detectNextPageUrl,
  detectObfuscatedChapters,
  detectTocPageUrl,
} from "~/server/sources/toc-detect";

/**
 * 通用 CSS 规则引擎适配器，消费 legado.ts 转换出的 RulesConfig。
 *
 * 抓取一律经 guardedFetch，域名不在授权白名单内直接拒绝 —— 这是这个
 * 适配器唯一的放行开关，装了规则也不等于能抓。
 */

/**
 * 分页翻页上限。必须有界：分页规则常写成 `option@value`（下拉里所有页），
 * 或指向自身，没有上限就会无限翻或打爆源站。
 */
const maxTocPages = 30;
const maxContentPages = 20;

/**
 * 探测结果达到这个数才认为「这页就是目录」，否则再去找目录页。
 * 与 toc-detect 里认定目录容器的最小链接数一致。
 */
const minDetectedChapters = 5;

/**
 * 求下一页地址。
 *
 * 分页规则有两种常见形态：
 *  - `text.下一页@href`：直接给出下一页链接
 *  - `option@value` / `option!0@value`：下拉框里列出全部页，
 *    此时规则会返回多个值，取第一个没访问过的才是"下一页"
 */
function nextPageUrl(
  doc: RuleDoc,
  rule: string,
  currentUrl: string,
  visited: Set<string>
): string | null {
  const candidates = evalRuleAll(doc, rule);
  for (const raw of candidates) {
    if (!raw) continue;
    const resolved = resolveUrl(currentUrl, raw);
    if (resolved === currentUrl || visited.has(resolved)) continue;
    return resolved;
  }
  return null;
}

/**
 * 目录规则失效时，用通用探测从页面结构认出章节列表。
 *
 * 返回的是带真实地址的章节，正文仍可按正文规则回源抓 —— 这是它比
 * 「切正文当章节」强的关键：那种做法产出的章节没有可访问地址。
 */
async function detectFromPage(
  ctx: Parameters<SourceAdapter["listChapters"]>[0],
  pageUrl: string
): Promise<SourceChapter[]> {
  const doc = await loadDoc(ctx, pageUrl);
  if (doc.kind !== "html") return [];
  return detectOnDoc(doc, pageUrl);
}

/**
 * 在一页上试两种探测，取章节多的那个。
 *
 * 不能"普通探测有结果就用它"：混淆目录页上普通探测并非颗粒无收，而是
 * 认出「封面/正序/翻页」这类导航链接 —— 有六七条，看着像成功，实则全是
 * 废条目。按数量仲裁才能让真目录（十条起）胜出。同分给普通探测，
 * 它覆盖绝大多数站。
 */
function detectOnDoc(doc: RuleDoc, pageUrl: string): SourceChapter[] {
  if (doc.kind !== "html") return [];
  const plain = detectChapterList(doc.node, pageUrl);
  const obfuscated = detectObfuscatedChapters(doc.node, pageUrl);
  const winner = obfuscated.length > plain.length ? obfuscated : plain;
  return winner.map((item) => ({ externalKey: item.url, title: item.title }));
}

/**
 * 探测目录：先在当前页找，找不到就跳一次目录页再找。
 *
 * 那一跳是必要的：详情页上本来就没有章节列表，而 infoTocUrl 规则
 * 需要 JS 求值的源（聚合站几乎都是）已经把该规则降级丢掉了，
 * 不跳就只能在详情页上空转。
 */
async function detectWithTocHop(
  ctx: Parameters<SourceAdapter["listChapters"]>[0],
  pageUrl: string
): Promise<SourceChapter[]> {
  const doc = await loadDoc(ctx, pageUrl);
  const here = detectOnDoc(doc, pageUrl);
  /**
   * 结果够厚就不必再跳。阈值取 5，与探测器认定「这是个目录容器」的
   * 最小链接数一致：详情页上认出的三五条多是换源站点链接，不是章节。
   */
  if (here.length >= minDetectedChapters) return here;

  if (doc.kind !== "html") return here;
  const tocPage = detectTocPageUrl(doc.node, pageUrl);
  if (!tocPage) return here;

  await delay(politeDelayMs);
  const hopped = await detectFromPage(ctx, tocPage);
  return hopped.length > here.length ? hopped : here;
}

/**
 * 读取时再降级一次含 JS 的规则。
 *
 * 导入时 legado.ts 已经降级过，这里重做是为了库里的老行：它们是在
 * 支持降级之前入库的，规则里还带着 `@js:` 尾巴。不在这兜一次就得跑
 * 数据迁移，而降级是纯函数、幂等，读取时做的代价可以忽略。
 */
function usableRule(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  if (canParseRule(raw)) return raw;
  const degraded = degradeJsRule(raw);
  /**
   * 降不下来就返回 null，不能把原值透传：透传的话 tocList 仍是真值，
   * 下面会判成 rules 模式，然后在求值时抛「不支持 JS 规则」——
   * 而这种源本可以走探测。null 才能让它正确落到 detect。
   */
  return degraded ? degraded.rule : null;
}

function readConfig(config: Record<string, unknown>): RulesConfig {
  const tocList = usableRule(config.tocList);
  const tocName = usableRule(config.tocName);
  const tocUrl = usableRule(config.tocUrl);
  const contentRule = usableRule(config.contentRule);
  if (!contentRule) {
    // 正文规则没有探测兜底：没有它这个源一章都读不出来
    const raw = typeof config.contentRule === "string" ? config.contentRule.trim() : "";
    throw new Error(
      raw
        ? "正文规则需要 JS 求值且无法降级，该源读不出正文。请换用规则为 CSS 的源。"
        : "规则配置不完整：需要 contentRule"
    );
  }

  /**
   * 目录三件套缺任意一项就走探测。
   *
   * 只留一半是不能用的：有 tocList 没 tocUrl，取出来的章节没有地址。
   * 显式标了 detect 的源同样走这条路。
   */
  const tocMode =
    config.tocMode === "detect" || !tocList || !tocName || !tocUrl ? "detect" : "rules";

  return {
    ...(config as unknown as RulesConfig),
    tocMode,
    tocList,
    tocName,
    tocUrl,
    contentRule,
  };
}

/**
 * 取回并解析成 RuleDoc。
 *
 * 按响应内容自动判断 HTML 还是 JSON：JSONPath 规则的源返回的是 JSON，
 * 硬当 HTML 解析会得到一棵空树，规则全部落空且没有任何错误提示。
 */
async function loadDoc(
  ctx: Parameters<SourceAdapter["listBooks"]>[0],
  url: string
): Promise<RuleDoc> {
  ctx.countRequest();
  const response = await guardedFetch(ctx.db, url, {
    headers: { Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
  });
  if (!response.ok) throw new Error(response.message);
  if (response.result.status >= 400) throw new Error(`源返回 HTTP ${response.result.status}`);

  const { body, contentType } = response.result;
  const trimmed = body.trimStart();
  const looksJson =
    contentType.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (looksJson) {
    try {
      return jsonDoc(JSON.parse(body));
    } catch {
      // 声明是 JSON 但解析失败时退回 HTML，比直接报错更宽容
    }
  }
  return htmlDoc(parseHtml(body));
}

/** 目录页可能与详情页不同，按 infoTocUrl 规则跳转一次 */
async function resolveTocUrl(
  ctx: Parameters<SourceAdapter["listBooks"]>[0],
  config: RulesConfig,
  bookUrl: string
): Promise<string> {
  if (!config.infoTocUrl) return bookUrl;
  const doc = await loadDoc(ctx, bookUrl);
  const raw = evalRuleOne(doc, config.infoTocUrl);
  return raw ? resolveUrl(bookUrl, raw) : bookUrl;
}

export const rulesAdapter: SourceAdapter = {
  kind: "rules",
  label: "自定义 CSS 规则（兼容开源阅读书源）",

  async probe(ctx) {
    try {
      const config = readConfig(ctx.config);
      const doc = await loadDoc(ctx, ctx.endpoint);
      // 首页通常不是目录页，能连通并解析出 HTML 就算基本可用
      const titleGuess = evalRuleOne(doc, "tag.title@text");
      // 目录走探测的源没有 tocName 可探，连通性判断只看页面能否解析
      const tocProbe = config.tocName ? evalRuleAll(doc, config.tocName).slice(0, 5) : [];
      return {
        ok: true,
        message: tocProbe.length
          ? `连通，当前页命中 ${tocProbe.length} 个章节名`
          : `连通（页面标题：${titleGuess || "无"}）。首页通常没有目录，请用「订阅指定书籍」输入详情页地址验证目录规则。`,
        sampleTitles: tocProbe,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  async search(ctx, keyword) {
    const config = readConfig(ctx.config);
    if (!config.searchUrl || !config.searchList) {
      throw new Error("该源未配置搜索规则，请直接用详情页地址订阅");
    }
    const url = resolveUrl(ctx.endpoint, buildSearchUrl(config.searchUrl, keyword));
    const doc = await loadDoc(ctx, url);
    const items = evalRuleNodes(doc, config.searchList);
    const books: SourceBook[] = [];
    for (const item of items) {
      const bookUrl = config.searchBookUrl ? evalRuleOne(item, config.searchBookUrl) : "";
      const title = config.searchName ? evalRuleOne(item, config.searchName) : "";
      if (!bookUrl || !title) continue;
      books.push({
        externalId: resolveUrl(url, bookUrl),
        title,
        author: config.searchAuthor ? evalRuleOne(item, config.searchAuthor) || null : null,
      });
    }
    return books;
  },

  async listBooks() {
    // 规则源没有"全部书籍"的概念，只能搜索或按详情页地址订阅
    return [];
  },

  /**
   * 拉目录，跟随 nextTocUrl 翻完所有页。
   *
   * 真实合集里约三成的源目录分多页，只取首页会漏掉大部分章节
   * （表现为"源站有 3 页，站内只看到 1 页"）。
   */
  async listChapters(ctx, book): Promise<SourceChapter[]> {
    const config = readConfig(ctx.config);
    const firstUrl = await resolveTocUrl(ctx, config, book.externalId);

    /**
     * 目录规则不可翻译的源（整段 JS）直接走探测，不必先跑一遍必定
     * 落空的规则 —— 那会白花一次请求，还会把真实原因盖成"规则未命中"。
     */
    if (config.tocMode === "detect") {
      const detected = await detectWithTocHop(ctx, firstUrl);
      if (detected.length > 0) return detected;
      throw new Error(
        "该源目录规则需要 JS 求值，已改用页面结构探测，但这本书的目录页没探测到章节列表。"
      );
    }

    // tocMode === "rules" 时 readConfig 已保证三者非空
    const tocListRule = config.tocList!;
    const tocNameRule = config.tocName!;
    const tocUrlRule = config.tocUrl!;

    const chapters: SourceChapter[] = [];
    const seen = new Set<string>();
    // 访问过的页面地址，防止分页规则自指导致死循环
    const visited = new Set<string>();
    let pageUrl: string | null = firstUrl;
    let pages = 0;

    while (pageUrl && pages < maxTocPages) {
      if (visited.has(pageUrl)) break;
      visited.add(pageUrl);
      pages += 1;

      const doc = await loadDoc(ctx, pageUrl);
      for (const item of evalRuleNodes(doc, tocListRule)) {
        const title = evalRuleOne(item, tocNameRule);
        const href = evalRuleOne(item, tocUrlRule);
        if (!title || !href) continue;
        const externalKey = resolveUrl(pageUrl, href);
        // 目录页常有"最新章节"重复块，按地址去重
        if (seen.has(externalKey)) continue;
        seen.add(externalKey);
        chapters.push({ externalKey, title });
      }

      /**
       * 与正文分页同样处理：规则优先，缺失时用通用探测兜底。
       * 目录分多页而书源没写 nextTocUrl 的源不少，不兜底就只能看到第一页章节。
       */
      const tocPageUrl: string = pageUrl;
      const tocByRule: string | null = config.nextTocUrl
        ? nextPageUrl(doc, config.nextTocUrl, tocPageUrl, visited)
        : null;
      const tocDetected: string | null =
        !tocByRule && doc.kind === "html" ? detectNextPageUrl(doc.node, tocPageUrl) : null;
      const tocCandidate = tocByRule ?? tocDetected;
      pageUrl = tocCandidate && !visited.has(tocCandidate) ? tocCandidate : null;
      if (pageUrl) await delay(paginationDelayMs);
    }

    if (chapters.length > 0) return chapters;

    /**
     * 目录规则一无所获时，改用通用目录探测：直接从页面结构认出章节列表。
     *
     * 不再走"把页面正文按字数切章"那条路 —— 目录页上没有正文，切出来的
     * 是简介碎片，会得到一堆点开就报错的假章节。探测真实目录才有意义：
     * 找到的是带真实地址的章节，正文照常能回源抓。
     */
    const detected = await detectWithTocHop(ctx, firstUrl);
    if (detected.length > 0) return detected;

    throw new Error(
      `目录规则未命中任何章节（已尝试 ${pages} 页），页面里也没探测到章节列表。` +
        `该源规则可能已失效。`
    );
  },

  /**
   * 拉正文，跟随 nextContentUrl 把分页的长章节拼完整。
   *
   * 不少站把一章切成若干页，只取首页会导致每章正文都被截断。
   */
  async fetchChapter(ctx, chapter) {
    const config = readConfig(ctx.config);

    const paragraphs: string[] = [];
    const visited = new Set<string>();
    let pageUrl: string | null = chapter.externalKey;
    let pages = 0;

    while (pageUrl && pages < maxContentPages) {
      if (visited.has(pageUrl)) break;
      visited.add(pageUrl);
      pages += 1;

      const doc = await loadDoc(ctx, pageUrl);
      /**
       * 用 evalRuleAll 而非 evalRuleOne：正文规则的选择器常命中一整组节点
       * （`.mrx-cot@p@html`、`.content p@text` 这类），取第一个等于只拿到
       * 首段，整章正文被截断。evalRuleAll 取首个有结果分支的全部命中，
       * 拼起来才是完整正文；命中单个容器的规则（`id.content@html`）
       * 结果不变。
       */
      const parsed = evalRuleAll(doc, config.contentRule).join("\n").trim();
      if (parsed) {
        // 正文规则多为 @html/@content，取出来的是 HTML 片段，需再解析分段；
        // 若已是纯文本，parseHtml 也能安全处理
        const text = parsed.includes("<") ? blockTextOf(parseHtml(parsed)) : parsed;
        const nextParagraphs = toParagraphs(text);
        paragraphs.push(...(nextParagraphs.length > 0 ? nextParagraphs : toParagraphs(parsed)));
      }

      /**
       * 先按书源规则找下一页；规则缺失或不可译时用通用探测兜底。
       *
       * 不少源没写 nextContentUrl，或那条规则要 JS 求值 —— 没有兜底
       * 就只能拿到每章的第一页，正文被截断。
       */
      const currentUrl: string = pageUrl;
      const byRule: string | null = config.nextContentUrl
        ? nextPageUrl(doc, config.nextContentUrl, currentUrl, visited)
        : null;
      const detected: string | null =
        !byRule && doc.kind === "html" ? detectNextPageUrl(doc.node, currentUrl) : null;
      const candidate = byRule ?? detected;
      pageUrl = candidate && !visited.has(candidate) ? candidate : null;
      if (pageUrl) await delay(paginationDelayMs);
    }

    if (paragraphs.length === 0) throw new Error("正文规则未命中内容");
    return { paragraphs };
  },
};
