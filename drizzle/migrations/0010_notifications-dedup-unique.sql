-- notifications.dedup_key 一直没有唯一索引，所以代码里的 onConflictDoNothing()
-- 从未真正生效，dedup_key 形同装饰。先按 (user_id, dedup_key) 收敛存量重复，
-- 再补上唯一索引。dedup_key 为 NULL 的行不参与（SQLite 唯一索引视 NULL 互不相等）。
DELETE FROM `notifications`
WHERE `dedup_key` IS NOT NULL
  AND `id` NOT IN (
    SELECT `id` FROM (
      SELECT `id`,
             ROW_NUMBER() OVER (
               PARTITION BY `user_id`, `dedup_key`
               ORDER BY `created_at` DESC, `rowid` DESC
             ) AS rn
      FROM `notifications`
      WHERE `dedup_key` IS NOT NULL
    )
    WHERE rn = 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_user_dedup_unique` ON `notifications` (`user_id`,`dedup_key`);
