import { eq } from "drizzle-orm";
import type { R2Bucket } from "@cloudflare/workers-types";
import { contentSources, sourceStatus } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { cacheKey, keyHash, readCache, writeCache } from "~/server/sources/cache";
import { getAdapter } from "~/server/sources/registry";
import type { SourceChapter } from "~/server/sources/types";

/**
 * 直接从源上读：目录与正文按需现抓，不建 books/chapters、不走草稿与发布。
 *
 * 与订阅链路的分工：
 *  - 订阅（sync.ts）：想把某本书长期收进本站书库、参与站内榜单与推荐
 *  - 现抓（本模块）：像开源阅读那样，搜到就能点开看，不留库
 *
 * 抓到的内容进 R2 短期缓存，避免同一章反复回源。
 */

/** 缓存有效期。目录变化快，正文基本不变，分别给不同时长。 */
const tocCacheTtlMs = 30 * 60 * 1000;
const contentCacheTtlMs = 7 * 24 * 60 * 60 * 1000;

function tocCacheKey(sourceId: string, hash: string) {
  return cacheKey(sourceId, "toc", hash);
}

function contentCacheKey(sourceId: string, hash: string) {
  return cacheKey(sourceId, "content", hash);
}

async function loadEnabledSource(db: AppDb, sourceId: string) {
  const source = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.id, sourceId))
    .get();
  if (!source) throw new Error("源不存在");
  if (source.status !== sourceStatus.enabled) throw new Error("该源未启用");
  return source;
}

function ctxFor(db: AppDb, source: { endpoint: string; config: unknown }) {
  return {
    db,
    endpoint: source.endpoint,
    config: (source.config as Record<string, unknown>) ?? {},
    countRequest: () => {},
  };
}

export interface LiveTocResult {
  sourceId: string;
  sourceName: string;
  bookUrl: string;
  chapters: { title: string; key: string }[];
  fromCache: boolean;
}

/**
 * 拉某本书在源上的目录。
 *
 * @param refresh 跳过缓存重抓。给「刷新目录」按钮用 —— 源站更新了新章节，
 *   而缓存还有效时，用户需要一个能立刻看到新章的手段。写回照常，
 *   所以刷新一次之后其他人也受益。
 */
export async function getLiveToc(
  db: AppDb,
  bucket: R2Bucket,
  sourceId: string,
  bookUrl: string,
  refresh = false
): Promise<LiveTocResult> {
  const source = await loadEnabledSource(db, sourceId);
  const hash = await keyHash(bookUrl);
  const key = tocCacheKey(sourceId, hash);

  const cached = refresh
    ? null
    : await readCache<{ title: string; key: string }[]>(bucket, key, tocCacheTtlMs);
  if (cached) {
    return {
      sourceId,
      sourceName: source.name,
      bookUrl,
      chapters: cached,
      fromCache: true,
    };
  }

  const adapter = getAdapter(source.kind);
  const remote: SourceChapter[] = await adapter.listChapters(ctxFor(db, source), {
    externalId: bookUrl,
  });
  const chapters = remote.map((chapter) => ({ title: chapter.title, key: chapter.externalKey }));
  await writeCache(bucket, key, chapters);

  return { sourceId, sourceName: source.name, bookUrl, chapters, fromCache: false };
}

export interface LiveChapterResult {
  sourceId: string;
  sourceName: string;
  chapterKey: string;
  paragraphs: string[];
  fromCache: boolean;
}

/** 拉单章正文 */
export async function getLiveChapter(
  db: AppDb,
  bucket: R2Bucket,
  sourceId: string,
  chapterKey: string
): Promise<LiveChapterResult> {
  const source = await loadEnabledSource(db, sourceId);
  const hash = await keyHash(chapterKey);
  const key = contentCacheKey(sourceId, hash);

  const cached = await readCache<string[]>(bucket, key, contentCacheTtlMs);
  const cachedParagraphs = cached?.map((paragraph) => paragraph.trim()).filter(Boolean) ?? [];
  if (cachedParagraphs.length > 0) {
    return {
      sourceId,
      sourceName: source.name,
      chapterKey,
      paragraphs: cachedParagraphs,
      fromCache: true,
    };
  }

  const adapter = getAdapter(source.kind);
  const { paragraphs } = await adapter.fetchChapter(ctxFor(db, source), {
    externalKey: chapterKey,
  });
  const normalizedParagraphs = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
  if (normalizedParagraphs.length === 0) throw new Error('正文为空');
  await writeCache(bucket, key, normalizedParagraphs);

  return { sourceId, sourceName: source.name, chapterKey, paragraphs: normalizedParagraphs, fromCache: false };
}
