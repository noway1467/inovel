import { and, eq } from "drizzle-orm";
import { shelfItems } from "drizzle/schema";
import type { Route } from "./+types/api.library-shelf";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = createDb(env.DB_APP);
  // DELETE 的请求体在部分代理下会被丢掉，同时容忍畸形 JSON（原来会抛成 500）
  let bookId = new URL(request.url).searchParams.get("bookId") ?? "";
  if (!bookId) {
    try {
      bookId = ((await request.json()) as { bookId?: string }).bookId ?? "";
    } catch {
      bookId = "";
    }
  }
  if (!bookId) return Response.json({ error: "bookId required" }, { status: 400 });

  if (request.method === "DELETE") {
    await db
      .delete(shelfItems)
      .where(and(eq(shelfItems.userId, session.user.id), eq(shelfItems.bookId, bookId)));
    return Response.json({ ok: true, inShelf: false });
  }

  // 命中 shelf_items_user_book_unique 直接 upsert，省掉先查后写的往返
  await db
    .insert(shelfItems)
    .values({
      id: crypto.randomUUID(),
      userId: session.user.id,
      bookId,
      group: "reading",
      addedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [shelfItems.userId, shelfItems.bookId],
      set: { updatedAt: new Date() },
    });
  return Response.json({ ok: true, inShelf: true });
}

