import { eq } from "drizzle-orm";
import type { R2Bucket } from "@cloudflare/workers-types";
import { contentSources, sourceStatus } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { cacheKey, keyHash, readCache, writeCache } from "~/server/sources/cache";
import { guardedFetch } from "~/server/sources/fetch-guard";
import { parseHtml } from "~/server/sources/html";
import { evalRuleNodes, evalRuleOne } from "~/server/sources/rule-expr";
import {
  buildExploreUrl,
  findCategory,
  usableCategories,
  type ExploreCategory,
} from "~/server/sources/explore";
import { detectExploreBooks } from "~/server/sources/explore-detect";
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
  categories: { id: string; title: string; group: string }[];
  /** 当前分类的 id，链接里带的就是它 */
  categoryId: string | null;
  category: string | null;
  page: number;
  books: ExploreBook[];
  /** 页面上还有下一页 —— 分类地址本身带 {{page}} 时也可能有 */
  hasMore: boolean;
  /** 这页书单来自缓存 */
  fromCache: boolean;
}

/**
 * 分类页缓存 30 分钟。
 *
 * 用户点进一本在线书、退出、再点进去，此前每次都要重抓分类页并重跑一遍
 * 结构探测（实测探测本身 70ms~500ms，叠上抓取就是秒级 CPU），反复几次就
 * 撞上 Worker 的 CPU 上限报 1102。书单本身是慢变量，半小时内没必要回源。
 */
const exploreCacheTtlMs = 30 * 60 * 1000;

/** 缓存里存这些就够重建响应，源名与分类列表都来自库，不用存 */
interface CachedExplorePage {
  books: ExploreBook[];
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
  bucket: R2Bucket | null,
  sourceId: string,
  categoryRef: string | null,
  page = 1
): Promise<ExploreResult> {
  const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
  if (!source) throw new Error("源不存在");
  if (source.status !== sourceStatus.enabled) throw new Error("源未启用，无法浏览");

  const config = (source.config as Record<string, unknown>) ?? {};
  const categories = usableCategories(config.exploreUrl);
  if (categories.length === 0) throw new Error("该源没有可用的分类（发现页规则缺失或需要 JS 求值）");

  const picked = findCategory(categories, categoryRef);
  if (!picked) throw new Error(`分类「${categoryRef}」不存在`);

  const shell = {
    sourceId,
    sourceName: source.name,
    categories: categories.map((item) => ({
      id: item.id,
      title: item.title,
      group: item.group,
    })),
    categoryId: picked.id,
    category: picked.title,
    page,
  };

  const target = resolveUrl(source.endpoint, buildExploreUrl(picked.urlTemplate, page));

  const key = bucket ? cacheKey(sourceId, "explore", await keyHash(target)) : null;
  if (bucket && key) {
    const cached = await readCache<CachedExplorePage>(bucket, key, exploreCacheTtlMs);
    if (cached) return { ...shell, ...cached, fromCache: true };
  }

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
   * 规则一无所获时用发现页专用探测兜底。
   *
   * 实测 152 个有分类的源里 54 个压根没有 exploreList 规则（蓝海搜书的
   * ruleExplore 就是个空对象），永远走这条路。此前这里用的是目录探测，
   * 它按「第 N 章」模式打分，分类页上没有这种模式，就退化成「挑链接最多的
   * 容器」—— 分类页上链接最多的往往是顶部标签云，于是点开标签看到的还是
   * 一排标签。改用按地址形状判别的书单探测。
   */
  if (books.length === 0) {
    for (const item of detectExploreBooks(doc, target, categories)) {
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

  const payload: CachedExplorePage = {
    books: deduped,
    // 模板带页码就认为可以往后翻；否则看页面上有没有下一页链接
    hasMore: /\{\{\s*page/i.test(picked.urlTemplate) || detectNextPageUrl(doc, target) !== null,
  };

  // 空结果不缓存：多半是源站临时抽风或规则失修，别把空书单钉住半小时
  if (bucket && key && payload.books.length > 0) {
    await writeCache(bucket, key, payload);
  }

  return { ...shell, ...payload, fromCache: false };
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
