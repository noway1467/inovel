import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

function applyMigration(raw: DatabaseSync, file: string) {
  const sql = readFileSync(
    fileURLToPath(new URL(`../../drizzle/migrations/${file}`, import.meta.url)),
    "utf8"
  );
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) raw.exec(trimmed);
  }
}

function seed() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT, link TEXT, read_at INTEGER,
      dedup_key TEXT, created_at INTEGER NOT NULL
    );
  `);
  return raw;
}

function insert(
  raw: DatabaseSync,
  id: string,
  dedupKey: string | null,
  readAt: number | null
) {
  raw
    .prepare(
      `INSERT INTO notifications (id, user_id, type, title, read_at, dedup_key, created_at)
       VALUES (?, 'u1', 'review_result', 't', ?, ?, 1000)`
    )
    .run(id, readAt, dedupKey);
}

function remainingIds(raw: DatabaseSync) {
  return (raw.prepare(`SELECT id FROM notifications ORDER BY id`).all() as { id: string }[]).map(
    (row) => row.id
  );
}

describe("0011 清理历史逐章通知", () => {
  it("删掉已读的逐章通知，保留未读的", () => {
    const raw = seed();
    insert(raw, "legacy-read-1", "review:task-1", 5000);
    insert(raw, "legacy-read-2", "review:task-2", 5000);
    insert(raw, "legacy-unread", "review:task-3", null);

    applyMigration(raw, "0011_purge-legacy-chapter-notifications.sql");

    expect(remainingIds(raw)).toEqual(["legacy-unread"]);
  });

  it("不碰聚合通知与其他类型通知", () => {
    const raw = seed();
    insert(raw, "batch-read", "review-batch:b1:approve:1", 5000);
    insert(raw, "legacy-read", "review:task-1", 5000);
    insert(raw, "no-key", null, 5000);

    applyMigration(raw, "0011_purge-legacy-chapter-notifications.sql");

    // review-batch: 前缀不该被 'review:%' 匹配到
    expect(remainingIds(raw)).toEqual(["batch-read", "no-key"]);
  });

  it("空表上安全执行", () => {
    const raw = seed();
    expect(() => applyMigration(raw, "0011_purge-legacy-chapter-notifications.sql")).not.toThrow();
  });
});
