import type { Route } from "./+types/api.chapter-content";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { getChapterContent } from "~/server/storage/chapter-content";
import { chapterVersionKey } from "~/server/storage/keys";
import { getChapterMeta } from "~/server/repositories/books";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { bookId, chapterId } = params;
  const db = createDb(env.DB_APP);
  const chapter = await getChapterMeta(db, chapterId);
  if (!chapter || chapter.bookId !== bookId) {
    return Response.json({ error: "chapter not found" }, { status: 404 });
  }
  if (chapter.status !== "published") {
    return Response.json({ error: "chapter unavailable", code: "CHAPTER_UNAVAILABLE" }, { status: 404 });
  }
  if (!chapter.currentVersionId) {
    return Response.json({ error: "chapter has no content" }, { status: 404 });
  }

  const key = chapterVersionKey(bookId, chapterId, chapter.currentVersionId);
  const content = await getChapterContent(env.R2_CONTENT, key);
  if (!content) {
    return Response.json({ error: "content not found" }, { status: 404 });
  }
  return Response.json({ chapter: { ...chapter, paragraphs: content.paragraphs } });
}
