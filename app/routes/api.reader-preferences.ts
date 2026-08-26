import type { Route } from "./+types/api.reader-preferences";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getPreferences, savePreferences } from "~/server/services/reader";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ preferences: null });

  const db = createDb(env.DB_APP);
  return Response.json({ preferences: await getPreferences(db, session.user.id) });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = (await request.json()) as Record<string, unknown>;
  const db = createDb(env.DB_APP);
  const preferences = await savePreferences(db, session.user.id, body);
  return Response.json({ preferences });
}

