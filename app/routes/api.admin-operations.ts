import type { Route } from "./+types/api.admin-operations";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import {
  addRecommendationItem,
  createCategory,
  createTag,
  listCategories,
  listRecommendationSlots,
  listTags,
  removeRecommendationItem,
  updateCategory,
  updateTag,
  createAnnouncement,
  listAnnouncements,
  updateAnnouncement,
} from "~/server/operations/service";
import { aggregateRanking, refreshRanking, setRankingFrozen, type RankingType } from "~/server/rankings/service";
import { getUserRoleCodes } from "~/server/security/rbac";

async function requireOperator(request: Request, env: { DB_APP: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string }) {
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  if (!roles.some((role) => ["operator", "admin", "super_admin"].includes(role))) return null;
  return { user: session.user, db };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const operator = await requireOperator(request, env);
  if (!operator) return Response.json({ error: "forbidden" }, { status: 403 });
  const path = new URL(request.url).pathname;
  if (path.includes("/categories")) {
    return Response.json({ categories: await listCategories(operator.db) });
  }
  if (path.includes("/tags")) {
    return Response.json({ tags: await listTags(operator.db) });
  }
  if (path.includes("/announcements")) {
    return Response.json({ announcements: await listAnnouncements(operator.db) });
  }
  if (path.includes("/rankings")) {
    const type = (new URL(request.url).searchParams.get("type") ?? "week") as RankingType;
    return Response.json({ ranking: await aggregateRankingForView(operator.db, type) });
  }
  return Response.json({ slots: await listRecommendationSlots(operator.db) });
}

async function aggregateRankingForView(db: ReturnType<typeof createDb>, type: RankingType) {
  return aggregateRanking(db, type, 20);
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const operator = await requireOperator(request, env);
  if (!operator) return Response.json({ error: "forbidden" }, { status: 403 });
  const path = new URL(request.url).pathname;

  try {
    if (path.includes("/categories")) {
      const body = (await request.json()) as {
        id?: string;
        name?: string;
        slug?: string;
        sortOrder?: number;
        enabled?: boolean;
      };
      if (body.id) {
        const category = await updateCategory(operator.db, operator.user.id, body.id, {
          name: body.name,
          slug: body.slug,
          sortOrder: body.sortOrder,
          enabled: body.enabled,
        });
        return Response.json({ category });
      }
      if (!body.name || !body.slug) return Response.json({ error: "name and slug required" }, { status: 400 });
      return Response.json({ category: await createCategory(operator.db, operator.user.id, { name: body.name, slug: body.slug }) });
    }

    if (path.includes("/tags")) {
      const body = (await request.json()) as { id?: string; name?: string; enabled?: boolean };
      if (body.id) {
        return Response.json({ tag: await updateTag(operator.db, operator.user.id, body.id, { enabled: body.enabled }) });
      }
      if (!body.name) return Response.json({ error: "name required" }, { status: 400 });
      return Response.json({ tag: await createTag(operator.db, operator.user.id, body.name) });
    }

    if (path.includes("/announcements")) {
      const body = (await request.json()) as { id?: string; title?: string; body?: string; enabled?: boolean };
      if (body.id) {
        return Response.json({ announcement: await updateAnnouncement(operator.db, operator.user.id, body.id, { enabled: body.enabled }) });
      }
      if (!body.title || !body.body) return Response.json({ error: "title and body required" }, { status: 400 });
      return Response.json({ announcement: await createAnnouncement(operator.db, operator.user.id, { title: body.title, body: body.body }) });
    }

    if (path.includes("/rankings")) {
      const body = (await request.json()) as { action?: "refresh" | "freeze"; type?: RankingType; frozen?: boolean };
      const type = body.type ?? "week";
      if (body.action === "refresh") {
        return Response.json(await refreshRanking(operator.db, operator.user.id, type, false));
      }
      if (body.action === "freeze") {
        return Response.json(await setRankingFrozen(operator.db, operator.user.id, type, Boolean(body.frozen)));
      }
      return Response.json({ error: "unknown action" }, { status: 400 });
    }

    const body = (await request.json()) as { slotId?: string; bookId?: string; itemId?: string; action?: "add" | "remove" };
    if (body.action === "add") {
      if (!body.slotId || !body.bookId) return Response.json({ error: "slotId and bookId required" }, { status: 400 });
      return Response.json({ item: await addRecommendationItem(operator.db, operator.user.id, body.slotId, body.bookId) });
    }
    if (body.action === "remove") {
      if (!body.itemId) return Response.json({ error: "itemId required" }, { status: 400 });
      return Response.json(await removeRecommendationItem(operator.db, operator.user.id, body.itemId));
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "操作失败" }, { status: 400 });
  }
}
