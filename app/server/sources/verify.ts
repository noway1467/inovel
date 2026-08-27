import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
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
export const maxVerifyPerRun = 8;

/**
 * 同时验证几个源。
 *
 * 原先整批是串行的，源之间还各等 politeDelayMs —— 但礼貌延迟只对
 * 「同一个站」有意义，不同源本就是不同域名，串着等纯属浪费：
 * 5 个源光延迟就 5 秒以上，两百多个源要跑十几分钟。
 * 同源内部的两步（搜索 → 取目录）仍然保留间隔。
 */
const verifyConcurrency = 4;

/** 固定并发跑一批任务，保持与输入同序 */
async function runPooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 单个源的验证时限。比搜索给得宽些，因为要连做两步。 */
const verifyTimeoutMs = 15_000;

/** 默认验证关键字：常见到几乎任何小说站都该有结果 */
export const defaultVerifyKeyword = "第一";

/**
 * 验证结论。
 *
 * skipped 是必需的第三态：规则源里有一批（合集实测 244 个可导入源中 48 个）
 * 搜索地址需要 JS 求值而被降级，只能靠详情页地址订阅。这类源没法自动跑
 * 「搜索 → 取目录」—— 拿不到书就无从取目录。
 *
 * 判 failed 会被「清理不可用的源」直接删掉，而它们其实完全能读；
 * 判 ok 又是撒谎，我们并没验证过任何一章。所以单独一态：不下结论，
 * 只说明为什么没法自动验，让运营方自己给个书籍地址试。
 */
export type VerifyStatus = "ok" | "failed" | "skipped";

/**
 * 失败原因分类。
 *
 * 为什么要分：原先失败一律记 failed，里面混着完全不同的毛病 —— 源站限流
 * 返 503、站点封禁返 403、连不上超时、规则失效搜不到、搜到书但没目录。
 * 这些该分开处理：403 的源基本没救可以删，503 多半是打太急、过一阵还能用，
 * 规则失效的可以等作者更新。一锅端成 failed 就只能全删或全留。
 */
export type VerifyFailReason =
  | "timeout" // 连不上或超过 verifyTimeoutMs
  | "http_403" // 站点封禁（含 401/407）
  | "http_429" // 明确限流
  | "http_5xx" // 源站故障或限流，503 居多
  | "http_4xx" // 其余 4xx，多为路径失效
  | "no_search" // 搜索规则失效：一条也搜不到
  | "irrelevant" // 搜索有返回但与关键字无关（源站不做匹配，回吐热门榜）
  | "no_toc" // 能搜到书但目录为空或取不到
  | "no_content" // 正文规则未命中
  | "other";

/**
 * 从错误信息反推失败原因。
 *
 * 走 message 而不是逐个 return 传参：抛错点分散在适配器各处（搜索、列目录、
 * 取章节），而 message 本来就带着 `源返回 HTTP 503`、`请求超时（15000ms）`
 * 这些信息。集中在一处判，比在八个 return 里各塞一个字段好维护。
 */
export function classifyFailure(message: string): VerifyFailReason {
  const text = message.toLowerCase();

  if (text.includes("超时") || text.includes("timeout") || text.includes("aborted")) {
    return "timeout";
  }

  const httpAt = /http\s*(\d{3})/.exec(text);
  if (httpAt) {
    const code = Number(httpAt[1]);
    if (code === 403 || code === 401 || code === 407) return "http_403";
    if (code === 429) return "http_429";
    if (code >= 500) return "http_5xx";
    if (code >= 400) return "http_4xx";
  }

  if (text.includes("与关键字无关") || text.includes("未做关键字匹配")) return "irrelevant";
  if (text.includes("搜索无结果") || text.includes("未配置搜索规则")) return "no_search";
  if (text.includes("目录为空") || text.includes("取目录失败") || text.includes("列目录失败")) {
    return "no_toc";
  }
  if (text.includes("正文规则未命中")) return "no_content";

  // 网络层没给状态码的连接失败也算超时一类：表现和处置方式一样
  if (text.includes("fetch failed") || text.includes("network") || text.includes("连接")) {
    return "timeout";
  }
  return "other";
}

/** 给管理台显示的中文说明 */
export const failReasonLabels: Record<VerifyFailReason, string> = {
  timeout: "请求超时",
  http_403: "被封禁 403",
  http_429: "被限流 429",
  http_5xx: "源站故障 5xx",
  http_4xx: "地址失效 4xx",
  no_search: "搜不到书",
  irrelevant: "结果与关键字无关",
  no_toc: "没有目录",
  no_content: "取不到正文",
  other: "其它",
};

export interface VerifyOutcome {
  sourceId: string;
  sourceName: string;
  status: VerifyStatus;
  searchHits: number;
  tocChapters: number;
  message: string;
  /** 仅 failed 时有值，供管理台按原因筛选与精准清理 */
  failReason?: VerifyFailReason;
}

export interface VerifyRunResult {
  outcomes: VerifyOutcome[];
  totals: {
    checked: number;
    ok: number;
    failed: number;
    /** 无法自动验证、未下结论的源数（搜索被降级掉的规则源） */
    skipped: number;
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

  /**
   * 搜索能力被降级掉的规则源：不下结论，直接跳过。
   *
   * 不能走下面的搜索分支 —— 规则适配器的 search 总是存在，对没有 searchUrl
   * 的源会抛错，结果被判 failed 然后被清理删掉。这类源用详情页地址订阅
   * 照样能读，删掉是实打实的误伤。
   */
  const searchable =
    source.kind !== "rules" || Boolean((ctx.config as { searchUrl?: unknown }).searchUrl);
  if (!searchable) {
    return {
      ...base,
      status: "skipped",
      searchHits: 0,
      tocChapters: 0,
      message: "该源搜索地址需 JS 求值，无法自动验证；用「订阅指定书籍」输入详情页地址即可使用",
    };
  }

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

  // 并发跑，各源互不相干；写回也在各自任务里做，省掉再排一轮
  const outcomes = await runPooled(targets, verifyConcurrency, async (source) => {
    const raw = await verifyOne(db, source, keyword, gapMs);
    /**
     * 失败原因在这里统一分类一次 —— verifyOne 里有八个 failed 出口，
     * 逐个塞字段容易漏，而 message 已经带着 HTTP 状态码与超时信息。
     */
    const outcome: VerifyOutcome =
      raw.status === "failed" ? { ...raw, failReason: classifyFailure(raw.message) } : raw;
    await db
      .update(contentSources)
      .set({
        verifyStatus: outcome.status,
        verifyMessage: outcome.message.slice(0, 300),
        // 原因写进独立列，管理台据此筛选与精准清理
        verifyFailReason: outcome.failReason ?? null,
        verifiedAt: new Date(),
        verifySearchHits: outcome.searchHits,
        verifyTocChapters: outcome.tocChapters,
        updatedAt: new Date(),
      })
      .where(eq(contentSources.id, source.id));
    return outcome;
  });

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
      skipped: outcomes.filter((item) => item.status === "skipped").length,
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
export async function purgeFailedSources(
  db: AppDb,
  /**
   * 只删指定原因的失败源。不传就删全部失败源（保持原行为）。
   *
   * 分原因删是有必要的：403 被封的源基本没救，删掉干净；而 503 多半是当时
   * 打太急，过一阵还能用，删了就白导入一遍。让运营方自己挑该删哪类。
   */
  reasons?: VerifyFailReason[]
): Promise<{ deleted: number }> {
  const condition =
    reasons && reasons.length > 0
      ? and(
          eq(contentSources.verifyStatus, "failed"),
          inArray(contentSources.verifyFailReason, reasons)
        )
      : eq(contentSources.verifyStatus, "failed");

  const failed = await db.select({ id: contentSources.id }).from(contentSources).where(condition).all();
  if (failed.length === 0) return { deleted: 0 };

  await db.delete(contentSources).where(condition);
  return { deleted: failed.length };
}

/** 各失败原因各有多少个源，供管理台显示「删掉这 N 个」 */
export async function getFailReasonCounts(
  db: AppDb
): Promise<{ reason: VerifyFailReason; label: string; count: number }[]> {
  const rows = await db
    .select({ reason: contentSources.verifyFailReason, count: sql<number>`count(*)` })
    .from(contentSources)
    .where(eq(contentSources.verifyStatus, "failed"))
    .groupBy(contentSources.verifyFailReason)
    .all();

  return rows
    .map((row) => {
      const reason = (row.reason ?? "other") as VerifyFailReason;
      return { reason, label: failReasonLabels[reason] ?? "其它", count: Number(row.count) };
    })
    .sort((a, b) => b.count - a.count);
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
    skipped: byStatus.get("skipped") ?? 0,
  };
}
