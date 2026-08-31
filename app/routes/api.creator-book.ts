import type { Route } from "./+types/api.creator-book";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { bookTags, books, tags } from "drizzle/schema";
import { eq } from "drizzle-orm";
import { ensureAuthorProfile } from "~/server/creator/profile";
import { listEnabledCategories } from "~/server/repositories/categories";
import {
  deleteBookPermanently,
  deleteChaptersBatch,
  publishAllChaptersDirectly,
  reorderChapters,
  submitAllChaptersForReview,
  toggleBookPublication,
  updateBookMetadata,
  type BookSerialStatus,
} from "~/server/creator/service";

async function requireUser(
  request: Request,
  env: { DB_APP: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string }
) {
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await requireUser(request, env);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = createDb(env.DB_APP);
  const author = await ensureAuthorProfile(db, user.id);
  const book = await db
    .select()
    .from(books)
    .where(eq(books.id, params.bookId ?? ""))
    .get();
  if (!book || book.authorId !== author?.id) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const categories = await listEnabledCategories(db);
  const tagRows = await db
    .select({ name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(bookTags.tagId, tags.id))
    .where(eq(bookTags.bookId, book.id));
  return Response.json({
    book,
    categories,
    tags: tagRows.map((row) => row.name),
    penName: book.authorName ?? author?.penName ?? "",
  });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const user = await requireUser(request, env);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const isSubmitAll = request.method === "POST" && url.pathname.endsWith("/submit-all");
  const isPublishAll = request.method === "POST" && url.pathname.endsWith("/publish-all");
  const isTogglePublication =
    request.method === "POST" && url.pathname.endsWith("/toggle-publication");
  const isReorderChapters =
    request.method === "POST" && url.pathname.endsWith("/chapters/reorder");
  const isDeleteChapters =
    request.method === "POST" && url.pathname.endsWith("/chapters/delete");
  const isDelete = request.method === "DELETE";
  if (
    !isSubmitAll &&
    !isPublishAll &&
    !isTogglePublication &&
    !isReorderChapters &&
    !isDeleteChapters &&
    !isDelete &&
    request.method !== "PUT"
  ) {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }

  const db = createDb(env.DB_APP);
  const author = await ensureAuthorProfile(db, user.id);
  const book = await db
    .select()
    .from(books)
    .where(eq(books.id, params.bookId ?? ""))
    .get();
  if (!book || book.authorId !== author?.id) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  if (isSubmitAll) {
    const result = await submitAllChaptersForReview(db, book.id, user.id);
    return Response.json({ ok: true, ...result });
  }

  if (isPublishAll) {
    const result = await publishAllChaptersDirectly(db, book.id, user.id);
    return Response.json({ ok: true, ...result });
  }

  if (isTogglePublication) {
    const result = await toggleBookPublication(db, book.id, user.id);
    return Response.json({ ok: true, ...result });
  }

  if (isReorderChapters) {
    const body = (await request.json().catch(() => ({}))) as { chapterIds?: unknown };
    const chapterIds = Array.isArray(body.chapterIds)
      ? body.chapterIds.filter((id): id is string => typeof id === "string")
      : [];
    if (chapterIds.length === 0) {
      return Response.json({ error: "缺少章节列表" }, { status: 400 });
    }
    const result = await reorderChapters(db, book.id, chapterIds, user.id);
    if (!result) return Response.json({ error: "章节列表已过期，请刷新" }, { status: 409 });
    return Response.json({ ok: true, ...result });
  }

  if (isDeleteChapters) {
    const body = (await request.json().catch(() => ({}))) as { chapterIds?: unknown };
    const chapterIds = Array.isArray(body.chapterIds)
      ? body.chapterIds.filter((id): id is string => typeof id === "string")
      : [];
    if (chapterIds.length === 0) {
      return Response.json({ error: "没有选中章节" }, { status: 400 });
    }
    const result = await deleteChaptersBatch(db, book.id, chapterIds, user.id);
    if (!result) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ ok: true, ...result });
  }

  if (isDelete) {
    await deleteBookPermanently(db, env.R2_CONTENT, book.id);
    return Response.json({ ok: true });
  }

  const body = (await request.json()) as {
    title?: string;
    description?: string;
    penName?: string;
    authorName?: string;
    categoryId?: string | null;
    categoryName?: string;
    tags?: string[];
    serialStatus?: BookSerialStatus;
  };
  const title = body.title?.trim();
  if (!title) return Response.json({ error: "书名不能为空" }, { status: 400 });
  if (title.length > 120) return Response.json({ error: "书名不能超过 120 字" }, { status: 400 });
  const description = body.description?.trim() ?? null;
  if (description && description.length > 2000) {
    return Response.json({ error: "简介不能超过 2000 字" }, { status: 400 });
  }
  const authorName = body.authorName?.trim();
  if (authorName && authorName.length > 30) {
    return Response.json({ error: "作者名不能超过 30 字" }, { status: 400 });
  }

  await db
    .update(books)
    .set({
      title,
      description,
      authorName: authorName || null,
      updatedAt: new Date(),
    })
    .where(eq(books.id, book.id));

  await updateBookMetadata(db, book.id, {
    categoryId: body.categoryId ?? null,
    categoryName: body.categoryName,
    tags: body.tags ?? [],
    serialStatus: body.serialStatus,
  });

  return Response.json({
    ok: true,
    book: {
      ...book,
      title,
      description,
      categoryId: body.categoryId ?? null,
      serialStatus: body.serialStatus ?? book.serialStatus,
    },
  });
}
