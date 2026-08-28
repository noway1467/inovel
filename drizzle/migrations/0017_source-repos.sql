-- 书源订阅：存清单地址，按间隔重拉，把新增源建起来、已有源按新规则升级。
-- 与 source_subscriptions 分开 —— 那张订的是一本书，这张订的是一批源。
CREATE TABLE IF NOT EXISTS `source_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sync_interval_minutes` integer DEFAULT 1440 NOT NULL,
	`last_sync_at` integer,
	`last_sync_status` text,
	`last_sync_message` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_created_count` integer DEFAULT 0 NOT NULL,
	`last_updated_count` integer DEFAULT 0 NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	-- 表名是 user（单数）—— drizzle 里的导出名叫 users，写迁移时容易顺手写错
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `source_repos_url_unique` ON `source_repos` (`url`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `source_repos_due_idx` ON `source_repos` (`status`,`last_sync_at`);
