import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { books, chapters } from "./catalog";

export const importJobStatus = {
  uploading: "uploading",
  uploaded: "uploaded",
  parsing: "parsing",
  awaitingConfirmation: "awaiting_confirmation",
  importing: "importing",
  completed: "completed",
  failed: "failed",
} as const;

export const importJobs = sqliteTable(
  "import_jobs",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    sourceKey: text("source_key").notNull(),
    sourceName: text("source_name").notNull(),
    sourceSize: integer("source_size").notNull().default(0),
    uploadId: text("upload_id"),
    commitCursor: integer("commit_cursor"),
    encoding: text("encoding"),
    status: text("status").notNull().default(importJobStatus.uploaded),
    reportKey: text("report_key"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [index("import_jobs_book_id_idx").on(table.bookId)]
);

export const importChapterCandidates = sqliteTable(
  "import_chapter_candidates",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    charCount: integer("char_count").notNull().default(0),
    warning: text("warning"),
    action: text("action").notNull().default("keep"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [index("import_candidates_job_id_idx").on(table.jobId)]
);

export const reviewTaskStatus = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  escalated: "escalated",
} as const;

export const reviewTasks = sqliteTable(
  "review_tasks",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    versionId: text("version_id").notNull(),
    status: text("status").notNull().default(reviewTaskStatus.pending),
    assignedTo: text("assigned_to").references(() => users.id),
    autoRuleHits: text("auto_rule_hits", { mode: "json" }),
    decision: text("decision"),
    reason: text("reason"),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    index("review_tasks_status_idx").on(table.status),
    index("review_tasks_chapter_id_idx").on(table.chapterId),
  ]
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    dedupKey: text("dedup_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    index("notifications_user_created_idx").on(table.userId, table.createdAt),
    // 没有这条唯一索引时，代码里的 onConflictDoNothing() 不会生效
    uniqueIndex("notifications_user_dedup_unique").on(table.userId, table.dedupKey),
  ]
);
