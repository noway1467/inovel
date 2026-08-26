import { eq, inArray, like, or } from "drizzle-orm";
import { auditLogs, roles, userRoles, users } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { ensureAuthorProfile } from "~/server/creator/profile";

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  status: string;
  roleCodes: string[];
  createdAt: Date;
}

export async function listAdminUsers(db: AppDb, query: string, limit = 50): Promise<AdminUserRow[]> {
  const q = `%${query.trim()}%`;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(query.trim() ? or(like(users.name, q), like(users.email, q)) : undefined)
    .limit(limit);

  const userIds = rows.map((row) => row.id);
  const roleRows = userIds.length
    ? await db
        .select({ userId: userRoles.userId, code: roles.code })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(inArray(userRoles.userId, userIds))
        .all()
    : [];
  const byUser = new Map<string, string[]>();
  for (const row of roleRows) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row.code);
    byUser.set(row.userId, list);
  }
  return rows.map((row) => ({ ...row, roleCodes: byUser.get(row.id) ?? [] }));
}

export async function setUserRoles(
  db: AppDb,
  targetUserId: string,
  roleCodes: string[],
  actorId: string
) {
  const roleRows = roleCodes.length
    ? await db
        .select({ id: roles.id, code: roles.code })
        .from(roles)
        .where(inArray(roles.code, roleCodes))
        .all()
    : [];
  const before = await db
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, targetUserId))
    .all();

  await db.delete(userRoles).where(eq(userRoles.userId, targetUserId));
  for (const role of roleRows) {
    await db.insert(userRoles).values({ userId: targetUserId, roleId: role.id, grantedBy: actorId, reason: "admin sync" });
  }
  if (roleCodes.includes("author")) {
    await ensureAuthorProfile(db, targetUserId);
  }
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "user.roles.update",
    entityType: "user",
    entityId: targetUserId,
    before: { roles: before.map((row) => row.code) },
    after: { roles: roleRows.map((row) => row.code) },
    reason: "admin role management",
  });
  return roleRows.map((row) => row.code);
}

export async function setUserStatus(db: AppDb, targetUserId: string, status: "active" | "disabled", actorId: string) {
  const user = await db.select().from(users).where(eq(users.id, targetUserId)).get();
  if (!user) throw new Error("用户不存在");
  if (user.id === actorId) throw new Error("不能修改自己的状态");
  const before = user.status;
  await db.update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, targetUserId));
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action: "user.status.update",
    entityType: "user",
    entityId: targetUserId,
    before: { status: before },
    after: { status },
    reason: "admin user status management",
  });
  return status;
}
