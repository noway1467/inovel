import { and, eq, inArray } from "drizzle-orm";
import { permissions, rolePermissions, roles, userRoles } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export const roleCodes = {
  reader: "reader",
  author: "author",
  moderator: "moderator",
  operator: "operator",
  admin: "admin",
  superAdmin: "super_admin",
} as const;

export const permissionCodes = {
  bookCreate: "book:create",
  bookEdit: "book:edit",
  bookReview: "book:review",
  bookApprove: "book:approve",
  bookPublish: "book:publish",
  userManage: "user:manage",
  roleManage: "role:manage",
  operationManage: "operation:manage",
  systemManage: "system:manage",
} as const;

export async function getUserRoleCodes(db: AppDb, userId: string): Promise<string[]> {
  const rows = await db
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((row) => row.code);
}

export async function getUserPermissionCodes(db: AppDb, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(userRoles.userId, userId));
  return rows.map((row) => row.code);
}

export async function hasRole(db: AppDb, userId: string, code: string): Promise<boolean> {
  const rows = await db
    .select({ id: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(eq(userRoles.userId, userId), eq(roles.code, code)))
    .limit(1);
  return rows.length > 0;
}

export async function hasAnyRole(db: AppDb, userId: string, codes: string[]): Promise<boolean> {
  const rows = await db
    .select({ id: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(eq(userRoles.userId, userId), inArray(roles.code, codes)))
    .limit(1);
  return rows.length > 0;
}

