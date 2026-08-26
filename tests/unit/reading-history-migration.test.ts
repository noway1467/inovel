import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(
  new URL("../../drizzle/migrations/0008_reading-history-unique.sql", import.meta.url)
);

/** 直接跑迁移文件本身，确认它能在存量重复数据上收敛并建起唯一索引。 */
function applyMigration(raw: DatabaseSync) {
  const sql = readFileSync(migrationPath, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) raw.exec(trimmed);
  }
}

function seed() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE reading_history (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, book_id TEXT NOT NULL,
      chapter_id TEXT, paragraph_anchor TEXT,
      char_offset INTEGER NOT NULL DEFAULT 0,
      chapter_progress INTEGER NOT NULL DEFAULT 0,
      book_progress INTEGER NOT NULL DEFAULT 0,
      read_at INTEGER NOT NULL
    );
    CREATE INDEX reading_history_user_read_at_idx ON reading_history (user_id, read_at);
  `);
  return raw;
}

describe("0008 阅读历史去重迁移", () => {
  it("同一 (用户,书,章) 收敛到 read_at 最新的一条", () => {
    const raw = seed();
    const insert = raw.prepare(
      `INSERT INTO reading_history (id, user_id, book_id, chapter_id, chapter_progress, read_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    // 复刻线上形态：同一章 27 条重复
    for (let i = 1; i <= 27; i += 1) {
      insert.run(`id-${i}`, "u1", "b1", "c1", i * 3, 1000 + i);
    }
    insert.run("keep-other-chapter", "u1", "b1", "c2", 50, 900);
    insert.run("keep-other-user", "u2", "b1", "c1", 40, 900);

    applyMigration(raw);

    const rows = raw
      .prepare(`SELECT user_id, book_id, chapter_id, chapter_progress FROM reading_history
                ORDER BY user_id, chapter_id`)
      .all() as Record<string, string | number>[];
    expect(rows).toHaveLength(3);
    const kept = rows.find((row) => row.user_id === "u1" && row.chapter_id === "c1");
    expect(kept?.chapter_progress).toBe(81); // 27 * 3，即 read_at 最大那条
    expect(rows.some((row) => row.chapter_id === "c2")).toBe(true);
    expect(rows.some((row) => row.user_id === "u2")).toBe(true);
  });

  it("迁移后重复写入被唯一索引挡住", () => {
    const raw = seed();
    raw
      .prepare(
        `INSERT INTO reading_history (id, user_id, book_id, chapter_id, chapter_progress, read_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run("a", "u1", "b1", "c1", 10, 1000);

    applyMigration(raw);

    expect(() =>
      raw
        .prepare(
          `INSERT INTO reading_history (id, user_id, book_id, chapter_id, chapter_progress, read_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run("b", "u1", "b1", "c1", 20, 2000)
    ).toThrow(/UNIQUE/i);
  });

  it("空表上也能安全执行", () => {
    const raw = seed();
    expect(() => applyMigration(raw)).not.toThrow();
    expect(
      (raw.prepare(`SELECT COUNT(*) AS c FROM reading_history`).get() as { c: number }).c
    ).toBe(0);
  });
});
