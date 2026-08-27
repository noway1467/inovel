-- 在线源书籍的书架与阅读进度。
--
-- 起因：在线源的书从不入 books 表（搜到就能读，不需要先订阅入库），
-- 而 shelf_items / reading_progress 的 book_id 都外键指向 books，
-- 于是在线源那边没有"加入书架"和"上次读到哪"，与本地导入的书体验不一致。
--
-- source_id 故意不加外键：管理台的「删除不可用的源」会成批删 content_sources，
-- 级联会顺手清掉用户的书架和进度。source_name / book_title 一并冗余存下，
-- 源没了也还能在书架里显示这本书读到哪。
CREATE TABLE `source_reading_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`book_url` text NOT NULL,
	`book_title` text NOT NULL,
	`source_name` text,
	-- 进度与书架分开：移出书架不该丢掉读到哪
	`shelved` integer DEFAULT false NOT NULL,
	`last_chapter_key` text,
	`last_chapter_title` text,
	`last_chapter_index` integer,
	`last_page_index` integer DEFAULT 0 NOT NULL,
	`chapter_count` integer,
	`last_read_at` integer,
	`added_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_reading_state_user_book_unique` ON `source_reading_state` (`user_id`,`source_id`,`book_url`);--> statement-breakpoint
CREATE INDEX `source_reading_state_user_shelved_idx` ON `source_reading_state` (`user_id`,`shelved`,`last_read_at`);--> statement-breakpoint
CREATE INDEX `source_reading_state_user_read_at_idx` ON `source_reading_state` (`user_id`,`last_read_at`);
