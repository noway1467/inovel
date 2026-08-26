import type { Route } from "./+types/api.creator-chapters";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import {
  deleteChapter,
  getChapterForEdit,
  publishChapterDirectly,
  saveChapterDraft,
  submitChapterForReview,
  unpublishChapter,
} from "~/server/creator/service";

async function requireAuthor(
  request: Request,
  env: { DB_APP: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string }
) {
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await requireAuthor(request, env);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = createDb(env.DB_APP);
  const chapter = await getChapterForEdit(db, env.R2_CONTENT, params.chapterId ?? "", user.id);
  if (!chapter) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ chapter });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await requireAuthor(request, env);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = createDb(env.DB_APP);
  const chapterId = params.chapterId ?? "";
  const path = new URL(request.url).pathname;

  if (request.method === "POST" && path.endsWith("/save")) {
    try {
      const body = (await request.json()) as { title?: string; paragraphs?: string[] };
      const chapter = await saveChapterDraft(db, env.R2_CONTENT, chapterId, user.id, {
        title: body.title ?? "",
        paragraphs: body.paragraphs ?? [],
      });
      if (!chapter) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ chapter });
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存失败";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (request.method === "POST" && path.endsWith("/publish")) {
    try {
      const result = await publishChapterDirectly(db, chapterId, user.id);
      if (!result) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "\u76f4\u63a5\u53d1\u5e03\u5931\u8d25";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (request.method === "POST" && path.endsWith("/submit")) {
    try {
      const result = await submitChapterForReview(db, chapterId, user.id);
      if (!result) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "提交审核失败";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (request.method === "POST" && path.endsWith("/unpublish")) {
    try {
      const result = await unpublishChapter(db, chapterId, user.id);
      if (!result) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "下架失败";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (request.method === "DELETE") {
    try {
      const result = await deleteChapter(db, chapterId, user.id);
      if (!result) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "删除章节失败";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
}
