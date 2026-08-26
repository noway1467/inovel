import type { Route } from "./+types/api.notifications";
import { and, desc, eq, isNull } from "drizzle-orm";
import { notifications } from "drizzle/schema";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ notifications: [], unreadCount: 0 });
  const db = createDb(env.DB_APP);
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, session.user.id))
    .orderBy(desc(notifications.createdAt))
    .limit(100);
  const unread = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, session.user.id), isNull(notifications.readAt)))
    .all();
  return Response.json({ notifications: rows, unreadCount: unread.length });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const db = createDb(env.DB_APP);
  const path = new URL(request.url).pathname;

  if (request.method === "POST" && path.endsWith("/read-all")) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, session.user.id), isNull(notifications.readAt)));
    return Response.json({ ok: true });
  }

  if (request.method === "POST" && path.includes("/read")) {
    const segments = path.split("/").filter(Boolean);
    const id = segments[segments.length - 2] ?? "";
    await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, id));
    return Response.json({ ok: true });
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
}

