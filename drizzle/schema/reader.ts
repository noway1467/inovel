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

/**
 * 在线源书籍的书架与阅读进度。
 *
 * 为什么不复用 shelf_items / reading_progress：那两张表的 book_id 外键指向
 * books，而在线源的书从不入 books 表（搜到就能读，不需要先订阅入库）。
 *
 * source_id 故意不加外键：管理台的「删除不可用的源」会成批删 content_sources，
 * 级联会顺手清掉用户的书架和进度。source_name / book_title 一并冗余存下来，
 * 源没了也还能在书架里显示这本书读到哪。
 */
export const sourceReadingState = sqliteTable(
  "source_reading_state",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    /** 源站上这本书的目录页地址，与 source_id 一起唯一确定一本书 */
    bookUrl: text("book_url").notNull(),
    bookTitle: text("book_title").notNull(),
    sourceName: text("source_name"),
    /** 是否在书架里。进度与书架分开：移出书架不该丢掉读到哪 */
    shelved: integer("shelved", { mode: "boolean" }).notNull().default(false),
    lastChapterKey: text("last_chapter_key"),
    lastChapterTitle: text("last_chapter_title"),
    /** 章节在目录里的序号，用于「继续阅读」直接跳回去 */
    lastChapterIndex: integer("last_chapter_index"),
    /** 章内页码，分页模式下恢复到具体那一页 */
    lastPageIndex: integer("last_page_index").notNull().default(0),
    chapterCount: integer("chapter_count"),
    lastReadAt: integer("last_read_at", { mode: "timestamp_ms" }),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_reading_state_user_book_unique").on(
      table.userId,
      table.sourceId,
      table.bookUrl
    ),
    index("source_reading_state_user_shelved_idx").on(table.userId, table.shelved, table.lastReadAt),
    index("source_reading_state_user_read_at_idx").on(table.userId, table.lastReadAt),
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

