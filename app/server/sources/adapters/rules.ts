import { guardedFetch } from "~/server/sources/fetch-guard";
import { parseHtml } from "~/server/sources/html";
import { buildSearchUrl, type RulesConfig } from "~/server/sources/legado";
import {
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

/**
 * 通用 CSS 规则引擎适配器，消费 legado.ts 转换出的 RulesConfig。
 *
 * 抓取一律经 guardedFetch，域名不在授权白名单内直接拒绝 —— 这是这个
 * 适配器唯一的放行开关，装了规则也不等于能抓。
 */

function readConfig(config: Record<string, unknown>): RulesConfig {
  const tocList = typeof config.tocList === "string" ? config.tocList : "";
  const tocName = typeof config.tocName === "string" ? config.tocName : "";
  const tocUrl = typeof config.tocUrl === "string" ? config.tocUrl : "";
  const contentRule = typeof config.contentRule === "string" ? config.contentRule : "";
  if (!tocList || !tocName || !tocUrl || !contentRule) {
    throw new Error("规则配置不完整：需要 tocList / tocName / tocUrl / contentRule");
  }
  return {
    ...(config as unknown as RulesConfig),
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
      const tocProbe = evalRuleAll(doc, config.tocName).slice(0, 5);
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

  async listChapters(ctx, book): Promise<SourceChapter[]> {
    const config = readConfig(ctx.config);
    const tocUrl = await resolveTocUrl(ctx, config, book.externalId);
    const doc = await loadDoc(ctx, tocUrl);
    const items = evalRuleNodes(doc, config.tocList);
    const chapters: SourceChapter[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const title = evalRuleOne(item, config.tocName);
      const href = evalRuleOne(item, config.tocUrl);
      if (!title || !href) continue;
      const externalKey = resolveUrl(tocUrl, href);
      // 目录页常有"最新章节"重复块，按地址去重
      if (seen.has(externalKey)) continue;
      seen.add(externalKey);
      chapters.push({ externalKey, title });
    }
    if (chapters.length === 0) {
      throw new Error("目录规则未命中任何章节，检查 tocList / tocName / tocUrl");
    }
    return chapters;
  },

  async fetchChapter(ctx, chapter) {
    const config = readConfig(ctx.config);
    const doc = await loadDoc(ctx, chapter.externalKey);
    const parsed = evalRuleOne(doc, config.contentRule);
    if (!parsed) throw new Error("正文规则未命中内容");
    // 正文规则多为 @html/@content，取出来的是 HTML 片段，需再解析分段；
    // 若已是纯文本，parseHtml 也能安全处理
    const text = parsed.includes("<") ? blockTextOf(parseHtml(parsed)) : parsed;
    const paragraphs = toParagraphs(text);
    if (paragraphs.length === 0) throw new Error("正文为空");
    return { paragraphs };
  },
};
