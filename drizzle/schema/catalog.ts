import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";

export const bookStatus = {
  draft: "draft",
  pendingReview: "pending_review",
  approved: "approved",
  published: "published",
  suspended: "suspended",
  archived: "archived",
} as const;

export type BookStatus = (typeof bookStatus)[keyof typeof bookStatus];

export const serialStatus = {
  ongoing: "ongoing",
  completed: "completed",
} as const;

export const authors = sqliteTable("authors", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  penName: text("pen_name").notNull(),
  bio: text("bio"),
  avatarKey: text("avatar_key"),
  status: text("status").notNull().default("active"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  parentId: text("parent_id"),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
});

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    normalized: text("normalized").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("tags_name_unique").on(table.name)]
);

export const books = sqliteTable(
  "books",
  {
    id: text("id").primaryKey(),
    authorId: text("author_id")
      .notNull()
      .references(() => authors.id),
    categoryId: text("category_id").references(() => categories.id),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    authorName: text("author_name"),
    coverKey: text("cover_key"),
    description: text("description"),
    status: text("status").notNull().default(bookStatus.draft),
    serialStatus: text("serial_status").notNull().default(serialStatus.ongoing),
    wordCount: integer("word_count").notNull().default(0),
    copyrightNotice: text("copyright_notice"),
    latestChapterId: text("latest_chapter_id"),
    latestChapterTitle: text("latest_chapter_title"),
    latestChapterAt: integer("latest_chapter_at", { mode: "timestamp_ms" }),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    deletedBy: text("deleted_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    index("books_author_id_idx").on(table.authorId),
    index("books_status_idx").on(table.status),
    index("books_category_id_idx").on(table.categoryId),
    index("books_updated_at_idx").on(table.updatedAt),
  ]
);

export const bookTags = sqliteTable(
  "book_tags",
  {
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("book_tags_pk").on(table.bookId, table.tagId)]
);

export const volumes = sqliteTable(
  "volumes",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [index("volumes_book_id_idx").on(table.bookId)]
);

export const chapterStatus = {
  draft: "draft",
  pendingReview: "pending_review",
  approved: "approved",
  scheduled: "scheduled",
  published: "published",
  rejected: "rejected",
  hidden: "hidden",
} as const;

export type ChapterStatus = (typeof chapterStatus)[keyof typeof chapterStatus];

export const chapters = sqliteTable(
  "chapters",
  {
    id: text("id").primaryKey(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    volumeId: text("volume_id").references(() => volumes.id),
    title: text("title").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status").notNull().default(chapterStatus.draft),
    wordCount: integer("word_count").notNull().default(0),
    currentVersionId: text("current_version_id"),
    hiddenReason: text("hidden_reason"),
    publishAt: integer("publish_at", { mode: "timestamp_ms" }),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    rejectedReason: text("rejected_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("chapters_book_id_sort_idx").on(table.bookId, table.sortOrder),
    index("chapters_status_idx").on(table.status),
    // 阅读页导航/目录/跳章的实际访问形态：book_id + status 过滤，sort_order 排序。
    // 缺这条时规划器会误走 chapters_status_idx 扫全表（published 即全量）。
    index("chapters_book_status_sort_idx").on(table.bookId, table.status, table.sortOrder),
  ]
);

export const chapterVersions = sqliteTable(
  "chapter_versions",
  {
    id: text("id").primaryKey(),
    chapterId: text("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    r2Key: text("r2_key").notNull(),
    contentHash: text("content_hash").notNull(),
    title: text("title").notNull(),
    wordCount: integer("word_count").notNull().default(0),
    isPublished: integer("is_published", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chapter_versions_chapter_version_unique").on(table.chapterId, table.version),
    index("chapter_versions_chapter_id_idx").on(table.chapterId),
  ]
);
