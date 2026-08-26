-- 阅读页导航/目录/跳章都是「按 book_id + status 过滤，按 sort_order 排序」。
-- 只有 (book_id, sort_order) 时，查询规划器会因为 status='published' 看着更"有选择性"
-- 而改走 chapters_status_idx，结果扫遍全表 3 万余行（实际 published 就是全部）。
-- 这条覆盖索引让三类查询都只碰目标作品的行。
CREATE INDEX `chapters_book_status_sort_idx` ON `chapters` (`book_id`,`status`,`sort_order`);
