-- 存量迁移：把历史导入后仍处于草稿、且已有正文版本的章节批量提交审核。
-- 幂等可重复执行：只处理没有 pending 审核任务的草稿章节。

INSERT INTO review_tasks (id, book_id, chapter_id, version_id, status, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  c.book_id,
  c.id,
  c.current_version_id,
  'pending',
  cast(strftime('%s', 'now') AS integer) * 1000,
  cast(strftime('%s', 'now') AS integer) * 1000
FROM chapters c
WHERE c.status = 'draft'
  AND c.current_version_id IS NOT NULL
  AND c.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM review_tasks rt
    WHERE rt.chapter_id = c.id AND rt.status = 'pending'
  );

UPDATE chapters
SET status = 'pending_review',
    updated_at = cast(strftime('%s', 'now') AS integer) * 1000
WHERE status = 'draft'
  AND current_version_id IS NOT NULL
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM review_tasks rt
    WHERE rt.chapter_id = chapters.id AND rt.status = 'pending'
  );

UPDATE books
SET status = 'pending_review',
    updated_at = cast(strftime('%s', 'now') AS integer) * 1000
WHERE status = 'draft'
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM chapters c
    JOIN review_tasks rt ON rt.chapter_id = c.id AND rt.status = 'pending'
    WHERE c.book_id = books.id
  );
