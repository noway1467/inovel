import { asc, eq, inArray, ne, sql } from "drizzle-orm";
import { contentSources, sourceStatus } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { getAdapter } from "~/server/sources/registry";
import { delay, politeDelayMs } from "~/server/sources/fetch-guard";
import { matchesKeyword } from "~/server/sources/search";

/**
 * 源可用性验证：拿一个常见关键字实际跑一遍「搜索 → 取目录」，
 * 只有两步都成的源才算可用。
 *
 * 为什么必须实测：一份合集导进来两百多个源，规则大多年久失修。
 * probe（只测连通性）会把这些源全判为"通"，而它们实际搜不到、点不开。
 * 用户看到的就是"处处报错"，却无法分辨是源坏了还是功能坏了。
 */

/** 每次验证处理的源数上限。与搜索同理：Workers 单请求资源有限。 */
export const maxVerifyPerRun = 5;

/** 单个源的验证时限。比搜索给得宽些，因为要连做两步。 */
const verifyTimeoutMs = 15_000;

/** 默认验证关键字：常见到几乎任何小说站都该有结果 */
export const defaultVerifyKeyword = "第一";

export type VerifyStatus = "ok" | "failed";

export interface VerifyOutcome {
  sourceId: string;
  sourceName: string;
  status: VerifyStatus;
  searchHits: number;
  tocChapters: number;
  message: string;
}

export interface VerifyRunResult {
  outcomes: VerifyOutcome[];
  totals: {
    checked: number;
    ok: number;
    failed: number;
    /** 尚未验证的源数，用于分批推进 */
    remaining: number;
  };
}

function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`超时（${ms}ms）`);
      error.name = "VerifyTimeout";
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

/**
 * 验证单个源。
 *
 * 判定：搜索有命中 且 第一本书能取到目录 → ok。
 * 只要有一步失败就是 failed，并记下失败在哪一步 —— 「能搜不能读」
 * 和「压根搜不到」是不同的问题，排查时需要区分。
 */
async function verifyOne(
  db: AppDb,
  source: typeof contentSources.$inferSelect,
  keyword: string,
  gapMs: number
): Promise<VerifyOutcome> {
  const base = { sourceId: source.id, sourceName: source.name };
  const adapter = getAdapter(source.kind);
  const ctx = {
    db,
    endpoint: source.endpoint,
    config: (source.config as Record<string, unknown>) ?? {},
    countRequest: () => {},
  };

  // 第一步：搜索（不支持搜索的源改为列目录）
  let books: { externalId: string; title: string; author?: string | null }[];
  if (adapter.search) {
    try {
      const found = await withTimeout(adapter.search(ctx, keyword), verifyTimeoutMs);
      books = found.filter((book) => matchesKeyword(book, keyword));
      if (books.length === 0) {
        return {
          ...base,
          status: "failed",
          searchHits: 0,
          tocChapters: 0,
          message:
            found.length > 0
              ? `搜索返回 ${found.length} 条但均与关键字无关（该源未做关键字匹配）`
              : "搜索无结果",
        };
      }
    } catch (error) {
      return {
        ...base,
        status: "failed",
        searchHits: 0,
        tocChapters: 0,
        message: `搜索失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    // 不支持搜索的源（feed/opds/gutendex）走列目录
    try {
      const listed = await withTimeout(adapter.listBooks(ctx), verifyTimeoutMs);
      books = listed;
      if (books.length === 0) {
        return { ...base, status: "failed", searchHits: 0, tocChapters: 0, message: "目录为空" };
      }
    } catch (error) {
      return {
        ...base,
        status: "failed",
        searchHits: 0,
        tocChapters: 0,
        message: `列目录失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (gapMs > 0) await delay(gapMs);

  // 第二步：取第一本书的目录
  const first = books[0]!;
  try {
    const chapters = await withTimeout(
      adapter.listChapters(ctx, { externalId: first.externalId }),
      verifyTimeoutMs
    );
    if (chapters.length === 0) {
      return {
        ...base,
        status: "failed",
        searchHits: books.length,
        tocChapters: 0,
        message: "能搜到书但目录为空",
      };
    }
    return {
      ...base,
      status: "ok",
      searchHits: books.length,
      tocChapters: chapters.length,
      message: `搜到 ${books.length} 本，《${first.title}》${chapters.length} 章`,
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      searchHits: books.length,
      tocChapters: 0,
      message: `能搜到书但取目录失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 分批验证。
 *
 * 默认优先验证还没测过的源；全部测过后重新从头轮，便于定期复检
 * （站点改版后原本可用的源也会失效）。
 */
export async function verifySources(
  db: AppDb,
  options?: {
    keyword?: string;
    limit?: number;
    sourceIds?: string[] | null;
    recheck?: boolean;
    /** 源间隔，仅测试注入用；生产走 politeDelayMs 以免打挂源站 */
    delayMs?: number;
  }
): Promise<VerifyRunResult> {
  const keyword = options?.keyword?.trim() || defaultVerifyKeyword;
  const limit = Math.min(Math.max(1, options?.limit ?? maxVerifyPerRun), maxVerifyPerRun);
  const gapMs = options?.delayMs ?? politeDelayMs;

  let pool: (typeof contentSources.$inferSelect)[];
  if (options?.sourceIds?.length) {
    pool = await db
      .select()
      .from(contentSources)
      .where(inArray(contentSources.id, options.sourceIds))
      .all();
  } else if (options?.recheck) {
    // 复检：按验证时间从旧到新
    pool = await db
      .select()
      .from(contentSources)
      .where(eq(contentSources.status, sourceStatus.enabled))
      .orderBy(asc(contentSources.verifiedAt))
      .limit(limit)
      .all();
  } else {
    // 优先没测过的
    pool = await db
      .select()
      .from(contentSources)
      .where(eq(contentSources.status, sourceStatus.enabled))
      .orderBy(asc(contentSources.verifiedAt))
      .limit(limit)
      .all();
    const untested = pool.filter((source) => source.verifyStatus === "untested");
    if (untested.length > 0) pool = untested;
  }

  const targets = pool.slice(0, limit);
  const outcomes: VerifyOutcome[] = [];

  for (const [index, source] of targets.entries()) {
    if (index > 0 && gapMs > 0) await delay(gapMs);
    const outcome = await verifyOne(db, source, keyword, gapMs);
    outcomes.push(outcome);
    await db
      .update(contentSources)
      .set({
        verifyStatus: outcome.status,
        verifyMessage: outcome.message.slice(0, 300),
        verifiedAt: new Date(),
        verifySearchHits: outcome.searchHits,
        verifyTocChapters: outcome.tocChapters,
        updatedAt: new Date(),
      })
      .where(eq(contentSources.id, source.id));
  }

  const remainingRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(contentSources)
    .where(
      sql`${contentSources.status} = ${sourceStatus.enabled} AND ${contentSources.verifyStatus} = 'untested'`
    )
    .get();

  return {
    outcomes,
    totals: {
      checked: outcomes.length,
      ok: outcomes.filter((item) => item.status === "ok").length,
      failed: outcomes.filter((item) => item.status === "failed").length,
      remaining: Number(remainingRow?.count ?? 0),
    },
  };
}

/**
 * 删除所有验证失败的源。
 *
 * 「只保留真正可用的源」用的就是这个：验证跑完后一键清掉坏源，
 * 剩下的都是实测能搜能读的。已入库的书籍不受影响。
 */
export async function purgeFailedSources(db: AppDb): Promise<{ deleted: number }> {
  const failed = await db
    .select({ id: contentSources.id })
    .from(contentSources)
    .where(eq(contentSources.verifyStatus, "failed"))
    .all();
  if (failed.length === 0) return { deleted: 0 };

  await db.delete(contentSources).where(eq(contentSources.verifyStatus, "failed"));
  return { deleted: failed.length };
}

/** 验证概览，给管理台展示进度 */
export async function getVerifyOverview(db: AppDb) {
  const rows = await db
    .select({
      status: contentSources.verifyStatus,
      count: sql<number>`count(*)`,
    })
    .from(contentSources)
    .where(ne(contentSources.status, "disabled"))
    .groupBy(contentSources.verifyStatus)
    .all();

  const byStatus = new Map(rows.map((row) => [row.status, Number(row.count)]));
  return {
    ok: byStatus.get("ok") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    untested: byStatus.get("untested") ?? 0,
  };
}
