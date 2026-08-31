import type { DatabaseSync } from "node:sqlite";

/**
 * 在线源订阅链路的最小表结构，字段与 0012_content-sources.sql 对齐。
 * 默认值必须写上：drizzle 插入时会省略 defaultNow() 的列，依赖库端默认。
 */
export function createSourceFixtures(raw: DatabaseSync) {
  const now = `(cast((julianday('now') - 2440587.5)*86400000 as integer))`;
  raw.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT ${now},
      updated_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE TABLE authors (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, pen_name TEXT NOT NULL,
      bio TEXT, avatar_key TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT ${now},
      updated_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE TABLE books (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL, category_id TEXT,
      title TEXT NOT NULL, slug TEXT NOT NULL, author_name TEXT,
      cover_key TEXT, description TEXT,
      status TEXT NOT NULL DEFAULT 'draft', serial_status TEXT NOT NULL DEFAULT 'ongoing',
      word_count INTEGER NOT NULL DEFAULT 0, copyright_notice TEXT,
      latest_chapter_id TEXT, latest_chapter_title TEXT, latest_chapter_at INTEGER,
      published_at INTEGER, deleted_at INTEGER, deleted_by TEXT,
      created_at INTEGER NOT NULL DEFAULT ${now},
      updated_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE TABLE volumes (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT ${now},
      updated_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, volume_id TEXT,
      title TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft', word_count INTEGER NOT NULL DEFAULT 0,
      current_version_id TEXT, hidden_reason TEXT,
      publish_at INTEGER, published_at INTEGER, rejected_reason TEXT,
      created_at INTEGER NOT NULL DEFAULT ${now},
      updated_at INTEGER NOT NULL DEFAULT ${now},
      deleted_at INTEGER
    );
    CREATE TABLE chapter_versions (
      id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, version INTEGER NOT NULL,
      r2_key TEXT NOT NULL, content_hash TEXT NOT NULL, title TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      is_published INTEGER NOT NULL DEFAULT 0, created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      before TEXT, after TEXT, reason TEXT, trace_id TEXT,
      created_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE TABLE site_settings (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL,
      description TEXT,
      updated_at INTEGER NOT NULL DEFAULT ${now}
    );

    CREATE TABLE source_domains (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, authorization_note TEXT NOT NULL,
      confirmed_by TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE UNIQUE INDEX source_domains_host_unique ON source_domains (host);
    CREATE TABLE content_sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      endpoint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'blocked',
      config TEXT, attribution TEXT,
      sync_interval_minutes INTEGER NOT NULL DEFAULT 360,
      last_sync_at INTEGER, last_sync_status TEXT, last_sync_message TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      search_weight INTEGER NOT NULL DEFAULT 0,
      search_failures INTEGER NOT NULL DEFAULT 0,
      last_search_at INTEGER,
      verify_status TEXT NOT NULL DEFAULT 'untested',
      verify_message TEXT,
      verify_fail_reason TEXT,
      verified_at INTEGER,
      verify_search_hits INTEGER NOT NULL DEFAULT 0,
      verify_toc_chapters INTEGER NOT NULL DEFAULT 0,
      explore_status TEXT NOT NULL DEFAULT 'untested',
      explore_books INTEGER NOT NULL DEFAULT 0,
      explore_message TEXT,
      explore_checked_at INTEGER,
      created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT ${now},
      updated_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE TABLE source_subscriptions (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, book_id TEXT NOT NULL,
      external_id TEXT NOT NULL, external_title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      synced_chapter_count INTEGER NOT NULL DEFAULT 0, toc_fingerprint TEXT,
      last_sync_at INTEGER, last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0, created_by TEXT,
      created_at INTEGER NOT NULL DEFAULT ${now},
      updated_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE UNIQUE INDEX source_subscriptions_source_external_unique
      ON source_subscriptions (source_id, external_id);
    CREATE TABLE source_chapter_links (
      id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, chapter_id TEXT,
      external_key TEXT NOT NULL, external_title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      fetch_status TEXT NOT NULL DEFAULT 'pending', fetch_error TEXT,
      created_at INTEGER NOT NULL DEFAULT ${now},
      updated_at INTEGER NOT NULL DEFAULT ${now}
    );
    CREATE UNIQUE INDEX source_chapter_links_unique
      ON source_chapter_links (subscription_id, external_key);
    CREATE TABLE source_sync_runs (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, subscription_id TEXT,
      trigger TEXT NOT NULL, status TEXT NOT NULL,
      books_checked INTEGER NOT NULL DEFAULT 0,
      chapters_added INTEGER NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0, message TEXT,
      started_at INTEGER NOT NULL DEFAULT ${now}, finished_at INTEGER
    );
  `);
}

/** 内存版 R2 桶，够 putChapterContent 用 */
export function createMemoryBucket() {
  const store = new Map<string, string>();
  return {
    store,
    bucket: {
      put: (key: string, body: string) => {
        store.set(key, body);
        return Promise.resolve({ key });
      },
      get: (key: string) => {
        const value = store.get(key);
        if (!value) return Promise.resolve(null);
        return Promise.resolve({ text: () => Promise.resolve(value) });
      },
    },
  };
}

/** 生成一个 RSS 文档，条目按 feed 惯例新→旧 */
export function makeRss(titles: { title: string; link: string; content?: string }[]) {
  const items = titles
    .map(
      (item) => `
    <item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <description><![CDATA[${item.content ?? `<p>${item.title} 的正文</p>`}]]></description>
    </item>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>测试连载</title>
  <description>用于单测的订阅源</description>${items}
</channel></rss>`;
}
