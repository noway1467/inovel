-- 搜索分批与排序所需的字段。
--
-- 起因：站内搜索把全部启用源（实测 250 个）在一个请求里全打出去，
-- 触发 Workers 资源上限（Error 1102）。改为每次只查一小批，
-- 于是需要"先查哪些源"的依据，以及各源的搜索健康度。

-- 书源自带的 weight，导入时写入，作为初始优先级
ALTER TABLE `content_sources` ADD `search_weight` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 搜索连续失败次数；与同步失败分开统计，二者健康度不等价
ALTER TABLE `content_sources` ADD `search_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- 最近一次搜索成功时间，用于让长期无结果的源沉底
ALTER TABLE `content_sources` ADD `last_search_at` integer;
--> statement-breakpoint
CREATE INDEX `content_sources_search_rank_idx`
  ON `content_sources` (`status`, `search_failures`, `search_weight`);
