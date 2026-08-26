-- 在线源订阅：域名授权白名单 + 源 + 订阅 + 章节映射 + 同步审计
-- 注意：drizzle-kit 的 _journal.json 只登记到 0003，而 0004-0011 均已由
-- wrangler 应用（d1_migrations 为准）。此文件手写，避免 generate 依据陈旧
-- 快照重建已存在的表。

CREATE TABLE `source_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`authorization_note` text NOT NULL,
	`confirmed_by` text NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`confirmed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_domains_host_unique` ON `source_domains` (`host`);
--> statement-breakpoint
CREATE TABLE `content_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` text DEFAULT 'blocked' NOT NULL,
	`config` text,
	`attribution` text,
	`sync_interval_minutes` integer DEFAULT 360 NOT NULL,
	`last_sync_at` integer,
	`last_sync_status` text,
	`last_sync_message` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `content_sources_status_idx` ON `content_sources` (`status`);
--> statement-breakpoint
CREATE INDEX `content_sources_last_sync_idx` ON `content_sources` (`last_sync_at`);
--> statement-breakpoint
CREATE TABLE `source_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`book_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`synced_chapter_count` integer DEFAULT 0 NOT NULL,
	`toc_fingerprint` text,
	`last_sync_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `content_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_subscriptions_source_external_unique` ON `source_subscriptions` (`source_id`,`external_id`);
--> statement-breakpoint
CREATE INDEX `source_subscriptions_book_idx` ON `source_subscriptions` (`book_id`);
--> statement-breakpoint
CREATE INDEX `source_subscriptions_status_idx` ON `source_subscriptions` (`status`);
--> statement-breakpoint
CREATE TABLE `source_chapter_links` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`chapter_id` text,
	`external_key` text NOT NULL,
	`external_title` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`fetch_status` text DEFAULT 'pending' NOT NULL,
	`fetch_error` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `source_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_chapter_links_unique` ON `source_chapter_links` (`subscription_id`,`external_key`);
--> statement-breakpoint
CREATE INDEX `source_chapter_links_status_idx` ON `source_chapter_links` (`fetch_status`);
--> statement-breakpoint
CREATE TABLE `source_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`subscription_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`books_checked` integer DEFAULT 0 NOT NULL,
	`chapters_added` integer DEFAULT 0 NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`message` text,
	`started_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `content_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_sync_runs_source_started_idx` ON `source_sync_runs` (`source_id`,`started_at`);
