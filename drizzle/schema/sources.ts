import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { books, chapters } from "./catalog";

/**
 * 在线源订阅。抓取一律受 source_domains 白名单约束：
 * 运营方必须逐个域名确认自己有授权，出厂为空表示什么都抓不了。
 */

export const sourceKind = {
  /** OPDS 电子书目录（Calibre-Web / Komga / Kavita 等自建库） */
  opds: "opds",
  /** RSS / Atom 连载订阅 */
  feed: "feed",
  /** 古腾堡计划（Gutendex API），公共领域 */
  gutendex: "gutendex",
  /** 通用 CSS 规则引擎，兼容开源阅读（Legado）书源 JSON */
  rules: "rules",
} as const;

export type SourceKind = (typeof sourceKind)[keyof typeof sourceKind];

export const sourceStatus = {
  /** 已登记但域名未获授权确认，不会发起任何抓取 */
  blocked: "blocked",
  enabled: "enabled",
  disabled: "disabled",
} as const;

export type SourceStatus = (typeof sourceStatus)[keyof typeof sourceStatus];

/**
 * 域名授权白名单。抓取前强制校验，未登记的域名直接拒绝。
 * 这是唯一的放行开关，不提供"全部允许"。
 */
export const sourceDomains = sqliteTable(
  "source_domains",
  {
    id: text("id").primaryKey(),
    /** 小写域名，不含协议与端口；命中时同时放行其子域 */
    host: text("host").notNull(),
    /** 运营方登记的授权依据，必填，便于事后追责 */
    authorizationNote: text("authorization_note").notNull(),
    confirmedBy: text("confirmed_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("source_domains_host_unique").on(table.host)]
);

export const contentSources = sqliteTable(
  "content_sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** 目录/搜索入口地址 */
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull().default(sourceStatus.blocked),
    /** 适配器专属配置（规则引擎的选择器等），JSON */
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
    /** 展示用出处署名，会写进 books.copyright_notice */
    attribution: text("attribution"),
    /** 同步间隔（分钟），Cron 按此判断是否到期 */
    syncIntervalMinutes: integer("sync_interval_minutes").notNull().default(360),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    lastSyncStatus: text("last_sync_status"),
    lastSyncMessage: text("last_sync_message"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /**
     * 搜索优先级与健康度。站内搜索每次只查一小批源（全查会超 Worker
     * 资源上限），靠这三个字段决定"先查谁"：权重高、近期成功、失败少的优先。
     */
    searchWeight: integer("search_weight").notNull().default(0),
    searchFailures: integer("search_failures").notNull().default(0),
    lastSearchAt: integer("last_search_at", { mode: "timestamp_ms" }),
    /**
     * 实测可用性。一份合集里多数源规则已失效，靠实际跑一遍搜索+目录
     * 才能分辨；结果存下来供「只保留可用源」使用。
     */
    verifyStatus: text("verify_status").notNull().default("untested"),
    verifyMessage: text("verify_message"),
    /**
     * 失败原因分类（timeout / http_403 / http_5xx / no_search / no_toc …）。
     *
     * 与 verify_message 分开存：message 是给人看的原话，这个是给筛选和批量
     * 清理用的。原先失败一律 failed，403 那种基本没救的和 503 那种过一阵还能
     * 用的混在一起，只能全删或全留。取值见 VerifyFailReason。
     */
    verifyFailReason: text("verify_fail_reason"),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    verifySearchHits: integer("verify_search_hits").notNull().default(0),
    verifyTocChapters: integer("verify_toc_chapters").notNull().default(0),
    /**
     * 分类浏览实测。「有分类规则」和「分类页真能抓到书」是两回事：
     * 规则在、页面改版了，点进去就是一片空白。跑一遍第一个分类记下抓到几本，
     * 管理台据此清理"有分类但抓不到书"的源。取值 untested / ok / empty / failed。
     */
    exploreStatus: text("explore_status").notNull().default("untested"),
    exploreBooks: integer("explore_books").notNull().default(0),
    exploreMessage: text("explore_message"),
    exploreCheckedAt: integer("explore_checked_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    index("content_sources_status_idx").on(table.status),
    index("content_sources_last_sync_idx").on(table.lastSyncAt),
    index("content_sources_search_rank_idx").on(
      table.status,
      table.searchFailures,
      table.searchWeight
    ),
    index("content_sources_verify_idx").on(table.verifyStatus),
    index("content_sources_explore_idx").on(table.exploreStatus),
  ]
);

export const subscriptionStatus = {
  active: "active",
  paused: "paused",
  /** 源端已删除或长期抓不到 */
  stale: "stale",
} as const;

/** 单本书的订阅：把源上的一本书绑到本地 books 行，增量拉新章。 */
export const sourceSubscriptions = sqliteTable(
  "source_subscriptions",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => contentSources.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    /** 源端书籍标识（详情页 URL 或 API id） */
    externalId: text("external_id").notNull(),
    externalTitle: text("external_title"),
    status: text("status").notNull().default(subscriptionStatus.active),
    /** 已同步到的章节数，增量对比的游标 */
    syncedChapterCount: integer("synced_chapter_count").notNull().default(0),
    /** 源端目录指纹，未变则跳过整本 */
    tocFingerprint: text("toc_fingerprint"),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_subscriptions_source_external_unique").on(table.sourceId, table.externalId),
    index("source_subscriptions_book_idx").on(table.bookId),
    index("source_subscriptions_status_idx").on(table.status),
  ]
);

/**
 * 源端章节到本地章节的映射。
 * 唯一键用来做增量去重：同一个 externalKey 只会落一次，队列重投也不会重复建章。
 */
export const sourceChapterLinks = sqliteTable(
  "source_chapter_links",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => sourceSubscriptions.id, { onDelete: "cascade" }),
    chapterId: text("chapter_id").references(() => chapters.id, { onDelete: "set null" }),
    /** 源端章节唯一标识（正文 URL 或 guid） */
    externalKey: text("external_key").notNull(),
    externalTitle: text("external_title").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** pending / fetched / failed */
    fetchStatus: text("fetch_status").notNull().default("pending"),
    fetchError: text("fetch_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("source_chapter_links_unique").on(table.subscriptionId, table.externalKey),
    index("source_chapter_links_status_idx").on(table.fetchStatus),
  ]
);

export const sourceRepoStatus = {
  active: "active",
  paused: "paused",
} as const;

export type SourceRepoStatus = (typeof sourceRepoStatus)[keyof typeof sourceRepoStatus];

/**
 * 书源订阅（对应开源阅读的"书源订阅地址"）。
 *
 * 存的是一份**清单地址**，不是单个源。清单作者会持续修规则、加站点，
 * 所以要按间隔重拉一次，把新增的源建起来、已有的按新规则升级。
 *
 * 与 source_subscriptions 的区别：那张表订的是"一本书"，这张订的是
 * "一批源"。原先只有一次性的批量导入 —— 导完就断了联系，清单更新了
 * 得手工再粘一遍地址，而书源失效是常态，这条路基本没人走。
 */
export const sourceRepos = sqliteTable(
  "source_repos",
  {
    id: text("id").primaryKey(),
    /** 展示名，取不到清单标题时回落成域名 */
    name: text("name").notNull(),
    /** 清单地址；支持 JSON 直链与 legado:// 之类的分享链接 */
    url: text("url").notNull(),
    status: text("status").notNull().default(sourceRepoStatus.active),
    /** 重拉间隔（分钟），Cron 按此判断是否到期 */
    syncIntervalMinutes: integer("sync_interval_minutes").notNull().default(1440),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    /** ok / failed */
    lastSyncStatus: text("last_sync_status"),
    lastSyncMessage: text("last_sync_message"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** 上次拉取的产出，给列表页显示"这份清单给了多少源" */
    lastCreatedCount: integer("last_created_count").notNull().default(0),
    lastUpdatedCount: integer("last_updated_count").notNull().default(0),
    sourceCount: integer("source_count").notNull().default(0),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
  },
  (table) => [
    // 同一个清单地址只留一行，重复添加走复用
    uniqueIndex("source_repos_url_unique").on(table.url),
    index("source_repos_due_idx").on(table.status, table.lastSyncAt),
  ]
);

/** 每次同步的审计记录，排障与配额观测都靠它。 */
export const sourceSyncRuns = sqliteTable(
  "source_sync_runs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => contentSources.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id"),
    /** cron / manual */
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    booksChecked: integer("books_checked").notNull().default(0),
    chaptersAdded: integer("chapters_added").notNull().default(0),
    requestCount: integer("request_count").notNull().default(0),
    message: text("message"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().defaultNow(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("source_sync_runs_source_started_idx").on(table.sourceId, table.startedAt)]
);
