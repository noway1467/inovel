import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const loginAttempts = sqliteTable(
  "login_attempts",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    failedCount: integer("failed_count").notNull().default(0),
    blockedUntil: integer("blocked_until", { mode: "timestamp_ms" }),
    lastFailedAt: integer("last_failed_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("login_attempts_identifier_unique").on(table.identifier)]
);

