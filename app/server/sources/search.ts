import { asc, desc, eq, sql } from "drizzle-orm";
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
  totals: {
    sourcesQueried: number;
    sourcesOk: number;
    hits: number;
    books: number;
    /** 启用且可搜的源总数，用于告诉使用者还剩多少没查 */
    sourcesAvailable: number;
    /** 下一批的起点；null 表示已查完所有源 */
    nextOffset: number | null;
  };
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
  /** 只查这些源；不传则按排序取一批启用的源 */
  sourceIds?: string[] | null;
  perSourceLimit?: number;
  timeoutMs?: number;
  /**
   * 本次最多查几个源。必须有上限：Workers 单请求的子请求数与 CPU 都有限，
   * 250 个源一次全打出去会直接触发资源限制（Error 1102）。
   */
  maxSources?: number;
  /** 从排序后的第几个源开始，用于分批把所有源轮完 */
  offset?: number;
}

/**
 * 单次搜索最多查的源数。
 *
 * 定这个值的约束不是并发，而是「一个请求内能做多少事」：
 * 每个源一次出站 + 一份 HTML 解析，解析是 CPU 密集的。
 * 8 个是实测下来既能出结果、又稳定不超限的值。
 */
export const maxSourcesPerSearch = 8;

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
    /**
     * 排序键必须在整轮分批期间不变。
     *
     * 曾按 searchFailures 排序，但每批结束都会写回失败计数 ——
     * 下一批重新查询时顺序已变，基于 offset 的翻页就会既重复又遗漏
     * （实测 20 个源轮完只覆盖到 12 个）。
     *
     * searchWeight 来自导入时的书源 weight，搜索过程不会改；
     * id 作为最终 tiebreaker 保证全序。失败计数仍然记录，
     * 用于管理台展示与「停用长期失败的源」，但不参与翻页排序。
     */
    .orderBy(desc(contentSources.searchWeight), asc(contentSources.id))
    .all();

  const explicit = options?.sourceIds?.length
    ? all.filter((source) => options.sourceIds!.includes(source.id))
    : null;

  const pool = explicit ?? all;
  const offset = Math.max(0, options?.offset ?? 0);
  /**
   * 上限在这里硬性封顶，不只在路由层。
   * 任何调用方（含将来新增的）传再大的 maxSources 也不能突破 ——
   * 否则又会回到"一个请求打 250 个源"的 Error 1102。
   *
   * 只有显式点名要查哪些源时才放开：那是调用方自己挑的一小组。
   */
  const limit = explicit
    ? pool.length
    : Math.min(Math.max(1, options?.maxSources ?? maxSourcesPerSearch), maxSourcesPerSearch);
  const wanted = pool.slice(offset, offset + limit);

  if (wanted.length === 0) {
    return {
      keyword: trimmed,
      books: [],
      outcomes: [],
      totals: {
        sourcesQueried: 0,
        sourcesOk: 0,
        hits: 0,
        books: 0,
        sourcesAvailable: pool.length,
        nextOffset: null,
      },
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

  // 记录各源的搜索健康度，影响下次的排序
  await recordSearchHealth(db, outcomes);

  const consumed = offset + wanted.length;
  return {
    keyword: trimmed,
    books,
    outcomes,
    totals: {
      sourcesQueried: wanted.length,
      sourcesOk: outcomes.filter((item) => item.status === "ok").length,
      hits: hits.length,
      books: books.length,
      sourcesAvailable: pool.length,
      nextOffset: consumed < pool.length ? consumed : null,
    },
  };
}

/**
 * 把本批各源的成败写回。
 *
 * 成功则清零失败计数并记时间；失败/超时累加。排序据此让稳定出结果的
 * 源留在前面，坏源逐渐沉底 —— 分批查的前提是"前几批就是最可能有结果的"。
 */
async function recordSearchHealth(db: AppDb, outcomes: SourceOutcome[]): Promise<void> {
  for (const outcome of outcomes) {
    if (outcome.status === "unsupported") continue;
    if (outcome.status === "ok") {
      await db
        .update(contentSources)
        .set({ searchFailures: 0, lastSearchAt: new Date() })
        .where(eq(contentSources.id, outcome.sourceId));
      continue;
    }
    await db
      .update(contentSources)
      .set({ searchFailures: sql`${contentSources.searchFailures} + 1` })
      .where(eq(contentSources.id, outcome.sourceId));
  }
}
