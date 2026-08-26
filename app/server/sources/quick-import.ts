import type { Queue } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { contentSources } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { normalizeEndpoint } from "~/server/sources/fetch-guard";
import { parseLegadoJson, type ConversionResult } from "~/server/sources/legado";
import { getAdapter } from "~/server/sources/registry";
import { createSource } from "~/server/sources/service";
import { createSubscription, syncSubscriptionToc, type SyncOutcome } from "~/server/sources/sync";
import type { SourceBook } from "~/server/sources/types";

/**
 * 一步到位的导入订阅入口。
 *
 * 之前要分三步：导入书源 → 浏览/搜索 → 逐本订阅。这里合成一个调用：
 * 传书源 JSON（或已有源 id）+ 可选的书籍地址/关键字，直接落到"已订阅、
 * 目录已拉、正文已入队"。
 */

export interface QuickImportInput {
  /** 书源 JSON 文本，单个对象或数组。与 sourceId 二选一 */
  sourceJson?: string | null;
  /** 复用已登记的源。与 sourceJson 二选一 */
  sourceId?: string | null;
  /** 书籍详情页地址，可多个；规则源最直接的订阅方式 */
  bookUrls?: string[] | null;
  /** 搜索关键字，命中结果按 maxPerKeyword 取前几本订阅 */
  keywords?: string[] | null;
  /** 每个关键字最多订阅几本，默认 1 */
  maxPerKeyword?: number;
  /** 不传书籍时，是否自动订阅源目录上的书（OPDS/古腾堡适用） */
  subscribeAllFromCatalog?: boolean;
  /** 目录订阅上限，防止一次拉爆 */
  maxFromCatalog?: number;
  syncIntervalMinutes?: number;
  actorId: string;
}

export interface QuickImportSourceResult {
  sourceId: string;
  sourceName: string;
  status: string;
  /** 书源转换时的降级提示 */
  warnings: string[];
  subscribed: {
    subscriptionId: string;
    title: string;
    externalId: string;
    created: boolean;
    chaptersAdded: number;
    syncStatus: SyncOutcome["status"];
    syncMessage: string;
  }[];
  failed: { target: string; reason: string }[];
}

export interface QuickImportResult {
  sources: QuickImportSourceResult[];
  /** 书源解析阶段就失败的条目 */
  rejected: { name: string; reason: string }[];
  totals: { sources: number; subscriptions: number; chaptersAdded: number };
}

function ctxFor(db: AppDb, source: { endpoint: string; config: unknown }) {
  return {
    db,
    endpoint: source.endpoint,
    config: (source.config as Record<string, unknown>) ?? {},
    countRequest: () => {},
  };
}

/** 用搜索或目录把关键字/空条件解析成待订阅书目 */
async function resolveTargets(
  db: AppDb,
  source: { id: string; kind: string; endpoint: string; config: unknown },
  input: QuickImportInput
): Promise<{ books: SourceBook[]; failed: { target: string; reason: string }[] }> {
  const adapter = getAdapter(source.kind);
  const books: SourceBook[] = [];
  const failed: { target: string; reason: string }[] = [];
  const seen = new Set<string>();

  const push = (book: SourceBook) => {
    if (seen.has(book.externalId)) return;
    seen.add(book.externalId);
    books.push(book);
  };

  // 1. 直接给的书籍地址，最省事，不需要源支持搜索
  for (const url of input.bookUrls ?? []) {
    const trimmed = url.trim();
    if (!trimmed) continue;
    push({ externalId: trimmed, title: trimmed });
  }

  // 2. 关键字搜索
  const perKeyword = Math.max(1, input.maxPerKeyword ?? 1);
  for (const keyword of input.keywords ?? []) {
    const trimmed = keyword.trim();
    if (!trimmed) continue;
    if (!adapter.search) {
      failed.push({ target: trimmed, reason: `${source.kind} 类型不支持搜索` });
      continue;
    }
    try {
      const results = await adapter.search(ctxFor(db, source), trimmed);
      if (results.length === 0) {
        failed.push({ target: trimmed, reason: "搜索无结果" });
        continue;
      }
      results.slice(0, perKeyword).forEach(push);
    } catch (error) {
      failed.push({
        target: trimmed,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 3. 没指定任何书时，按需拉源目录（OPDS / 古腾堡这类有目录的源）
  const nothingSpecified = books.length === 0 && (input.keywords ?? []).length === 0;
  if (input.subscribeAllFromCatalog || nothingSpecified) {
    try {
      const catalog = await adapter.listBooks(ctxFor(db, source));
      catalog.slice(0, Math.max(1, input.maxFromCatalog ?? 20)).forEach(push);
      if (catalog.length === 0 && nothingSpecified) {
        failed.push({
          target: "(目录)",
          reason: `${source.kind} 类型没有可列举的目录，请提供 bookUrls 或 keywords`,
        });
      }
    } catch (error) {
      failed.push({
        target: "(目录)",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { books, failed };
}

/** 对一个源执行订阅 + 首次目录同步 */
async function subscribeAll(
  db: AppDb,
  queue: Queue<unknown> | undefined,
  source: { id: string; name: string; kind: string; endpoint: string; config: unknown; status: string },
  input: QuickImportInput,
  warnings: string[]
): Promise<QuickImportSourceResult> {
  const result: QuickImportSourceResult = {
    sourceId: source.id,
    sourceName: source.name,
    status: source.status,
    warnings,
    subscribed: [],
    failed: [],
  };

  if (source.status !== "enabled") {
    result.failed.push({ target: "(源)", reason: "源未启用，跳过订阅" });
    return result;
  }

  const { books, failed } = await resolveTargets(db, source, input);
  result.failed.push(...failed);

  for (const book of books) {
    try {
      const created = await createSubscription(db, {
        sourceId: source.id,
        externalId: book.externalId,
        title: book.title,
        author: book.author ?? null,
        description: book.description ?? null,
        rights: book.rights ?? null,
        actorId: input.actorId,
      });
      // 立刻拉目录：新增章节登记为 pending 并投队列抓正文
      const sync = await syncSubscriptionToc(db, queue, created.subscriptionId, "manual");
      result.subscribed.push({
        subscriptionId: created.subscriptionId,
        title: book.title,
        externalId: book.externalId,
        created: created.created !== false,
        chaptersAdded: sync.chaptersAdded,
        syncStatus: sync.status,
        syncMessage: sync.message,
      });
    } catch (error) {
      result.failed.push({
        target: book.title || book.externalId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * 主入口：书源 JSON / 已有源 id → 已订阅并开始同步。
 */
export async function quickImportAndSubscribe(
  db: AppDb,
  queue: Queue<unknown> | undefined,
  input: QuickImportInput
): Promise<QuickImportResult> {
  const sources: QuickImportSourceResult[] = [];
  const rejected: { name: string; reason: string }[] = [];

  if (!input.sourceJson?.trim() && !input.sourceId) {
    throw new Error("需要提供 sourceJson（书源 JSON）或 sourceId（已登记的源）");
  }

  // 复用已有源
  if (input.sourceId) {
    const existing = await db
      .select()
      .from(contentSources)
      .where(eq(contentSources.id, input.sourceId))
      .get();
    if (!existing) throw new Error("源不存在");
    sources.push(await subscribeAll(db, queue, existing, input, []));
  }

  // 从书源 JSON 新建
  if (input.sourceJson?.trim()) {
    const { converted, failed } = parseLegadoJson(input.sourceJson);
    rejected.push(...failed);

    for (const item of converted) {
      try {
        const created = await createSourceOrReuse(db, item, input);
        sources.push(await subscribeAll(db, queue, created, input, item.warnings));
      } catch (error) {
        rejected.push({
          name: item.name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const subscriptions = sources.reduce((sum, s) => sum + s.subscribed.length, 0);
  const chaptersAdded = sources.reduce(
    (sum, s) => sum + s.subscribed.reduce((n, sub) => n + sub.chaptersAdded, 0),
    0
  );
  return { sources, rejected, totals: { sources: sources.length, subscriptions, chaptersAdded } };
}

/** 同名同地址的源已存在时复用，避免重复导入同一书源产生一堆重复行 */
async function createSourceOrReuse(db: AppDb, item: ConversionResult, input: QuickImportInput) {
  // 必须按归一化后的地址查重：createSource 存的是 URL.toString() 的结果
  // （会补尾斜杠），拿原始字符串比会永远查不中而反复新建
  const normalized = normalizeEndpoint(item.endpoint);
  if (!normalized) throw new Error(`书源地址无法解析：${item.endpoint}`);

  const existing = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.endpoint, normalized))
    .get();
  if (existing) return existing;

  const created = await createSource(db, {
    name: item.name,
    kind: "rules",
    endpoint: item.endpoint,
    config: item.config as unknown as Record<string, unknown>,
    attribution: `来源：${item.name}`,
    syncIntervalMinutes: input.syncIntervalMinutes ?? 360,
    actorId: input.actorId,
  });
  const row = await db.select().from(contentSources).where(eq(contentSources.id, created.id)).get();
  if (!row) throw new Error("源创建后读取失败");
  return row;
}
