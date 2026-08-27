import { eq } from "drizzle-orm";
import type { R2Bucket } from "@cloudflare/workers-types";
import { contentSources, sourceStatus } from "drizzle/schema";
import type { AppDb } from "~/server/db";
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

/**
 * 抓取管线版本号。**改动抓取/解析逻辑时必须 +1。**
 *
 * 为什么需要它：正文缓存 7 天。修好分页跟随之后，早先存进去的截断正文
 * （只有第一页）会继续供 7 天 —— 部署完全正确，用户看到的还是旧内容，
 * 而且没有任何迹象说明问题出在缓存。上一轮就是这样，只能手动逐章删 R2。
 *
 * 版本号进 key，改一次逻辑就等于把旧缓存全部作废，旧对象自然失活
 * （R2 生命周期规则回收，不影响读取）。
 *
 * v2: 跟随正文/目录分页（数字分页器、`>` 符号、地址形状），滤掉翻页提示行
 * v3: 按响应编码解码（gbk/gb2312/big5），此前写死 utf-8，gbk 站缓存的是乱码
 */
const pipelineVersion = "v3";

/** 源地址不能直接当 R2 键（含协议与斜杠），用摘要 */
async function keyHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function tocCacheKey(sourceId: string, hash: string) {
  return `source-cache/${pipelineVersion}/${sourceId}/toc/${hash}.json`;
}

function contentCacheKey(sourceId: string, hash: string) {
  return `source-cache/${pipelineVersion}/${sourceId}/content/${hash}.json`;
}

interface CachedEnvelope<T> {
  cachedAt: number;
  data: T;
}

async function readCache<T>(
  bucket: R2Bucket,
  key: string,
  ttlMs: number
): Promise<T | null> {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    const parsed = JSON.parse(await object.text()) as CachedEnvelope<T>;
    if (Date.now() - parsed.cachedAt > ttlMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

async function writeCache<T>(bucket: R2Bucket, key: string, data: T): Promise<void> {
  const envelope: CachedEnvelope<T> = { cachedAt: Date.now(), data };
  await bucket.put(key, JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json" },
  });
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

/** 拉某本书在源上的目录 */
export async function getLiveToc(
  db: AppDb,
  bucket: R2Bucket,
  sourceId: string,
  bookUrl: string
): Promise<LiveTocResult> {
  const source = await loadEnabledSource(db, sourceId);
  const hash = await keyHash(bookUrl);
  const key = tocCacheKey(sourceId, hash);

  const cached = await readCache<{ title: string; key: string }[]>(bucket, key, tocCacheTtlMs);
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
