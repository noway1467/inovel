import { desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  books,
  contentSources,
  siteSettings,
  sourceChapterLinks,
  sourceDomains,
  sourceStatus,
  sourceSubscriptions,
  sourceSyncRuns,
  subscriptionStatus,
} from "drizzle/schema";
import type { AppDb } from "~/server/db";
import {
  domainRestrictionKey,
  hostMatchesAllowlist,
  isDomainRestrictionEnabled,
  loadAllowlist,
  normalizeEndpoint,
  parseSourceUrl,
} from "~/server/sources/fetch-guard";
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
  input: { host: string; authorizationNote?: string; actorId: string }
) {
  const host = input.host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    throw new Error(`域名格式无效：${input.host}`);
  }
  // 备注是可选的自用标签，不做长度校验
  const note = (input.authorizationNote ?? "").trim() || "（无备注）";

  const id = crypto.randomUUID();
  await db
    .insert(sourceDomains)
    .values({ id, host, authorizationNote: note.slice(0, 500), confirmedBy: input.actorId })
    .onConflictDoNothing();

  // 必须回头放行此前被挡下的源：否则源卡在 blocked，而 UI 上的「启用」
  // 按钮在 blocked 状态恰好是禁用的，用户没有任何办法救它
  const unblocked = await reconcileBlockedSources(db);

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: input.actorId,
    action: "source_domain.allow",
    entityType: "source_domain",
    entityId: host,
    after: { host, authorizationNote: note.slice(0, 500) },
    reason: "operator added domain to allowlist",
  });
  return { host, unblocked };
}

export async function removeDomain(db: AppDb, host: string, actorId: string) {
  await db.delete(sourceDomains).where(eq(sourceDomains.host, host));

  // 只在域名限定开启时才需要停抓：开关关着的话白名单本身不生效，
  // 删一条记录不该影响任何源
  let blockedCount = 0;
  if (await isDomainRestrictionEnabled(db)) {
    const affected = await db.select().from(contentSources).all();
    for (const source of affected) {
      const parsed = parseSourceUrl(source.endpoint);
      if (!parsed.ok) continue;
      const hostname = parsed.url.hostname.toLowerCase();
      if (hostname === host || hostname.endsWith(`.${host}`)) {
        await db
          .update(contentSources)
          .set({ status: sourceStatus.blocked, updatedAt: new Date() })
          .where(eq(contentSources.id, source.id));
        blockedCount += 1;
      }
    }
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "source_domain.revoke",
    entityType: "source_domain",
    entityId: host,
    before: { host },
    reason: "operator removed domain from allowlist",
  });
  return { blocked: blockedCount };
}

/**
 * 源登记后默认直接可用。
 *
 * 只有两种情况不启用：地址本身非法（解析不了、内网地址），
 * 或者运营方主动开了域名限定而该域名不在白名单里。
 */
async function resolveStatus(db: AppDb, endpoint: string): Promise<{ status: string; reason: string }> {
  const parsed = parseSourceUrl(endpoint);
  if (!parsed.ok) return { status: sourceStatus.blocked, reason: parsed.message };
  if (await isDomainRestrictionEnabled(db)) {
    const allowlist = await loadAllowlist(db);
    if (!hostMatchesAllowlist(parsed.url.hostname, allowlist)) {
      return {
        status: sourceStatus.blocked,
        reason: `已开启域名限定，${parsed.url.hostname} 不在白名单内`,
      };
    }
  }
  return { status: sourceStatus.enabled, reason: "源已启用" };
}

/**
 * 重新评估所有 blocked 源，把现在已可用的放行。
 *
 * 之前 removeDomain 会把源降级为 blocked，但 addDomain 不会升回来，
 * 而 UI 上「启用」按钮在 blocked 时恰好是禁用的 —— 源就永久卡死。
 * 任何改变放行条件的操作都必须调这个函数。
 */
export async function reconcileBlockedSources(db: AppDb): Promise<number> {
  const blocked = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.status, sourceStatus.blocked))
    .all();
  let unblocked = 0;
  for (const source of blocked) {
    const { status } = await resolveStatus(db, source.endpoint);
    if (status === sourceStatus.enabled) {
      await db
        .update(contentSources)
        .set({ status: sourceStatus.enabled, updatedAt: new Date() })
        .where(eq(contentSources.id, source.id));
      unblocked += 1;
    }
  }
  return unblocked;
}

/** 读写「域名限定」开关。关闭时（默认）所有合法地址都可抓。 */
export async function getDomainRestriction(db: AppDb): Promise<boolean> {
  return isDomainRestrictionEnabled(db);
}

export async function setDomainRestriction(db: AppDb, enabled: boolean, actorId: string) {
  const existing = await db
    .select({ id: siteSettings.id })
    .from(siteSettings)
    .where(eq(siteSettings.key, domainRestrictionKey))
    .get();
  if (existing) {
    await db
      .update(siteSettings)
      .set({ value: { enabled }, updatedAt: new Date() })
      .where(eq(siteSettings.id, existing.id));
  } else {
    await db.insert(siteSettings).values({
      id: crypto.randomUUID(),
      key: domainRestrictionKey,
      value: { enabled },
      description: "是否用白名单限定在线源可抓域名，默认关闭",
    });
  }
  // 关掉限定后，此前被挡下的源应立即恢复
  const unblocked = enabled ? 0 : await reconcileBlockedSources(db);
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "source_domain.restriction",
    entityType: "site_settings",
    entityId: domainRestrictionKey,
    after: { enabled },
    reason: "admin toggled source domain restriction",
  });
  return { enabled, unblocked };
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
  // 与查重共用同一个归一化实现，避免"存的值"和"查的值"分叉
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!endpoint) {
    const parsed = parseSourceUrl(input.endpoint);
    throw new Error(parsed.ok ? `地址无法解析：${input.endpoint}` : parsed.message);
  }
  if (!input.name.trim()) throw new Error("源名称不能为空");

  const interval = input.syncIntervalMinutes ?? 360;
  if (!Number.isFinite(interval) || interval < 30 || interval > 10080) {
    throw new Error("同步间隔需在 30 分钟至 7 天之间");
  }

  /**
   * 规则源必须带规则。
   *
   * 此前允许 kind="rules" 且 config 为空落库，这种源一定在搜索/同步时
   * 抛「规则配置不完整」——错误发生在使用时，而非创建时，很难定位。
   * 规则源只能由导入书源 JSON 产生，不能手工登记。
   */
  if (input.kind === "rules") {
    const config = input.config ?? {};
    const missing = ["tocList", "tocName", "tocUrl", "contentRule"].filter(
      (key) => typeof config[key] !== "string" || !(config[key] as string).trim()
    );
    if (missing.length > 0) {
      throw new Error(
        `规则源需要完整规则（缺 ${missing.join(" / ")}）。请用「批量导入源」粘贴书源 JSON，不要手工登记规则源。`
      );
    }
  }

  const { status, reason } = await resolveStatus(db, endpoint);
  const id = crypto.randomUUID();
  await db.insert(contentSources).values({
    id,
    name: input.name.trim().slice(0, 100),
    kind: input.kind,
    endpoint,
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
    after: { name: input.name, kind: input.kind, endpoint, status },
    reason: "admin added online source",
  });

  return { id, status, reason };
}

/** 批量导入书源 JSON。导入后即启用，除非开了域名限定且不在白名单内。 */
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

export type BulkAction = "enable" | "disable" | "delete";

export interface BulkResult {
  ok: string[];
  failed: { sourceId: string; reason: string }[];
}

/**
 * 批量启用/停用/删除源。
 *
 * 导入一份合集会一次进来几百个源，逐个点按钮不可行。
 * 单个失败只记原因，不中断整批。
 */
export async function bulkUpdateSources(
  db: AppDb,
  sourceIds: string[],
  action: BulkAction,
  actorId: string
): Promise<BulkResult> {
  const ok: string[] = [];
  const failed: { sourceId: string; reason: string }[] = [];

  for (const sourceId of sourceIds) {
    try {
      if (action === "delete") {
        await deleteSource(db, sourceId, actorId);
      } else {
        await updateSourceStatus(db, sourceId, action === "enable" ? "enabled" : "disabled", actorId);
      }
      ok.push(sourceId);
    } catch (error) {
      failed.push({
        sourceId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: `content_source.bulk_${action}`,
    entityType: "content_source",
    entityId: `${ok.length}/${sourceIds.length}`,
    after: { action, ok: ok.length, failed: failed.length },
    reason: "admin bulk source management",
  });

  return { ok, failed };
}

/** 按名称/地址/类型/状态筛选源，供大批量场景下的管理页使用 */
export async function listSourcesFiltered(
  db: AppDb,
  filter?: { q?: string | null; kind?: string | null; status?: string | null }
) {
  const rows = await listSources(db);
  const q = filter?.q?.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter?.kind && row.kind !== filter.kind) return false;
    if (filter?.status && row.status !== filter.status) return false;
    if (q) {
      const haystack = `${row.name} ${row.endpoint}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
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
