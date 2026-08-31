-- 分类浏览实测结果。
--
-- 起因：源列表里"有分类"只看 ruleExplore 里有没有地址，规则在但源站改版的源
-- 照样排在分类浏览的第一屏（没有搜索入口的还被特意排到最前），用户点进去
-- 是一片空白。要分辨只能真跑一遍分类页看抓到几本。
--
-- 与 verify_* 分开存：那套测的是"搜索 + 目录"，这套测的是"分类页出不出书"。
-- 只有分类入口的源在 verify 里会被判 skipped，正是这套要覆盖的那批。
--
-- explore_status 取值：untested（没测过）/ ok（抓到书）/ empty（跑通但 0 本）
-- / failed（抓取或规则报错）。历史行默认 untested，下次实测自然补上。
ALTER TABLE `content_sources` ADD `explore_status` text DEFAULT 'untested' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_sources` ADD `explore_books` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `content_sources` ADD `explore_message` text;--> statement-breakpoint
ALTER TABLE `content_sources` ADD `explore_checked_at` integer;--> statement-breakpoint
CREATE INDEX `content_sources_explore_idx` ON `content_sources` (`explore_status`);
