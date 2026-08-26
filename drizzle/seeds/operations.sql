INSERT INTO categories (id, name, slug, parent_id, description, sort_order, enabled, created_at, updated_at) VALUES
('cat-xuanhuan', '玄幻', 'xuanhuan', NULL, '东方玄幻题材', 1, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-qihuan', '奇幻', 'qihuan', NULL, '西方奇幻题材', 2, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-wuxia', '武侠', 'wuxia', NULL, '传统武侠题材', 3, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-xianxia', '仙侠', 'xianxia', NULL, '仙侠修真题材', 4, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-dushi', '都市', 'dushi', NULL, '都市现实题材', 5, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-lishi', '历史', 'lishi', NULL, '历史架空题材', 6, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-kehuan', '科幻', 'kehuan', NULL, '科幻未来题材', 7, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-yanqing', '言情', 'yanqing', NULL, '言情恋爱题材', 8, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-moshi', '末世', 'moshi', NULL, '末世题材', 9, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-xihuan', '西幻', 'xihuan', NULL, '西幻题材', 10, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-jiakong', '架空', 'jiakong', NULL, '架空题材', 11, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer)),
('cat-chuanyue', '穿越', 'chuanyue', NULL, '穿越题材', 12, 1, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer));

INSERT INTO tags (id, name, normalized, enabled, created_at) VALUES
('tag-rexue', '热血', '热血', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-xitong', '系统', '系统', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-chongsheng', '重生', '重生', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-chuanyue', '穿越', '穿越', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-wudiliu', '无敌流', '无敌流', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-zhongtian', '种田', '种田', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-tianchong', '甜宠', '甜宠', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-moshi', '末世', '末世', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-xihuan', '西幻', '西幻', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-jiakong', '架空', '架空', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-xuanyi', '悬疑', '悬疑', 1, cast((julianday('now') - 2440587.5)*86400000 as integer)),
('tag-qingxiaoshuo', '轻小说', '轻小说', 1, cast((julianday('now') - 2440587.5)*86400000 as integer));

INSERT INTO recommendation_slots (id, code, name, enabled, sort_order, created_at, updated_at) VALUES
('slot-home-editor', 'home-editor', '首页编辑推荐', 1, 0, cast((julianday('now') - 2440587.5)*86400000 as integer), cast((julianday('now') - 2440587.5)*86400000 as integer));

