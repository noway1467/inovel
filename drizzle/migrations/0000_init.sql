CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`provider_id` text NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`image` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission_id` text NOT NULL,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_permissions_pk` ON `role_permissions` (`role_id`,`permission_id`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` text NOT NULL,
	`role_id` text NOT NULL,
	`granted_by` text,
	`reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_roles_pk` ON `user_roles` (`user_id`,`role_id`);--> statement-breakpoint
CREATE TABLE `authors` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`pen_name` text NOT NULL,
	`bio` text,
	`avatar_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `book_tags` (
	`book_id` text NOT NULL,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_tags_pk` ON `book_tags` (`book_id`,`tag_id`);--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`category_id` text,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`cover_key` text,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`serial_status` text DEFAULT 'ongoing' NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`copyright_notice` text,
	`latest_chapter_id` text,
	`latest_chapter_title` text,
	`latest_chapter_at` integer,
	`published_at` integer,
	`deleted_at` integer,
	`deleted_by` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `books_author_id_idx` ON `books` (`author_id`);--> statement-breakpoint
CREATE INDEX `books_status_idx` ON `books` (`status`);--> statement-breakpoint
CREATE INDEX `books_category_id_idx` ON `books` (`category_id`);--> statement-breakpoint
CREATE INDEX `books_updated_at_idx` ON `books` (`updated_at`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`parent_id` text,
	`description` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chapter_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`version` integer NOT NULL,
	`r2_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`title` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`is_published` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chapter_versions_chapter_version_unique` ON `chapter_versions` (`chapter_id`,`version`);--> statement-breakpoint
CREATE INDEX `chapter_versions_chapter_id_idx` ON `chapter_versions` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`volume_id` text,
	`title` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`current_version_id` text,
	`hidden_reason` text,
	`publish_at` integer,
	`published_at` integer,
	`rejected_reason` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chapters_book_id_sort_idx` ON `chapters` (`book_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `chapters_status_idx` ON `chapters` (`status`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`normalized` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`title` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `volumes_book_id_idx` ON `volumes` (`book_id`);--> statement-breakpoint
CREATE TABLE `bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` text,
	`paragraph_anchor` text,
	`char_offset` integer DEFAULT 0 NOT NULL,
	`excerpt` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bookmarks_user_book_idx` ON `bookmarks` (`user_id`,`book_id`);--> statement-breakpoint
CREATE INDEX `bookmarks_user_created_at_idx` ON `bookmarks` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `reading_history` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` text,
	`paragraph_anchor` text,
	`char_offset` integer DEFAULT 0 NOT NULL,
	`chapter_progress` integer DEFAULT 0 NOT NULL,
	`book_progress` integer DEFAULT 0 NOT NULL,
	`read_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reading_history_user_read_at_idx` ON `reading_history` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `reading_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`theme` text DEFAULT 'paper' NOT NULL,
	`font_size` integer DEFAULT 18 NOT NULL,
	`font_family` text DEFAULT 'system' NOT NULL,
	`line_height` integer DEFAULT 180 NOT NULL,
	`paragraph_spacing` integer DEFAULT 80 NOT NULL,
	`margin` text DEFAULT 'standard' NOT NULL,
	`align` text DEFAULT 'justify' NOT NULL,
	`indent` text DEFAULT '2char' NOT NULL,
	`letter_spacing` text DEFAULT 'default' NOT NULL,
	`pagination_mode` text DEFAULT 'scroll' NOT NULL,
	`sync_progress` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reading_preferences_user_unique` ON `reading_preferences` (`user_id`);--> statement-breakpoint
CREATE TABLE `reading_progress` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` text,
	`paragraph_anchor` text,
	`char_offset` integer DEFAULT 0 NOT NULL,
	`chapter_progress` integer DEFAULT 0 NOT NULL,
	`book_progress` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`device_id` text,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reading_progress_user_book_unique` ON `reading_progress` (`user_id`,`book_id`);--> statement-breakpoint
CREATE INDEX `reading_progress_updated_at_idx` ON `reading_progress` (`updated_at`);--> statement-breakpoint
CREATE TABLE `shelf_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`group` text DEFAULT 'reading' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`last_read_at` integer,
	`added_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shelf_items_user_book_unique` ON `shelf_items` (`user_id`,`book_id`);--> statement-breakpoint
CREATE INDEX `shelf_items_user_last_read_idx` ON `shelf_items` (`user_id`,`last_read_at`);--> statement-breakpoint
CREATE TABLE `import_chapter_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`title` text NOT NULL,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL,
	`warning` text,
	`action` text DEFAULT 'keep' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_candidates_job_id_idx` ON `import_chapter_candidates` (`job_id`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`created_by` text NOT NULL,
	`source_key` text NOT NULL,
	`source_name` text NOT NULL,
	`source_size` integer DEFAULT 0 NOT NULL,
	`encoding` text,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`report_key` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_jobs_book_id_idx` ON `import_jobs` (`book_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`read_at` integer,
	`dedup_key` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`chapter_id` text NOT NULL,
	`version_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`assigned_to` text,
	`auto_rule_hits` text,
	`decision` text,
	`reason` text,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_to`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_tasks_status_idx` ON `review_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `review_tasks_chapter_id_idx` ON `review_tasks` (`chapter_id`);--> statement-breakpoint
CREATE TABLE `announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `announcements_enabled_idx` ON `announcements` (`enabled`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`reason` text,
	`trace_id` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `feature_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`description` text,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_dedup` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`handler` text NOT NULL,
	`status` text DEFAULT 'processed' NOT NULL,
	`processed_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_dedup_event_handler_unique` ON `job_dedup` (`event_id`,`handler`);--> statement-breakpoint
CREATE TABLE `ranking_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`period` text NOT NULL,
	`payload` text NOT NULL,
	`frozen` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ranking_snapshots_type_period_unique` ON `ranking_snapshots` (`type`,`period`);--> statement-breakpoint
CREATE TABLE `recommendation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`book_id` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`start_at` integer,
	`end_at` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `recommendation_slots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recommendation_items_slot_idx` ON `recommendation_items` (`slot_id`);--> statement-breakpoint
CREATE TABLE `recommendation_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`description` text,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `books_fts` USING fts5(
	`book_id` UNINDEXED,
	`title`,
	`author_name`,
	`description`,
	tokenize = 'unicode61'
);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `books_fts_ai` AFTER INSERT ON `books` BEGIN
	INSERT INTO `books_fts`(`rowid`, `book_id`, `title`, `author_name`, `description`)
	SELECT `books`.`rowid`, `books`.`id`, `books`.`title`, `authors`.`pen_name`, `books`.`description`
	FROM `books` JOIN `authors` ON `authors`.`id` = `books`.`author_id`
	WHERE `books`.`id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `books_fts_ad` AFTER DELETE ON `books` BEGIN
	DELETE FROM `books_fts` WHERE `book_id` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `books_fts_au` AFTER UPDATE ON `books` BEGIN
	DELETE FROM `books_fts` WHERE `book_id` = NEW.`id`;
	INSERT INTO `books_fts`(`rowid`, `book_id`, `title`, `author_name`, `description`)
	SELECT `books`.`rowid`, `books`.`id`, `books`.`title`, `authors`.`pen_name`, `books`.`description`
	FROM `books` JOIN `authors` ON `authors`.`id` = `books`.`author_id`
	WHERE `books`.`id` = NEW.`id`;
END;
