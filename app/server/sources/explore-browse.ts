import { eq } from "drizzle-orm";
import { contentSources, sourceStatus } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { guardedFetch } from "~/server/sources/fetch-guard";
import { parseHtml } from "~/server/sources/html";
import { evalRuleNodes, evalRuleOne } from "~/server/sources/rule-expr";
import { buildExploreUrl, usableCategories, type ExploreCategory } from "~/server/sources/explore";
import { detectNextPageUrl } from "~/server/sources/toc-detect";
import { resolveUrl } from "~/server/sources/types";

/**
 * 按分类浏览一个源的书单。
 *
 * 一次只打一个源、一页 —— 这是选「按源浏览」而不是跨源合并的理由：
 * 跨源合并每开一个分类要同时打 N 个源，Worker 的 CPU 和子请求都吃不住，
 * 而且任一源慢就拖住整页。
 */

export interface ExploreBook {
  title: string;
  author: string | null;
  url: string;
  cover: string | null;
}

export interface ExploreResult {
  sourceId: string;
  sourceName: string;
  categories: { title: string }[];
  category: string | null;
  page: number;
  books: ExploreBook[];
  /** 页面上还有下一页 —— 分类地址本身带 {{page}} 时也可能有 */
  hasMore: boolean;
}

/** 列出源上可用的分类，不发任何请求 */
export async function listExploreCategories(
  db: AppDb,
  sourceId: string
): Promise<{ sourceName: string; categories: ExploreCategory[] }> {
  const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
  if (!source) throw new Error("源不存在");
  const config = (source.config as Record<string, unknown>) ?? {};
  return { sourceName: source.name, categories: usableCategories(config.exploreUrl) };
}

/**
 * 取某个分类第 page 页的书。
 *
 * 书单规则缺失时不硬失败：发现页的书单大多就是一组指向书籍详情页的链接，
 * 交给通用探测兜底还能出结果 —— 与目录探测同一套思路。
 */
export async function browseExplore(
  db: AppDb,
  sourceId: string,
  categoryTitle: string | null,
  page = 1
): Promise<ExploreResult> {
  const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
  if (!source) throw new Error("源不存在");
  if (source.status !== sourceStatus.enabled) throw new Error("源未启用，无法浏览");

  const config = (source.config as Record<string, unknown>) ?? {};
  const categories = usableCategories(config.exploreUrl);
  if (categories.length === 0) throw new Error("该源没有可用的分类（发现页规则缺失或需要 JS 求值）");

  const picked = categoryTitle
    ? categories.find((item) => item.title === categoryTitle)
    : categories[0];
  if (!picked) throw new Error(`分类「${categoryTitle}」不存在`);

  const target = resolveUrl(source.endpoint, buildExploreUrl(picked.urlTemplate, page));
  const fetched = await guardedFetch(db, target);
  if (!fetched.ok) throw new Error(fetched.message);

  const doc = parseHtml(fetched.result.body);
  const books: ExploreBook[] = [];
  const listRule = typeof config.exploreList === "string" ? config.exploreList : null;

  if (listRule) {
    const nameRule = typeof config.exploreName === "string" ? config.exploreName : "text";
    const urlRule = typeof config.exploreBookUrl === "string" ? config.exploreBookUrl : "href";
    const authorRule = typeof config.exploreAuthor === "string" ? config.exploreAuthor : null;
    const coverRule = typeof config.exploreCover === "string" ? config.exploreCover : null;

    for (const item of evalRuleNodes({ kind: "html", node: doc }, listRule)) {
      const title = evalRuleOne(item, nameRule);
      const href = evalRuleOne(item, urlRule);
      if (!title || !href) continue;
      books.push({
        title,
        author: authorRule ? evalRuleOne(item, authorRule) : null,
        url: resolveUrl(target, href),
        cover: coverRule ? evalRuleOne(item, coverRule) : null,
      });
    }
  }

  /**
   * 规则一无所获时用通用探测兜底：发现页的书单就是一堆指向详情页的链接，
   * 结构上跟目录页很像，同一套探测能认出来。
   */
  if (books.length === 0) {
    const { detectChapterList } = await import("~/server/sources/toc-detect");
    for (const item of detectChapterList(doc, target)) {
      books.push({ title: item.title, author: null, url: item.url, cover: null });
    }
  }

  // 去重：发现页常有"热门/推荐"块重复同一本书
  const seen = new Set<string>();
  const deduped = books.filter((book) => {
    if (seen.has(book.url)) return false;
    seen.add(book.url);
    return true;
  });

  return {
    sourceId,
    sourceName: source.name,
    categories: categories.map((item) => ({ title: item.title })),
    category: picked.title,
    page,
    books: deduped,
    // 模板带页码就认为可以往后翻；否则看页面上有没有下一页链接
    hasMore:
      /\{\{\s*page/i.test(picked.urlTemplate) || detectNextPageUrl(doc, target) !== null,
  };
}

/** 哪些源有可用分类 —— 分类区的源列表用它，不发出站请求 */
export async function listSourcesWithExplore(
  db: AppDb
): Promise<{ id: string; name: string; categoryCount: number; searchable: boolean }[]> {
  const rows = await db
    .select({
      id: contentSources.id,
      name: contentSources.name,
      status: contentSources.status,
      config: contentSources.config,
    })
    .from(contentSources);

  return rows
    .filter((row) => row.status === sourceStatus.enabled)
    .map((row) => {
      const config = (row.config as Record<string, unknown>) ?? {};
      return {
        id: row.id,
        name: row.name,
        categoryCount: usableCategories(config.exploreUrl).length,
        searchable: typeof config.searchUrl === "string" && config.searchUrl.trim().length > 0,
      };
    })
    .filter((row) => row.categoryCount > 0)
    /**
     * 没有搜索入口的源排前面 —— 分类浏览对它们是唯一入口，
     * 而能搜索的源用户本来就找得到书。
     */
    .sort((a, b) => Number(a.searchable) - Number(b.searchable) || b.categoryCount - a.categoryCount);
}
