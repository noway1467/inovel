import type { Route } from "./+types/api.admin-site-settings";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { getRegistrationEnabled, setRegistrationEnabled } from "~/server/settings/registration";
import { getMaxUploadMb, setMaxUploadMb } from "~/server/settings/import-limits";
import { getUserRoleCodes } from "~/server/security/rbac";
import { auditLogs } from "drizzle/schema";

async function requireAdmin(request: Request, env: { DB_APP: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string }) {
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  if (!roles.some((role) => role === "admin" || role === "super_admin")) return null;
  return { user: session.user, db };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const admin = await requireAdmin(request, env);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json({
    registrationEnabled: await getRegistrationEnabled(admin.db),
    maxUploadMb: await getMaxUploadMb(admin.db),
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const admin = await requireAdmin(request, env);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await request.json()) as { registrationEnabled?: boolean; maxUploadMb?: number };
  if (body.registrationEnabled === undefined && body.maxUploadMb === undefined) {
    return Response.json({ error: "registrationEnabled or maxUploadMb required" }, { status: 400 });
  }
  const result: { registrationEnabled?: boolean; maxUploadMb?: number } = {};
  if (body.registrationEnabled !== undefined) {
    if (typeof body.registrationEnabled !== "boolean") {
      return Response.json({ error: "registrationEnabled must be boolean" }, { status: 400 });
    }
    const before = await getRegistrationEnabled(admin.db);
    await setRegistrationEnabled(admin.db, body.registrationEnabled);
    await admin.db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId: admin.user.id,
      action: "site_settings.update",
      entityType: "site_settings",
      entityId: "registration.enabled",
      before: { enabled: before },
      after: { enabled: body.registrationEnabled },
      reason: "admin update registration",
    });
    result.registrationEnabled = body.registrationEnabled;
  }
  if (body.maxUploadMb !== undefined) {
    if (typeof body.maxUploadMb !== "number") {
      return Response.json({ error: "maxUploadMb must be number" }, { status: 400 });
    }
    const before = await getMaxUploadMb(admin.db);
    const next = await setMaxUploadMb(admin.db, body.maxUploadMb);
    await admin.db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId: admin.user.id,
      action: "site_settings.update",
      entityType: "site_settings",
      entityId: "imports.max_upload_mb",
      before: { maxUploadMb: before },
      after: { maxUploadMb: next },
      reason: "admin update upload limit",
    });
    result.maxUploadMb = next;
  }
  return Response.json(result);
}
