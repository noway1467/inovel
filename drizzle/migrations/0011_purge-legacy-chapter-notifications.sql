-- 清理旧的「一章一条」审核通知。
-- 这些行由 dedup_key 前缀 'review:' 标识（每个审核任务一条），线上单账号已累积
-- 20,688 条且全部已读，把通知中心彻底压垮。新代码改为按书聚合，dedup_key 前缀
-- 是 'review-batch:'，不受影响；单章审核仍走 'review:'，但每章只会有一条。
--
-- 只删已读的，未读的保留（可能是用户还没看到的真实结果）。
DELETE FROM `notifications`
WHERE `dedup_key` LIKE 'review:%'
  AND `read_at` IS NOT NULL;
