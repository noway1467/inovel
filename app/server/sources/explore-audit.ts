import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { contentSources, sourceStatus } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { usableCategories } from "~/server/sources/explore";
import { browseExplore } from "~/server/sources/explore-browse";

/**
 * 分类浏览实测：真跑一遍源的第一个分类，看能不能抓到书。
 *
 * 为什么要单独一套：verify.ts 测的是「搜索 → 取目录」，只有分类入口的源在
 * 那里会被判 skipped —— 恰恰是分类浏览最依赖的那批。而源列表里的"有分类"
 * 只查配置里有没有地址，规则在、源站改版了照样算有，用户点进去一片空白。
 *
 * 与验证一样把结果写回库：一次实测供后面反复筛选和批量清理，不用每次重跑。
 */

/** 单次实测的源数上限。分类页比搜索重，给得比 maxVerifyPerRun 更保守。 */
export const maxExploreAuditPerRun = 6;

/** 同时打几个源。不同域名之间不用互相等。 */
const auditConcurrency = 3;

export type ExploreStatus = "untested" | "ok" | "empty" | "failed";

export interface ExploreAuditOutcome {
  sourceId: string;
  sourceName: string;
  status: Exclude<ExploreStatus, "untested">;
  books: number;
  message: string;
}

/** 固定并发跑一批，保持与输入同序 */
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

/**
 * 实测一个源的分类浏览。
 *
 * 只测第一个分类：一个源动辄几十个分类，全测既慢又没必要 —— 分类页多半
 * 共用同一套规则，第一个抓不到书基本意味着整套规则失效。
 */
async function auditOne(
  db: AppDb,
  source: { id: string; name: string; config: unknown }
): Promise<ExploreAuditOutcome> {
  const base = { sourceId: source.id, sourceName: source.name };
  const config = (source.config as Record<string, unknown>) ?? {};
  const categories = usableCategories(config.exploreUrl);
  if (categories.length === 0) {
    return { ...base, status: "empty", books: 0, message: "没有可用分类" };
  }

  try {
    // 传 null 跳过 R2 缓存：实测要的是源站此刻的真实反应，读缓存等于没测
    const result = await browseExplore(db, null, source.id, categories[0]!.id, 1);
    if (result.books.length === 0) {
      return {
        ...base,
        status: "empty",
        books: 0,
        message: `分类「${categories[0]!.title}」一本书都没抓到`,
      };
    }
    return {
      ...base,
      status: "ok",
      books: result.books.length,
      message: `分类「${result.category ?? categories[0]!.title}」抓到 ${result.books.length} 本`,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      books: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 分批实测。默认优先测还没测过的源，全测过后按时间从旧到新轮着复检
 * —— 源站改版后原本能抓的也会失效。
 */
export async function auditSourcesExplore(
  db: AppDb,
  options?: { limit?: number; sourceIds?: string[] | null; recheck?: boolean }
): Promise<{
  outcomes: ExploreAuditOutcome[];
  totals: { checked: number; ok: number; empty: number; failed: number; remaining: number };
}> {
  const limit = Math.min(
    Math.max(1, options?.limit ?? maxExploreAuditPerRun),
    maxExploreAuditPerRun
  );

  let pool: { id: string; name: string; config: unknown }[];
  if (options?.sourceIds?.length) {
    pool = await db
      .select({ id: contentSources.id, name: contentSources.name, config: contentSources.config })
      .from(contentSources)
      .where(inArray(contentSources.id, options.sourceIds))
      .all();
  } else {
    pool = await db
      .select({ id: contentSources.id, name: contentSources.name, config: contentSources.config })
      .from(contentSources)
      .where(
        options?.recheck
          ? eq(contentSources.status, sourceStatus.enabled)
          : and(
              eq(contentSources.status, sourceStatus.enabled),
              eq(contentSources.exploreStatus, "untested")
            )
      )
      .orderBy(asc(contentSources.exploreCheckedAt))
      .limit(limit)
      .all();
  }

  const targets = pool.slice(0, limit);
  const outcomes = await runPooled(targets, auditConcurrency, async (source) => {
    const outcome = await auditOne(db, source);
    await db
      .update(contentSources)
      .set({
        exploreStatus: outcome.status,
        exploreBooks: outcome.books,
        exploreMessage: outcome.message.slice(0, 300),
        exploreCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(contentSources.id, source.id));
    return outcome;
  });

  const remainingRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(contentSources)
    .where(
      and(
        eq(contentSources.status, sourceStatus.enabled),
        eq(contentSources.exploreStatus, "untested")
      )
    )
    .get();

  return {
    outcomes,
    totals: {
      checked: outcomes.length,
      ok: outcomes.filter((item) => item.status === "ok").length,
      empty: outcomes.filter((item) => item.status === "empty").length,
      failed: outcomes.filter((item) => item.status === "failed").length,
      remaining: Number(remainingRow?.count ?? 0),
    },
  };
}

/**
 * 可清理的源分三类，各自单独统计、单独删。
 *
 * 为什么不合成一条「该删」：这三类的性质不一样。没有分类浏览的源里有一批
 * 靠搜索活得很好，删了纯亏；不能搜索的源里也有一批分类抓得到书，分类就是
 * 它唯一的入口。混成一条就只能全删或全留，于是谁也不敢按。
 */
export type SourceCleanupReason = "no_explore" | "explore_empty" | "not_searchable";

export const cleanupReasonLabels: Record<SourceCleanupReason, string> = {
  no_explore: "没有分类浏览",
  explore_empty: "分类里没有数据",
  not_searchable: "不能搜索",
};

export const cleanupReasonHints: Record<SourceCleanupReason, string> = {
  no_explore: "配置里没有可用的发现页地址，分类区不会出现它",
  explore_empty: "实测跑过分类页，一本书也没抓到（需先跑分类实测）",
  not_searchable: "没有搜索地址，站内搜索永远搜不到它",
};

function isSearchable(config: unknown) {
  const value = (config as Record<string, unknown>)?.searchUrl;
  return typeof value === "string" && value.trim().length > 0;
}

function hasExplore(config: unknown) {
  return usableCategories((config as Record<string, unknown>)?.exploreUrl).length > 0;
}

/** 某个源命中哪几类可清理原因 */
function reasonsFor(row: {
  config: unknown;
  exploreStatus: string;
}): SourceCleanupReason[] {
  const reasons: SourceCleanupReason[] = [];
  if (!hasExplore(row.config)) reasons.push("no_explore");
  // 只认实测判定：没测过的不能当"没有数据"，那是还不知道
  else if (row.exploreStatus === "empty" || row.exploreStatus === "failed") {
    reasons.push("explore_empty");
  }
  if (!isSearchable(row.config)) reasons.push("not_searchable");
  return reasons;
}

/**
 * 三类各有多少个源，供管理台显示「删掉这 N 个」。
 *
 * 分类判定要读 config 里的发现页规则，SQL 里做不了（规则是 JSON 里的
 * 一段模板文本，还要过 usableCategories 排掉需要 JS 求值的），
 * 所以在内存里过一遍 —— 源总量是几百，不是几百万。
 */
export async function getCleanupReasonCounts(db: AppDb): Promise<
  {
    reason: SourceCleanupReason;
    label: string;
    hint: string;
    count: number;
  }[]
> {
  const rows = await db
    .select({
      config: contentSources.config,
      exploreStatus: contentSources.exploreStatus,
    })
    .from(contentSources)
    .all();

  const counts = new Map<SourceCleanupReason, number>();
  for (const row of rows) {
    for (const reason of reasonsFor(row)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  return (Object.keys(cleanupReasonLabels) as SourceCleanupReason[]).map((reason) => ({
    reason,
    label: cleanupReasonLabels[reason],
    hint: cleanupReasonHints[reason],
    count: counts.get(reason) ?? 0,
  }));
}

/** 按原因批量删源。已入库的书籍不受影响。 */
export async function purgeSourcesByCleanupReason(
  db: AppDb,
  reasons: SourceCleanupReason[]
): Promise<{ deleted: number }> {
  const wanted = new Set(reasons);
  if (wanted.size === 0) return { deleted: 0 };

  const rows = await db
    .select({
      id: contentSources.id,
      config: contentSources.config,
      exploreStatus: contentSources.exploreStatus,
    })
    .from(contentSources)
    .all();

  const targets = rows
    .filter((row) => reasonsFor(row).some((reason) => wanted.has(reason)))
    .map((row) => row.id);
  if (targets.length === 0) return { deleted: 0 };

  // inArray 每个 id 占一个绑定参数，D1 单语句上限 ~100，按片删
  const chunkSize = 80;
  for (let index = 0; index < targets.length; index += chunkSize) {
    const slice = targets.slice(index, index + chunkSize);
    await db.delete(contentSources).where(inArray(contentSources.id, slice));
  }
  return { deleted: targets.length };
}

/** 实测概览，给管理台显示进度 */
export async function getExploreAuditOverview(db: AppDb) {
  const rows = await db
    .select({ status: contentSources.exploreStatus, count: sql<number>`count(*)` })
    .from(contentSources)
    .where(eq(contentSources.status, sourceStatus.enabled))
    .groupBy(contentSources.exploreStatus)
    .all();

  const byStatus = new Map(rows.map((row) => [row.status, Number(row.count)]));
  return {
    ok: byStatus.get("ok") ?? 0,
    empty: byStatus.get("empty") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    untested: byStatus.get("untested") ?? 0,
  };
}
