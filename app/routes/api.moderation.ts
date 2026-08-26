import type { Route } from "./+types/api.moderation";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import {
  decideReviewTask,
  decideReviewTasksBatch,
  deleteBookPermanently,
  getReviewTask,
  listPendingReviewBookGroups,
  listPendingReviewTasksForBook,
} from "~/server/creator/service";
import { getUserRoleCodes } from "~/server/security/rbac";

async function requireModerator(
  request: Request,
  env: { DB_APP: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string }
) {
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  if (!roles.some((role) => ["moderator", "admin", "super_admin"].includes(role))) return null;
  return { user: session.user, db };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const moderator = await requireModerator(request, env);
  if (!moderator) return Response.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const taskId =
    segments[segments.length - 1] !== "tasks" ? segments[segments.length - 1] : undefined;
  if (taskId) {
    const task = await getReviewTask(moderator.db, env.R2_CONTENT, taskId);
    if (!task) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ task });
  }
  // 带 bookId 时返回该书的待审任务，否则返回按作品聚合的摘要，避免全量任务列表撑爆响应
  const bookId = url.searchParams.get("bookId");
  if (bookId) {
    return Response.json({ tasks: await listPendingReviewTasksForBook(moderator.db, bookId) });
  }
  return Response.json({ groups: await listPendingReviewBookGroups(moderator.db) });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const moderator = await requireModerator(request, env);
  if (!moderator) return Response.json({ error: "forbidden" }, { status: 403 });
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  if (request.method === "DELETE" && segments.includes("books")) {
    const bookId = segments[segments.length - 1] ?? "";
    await deleteBookPermanently(moderator.db, env.R2_CONTENT, bookId);
    return Response.json({ ok: true });
  }
  if (segments.includes("batch-decision")) {
    const body = (await request.json()) as {
      taskIds?: string[];
      bookId?: string;
      decision?: "approve" | "reject";
      reason?: string;
    };
    try {
      const result = await decideReviewTasksBatch(moderator.db, env.R2_CONTENT, moderator.user.id, {
        taskIds: body.taskIds,
        bookId: body.bookId,
        decision: body.decision ?? "approve",
        reason: body.reason,
      });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "批量处理失败" },
        { status: 400 }
      );
    }
  }
  const taskId = segments[segments.length - 2] ?? "";
  if (!taskId) return Response.json({ error: "task id required" }, { status: 400 });
  const body = (await request.json()) as { decision?: "approve" | "reject"; reason?: string };
  try {
    const result = await decideReviewTask(moderator.db, env.R2_CONTENT, taskId, moderator.user.id, {
      decision: body.decision ?? "reject",
      reason: body.reason,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "处理失败" },
      { status: 400 }
    );
  }
}
