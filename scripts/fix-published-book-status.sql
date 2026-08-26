-- 存量修复：已有已发布章节的书，把书状态同步为 published。
-- 历史版本审核通过时只更新章节，未更新 books.status，导致公开页面不可见。

UPDATE books
SET status = 'published',
    updated_at = cast(strftime('%s', 'now') AS integer) * 1000
WHERE status IN ('pending_review', 'draft')
  AND deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM chapters c
    WHERE c.book_id = books.id
      AND c.status = 'published'
      AND c.deleted_at IS NULL
  );
