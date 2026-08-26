import type { Route } from "./+types/api.admin-sources";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { getUserRoleCodes } from "~/server/security/rbac";
import {
  addDomain,
  browseSource,
  createSource,
  deleteSource,
  getDomainRestriction,
  getSourceOverview,
  importLegadoSources,
  listAdapters,
  listDomains,

  listSubscriptions,
  listSyncRuns,
  probeSource,
  removeDomain,
  removeSubscription,
  searchSource,
  setDomainRestriction,
  setSubscriptionStatus,
  updateSourceStatus,
} from "~/server/sources/service";
import { quickImportAndSubscribe } from "~/server/sources/quick-import";
import { batchImportSources } from "~/server/sources/batch-import";
import { aggregateSearch } from "~/server/sources/search";
import { bulkUpdateSources, listSourcesFiltered } from "~/server/sources/service";
import { getVerifyOverview, purgeFailedSources, verifySources } from "~/server/sources/verify";
import { createSubscription, syncSource, syncSubscriptionToc } from "~/server/sources/sync";

/**
 * 在线源管理接口。全部要求 admin / super_admin：
 * 抓取外部站点是运营决策，不开放给普通作者。
 */
async function requireAdmin(
  request: Request,
  env: { DB_APP: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string }
) {
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  if (!roles.some((role) => role === "admin" || role === "super_admin")) return null;
  return { user: session.user, db };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const admin = await requireAdmin(request, env);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const path = url.pathname;

  if (path.includes("/domains")) {
    return Response.json({
      domains: await listDomains(admin.db),
      restrictionEnabled: await getDomainRestriction(admin.db),
    });
  }
  if (path.includes("/subscriptions")) {
    const sourceId = url.searchParams.get("sourceId") ?? undefined;
    return Response.json({ subscriptions: await listSubscriptions(admin.db, sourceId) });
  }
  if (path.includes("/runs")) {
    return Response.json({ runs: await listSyncRuns(admin.db) });
  }
  if (path.includes("/browse")) {
    const sourceId = url.searchParams.get("sourceId") ?? "";
    const keyword = url.searchParams.get("q") ?? "";
    try {
      const books = keyword
        ? await searchSource(admin.db, sourceId, keyword)
        : await browseSource(admin.db, sourceId);
      return Response.json({ books });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "浏览失败" },
        { status: 400 }
      );
    }
  }

  // 大批量导入后源可能有几百个，支持按名称/类型/状态/验证结果筛选
  return Response.json({
    sources: await listSourcesFiltered(admin.db, {
      q: url.searchParams.get("q"),
      kind: url.searchParams.get("kind"),
      status: url.searchParams.get("status"),
      verifyStatus: url.searchParams.get("verifyStatus"),
    }),
    adapters: listAdapters(),
    overview: await getSourceOverview(admin.db),
    verifyOverview: await getVerifyOverview(admin.db),
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const admin = await requireAdmin(request, env);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const path = url.pathname;
  const actorId = admin.user.id;

  try {
    if (path.includes("/domains")) {
      if (request.method === "DELETE") {
        const body = (await request.json()) as { host?: string };
        if (!body.host) return Response.json({ error: "host required" }, { status: 400 });
        await removeDomain(admin.db, body.host, actorId);
        return Response.json({ ok: true });
      }
      const body = (await request.json()) as { host?: string; authorizationNote?: string };
      const result = await addDomain(admin.db, {
        host: body.host ?? "",
        authorizationNote: body.authorizationNote ?? "",
        actorId,
      });
      return Response.json(result);
    }

    // 从清单地址或粘贴的 JSON 批量导入（书源/订阅源自动判别）
    if (path.includes("/batch-import")) {
      const body = (await request.json()) as {
        url?: string;
        text?: string;
        syncIntervalMinutes?: number;
      };
      const result = await batchImportSources(admin.db, {
        url: body.url ?? null,
        text: body.text ?? null,
        syncIntervalMinutes: body.syncIntervalMinutes,
        actorId,
      });
      return Response.json(result);
    }

    // 批量启用/停用/删除
    if (path.includes("/bulk")) {
      const body = (await request.json()) as {
        sourceIds?: string[];
        action?: "enable" | "disable" | "delete";
      };
      if (!body.sourceIds?.length || !body.action) {
        return Response.json({ error: "sourceIds / action required" }, { status: 400 });
      }
      const result = await bulkUpdateSources(admin.db, body.sourceIds, body.action, actorId);
      return Response.json(result);
    }

    // 分批验证源可用性（实跑搜索 + 取目录）
    if (path.includes("/verify-batch")) {
      const body = (await request.json()) as {
        keyword?: string;
        limit?: number;
        sourceIds?: string[];
        recheck?: boolean;
      };
      const result = await verifySources(admin.db, {
        keyword: body.keyword,
        limit: body.limit,
        sourceIds: body.sourceIds ?? null,
        recheck: body.recheck,
      });
      return Response.json(result);
    }

    // 清掉验证失败的源，只留实测可用的
    if (path.includes("/purge-failed")) {
      const result = await purgeFailedSources(admin.db);
      return Response.json(result);
    }

    // 跨源聚合搜索
    if (path.includes("/aggregate-search")) {
      const body = (await request.json()) as {
        keyword?: string;
        sourceIds?: string[];
        perSourceLimit?: number;
      };
      if (!body.keyword?.trim()) {
        return Response.json({ error: "keyword required" }, { status: 400 });
      }
      const result = await aggregateSearch(admin.db, body.keyword, {
        sourceIds: body.sourceIds ?? null,
        perSourceLimit: body.perSourceLimit,
      });
      return Response.json(result);
    }

    // 一步到位：书源 JSON（或已有 sourceId）→ 已订阅并开始同步
    if (path.includes("/quick-import")) {
      const body = (await request.json()) as {
        sourceJson?: string;
        sourceId?: string;
        bookUrls?: string[];
        keywords?: string[];
        maxPerKeyword?: number;
        subscribeAllFromCatalog?: boolean;
        maxFromCatalog?: number;
        syncIntervalMinutes?: number;
      };
      const result = await quickImportAndSubscribe(admin.db, env.QUEUE_JOBS, {
        sourceJson: body.sourceJson ?? null,
        sourceId: body.sourceId ?? null,
        bookUrls: body.bookUrls ?? null,
        keywords: body.keywords ?? null,
        maxPerKeyword: body.maxPerKeyword,
        subscribeAllFromCatalog: body.subscribeAllFromCatalog,
        maxFromCatalog: body.maxFromCatalog,
        syncIntervalMinutes: body.syncIntervalMinutes,
        actorId,
      });
      return Response.json(result);
    }

    if (path.includes("/domain-restriction")) {
      const body = (await request.json()) as { enabled?: boolean };
      const result = await setDomainRestriction(admin.db, Boolean(body.enabled), actorId);
      return Response.json(result);
    }

    if (path.includes("/import-legado")) {
      const body = (await request.json()) as { text?: string; syncIntervalMinutes?: number };
      if (!body.text?.trim()) return Response.json({ error: "书源 JSON 不能为空" }, { status: 400 });
      const result = await importLegadoSources(
        admin.db,
        body.text,
        actorId,
        body.syncIntervalMinutes ?? 360
      );
      return Response.json(result);
    }

    if (path.includes("/probe")) {
      const body = (await request.json()) as { sourceId?: string };
      if (!body.sourceId) return Response.json({ error: "sourceId required" }, { status: 400 });
      return Response.json({ probe: await probeSource(admin.db, body.sourceId) });
    }

    if (path.includes("/subscribe")) {
      const body = (await request.json()) as {
        sourceId?: string;
        externalId?: string;
        title?: string;
        author?: string | null;
        description?: string | null;
        rights?: string | null;
      };
      if (!body.sourceId || !body.externalId || !body.title) {
        return Response.json({ error: "sourceId / externalId / title required" }, { status: 400 });
      }
      const result = await createSubscription(admin.db, {
        sourceId: body.sourceId,
        externalId: body.externalId,
        title: body.title,
        author: body.author ?? null,
        description: body.description ?? null,
        rights: body.rights ?? null,
        actorId,
      });
      // 建立订阅后立即拉一次目录，让运营方马上看到结果
      const outcome = await syncSubscriptionToc(
        admin.db,
        env.QUEUE_JOBS,
        result.subscriptionId,
        "manual"
      );
      return Response.json({ ...result, sync: outcome });
    }

    if (path.includes("/sync")) {
      const body = (await request.json()) as { sourceId?: string; subscriptionId?: string };
      if (body.subscriptionId) {
        const outcome = await syncSubscriptionToc(
          admin.db,
          env.QUEUE_JOBS,
          body.subscriptionId,
          "manual"
        );
        return Response.json({ sync: outcome });
      }
      if (body.sourceId) {
        const result = await syncSource(admin.db, env.QUEUE_JOBS, body.sourceId, "manual");
        return Response.json({ sync: result });
      }
      return Response.json({ error: "sourceId or subscriptionId required" }, { status: 400 });
    }

    if (path.includes("/subscriptions")) {
      const body = (await request.json()) as {
        subscriptionId?: string;
        status?: "active" | "paused";
      };
      if (!body.subscriptionId) {
        return Response.json({ error: "subscriptionId required" }, { status: 400 });
      }
      if (request.method === "DELETE") {
        await removeSubscription(admin.db, body.subscriptionId, actorId);
        return Response.json({ ok: true });
      }
      const next = await setSubscriptionStatus(
        admin.db,
        body.subscriptionId,
        body.status ?? "active",
        actorId
      );
      return Response.json({ status: next });
    }

    // 源本身的增删改
    if (request.method === "DELETE") {
      const body = (await request.json()) as { sourceId?: string };
      if (!body.sourceId) return Response.json({ error: "sourceId required" }, { status: 400 });
      await deleteSource(admin.db, body.sourceId, actorId);
      return Response.json({ ok: true });
    }
    if (request.method === "PATCH") {
      const body = (await request.json()) as {
        sourceId?: string;
        status?: "enabled" | "disabled";
      };
      if (!body.sourceId || !body.status) {
        return Response.json({ error: "sourceId / status required" }, { status: 400 });
      }
      const next = await updateSourceStatus(admin.db, body.sourceId, body.status, actorId);
      return Response.json({ status: next });
    }

    const body = (await request.json()) as {
      name?: string;
      kind?: string;
      endpoint?: string;
      config?: Record<string, unknown> | null;
      attribution?: string | null;
      syncIntervalMinutes?: number;
    };
    if (!body.name || !body.kind || !body.endpoint) {
      return Response.json({ error: "name / kind / endpoint required" }, { status: 400 });
    }
    const created = await createSource(admin.db, {
      name: body.name,
      kind: body.kind,
      endpoint: body.endpoint,
      config: body.config ?? null,
      attribution: body.attribution ?? null,
      syncIntervalMinutes: body.syncIntervalMinutes,
      actorId,
    });
    return Response.json(created);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "操作失败" },
      { status: 400 }
    );
  }
}
