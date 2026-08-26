import type { Route } from "./+types/api.admin-users";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { listAdminUsers, setUserRoles, setUserStatus } from "~/server/admin/users";
import { getUserRoleCodes } from "~/server/security/rbac";

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
  const url = new URL(request.url);
  const q = url.searchParams.get("q") ?? "";
  return Response.json({ users: await listAdminUsers(admin.db, q) });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const admin = await requireAdmin(request, env);
  if (!admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const targetUserId = segments[segments.length - 2] ?? "";
  if (!targetUserId) return Response.json({ error: "user id required" }, { status: 400 });

  try {
    if (request.method === "POST" && request.url.includes("/roles")) {
      const body = (await request.json()) as { roleCodes?: string[] };
      const roles = await setUserRoles(admin.db, targetUserId, body.roleCodes ?? [], admin.user.id);
      return Response.json({ roleCodes: roles });
    }
    if (request.method === "POST" && request.url.includes("/status")) {
      const body = (await request.json()) as { status?: "active" | "disabled" };
      const status = await setUserStatus(admin.db, targetUserId, body.status ?? "active", admin.user.id);
      return Response.json({ status });
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "操作失败" }, { status: 400 });
  }
  return Response.json({ error: "method not allowed" }, { status: 405 });
}

