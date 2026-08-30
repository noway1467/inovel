import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { R2Bucket } from "@cloudflare/workers-types";
import { asc } from "drizzle-orm";
import { chapters } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { confirmImport, createImportJob } from "~/server/imports/service";
import { listBookChapters } from "~/server/repositories/books";
import {
  importChapterBatchKey,
  importReportKey,
  importSourceKey,
} from "~/server/storage/keys";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createMemoryBucket } from "../helpers/sources-fixtures";

/**
 * 追加导入必须接在已有章节之后。这里用真迁移建库 + 真 confirmImport 跑两轮导入，
 * 断言第二次上传的章节 sortOrder 全部大于第一批，而不是从头插一遍。
 */

let db: AppDb;
let raw: DatabaseSync;
let bucket: R2Bucket;

const userId = "user-1";
const authorId = "author-1";
const bookId = "book-1";

function applyMigrations(target: DatabaseSync) {
  const dir = path.resolve(process.cwd(), "drizzle/migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) target.exec(trimmed);
    }
  }
}

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  applyMigrations(raw);
  db = createDb(sqlite.d1);
  bucket = createMemoryBucket().bucket as unknown as R2Bucket;

  const now = Date.now();
  raw
    .prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)`
    )
    .run(userId, "作者甲", "a@test.local", now, now);
  raw
    .prepare(
      `INSERT INTO authors (id, user_id, pen_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`
    )
    .run(authorId, userId, "作者甲", now, now);
  raw
    .prepare(
      `INSERT INTO books (id, title, slug, status, serial_status, word_count, author_id, created_at, updated_at) VALUES (?, ?, ?, 'draft', 'ongoing', 0, ?, ?, ?)`
    )
    .run(bookId, "测试书", "test-book", authorId, now, now);
});

/** 造一个已解析完、待确认的导入任务：报告 + 章节批次都写进内存桶。 */
async function stageJob(jobId: string, titles: string[], volumeTitle = "正文") {
  const now = Date.now();
  raw
    .prepare(
      `INSERT INTO import_jobs (id, book_id, created_by, source_key, source_name, source_size, status, report_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'awaiting_confirmation', ?, ?, ?)`
    )
    .run(
      jobId,
      bookId,
      userId,
      importSourceKey(bookId, jobId),
      `${jobId}.txt`,
      100,
      importReportKey(bookId, jobId),
      now,
      now
    );

  const report = {
    format: "txt",
    encoding: "utf-8",
    generatedAt: new Date().toISOString(),
    ruleVersion: "source-toc-v2",
    warnings: [],
    chapters: titles.map((title, index) => ({
      index,
      title,
      startLine: index,
      endLine: index,
      charCount: 10,
      paragraphCount: 1,
      warning: null,
      preview: title,
      volumeTitle,
      sourceId: null,
      sourceHref: null,
    })),
  };
  await bucket.put(importReportKey(bookId, jobId), JSON.stringify(report));
  await bucket.put(
    importChapterBatchKey(bookId, jobId, 0),
    JSON.stringify(
      titles.map((title) => ({
        title,
        paragraphs: [`${title} 的正文`],
        charCount: 10,
        warning: null,
        volumeTitle,
        sourceId: null,
        sourceHref: null,
      }))
    )
  );
}

async function chapterOrder() {
  const rows = await db
    .select({ title: chapters.title, sortOrder: chapters.sortOrder })
    .from(chapters)
    .orderBy(asc(chapters.sortOrder));
  return rows;
}

/** 读者端目录/详情页的真实呈现顺序：先按卷 sortOrder 分组，再按章 sortOrder。 */
async function displayOrder() {
  const grouped = await listBookChapters(db, bookId, true);
  return grouped.flatMap((volume) => volume.chapters.map((chapter) => chapter.title));
}

describe("追加导入的章节顺序", () => {
  it("第二次上传的章节接在已有章节末尾", async () => {
    await stageJob("job-a", ["第一章", "第二章", "第三章"]);
    await confirmImport(db, bucket, "job-a", userId, { publishMode: "publish" });

    await stageJob("job-b", ["第四章", "第五章"]);
    await confirmImport(db, bucket, "job-b", userId, { publishMode: "publish" });

    expect((await chapterOrder()).map((row) => row.title)).toEqual([
      "第一章",
      "第二章",
      "第三章",
      "第四章",
      "第五章",
    ]);
  });

  it("卷名与已有卷重名时，新章节仍排在全书最后", async () => {
    await stageJob("job-a", ["第一章", "第二章"], "第一卷");
    await confirmImport(db, bucket, "job-a", userId, { publishMode: "publish" });

    await stageJob("job-b", ["第三章"], "第二卷");
    await confirmImport(db, bucket, "job-b", userId, { publishMode: "publish" });

    await stageJob("job-c", ["第四章"], "第一卷");
    await confirmImport(db, bucket, "job-c", userId, { publishMode: "publish" });

    expect((await chapterOrder()).map((row) => row.title)).toEqual([
      "第一章",
      "第二章",
      "第三章",
      "第四章",
    ]);
    // 目录按卷分组呈现，重名卷不能把新章节拖回全书中部
    expect(await displayOrder()).toEqual(["第一章", "第二章", "第三章", "第四章"]);
  });

  it("续写同一卷时合并进最后一卷，不生成重复卷目录", async () => {
    await stageJob("job-a", ["第一章", "第二章"], "第一卷");
    await confirmImport(db, bucket, "job-a", userId, { publishMode: "publish" });

    await stageJob("job-b", ["第三章"], "第一卷");
    await confirmImport(db, bucket, "job-b", userId, { publishMode: "publish" });

    const grouped = await listBookChapters(db, bookId, true);
    expect(grouped.map((volume) => volume.title)).toEqual(["第一卷"]);
    expect(await displayOrder()).toEqual(["第一章", "第二章", "第三章"]);
  });

  it("无卷名的 TXT 追加时并入已有正文卷", async () => {
    await stageJob("job-a", ["第一章", "第二章"]);
    await confirmImport(db, bucket, "job-a", userId, { publishMode: "publish" });

    await stageJob("job-b", ["第三章"]);
    await confirmImport(db, bucket, "job-b", userId, { publishMode: "publish" });

    const grouped = await listBookChapters(db, bookId, true);
    expect(grouped.map((volume) => volume.title)).toEqual(["正文"]);
    expect(await displayOrder()).toEqual(["第一章", "第二章", "第三章"]);
  });

  it("同名文件传到另一本书时不复用旧任务", async () => {
    const otherBookId = "book-2";
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO books (id, title, slug, status, serial_status, word_count, author_id, created_at, updated_at) VALUES (?, ?, ?, 'draft', 'ongoing', 0, ?, ?, ?)`
      )
      .run(otherBookId, "另一本书", "other-book", authorId, now, now);
    raw
      .prepare(
        `INSERT INTO import_jobs (id, book_id, created_by, source_key, source_name, source_size, status, report_key, created_at, updated_at)
         VALUES ('job-old', ?, ?, 'k', 'same.txt', 100, 'awaiting_confirmation', 'r', ?, ?)`
      )
      .run(otherBookId, userId, now, now);

    const file = new File(["第一章\n正文内容\n"], "same.txt");
    Object.defineProperty(file, "size", { value: 100 });
    const job = await createImportJob(db, bucket, undefined, userId, { bookId, file });

    expect(job.id).not.toBe("job-old");
    expect(job.bookId).toBe(bookId);
  });

  it("分片续传的大批量导入不重复建卷，顺序仍然连续", async () => {
    await stageJob("job-a", ["旧章"]);
    await confirmImport(db, bucket, "job-a", userId, { publishMode: "publish" });

    // 单片上限 24 章，30 章会跨两片提交，第二片必须复用第一片建的卷
    const titles = Array.from({ length: 30 }, (_, index) => `新章${index + 1}`);
    await stageJob("job-b", titles, "新卷");
    let done = false;
    let rounds = 0;
    for (let guard = 0; guard < 5 && !done; guard++) {
      const result = await confirmImport(db, bucket, "job-b", userId, { publishMode: "publish" });
      done = result.done === true;
      rounds += 1;
    }
    expect(done).toBe(true);
    // 30 章 / 单片 24 章 = 必须跨两片，才真正覆盖续传复用卷的分支
    expect(rounds).toBe(2);

    const grouped = await listBookChapters(db, bookId, true);
    expect(grouped.map((volume) => volume.title)).toEqual(["正文", "新卷"]);
    expect(await displayOrder()).toEqual(["旧章", ...titles]);
  });
});
