-- 源可用性验证结果。
--
-- 起因：一份合集导入进来两百多个源，其中大部分规则早已失效。
-- 用户搜不到东西、点开报错，但无法分辨"这个源坏了"还是"功能坏了"。
-- 存下每个源的实测结果，才能一键筛掉真正不可用的。

-- untested / ok / failed
ALTER TABLE `content_sources` ADD `verify_status` text DEFAULT 'untested' NOT NULL;
--> statement-breakpoint
ALTER TABLE `content_sources` ADD `verify_message` text;
--> statement-breakpoint
ALTER TABLE `content_sources` ADD `verified_at` integer;
--> statement-breakpoint
-- 实测能搜到的书数 / 能取到目录的书数，用于区分"能搜不能读"的源
ALTER TABLE `content_sources` ADD `verify_search_hits` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `content_sources` ADD `verify_toc_chapters` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `content_sources_verify_idx` ON `content_sources` (`verify_status`);
