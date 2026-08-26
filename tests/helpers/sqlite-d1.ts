import { DatabaseSync } from "node:sqlite";
import type { D1Database } from "@cloudflare/workers-types";

/**
 * 用 node:sqlite 兜出一个够 drizzle-orm/d1 用的 D1Database 外壳，
 * 让仓储层的 SQL 能在单测里真跑一遍，而不是靠 mock 猜行为。
 */
export function createSqliteD1(): { d1: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");

  function prepare(query: string) {
    let bindings: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        bindings = values;
        return statement;
      },
      all() {
        const results = raw.prepare(query).all(...(bindings as never[]));
        return Promise.resolve({ results, success: true, meta: {} });
      },
      first(column?: string) {
        const row = raw.prepare(query).get(...(bindings as never[])) as
          | Record<string, unknown>
          | undefined;
        if (!row) return Promise.resolve(null);
        return Promise.resolve(column ? (row[column] ?? null) : row);
      },
      run() {
        raw.prepare(query).run(...(bindings as never[]));
        return Promise.resolve({ results: [], success: true, meta: {} });
      },
      raw() {
        const rows = raw.prepare(query).all(...(bindings as never[])) as Record<
          string,
          unknown
        >[];
        return Promise.resolve(rows.map((row) => Object.values(row)));
      },
    };
    return statement;
  }

  const d1 = {
    prepare,
    batch: (statements: { all(): Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    exec: (query: string) => {
      raw.exec(query);
      return Promise.resolve({ count: 0, duration: 0 });
    },
    dump: () => Promise.resolve(new ArrayBuffer(0)),
  };

  return { d1: d1 as unknown as D1Database, raw };
}

/** 建出被测查询用到的最小表结构，索引与线上一致以便暴露真实执行计划问题。 */
export function createChapterFixtures(raw: DatabaseSync) {
  raw.exec(`
    CREATE TABLE books (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT NOT NULL,
      cover_key TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'draft',
      serial_status TEXT NOT NULL DEFAULT 'ongoing', word_count INTEGER NOT NULL DEFAULT 0,
      author_id TEXT NOT NULL, author_name TEXT, category_id TEXT,
      latest_chapter_id TEXT, latest_chapter_title TEXT, latest_chapter_at INTEGER,
      published_at INTEGER, updated_at INTEGER, created_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE volumes (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, book_id TEXT NOT NULL, volume_id TEXT NOT NULL,
      title TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft', word_count INTEGER NOT NULL DEFAULT 0,
      current_version_id TEXT, published_at INTEGER, deleted_at INTEGER
    );
    CREATE INDEX chapters_book_id_sort_idx ON chapters (book_id, sort_order);
    CREATE INDEX chapters_status_idx ON chapters (status);
    CREATE INDEX chapters_book_status_sort_idx ON chapters (book_id, status, sort_order);
  `);
}
