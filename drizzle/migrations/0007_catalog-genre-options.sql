-- 补充作品编辑页常用分类与标签，可重复安全执行?
INSERT OR IGNORE INTO categories (id, name, slug, parent_id, description, sort_order, enabled) VALUES
  ('cat-moshi', '末世', 'moshi', NULL, '末世题材', 9, 1),
  ('cat-xihuan', '西幻', 'xihuan', NULL, '西幻题材', 10, 1),
  ('cat-jiakong', '架空', 'jiakong', NULL, '架空题材', 11, 1),
  ('cat-chuanyue', '穿越', 'chuanyue', NULL, '穿越题材', 12, 1);

UPDATE categories
SET enabled = 1, updated_at = cast((julianday('now') - 2440587.5) * 86400000 as integer)
WHERE name IN ('末世', '西幻', '架空', '穿越');

INSERT OR IGNORE INTO tags (id, name, normalized, enabled) VALUES
  ('tag-moshi', '末世', '末世', 1),
  ('tag-xihuan', '西幻', '西幻', 1),
  ('tag-jiakong', '架空', '架空', 1),
  ('tag-chuanyue', '穿越', '穿越', 1);

UPDATE tags SET enabled = 1 WHERE name IN ('末世', '西幻', '架空', '穿越');
