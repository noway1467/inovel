import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";

export const roles = sqliteTable(
  "roles",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("roles_code_unique").on(table.code)]
);

export const permissions = sqliteTable(
  "permissions",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("permissions_code_unique").on(table.code)]
);

export const rolePermissions = sqliteTable(
  "role_permissions",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: text("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("role_permissions_pk").on(table.roleId, table.permissionId)]
);

export const userRoles = sqliteTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => users.id),
    reason: text("reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("user_roles_pk").on(table.userId, table.roleId)]
);
