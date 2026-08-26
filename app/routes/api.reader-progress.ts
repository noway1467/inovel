import type { Route } from "./+types/api.reader-progress";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getProgress, syncProgress } from "~/server/services/reader";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const bookId = url.searchParams.get("bookId");
  if (!bookId) return Response.json({ error: "bookId required" }, { status: 400 });

  const db = createDb(env.DB_APP);
  const progress = await getProgress(db, session.user.id, bookId);
  return Response.json({ progress });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json()) as Parameters<typeof syncProgress>[2];
  const db = createDb(env.DB_APP);
  const result = await syncProgress(db, session.user.id, body);
  return Response.json(result);
}

