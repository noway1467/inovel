-- 验证失败原因分类。
--
-- 起因：失败原先一律记 verify_status = 'failed'，里面混着完全不同的毛病 ——
-- 源站限流返 503、站点封禁返 403、连不上超时、规则失效搜不到、能搜到书但没目录。
-- 这些的处置方式不一样：403 基本没救可以删，503 多半是打太急、过一阵还能用，
-- 规则失效的可以等作者更新。一锅端成 failed 就只能全删或全留。
--
-- 与 verify_message 分开：message 是给人看的原话（含具体错误文本），
-- 这一列是给筛选和批量清理用的枚举值。
--
-- 可空：历史行没有分类，下次验证时自然补上，不需要回填。
ALTER TABLE `content_sources` ADD `verify_fail_reason` text;--> statement-breakpoint
CREATE INDEX `content_sources_verify_fail_reason_idx` ON `content_sources` (`verify_fail_reason`);
