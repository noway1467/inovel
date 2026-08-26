import { eq } from "drizzle-orm";
import { contentSources, sourceStatus } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { getAdapter } from "~/server/sources/registry";
import type { SourceBook } from "~/server/sources/types";

/**
 * 跨源聚合搜索：拿关键字同时问所有启用的源，合并去重后返回。
 *
 * 三条约束，都是为了"一个坏源不能拖垮整次搜索"：
 *  - 每个源单独限时，超时只废掉这一个源
 *  - 并发有上限，避免几十个源同时出站把 Worker 打满
 *  - 单源异常只记原因，不冒泡
 */

/** 同时进行的源查询数上限 */
const searchConcurrency = 6;
/** 单个源的查询时限；超过就放弃该源 */
export const perSourceTimeoutMs = 12_000;
/** 每个源最多取几条，防止某个源刷屏 */
const defaultPerSourceLimit = 10;

export interface AggregateHit extends SourceBook {
  sourceId: string;
  sourceName: string;
}

export interface SourceOutcome {
  sourceId: string;
  sourceName: string;
  status: "ok" | "failed" | "unsupported" | "timeout";
  hits: number;
  message?: string;
}

/** 同一本书在多个源上命中时合并成一条，带上全部可选源 */
export interface GroupedBook {
  title: string;
  author: string | null;
  description: string | null;
  /** 可从哪些源订阅这本书 */
  options: { sourceId: string; sourceName: string; externalId: string }[];
}

export interface AggregateSearchResult {
  keyword: string;
  books: GroupedBook[];
  outcomes: SourceOutcome[];
  totals: { sourcesQueried: number; sourcesOk: number; hits: number; books: number };
}

/** 给单个源的查询套上时限 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`查询超时（${ms}ms）`);
      error.name = "SourceTimeout";
      reject(error);
    }, ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** 固定并发地跑一批任务 */
async function runPooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 分组键：书名 + 作者，两者都规范化后比较 */
function groupKey(title: string, author: string | null | undefined): string {
  const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  return `${normalize(title)}|${normalize(author ?? "")}`;
}

export interface AggregateSearchOptions {
  /** 只查这些源；不传则查全部启用的源 */
  sourceIds?: string[] | null;
  perSourceLimit?: number;
  timeoutMs?: number;
}

export async function aggregateSearch(
  db: AppDb,
  keyword: string,
  options?: AggregateSearchOptions
): Promise<AggregateSearchResult> {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error("搜索关键字不能为空");

  const all = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.status, sourceStatus.enabled))
    .all();

  const wanted = options?.sourceIds?.length
    ? all.filter((source) => options.sourceIds!.includes(source.id))
    : all;

  if (wanted.length === 0) {
    return {
      keyword: trimmed,
      books: [],
      outcomes: [],
      totals: { sourcesQueried: 0, sourcesOk: 0, hits: 0, books: 0 },
    };
  }

  const perSourceLimit = Math.max(1, options?.perSourceLimit ?? defaultPerSourceLimit);
  const timeoutMs = options?.timeoutMs ?? perSourceTimeoutMs;

  const outcomes: SourceOutcome[] = [];
  const hits: AggregateHit[] = [];

  await runPooled(wanted, searchConcurrency, async (source) => {
    const adapter = getAdapter(source.kind);
    if (!adapter.search) {
      outcomes.push({
        sourceId: source.id,
        sourceName: source.name,
        status: "unsupported",
        hits: 0,
        message: `${source.kind} 类型不支持搜索`,
      });
      return;
    }
    try {
      const found = await withTimeout(
        adapter.search(
          {
            db,
            endpoint: source.endpoint,
            config: (source.config as Record<string, unknown>) ?? {},
            countRequest: () => {},
          },
          trimmed
        ),
        timeoutMs
      );
      const capped = found.slice(0, perSourceLimit);
      for (const book of capped) {
        hits.push({ ...book, sourceId: source.id, sourceName: source.name });
      }
      outcomes.push({
        sourceId: source.id,
        sourceName: source.name,
        status: "ok",
        hits: capped.length,
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "SourceTimeout";
      outcomes.push({
        sourceId: source.id,
        sourceName: source.name,
        status: isTimeout ? "timeout" : "failed",
        hits: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 同名同作者合并成一条，把各源作为可选项挂上去
  const grouped = new Map<string, GroupedBook>();
  for (const hit of hits) {
    const key = groupKey(hit.title, hit.author);
    const existing = grouped.get(key);
    const option = {
      sourceId: hit.sourceId,
      sourceName: hit.sourceName,
      externalId: hit.externalId,
    };
    if (existing) {
      const duplicate = existing.options.some(
        (item) => item.sourceId === option.sourceId && item.externalId === option.externalId
      );
      if (!duplicate) existing.options.push(option);
      // 简介取第一个非空的
      if (!existing.description && hit.description) existing.description = hit.description;
      continue;
    }
    grouped.set(key, {
      title: hit.title,
      author: hit.author ?? null,
      description: hit.description ?? null,
      options: [option],
    });
  }

  // 多源命中的排前面：可选源越多越可能是真结果
  const books = [...grouped.values()].sort((a, b) => b.options.length - a.options.length);

  return {
    keyword: trimmed,
    books,
    outcomes,
    totals: {
      sourcesQueried: wanted.length,
      sourcesOk: outcomes.filter((item) => item.status === "ok").length,
      hits: hits.length,
      books: books.length,
    },
  };
}
