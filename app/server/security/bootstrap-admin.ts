import { eq } from "drizzle-orm";
import { permissions, rolePermissions, roles, siteSettings, userRoles, users } from "drizzle/schema";
import type { D1Database } from "@cloudflare/workers-types";
import type { AppDb } from "~/server/db";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { seedPermissions, seedRolePermissions, seedRoles } from "~/server/seed-data";

const bootstrapMarkerKey = "admin.bootstrap.done";

async function ensureRoles(db: AppDb) {
  const roleIds: Record<string, string> = {};
  for (const role of seedRoles) {
    const inserted = await db
      .insert(roles)
      .values({ id: crypto.randomUUID(), code: role.code, name: role.name, description: role.description })
      .onConflictDoNothing()
      .returning({ id: roles.id, code: roles.code })
      .get();
    if (inserted) {
      roleIds[inserted.code] = inserted.id;
    } else {
      const existing = await db.select().from(roles).where(eq(roles.code, role.code)).get();
      if (existing) roleIds[existing.code] = existing.id;
    }
  }

  const permissionIds: Record<string, string> = {};
  for (const permission of seedPermissions) {
    const inserted = await db
      .insert(permissions)
      .values({ id: crypto.randomUUID(), code: permission.code, name: permission.name })
      .onConflictDoNothing()
      .returning({ id: permissions.id, code: permissions.code })
      .get();
    if (inserted) {
      permissionIds[inserted.code] = inserted.id;
    } else {
      const existing = await db.select().from(permissions).where(eq(permissions.code, permission.code)).get();
      if (existing) permissionIds[existing.code] = existing.id;
    }
  }

  for (const [roleCode, codes] of Object.entries(seedRolePermissions)) {
    const roleId = roleIds[roleCode];
    if (!roleId) continue;
    for (const code of codes) {
      const permissionId = permissionIds[code];
      if (!permissionId) continue;
      await db.insert(rolePermissions).values({ roleId, permissionId }).onConflictDoNothing();
    }
  }

  return roleIds;
}

/**
 * 由环境变量 ADMIN_EMAIL / ADMIN_PASSWORD 初始化超管账号，幂等。
 */
export async function ensureAdminUser(
  d1: D1Database,
  secret: string,
  baseURL: string,
  config: { email?: string; password?: string; name?: string }
) {
  if (!config.email || !config.password) return { created: false, reason: "env missing" };

  const db = createDb(d1);
  const existingUser = await db.select().from(users).where(eq(users.email, config.email)).get();
  if (!existingUser) {
    // 用户不存在时按当前 secret 重建（即使 marker 已存在，用于管理员密码轮换）
    const auth = createAuth(d1, secret, baseURL);
    try {
      await auth.api.signUpEmail({
        body: { email: config.email, password: config.password, name: config.name || "平台管理员" },
        headers: new Headers({ Origin: baseURL }),
      });
    } catch {
      // 邮箱冲突等情况下继续走角色授予
    }
  }

  const user = await db.select().from(users).where(eq(users.email, config.email)).get();
  if (!user) return { created: false, reason: "user missing" };

  // 每次调用都校验并补齐角色，避免角色清理等操作误删管理员授权
  const roleIds = await ensureRoles(db);
  const adminRoleId = roleIds.super_admin ?? roleIds.admin;
  if (adminRoleId) {
    await db.insert(userRoles).values({ userId: user.id, roleId: adminRoleId, reason: "env bootstrap" }).onConflictDoNothing();
    if (roleIds.admin && roleIds.admin !== adminRoleId) {
      await db.insert(userRoles).values({ userId: user.id, roleId: roleIds.admin, reason: "env bootstrap" }).onConflictDoNothing();
    }
  }

  await db
    .insert(siteSettings)
    .values({
      id: crypto.randomUUID(),
      key: bootstrapMarkerKey,
      value: { at: new Date().toISOString(), email: config.email },
      description: "环境变量管理员初始化标记",
    })
    .onConflictDoNothing();

  return { created: true };
}
