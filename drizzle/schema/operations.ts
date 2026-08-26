import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { books } from "./catalog";

export const recommendationSlots = sqliteTable("recommendation_slots", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const recommendationItems = sqliteTable(
  "recommendation_items",
  {
    id: text("id").primaryKey(),
    slotId: text("slot_id")
      .notNull()
      .references(() => recommendationSlots.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
    startAt: integer("start_at", { mode: "timestamp_ms" }),
    endAt: integer("end_at", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [index("recommendation_items_slot_idx").on(table.slotId)]
);

export const rankingSnapshots = sqliteTable(
  "ranking_snapshots",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    period: text("period").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    frozen: integer("frozen", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ranking_snapshots_type_period_unique").on(table.type, table.period)]
);

export const announcements = sqliteTable(
  "announcements",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    startAt: integer("start_at", { mode: "timestamp_ms" }),
    endAt: integer("end_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [index("announcements_enabled_idx").on(table.enabled)]
);

export const featureFlags = sqliteTable("feature_flags", {
  id: text("id").primaryKey(),
  code: text("code").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  description: text("description"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const siteSettings = sqliteTable("site_settings", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  value: text("value", { mode: "json" }).notNull(),
  description: text("description"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),
    reason: text("reason"),
    traceId: text("trace_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [index("audit_logs_entity_idx").on(table.entityType, table.entityId)]
);

export const jobDedup = sqliteTable(
  "job_dedup",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    handler: text("handler").notNull(),
    status: text("status").notNull().default("processed"),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("job_dedup_event_handler_unique").on(table.eventId, table.handler)]
);

