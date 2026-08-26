-- 阅读历史此前每次进度同步都插一条新行（主键是随机 UUID，
-- onConflictDoNothing 永远命中不了），同一章最多已堆到 27 行。
-- 先按 (user_id, book_id, chapter_id) 收敛到最近一条，再加唯一索引兜住。
DELETE FROM `reading_history`
WHERE `id` NOT IN (
  SELECT `id` FROM (
    SELECT `id`,
           ROW_NUMBER() OVER (
             PARTITION BY `user_id`, `book_id`, `chapter_id`
             ORDER BY `read_at` DESC, `rowid` DESC
           ) AS rn
    FROM `reading_history`
    WHERE `chapter_id` IS NOT NULL
  )
  WHERE rn = 1
)
AND `chapter_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reading_history_user_book_chapter_unique` ON `reading_history` (`user_id`,`book_id`,`chapter_id`);
