import { desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  books,
  contentSources,
  sourceChapterLinks,
  sourceDomains,
  sourceStatus,
  sourceSubscriptions,
  sourceSyncRuns,
  subscriptionStatus,
} from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { hostMatchesAllowlist, loadAllowlist, parseSourceUrl } from "~/server/sources/fetch-guard";
import { parseLegadoJson, type ConversionResult } from "~/server/sources/legado";
import { getAdapter, listAdapters } from "~/server/sources/registry";
import type { SourceBook } from "~/server/sources/types";

/** 管理台读写在线源的服务层。所有入口都假定调用方已校验管理员权限。 */

export { listAdapters };

export async function listDomains(db: AppDb) {
  return db.select().from(sourceDomains).orderBy(sourceDomains.host).all();
}

export async function addDomain(
  db: AppDb,
  input: { host: string; authorizationNote: string; actorId: string }
) {
  const host = input.host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new Error(`域名格式无效：${input.host}`);
  }
  const note = input.authorizationNote.trim();
  // 强制填写授权依据：这条记录是事后追责的唯一凭据
  if (note.length < 5) {
    throw new Error("必须填写授权依据（至少 5 个字），说明你为何有权抓取该站点");
  }

  const id = crypto.randomUUID();
  await db
    .insert(sourceDomains)
    .values({ id, host, authorizationNote: note.slice(0, 500), confirmedBy: input.actorId })
    .onConflictDoNothing();

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: input.actorId,
    action: "source_domain.allow",
    entityType: "source_domain",
    entityId: host,
    after: { host, authorizationNote: note.slice(0, 500) },
    reason: "operator confirmed crawl authorization",
  });
  return { host };
}

export async function removeDomain(db: AppDb, host: string, actorId: string) {
  await db.delete(sourceDomains).where(eq(sourceDomains.host, host));
  // 白名单撤销后，该域名下的源立即停抓
  const affected = await db.select().from(contentSources).all();
  for (const source of affected) {
    const parsed = parseSourceUrl(source.endpoint);
    if (!parsed.ok) continue;
    if (parsed.url.hostname.toLowerCase() === host || parsed.url.hostname.toLowerCase().endsWith(`.${host}`)) {
      await db
        .update(contentSources)
        .set({ status: sourceStatus.blocked, updatedAt: new Date() })
        .where(eq(contentSources.id, source.id));
    }
  }
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "source_domain.revoke",
    entityType: "source_domain",
    entityId: host,
    before: { host },
    reason: "operator revoked crawl authorization",
  });
}

/** 源的状态取决于其域名是否已授权；登记与启用解耦，避免误抓。 */
async function resolveStatus(db: AppDb, endpoint: string): Promise<{ status: string; reason: string }> {
  const parsed = parseSourceUrl(endpoint);
  if (!parsed.ok) return { status: sourceStatus.blocked, reason: parsed.message };
  const allowlist = await loadAllowlist(db);
  if (!hostMatchesAllowlist(parsed.url.hostname, allowlist)) {
    return {
      status: sourceStatus.blocked,
      reason: `域名 ${parsed.url.hostname} 未获授权确认，源已登记但不会抓取`,
    };
  }
  return { status: sourceStatus.enabled, reason: "域名已授权，源已启用" };
}

export async function listSources(db: AppDb) {
  const rows = await db.select().from(contentSources).orderBy(desc(contentSources.createdAt)).all();
  const counts = await db
    .select({
      sourceId: sourceSubscriptions.sourceId,
      count: sql<number>`count(*)`,
    })
    .from(sourceSubscriptions)
    .groupBy(sourceSubscriptions.sourceId)
    .all();
  const bySource = new Map(counts.map((row) => [row.sourceId, Number(row.count)]));
  return rows.map((row) => ({ ...row, subscriptionCount: bySource.get(row.id) ?? 0 }));
}

export interface CreateSourceInput {
  name: string;
  kind: string;
  endpoint: string;
  config?: Record<string, unknown> | null;
  attribution?: string | null;
  syncIntervalMinutes?: number;
  actorId: string;
}

export async function createSource(db: AppDb, input: CreateSourceInput) {
  getAdapter(input.kind); // 未知类型直接抛错
  const parsed = parseSourceUrl(input.endpoint);
  if (!parsed.ok) throw new Error(parsed.message);
  if (!input.name.trim()) throw new Error("源名称不能为空");

  const interval = input.syncIntervalMinutes ?? 360;
  if (!Number.isFinite(interval) || interval < 30 || interval > 10080) {
    throw new Error("同步间隔需在 30 分钟至 7 天之间");
  }

  const { status, reason } = await resolveStatus(db, input.endpoint);
  const id = crypto.randomUUID();
  await db.insert(contentSources).values({
    id,
    name: input.name.trim().slice(0, 100),
    kind: input.kind,
    endpoint: parsed.url.toString(),
    status,
    config: input.config ?? null,
    attribution: input.attribution?.slice(0, 200) ?? null,
    syncIntervalMinutes: interval,
    createdBy: input.actorId,
  });

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: input.actorId,
    action: "content_source.create",
    entityType: "content_source",
    entityId: id,
    after: { name: input.name, kind: input.kind, endpoint: parsed.url.toString(), status },
    reason: "admin added online source",
  });

  return { id, status, reason };
}

/** 批量导入开源阅读书源 JSON。域名未授权的会登记为 blocked，不会抓取。 */
export async function importLegadoSources(
  db: AppDb,
  text: string,
  actorId: string,
  defaultIntervalMinutes = 360
) {
  const { converted, failed } = parseLegadoJson(text);
  const created: { name: string; status: string; reason: string }[] = [];
  const skipped: { name: string; reason: string }[] = [...failed.map((f) => ({ name: f.name, reason: f.reason }))];

  for (const item of converted) {
    try {
      const result = await createSourceFromConversion(db, item, actorId, defaultIntervalMinutes);
      created.push({ name: item.name, status: result.status, reason: result.reason });
    } catch (error) {
      skipped.push({
        name: item.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { created, skipped };
}

async function createSourceFromConversion(
  db: AppDb,
  item: ConversionResult,
  actorId: string,
  intervalMinutes: number
) {
  return createSource(db, {
    name: item.name,
    kind: "rules",
    endpoint: item.endpoint,
    config: item.config as unknown as Record<string, unknown>,
    attribution: `来源：${item.name}`,
    syncIntervalMinutes: intervalMinutes,
    actorId,
  });
}

export async function updateSourceStatus(
  db: AppDb,
  sourceId: string,
  next: "enabled" | "disabled",
  actorId: string
) {
  const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
  if (!source) throw new Error("源不存在");

  if (next === "enabled") {
    // 启用前必须过白名单，不允许绕过
    const { status, reason } = await resolveStatus(db, source.endpoint);
    if (status !== sourceStatus.enabled) throw new Error(reason);
  }
  await db
    .update(contentSources)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(contentSources.id, sourceId));

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "content_source.status",
    entityType: "content_source",
    entityId: sourceId,
    before: { status: source.status },
    after: { status: next },
    reason: "admin toggled source",
  });
  return next;
}

export async function deleteSource(db: AppDb, sourceId: string, actorId: string) {
  const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
  if (!source) throw new Error("源不存在");
  // 订阅与章节映射走级联删除；本地已入库的书籍保留，避免误删内容
  await db.delete(contentSources).where(eq(contentSources.id, sourceId));
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "content_source.delete",
    entityType: "content_source",
    entityId: sourceId,
    before: { name: source.name, endpoint: source.endpoint },
    reason: "admin removed source; imported books kept",
  });
}

export async function probeSource(db: AppDb, sourceId: string) {
  const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
  if (!source) throw new Error("源不存在");
  const adapter = getAdapter(source.kind);
  return adapter.probe({
    db,
    endpoint: source.endpoint,
    config: (source.config as Record<string, unknown>) ?? {},
    // 探测只看连通性，不统计请求数
    countRequest: () => {},
  });
}

export async function searchSource(db: AppDb, sourceId: string, keyword: string): Promise<SourceBook[]> {
  const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
  if (!source) throw new Error("源不存在");
  if (source.status !== sourceStatus.enabled) throw new Error("源未启用，无法搜索");
  const adapter = getAdapter(source.kind);
  if (!adapter.search) throw new Error("该源类型不支持搜索");
  return adapter.search(
    {
      db,
      endpoint: source.endpoint,
      config: (source.config as Record<string, unknown>) ?? {},
      countRequest: () => {},
    },
    keyword
  );
}

export async function browseSource(db: AppDb, sourceId: string): Promise<SourceBook[]> {
  const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
  if (!source) throw new Error("源不存在");
  if (source.status !== sourceStatus.enabled) throw new Error("源未启用，无法浏览");
  const adapter = getAdapter(source.kind);
  return adapter.listBooks({
    db,
    endpoint: source.endpoint,
    config: (source.config as Record<string, unknown>) ?? {},
    countRequest: () => {},
  });
}

export async function listSubscriptions(db: AppDb, sourceId?: string) {
  const query = db
    .select({
      id: sourceSubscriptions.id,
      sourceId: sourceSubscriptions.sourceId,
      sourceName: contentSources.name,
      bookId: sourceSubscriptions.bookId,
      bookTitle: books.title,
      bookStatus: books.status,
      externalId: sourceSubscriptions.externalId,
      externalTitle: sourceSubscriptions.externalTitle,
      status: sourceSubscriptions.status,
      syncedChapterCount: sourceSubscriptions.syncedChapterCount,
      lastSyncAt: sourceSubscriptions.lastSyncAt,
      lastError: sourceSubscriptions.lastError,
    })
    .from(sourceSubscriptions)
    .innerJoin(contentSources, eq(sourceSubscriptions.sourceId, contentSources.id))
    .innerJoin(books, eq(sourceSubscriptions.bookId, books.id))
    .orderBy(desc(sourceSubscriptions.updatedAt));

  const rows = sourceId ? await query.where(eq(sourceSubscriptions.sourceId, sourceId)).all() : await query.all();

  const pending = await db
    .select({
      subscriptionId: sourceChapterLinks.subscriptionId,
      count: sql<number>`count(*)`,
    })
    .from(sourceChapterLinks)
    .where(eq(sourceChapterLinks.fetchStatus, "pending"))
    .groupBy(sourceChapterLinks.subscriptionId)
    .all();
  const pendingBySub = new Map(pending.map((row) => [row.subscriptionId, Number(row.count)]));

  return rows.map((row) => ({ ...row, pendingChapters: pendingBySub.get(row.id) ?? 0 }));
}

export async function setSubscriptionStatus(
  db: AppDb,
  subscriptionId: string,
  next: "active" | "paused",
  actorId: string
) {
  await db
    .update(sourceSubscriptions)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(sourceSubscriptions.id, subscriptionId));
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "source_subscription.status",
    entityType: "source_subscription",
    entityId: subscriptionId,
    after: { status: next },
    reason: "admin toggled subscription",
  });
  return next;
}

export async function removeSubscription(db: AppDb, subscriptionId: string, actorId: string) {
  await db.delete(sourceSubscriptions).where(eq(sourceSubscriptions.id, subscriptionId));
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "source_subscription.delete",
    entityType: "source_subscription",
    entityId: subscriptionId,
    reason: "admin removed subscription; local book kept",
  });
}

export async function listSyncRuns(db: AppDb, limit = 30) {
  return db
    .select({
      id: sourceSyncRuns.id,
      sourceId: sourceSyncRuns.sourceId,
      sourceName: contentSources.name,
      trigger: sourceSyncRuns.trigger,
      status: sourceSyncRuns.status,
      booksChecked: sourceSyncRuns.booksChecked,
      chaptersAdded: sourceSyncRuns.chaptersAdded,
      requestCount: sourceSyncRuns.requestCount,
      message: sourceSyncRuns.message,
      startedAt: sourceSyncRuns.startedAt,
      finishedAt: sourceSyncRuns.finishedAt,
    })
    .from(sourceSyncRuns)
    .innerJoin(contentSources, eq(sourceSyncRuns.sourceId, contentSources.id))
    .orderBy(desc(sourceSyncRuns.startedAt))
    .limit(limit)
    .all();
}

/** 订阅统计，给管理台顶部的概览卡片 */
export async function getSourceOverview(db: AppDb) {
  const [sources, subs, pendingRows, allowlist] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(contentSources).get(),
    db.select({ count: sql<number>`count(*)` }).from(sourceSubscriptions).get(),
    db
      .select({ count: sql<number>`count(*)` })
      .from(sourceChapterLinks)
      .where(eq(sourceChapterLinks.fetchStatus, "pending"))
      .get(),
    db.select({ count: sql<number>`count(*)` }).from(sourceDomains).get(),
  ]);
  const active = await db
    .select({ count: sql<number>`count(*)` })
    .from(sourceSubscriptions)
    .where(eq(sourceSubscriptions.status, subscriptionStatus.active))
    .get();

  return {
    sourceCount: Number(sources?.count ?? 0),
    subscriptionCount: Number(subs?.count ?? 0),
    activeSubscriptionCount: Number(active?.count ?? 0),
    pendingChapterCount: Number(pendingRows?.count ?? 0),
    allowlistCount: Number(allowlist?.count ?? 0),
  };
}
