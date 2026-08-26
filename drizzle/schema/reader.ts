import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { books, chapters } from "./catalog";

export const readingProgress = sqliteTable(
  "reading_progress",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id),
    paragraphAnchor: text("paragraph_anchor"),
    charOffset: integer("char_offset").notNull().default(0),
    chapterProgress: integer("chapter_progress").notNull().default(0),
    bookProgress: integer("book_progress").notNull().default(0),
    version: integer("version").notNull().default(0),
    deviceId: text("device_id"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("reading_progress_user_book_unique").on(table.userId, table.bookId),
    index("reading_progress_updated_at_idx").on(table.updatedAt),
  ]
);

export const readingPreferences = sqliteTable(
  "reading_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    theme: text("theme").notNull().default("paper"),
    fontSize: integer("font_size").notNull().default(18),
    fontFamily: text("font_family").notNull().default("system"),
    lineHeight: integer("line_height").notNull().default(180),
    paragraphSpacing: integer("paragraph_spacing").notNull().default(80),
    margin: text("margin").notNull().default("standard"),
    align: text("align").notNull().default("justify"),
    indent: text("indent").notNull().default("2char"),
    letterSpacing: text("letter_spacing").notNull().default("default"),
    paginationMode: text("pagination_mode").notNull().default("scroll"),
    syncProgress: integer("sync_progress", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("reading_preferences_user_unique").on(table.userId)]
);

export const shelfItems = sqliteTable(
  "shelf_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    group: text("group").notNull().default("reading"),
    sortOrder: integer("sort_order").notNull().default(0),
    lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("shelf_items_user_book_unique").on(table.userId, table.bookId),
    index("shelf_items_user_last_read_idx").on(table.userId, table.lastReadAt),
  ]
);

export const readingHistory = sqliteTable(
  "reading_history",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id),
    paragraphAnchor: text("paragraph_anchor"),
    charOffset: integer("char_offset").notNull().default(0),
    chapterProgress: integer("chapter_progress").notNull().default(0),
    bookProgress: integer("book_progress").notNull().default(0),
    readAt: integer("read_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    index("reading_history_user_read_at_idx").on(table.userId, table.readAt),
    // 一书一章只保留一条，靠 read_at 体现“最近读到哪”
    uniqueIndex("reading_history_user_book_chapter_unique").on(
      table.userId,
      table.bookId,
      table.chapterId
    ),
  ]
);

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id),
    paragraphAnchor: text("paragraph_anchor"),
    charOffset: integer("char_offset").notNull().default(0),
    excerpt: text("excerpt"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    index("bookmarks_user_book_idx").on(table.userId, table.bookId),
    index("bookmarks_user_created_at_idx").on(table.userId, table.createdAt),
  ]
);

