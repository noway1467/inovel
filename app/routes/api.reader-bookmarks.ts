import type { Route } from "./+types/api.reader-bookmarks";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { addBookmark, listBookmarks } from "~/server/services/reader";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ bookmarks: [] });
  const db = createDb(env.DB_APP);
  return Response.json({ bookmarks: await listBookmarks(db, session.user.id) });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json()) as {
    bookId: string;
    chapterId?: string;
    paragraphAnchor?: string;
    charOffset?: number;
    excerpt?: string;
  };
  const db = createDb(env.DB_APP);
  const bookmark = await addBookmark(db, session.user.id, {
    bookId: body.bookId,
    chapterId: body.chapterId ?? null,
    paragraphAnchor: body.paragraphAnchor ?? null,
    charOffset: body.charOffset ?? 0,
    excerpt: body.excerpt,
  });
  return Response.json({ bookmark });
}

