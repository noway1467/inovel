import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  authors,
  bookTags,
  books,
  chapters,
  chapterVersions,
  importChapterCandidates,
  importJobs,
  reviewTasks,
  tags,
  volumes,
} from "drizzle/schema";
import type { R2Bucket, R2UploadedPart } from "@cloudflare/workers-types";
import type { AppDb } from "~/server/db";
import { parseBookFile, supportedExtensions } from "~/server/imports/parser";
import { getMaxUploadMbForFormat } from "~/server/settings/import-limits";
import { ensureAuthorProfile } from "~/server/creator/profile";
import { updateBookMetadata, type BookSerialStatus } from "~/server/creator/service";
import {
  chapterVersionKey,
  importChapterBatchKey,
  importChapterKey,
  importConfirmPayloadKey,
  importReportKey,
  importSourceKey,
} from "~/server/storage/keys";
import { putChapterContent } from "~/server/storage/chapter-content";
import { createEnvelope, queueEventTypes } from "~/server/queues/messages";

export const chunkedPartSize = 8 * 1024 * 1024;
export const directUploadMaxBytes = 8 * 1024 * 1024;
const parsedChapterBatchSize = 50;
const parsedChapterBatchWriteConcurrency = 2;
const commitChunkMaxChapters = 24;
const commitChunkTargetChars = 200_000;
const commitContentWriteConcurrency = 2;
const d1MaxBoundParameters = 100;

export type StagedImportChapter = {
  title: string;
  paragraphs: string[];
  charCount: number;
  warning?: string | null;
  /** 暂存内容缺失时保留章节壳，允许后续在章节编辑器中补录。 */
  contentMissing?: boolean;
  volumeTitle?: string | null;
  sourceId?: string | null;
  sourceHref?: string | null;
};

export function recoverStagedImportChapter(
  entry: StagedImportChapter | null | undefined,
  fallback: { title: string; volumeTitle: string; warning: string }
): StagedImportChapter {
  if (
    entry &&
    Array.isArray(entry.paragraphs) &&
    entry.paragraphs.every((text) => typeof text === "string")
  ) {
    return { ...entry, volumeTitle: entry.volumeTitle || fallback.volumeTitle };
  }
  return {
    title: fallback.title,
    paragraphs: [],
    charCount: 0,
    warning: fallback.warning,
    contentMissing: true,
    volumeTitle: fallback.volumeTitle,
  };
}

// D1 db.batch 要求非空元组 [U, ...U[]]，运行时数组需显式转成元组
function toBatch<T extends BatchItem<"sqlite">>(items: T[]): [T, ...T[]] {
  return items as [T, ...T[]];
}

function chunkRows<T>(rows: T[], columnsPerRow: number): T[][] {
  const rowsPerStatement = Math.max(1, Math.floor(d1MaxBoundParameters / columnsPerRow));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += rowsPerStatement) {
    chunks.push(rows.slice(i, i + rowsPerStatement));
  }
  return chunks;
}

async function runWithLimit<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>
) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) await task(item, index);
    }
  });
  await Promise.all(workers);
}

export interface ImportCandidateView {
  index: number;
  title: string;
  volumeTitle: string;
  charCount: number;
  paragraphCount: number;
  warning?: string | null;
  preview: string;
}

export interface ImportJobView {
  id: string;
  bookId: string;
  commitCursor: number | null;
  bookTitle: string;
  bookAuthorName: string;
  sourceAuthorName: string | null;
  bookCategoryId: string | null;
  bookSerialStatus: BookSerialStatus;
  bookTags: string[];
  sourceName: string;
  sourceSize: number;
  encoding: string | null;
  format: string;
  status: string;
  reportKey: string | null;
  errorMessage: string | null;
  candidates: ImportCandidateView[];
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ImportReportChapterMeta {
  index: number;
  title: string;
  startLine: number;
  endLine: number;
  charCount: number;
  paragraphCount: number;
  warning: string | null;
  preview: string;
  volumeTitle: string;
  sourceId: string | null;
  sourceHref: string | null;
}

export interface ImportReportMeta {
  format: string;
  encoding: string | null;
  metadata?: { title?: string; author?: string };
  pageCount?: number;
  generatedAt: string;
  ruleVersion: string;
  warnings: string[];
  chapters: ImportReportChapterMeta[];
}

interface LegacyImportReportChapter {
  title: string;
  paragraphs: string[];
  charCount: number;
  warning?: string | null;
  volumeTitle?: string | null;
}

interface ImportReportData {
  meta?: ImportReportMeta;
  legacyChapters?: LegacyImportReportChapter[];
  legacyWarnings?: string[];
}

export interface ChunkedImportStartInput {
  bookId?: string;
  title?: string;
  fileName: string;
  fileSize: number;
  splitChars?: number;
}

export interface ChunkedImportStartResult {
  jobId: string;
  uploadId: string;
  partSize: number;
}

export type ImportPublishMode = "draft" | "review" | "publish";

export function getImportChapterDisposition(
  publishMode: ImportPublishMode,
  contentMissing: boolean
) {
  if (contentMissing) {
    return { status: "draft", isPublished: false, submitForReview: false } as const;
  }
  return {
    status:
      publishMode === "publish"
        ? "published"
        : publishMode === "review"
          ? "pending_review"
          : "draft",
    isPublished: publishMode === "publish",
    submitForReview: publishMode === "review",
  } as const;
}

export interface ConfirmImportInput {
  actions?: ConfirmAction[];
  title?: string;
  /** 新接口使用 publishMode；submitForReview 仅保留旧客户端兼容。 */
  publishMode?: ImportPublishMode;
  submitForReview?: boolean;
  categoryId?: string | null;
  categoryName?: string;
  tags?: string[];
  serialStatus?: BookSerialStatus;
  authorName?: string | null;
}

export interface ConfirmImportPayload {
  actions: ConfirmAction[];
  title?: string;
  publishMode: ImportPublishMode;
  categoryId?: string | null;
  categoryName?: string;
  tags?: string[];
  serialStatus?: BookSerialStatus;
  authorName?: string | null;
  createdBy: string;
}

async function resolveBookIdForImport(
  db: AppDb,
  userId: string,
  input: { bookId?: string; title?: string; fileName: string }
): Promise<string> {
  const authorRow = await ensureAuthorProfile(db, userId);
  if (!authorRow) {
    throw new Error("当前账号还不是作者，请先完成作者认证");
  }
  if (input.bookId) {
    const book = await db.select().from(books).where(eq(books.id, input.bookId)).get();
    if (!book || book.authorId !== authorRow.id) {
      throw new Error("无权导入到该作品");
    }
    return input.bookId;
  }
  const sourceName = input.fileName.split(/[\\/]/).pop() ?? input.fileName;
  const fallbackTitle = sourceName.replace(/\.[^.]+$/, "").trim();
  const bookTitle = input.title?.trim() || fallbackTitle;
  if (!bookTitle) throw new Error("无法确定作品标题，请填写标题或使用合法文件名");
  const inserted = await db
    .insert(books)
    .values({
      id: crypto.randomUUID(),
      authorId: authorRow.id,
      title: bookTitle,
      slug: `${Date.now()}-${bookTitle.slice(0, 24)}`,
      status: "draft",
    })
    .returning()
    .get();
  return inserted.id;
}

// 同一用户重复上传同名同大小文件时，复用仍在解析或待导入的任务，
// 避免同一个文件被反复解析（每次解析都消耗 Worker CPU，容易触发 1102）。
async function findExistingImportJob(
  db: AppDb,
  userId: string,
  fileName: string,
  fileSize: number
) {
  const sourceName = fileName.split(/[\\/]/).pop() ?? fileName;
  return db
    .select()
    .from(importJobs)
    .where(
      and(
        eq(importJobs.createdBy, userId),
        eq(importJobs.sourceName, sourceName),
        eq(importJobs.sourceSize, fileSize),
        inArray(importJobs.status, ["uploaded", "parsing", "awaiting_confirmation"])
      )
    )
    .orderBy(desc(importJobs.createdAt))
    .limit(1)
    .get();
}

export async function createImportJob(
  db: AppDb,
  bucket: R2Bucket,
  queue: Queue<unknown> | undefined,
  userId: string,
  input: { bookId?: string; title?: string; file: File; splitChars?: number }
): Promise<ImportJobView> {
  const ext = input.file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!supportedExtensions.includes(ext as (typeof supportedExtensions)[number])) {
    throw new Error(`不支持的文件格式：${input.file.name}`);
  }
  const maxSize = (await getMaxUploadMbForFormat(db, ext)) * 1024 * 1024;
  if (input.file.size > maxSize) {
    throw new Error(`${ext.toUpperCase()} 文件超过 ${Math.round(maxSize / 1024 / 1024)}MB 上限`);
  }
  if (input.file.size > directUploadMaxBytes) {
    throw new Error(`${ext.toUpperCase()} 文件超过 8MB，请使用分片上传`);
  }
  const existing = await findExistingImportJob(db, userId, input.file.name, input.file.size);
  if (existing) {
    return getImportJob(db, bucket, existing.id);
  }
  const bookId = await resolveBookIdForImport(db, userId, {
    bookId: input.bookId,
    title: input.title,
    fileName: input.file.name,
  });

  const jobId = crypto.randomUUID();
  const sourceKey = importSourceKey(bookId, jobId);
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  await bucket.put(sourceKey, bytes, {
    httpMetadata: { contentType: input.file.type || "application/octet-stream" },
  });

  await db.insert(importJobs).values({
    id: jobId,
    bookId,
    createdBy: userId,
    sourceKey,
    sourceName: input.file.name,
    sourceSize: input.file.size,
    status: "uploaded",
  });

  let queued = false;
  if (queue) {
    try {
      await queue.send(
        createEnvelope(
          queueEventTypes.importParse,
          jobId,
          { jobId, bookId, splitChars: input.splitChars },
          userId
        )
      );
      queued = true;
    } catch {
      // 不退回请求内解析：大文件同步解析会撞 Worker 1102，宁可明确失败
    }
  }

  if (!queued) {
    await db
      .update(importJobs)
      .set({
        status: "failed",
        errorCode: "QUEUE_UNAVAILABLE",
        errorMessage: "解析队列暂不可用，请稍后重试",
      })
      .where(eq(importJobs.id, jobId));
  }

  return getImportJob(db, bucket, jobId);
}

/**
 * 重试解析：解析失败（含队列瞬时故障、消费者被掐死导致卡在 parsing）的任务
 * 可以重新入队，不必重新上传整个文件。新信封带全新 eventId，不会被幂等表挡掉。
 */
export async function retryImportParse(
  db: AppDb,
  bucket: R2Bucket,
  queue: Queue<unknown> | undefined,
  userId: string,
  jobId: string,
  splitChars?: number
) {
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job) throw new Error("导入任务不存在");
  const authorRow = await ensureAuthorProfile(db, userId);
  if (!authorRow) throw new Error("无作者权限");
  const book = await db.select().from(books).where(eq(books.id, job.bookId)).get();
  if (!book || book.authorId !== authorRow.id) throw new Error("无权操作该导入任务");
  if (!["failed", "parsing", "uploaded"].includes(job.status)) {
    throw new Error(`当前状态（${job.status}）不需要重试解析`);
  }
  if (!queue) throw new Error("解析队列暂不可用，请稍后重试");

  await db
    .update(importJobs)
    .set({ status: "uploaded", errorCode: null, errorMessage: null, updatedAt: new Date() })
    .where(eq(importJobs.id, jobId));
  await queue.send(
    createEnvelope(
      queueEventTypes.importParse,
      jobId,
      { jobId, bookId: job.bookId, splitChars },
      userId
    )
  );
  return getImportJob(db, bucket, jobId);
}

/**
 * 待确认任务可以重新入队解析：按新的 splitChars 强制重分章，
 * 适合用户确认导入前选择“按 5000 字重新划分章节”。
 */
export async function reparseImportJob(
  db: AppDb,
  bucket: R2Bucket,
  queue: Queue<unknown> | undefined,
  userId: string,
  jobId: string,
  splitChars?: number
): Promise<ImportJobView> {
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job) throw new Error("导入任务不存在");
  const authorRow = await ensureAuthorProfile(db, userId);
  if (!authorRow) throw new Error("无作者权限");
  const book = await db.select().from(books).where(eq(books.id, job.bookId)).get();
  if (!book || book.authorId !== authorRow.id) throw new Error("无权操作该导入任务");
  if (job.status !== "awaiting_confirmation") {
    throw new Error(`当前状态（${job.status}）不能重新划分章节`);
  }
  if (!queue) throw new Error("解析队列暂不可用，请稍后重试");

  const chars =
    Number.isFinite(splitChars) && (splitChars as number) > 0
      ? Math.max(0, Math.round(splitChars as number))
      : undefined;
  await db
    .update(importJobs)
    .set({
      status: "uploaded",
      commitCursor: null,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, jobId));
  await queue.send(
    createEnvelope(
      queueEventTypes.importParse,
      jobId,
      { jobId, bookId: job.bookId, splitChars: chars, forceSplitByChars: true },
      userId
    )
  );
  return getImportJob(db, bucket, jobId);
}

export async function startChunkedImport(
  db: AppDb,
  bucket: R2Bucket,
  userId: string,
  input: ChunkedImportStartInput
): Promise<ChunkedImportStartResult> {
  const ext = input.fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!supportedExtensions.includes(ext as (typeof supportedExtensions)[number])) {
    throw new Error(`不支持的文件格式：${input.fileName}`);
  }
  if (!Number.isFinite(input.fileSize) || input.fileSize <= 0) {
    throw new Error("文件不能为空");
  }
  const maxSize = (await getMaxUploadMbForFormat(db, ext)) * 1024 * 1024;
  if (input.fileSize > maxSize) {
    throw new Error(`${ext.toUpperCase()} 文件超过 ${Math.round(maxSize / 1024 / 1024)}MB 上限`);
  }
  const existing = await findExistingImportJob(
    db,
    userId,
    input.fileName,
    Math.round(input.fileSize)
  );
  if (existing) {
    throw new Error("该文件正在解析或待导入中，请勿重复上传");
  }
  const bookId = await resolveBookIdForImport(db, userId, {
    bookId: input.bookId,
    title: input.title,
    fileName: input.fileName,
  });
  const jobId = crypto.randomUUID();
  const sourceKey = importSourceKey(bookId, jobId);
  const multipart = await bucket.createMultipartUpload(sourceKey, {
    httpMetadata: { contentType: ext === "txt" ? "text/plain" : "application/octet-stream" },
  });
  await db.insert(importJobs).values({
    id: jobId,
    bookId,
    createdBy: userId,
    sourceKey,
    sourceName: input.fileName,
    sourceSize: Math.round(input.fileSize),
    uploadId: multipart.uploadId,
    status: "uploading",
  });
  return { jobId, uploadId: multipart.uploadId, partSize: chunkedPartSize };
}

export async function uploadChunkPart(
  db: AppDb,
  bucket: R2Bucket,
  userId: string,
  jobId: string,
  partNumber: number,
  bytes: Uint8Array
): Promise<R2UploadedPart> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new Error("分片编号无效");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > chunkedPartSize) {
    throw new Error(`分片大小无效，每片不能超过 ${Math.round(chunkedPartSize / 1024 / 1024)}MB`);
  }
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job || job.createdBy !== userId) throw new Error("导入任务不存在");
  if (job.status !== "uploading") throw new Error("当前任务不能上传分片");
  if (!job.uploadId) throw new Error("上传会话缺失，请重新发起上传");
  const multipart = bucket.resumeMultipartUpload(job.sourceKey, job.uploadId);
  const part = await multipart.uploadPart(partNumber, bytes);
  return { partNumber: part.partNumber, etag: part.etag };
}

export async function completeChunkedImport(
  db: AppDb,
  bucket: R2Bucket,
  queue: Queue<unknown> | undefined,
  userId: string,
  jobId: string,
  parts: R2UploadedPart[],
  splitChars?: number
): Promise<ImportJobView> {
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job || job.createdBy !== userId) throw new Error("导入任务不存在");
  if (job.status !== "uploading") throw new Error("当前任务不能完成上传");
  if (!job.uploadId) throw new Error("上传会话缺失，请重新发起上传");
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("缺少分片列表");
  const expectedPartCount = Math.ceil(job.sourceSize / chunkedPartSize);
  if (parts.length !== expectedPartCount) throw new Error("分片数量不完整，请重新上传");
  const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  for (let index = 0; index < sortedParts.length; index++) {
    const part = sortedParts[index];
    if (!part || part.partNumber !== index + 1 || !part.etag) {
      throw new Error("分片列表无效，请重新上传");
    }
  }
  const multipart = bucket.resumeMultipartUpload(job.sourceKey, job.uploadId);
  const object = await multipart.complete(sortedParts);
  await db
    .update(importJobs)
    .set({
      status: "uploaded",
      sourceSize: object.size,
      uploadId: null,
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, jobId));
  let queued = false;
  if (queue) {
    try {
      await queue.send(
        createEnvelope(
          queueEventTypes.importParse,
          jobId,
          { jobId, bookId: job.bookId, splitChars },
          userId
        )
      );
      queued = true;
    } catch {
      // 不退回请求内解析：大文件同步解析会撞 Worker 1102，宁可明确失败
    }
  }
  if (!queued) {
    await db
      .update(importJobs)
      .set({
        status: "failed",
        errorCode: "QUEUE_UNAVAILABLE",
        errorMessage: "解析队列暂不可用，请稍后重试",
        updatedAt: new Date(),
      })
      .where(eq(importJobs.id, jobId));
  }
  return getImportJob(db, bucket, jobId);
}

export async function abortChunkedImport(
  db: AppDb,
  bucket: R2Bucket,
  userId: string,
  jobId: string
) {
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job || job.createdBy !== userId) throw new Error("导入任务不存在");
  if (job.uploadId) {
    try {
      await bucket.resumeMultipartUpload(job.sourceKey, job.uploadId).abort();
    } catch {
      // 会话可能已失效，忽略并继续清理
    }
  }
  try {
    await bucket.delete(job.sourceKey);
  } catch {
    // 对象可能不存在，忽略
  }
  await db.delete(importJobs).where(eq(importJobs.id, jobId));
}

export async function parseImportJob(
  db: AppDb,
  bucket: R2Bucket,
  jobId: string,
  options?: { splitChars?: number; forceSplitByChars?: boolean }
) {
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job) throw new Error("导入任务不存在");
  if (job.status !== "uploaded") return;

  // 原子抢占：只允许 uploaded → parsing 的消费者继续；重复投递、重试与
  // 多个手动重试并发时，其余消息直接跳过，避免同一文件被重复解析。
  const claimed = await db
    .update(importJobs)
    .set({ status: "parsing", updatedAt: new Date() })
    .where(and(eq(importJobs.id, jobId), eq(importJobs.status, "uploaded")))
    .returning({ id: importJobs.id })
    .get();
  if (!claimed) return;

  const parseStartedAt = Date.now();
  console.info("[import] parse:start", {
    jobId,
    sourceName: job.sourceName,
    sourceSize: job.sourceSize,
  });
  let parsed: Awaited<ReturnType<typeof parseBookFile>>;
  {
    // 缩小源文件对象与字节数组的作用域，让后续写入章节批次时能尽早回收这部分内存。
    const object = await bucket.get(job.sourceKey);
    if (!object) throw new Error("上传文件丢失");
    const bytes = new Uint8Array(await object.arrayBuffer());
    parsed = await parseBookFile(bytes, job.sourceName, {
      charsPerChapter:
        options?.splitChars === undefined ? undefined : Math.max(0, Math.round(options.splitChars)),
      forceSplitByChars: options?.forceSplitByChars,
    });
  }
  console.info("[import] parse:decoded", {
    jobId,
    chapters: parsed.chapters.length,
    elapsedMs: Date.now() - parseStartedAt,
  });

  // 报告只存章节元数据与预览，正文按章拆成独立 R2 对象：
  // 候选列表加载和分片确认导入都不再需要把整本正文拉进 Worker 内存。
  const report: ImportReportMeta = {
    format: parsed.format,
    encoding: parsed.encoding ?? null,
    metadata: parsed.metadata,
    pageCount: parsed.pageCount,
    generatedAt: new Date().toISOString(),
    ruleVersion: "source-toc-v2",
    warnings: parsed.warnings,
    chapters: parsed.chapters.map((chapter, index) => ({
      index,
      title: chapter.title,
      startLine: chapter.startLine,
      endLine: chapter.endLine,
      charCount: chapter.charCount,
      paragraphCount: chapter.paragraphs.length,
      warning: chapter.warning ?? null,
      preview: chapter.paragraphs[0]?.slice(0, 80) ?? "",
      volumeTitle: chapter.volumeTitle?.trim() || "正文",
      sourceId: chapter.sourceId ?? null,
      sourceHref: chapter.sourceHref ?? null,
    })),
  };
  const reportKey = importReportKey(job.bookId, jobId);
  await bucket.put(reportKey, JSON.stringify(report), {
    httpMetadata: { contentType: "application/json" },
  });
  for (
    let i = 0;
    i < parsed.chapters.length;
    i += parsedChapterBatchSize * parsedChapterBatchWriteConcurrency
  ) {
    const batchCount = Math.ceil(
      Math.min(
        parsed.chapters.length - i,
        parsedChapterBatchSize * parsedChapterBatchWriteConcurrency
      ) / parsedChapterBatchSize
    );
    await Promise.all(
      Array.from({ length: batchCount }, (_, batchOffset) => {
        const batchStart = i + batchOffset * parsedChapterBatchSize;
        const batchIndex = Math.floor(batchStart / parsedChapterBatchSize);
        const batch = parsed.chapters
          .slice(batchStart, batchStart + parsedChapterBatchSize)
          .map<StagedImportChapter>((chapter) => ({
            title: chapter.title,
            paragraphs: chapter.paragraphs,
            charCount: chapter.charCount,
            warning: chapter.warning ?? null,
            volumeTitle: chapter.volumeTitle?.trim() || "正文",
            sourceId: chapter.sourceId ?? null,
            sourceHref: chapter.sourceHref ?? null,
          }));
        return bucket.put(
          importChapterBatchKey(job.bookId, jobId, batchIndex),
          JSON.stringify(batch),
          {
            httpMetadata: { contentType: "application/json" },
          }
        );
      })
    );
    const writtenEnd = Math.min(
      parsed.chapters.length,
      i + parsedChapterBatchSize * parsedChapterBatchWriteConcurrency
    );
    for (let writtenIndex = i; writtenIndex < writtenEnd; writtenIndex++) {
      const chapter = parsed.chapters[writtenIndex];
      if (chapter) chapter.paragraphs = [];
    }
  }

  await db.delete(importChapterCandidates).where(eq(importChapterCandidates.jobId, jobId));
  const candidateValues = parsed.chapters.map((chapter, index) => ({
    id: crypto.randomUUID(),
    jobId,
    title: chapter.title,
    startLine: chapter.startLine,
    endLine: chapter.endLine,
    charCount: chapter.charCount,
    warning: chapter.warning ?? null,
    action: "keep" as const,
    sortOrder: index,
  }));
  // 多行 VALUES + db.batch 双层打包：每条 INSERT 9 行（10 列 ≈ 90 个绑定参数，
  // 贴着 D1 单语句上限），每次 batch 50 条语句 = 450 行/往返。5000 章从上千次
  // 子请求压到约 12 次往返。D1 batch 为原子事务，任一条失败整批回滚。
  const rowsPerInsert = 9;
  const insertsPerBatch = 50;
  const insertStatements = [];
  for (let i = 0; i < candidateValues.length; i += rowsPerInsert) {
    insertStatements.push(
      db.insert(importChapterCandidates).values(candidateValues.slice(i, i + rowsPerInsert))
    );
  }
  for (let i = 0; i < insertStatements.length; i += insertsPerBatch) {
    await db.batch(toBatch(insertStatements.slice(i, i + insertsPerBatch)));
  }

  await db
    .update(importJobs)
    .set({
      status: "awaiting_confirmation",
      encoding: parsed.encoding ?? job.encoding,
      reportKey,
      errorCode: null,
      errorMessage: null,
    })
    .where(eq(importJobs.id, jobId));
  console.info("[import] parse:ready", {
    jobId,
    chapters: candidateValues.length,
    elapsedMs: Date.now() - parseStartedAt,
  });
}

export interface ConfirmAction {
  index: number;
  action: "keep" | "ignore";
  title?: string;
}

async function loadImportReport(bucket: R2Bucket, reportKey: string): Promise<ImportReportData> {
  const raw = (await (await bucket.get(reportKey))?.text()) ?? "null";
  const data = JSON.parse(raw) as
    | ImportReportMeta
    | (Omit<ImportReportMeta, "chapters"> & { chapters: LegacyImportReportChapter[] });
  if (!data || !Array.isArray(data.chapters)) {
    throw new Error("解析报告无效");
  }
  const first = data.chapters[0] as unknown;
  if (first && typeof first === "object" && "paragraphs" in first) {
    // 兼容旧格式：报告整体包含正文，仍按整份读取
    return {
      legacyChapters: data.chapters as unknown as LegacyImportReportChapter[],
      legacyWarnings: data.warnings ?? [],
    };
  }
  return { meta: data as ImportReportMeta };
}

export async function enqueueImportCommit(
  db: AppDb,
  bucket: R2Bucket,
  queue: Queue<unknown> | undefined,
  jobId: string,
  userId: string,
  input: ConfirmImportInput = {}
): Promise<{ done: boolean; imported: number; queued: boolean; bookId: string }> {
  const actions = input.actions ?? [];
  const publishMode: ImportPublishMode =
    input.publishMode ?? (input.submitForReview ? "review" : "draft");
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job) throw new Error("导入任务不存在");
  const authorRow = await ensureAuthorProfile(db, userId);
  if (!authorRow) throw new Error("无作者权限");
  const book = await db.select().from(books).where(eq(books.id, job.bookId)).get();
  if (!book || book.authorId !== authorRow.id) throw new Error("无权确认该导入任务");
  if (!job.reportKey) throw new Error("解析报告缺失");
  if (job.status === "completed") {
    return { done: true, imported: job.commitCursor ?? 0, queued: false, bookId: job.bookId };
  }
  if (job.status !== "awaiting_confirmation" && job.status !== "importing") {
    throw new Error(`当前状态（${job.status}）不能确认导入`);
  }
  const reportData = await loadImportReport(bucket, job.reportKey);
  const totalCount = reportData.meta?.chapters.length ?? reportData.legacyChapters?.length ?? 0;
  if (totalCount === 0) throw new Error("解析报告无效");
  const actionByIndex = new Map(actions.map((action) => [action.index, action]));
  const selectedIndices = Array.from({ length: totalCount }, (_, index) => index).filter(
    (index) => actionByIndex.get(index)?.action !== "ignore"
  );
  if (selectedIndices.length === 0) throw new Error("没有可导入的章节");
  const payload: ConfirmImportPayload = {
    actions,
    title: input.title,
    publishMode,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    tags: input.tags,
    serialStatus: input.serialStatus,
    authorName: input.authorName,
    createdBy: userId,
  };
  await bucket.put(importConfirmPayloadKey(job.bookId, jobId), JSON.stringify(payload), {
    httpMetadata: { contentType: "application/json" },
  });
  await db
    .update(importJobs)
    .set({
      status: "importing",
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, jobId));
  const revertStatus = async () => {
    await db
      .update(importJobs)
      .set({ status: "awaiting_confirmation", updatedAt: new Date() })
      .where(eq(importJobs.id, jobId));
  };
  if (queue) {
    try {
      await queue.send(createEnvelope(queueEventTypes.importCommit, jobId, { jobId }, userId));
    } catch {
      await revertStatus();
      throw new Error("导入队列暂不可用，请稍后重试");
    }
  } else {
    await revertStatus();
    throw new Error("导入队列暂不可用，请稍后重试");
  }
  return {
    done: false,
    imported: job.commitCursor ?? 0,
    queued: true,
    bookId: job.bookId,
  };
}

export async function confirmImport(
  db: AppDb,
  bucket: R2Bucket,
  jobId: string,
  userId: string,
  input: ConfirmImportInput = {}
) {
  const actions = input.actions ?? [];
  const publishMode: ImportPublishMode =
    input.publishMode ?? (input.submitForReview ? "review" : "draft");
  const submitForReview = publishMode === "review";
  const directPublish = publishMode === "publish";
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job) throw new Error("导入任务不存在");
  const authorRow = await ensureAuthorProfile(db, userId);
  if (!authorRow) throw new Error("无作者权限");
  const book = await db.select().from(books).where(eq(books.id, job.bookId)).get();
  if (!book || book.authorId !== authorRow.id) throw new Error("无权确认该导入任务");
  if (!job.reportKey) throw new Error("解析报告缺失");

  const reportData = await loadImportReport(bucket, job.reportKey);
  const totalCount = reportData.meta?.chapters.length ?? reportData.legacyChapters?.length ?? 0;
  if (totalCount === 0) throw new Error("解析报告无效");
  const actionByIndex = new Map(actions.map((action) => [action.index, action]));
  const selectedIndices = Array.from({ length: totalCount }, (_, index) => index).filter(
    (index) => actionByIndex.get(index)?.action !== "ignore"
  );
  if (selectedIndices.length === 0) throw new Error("没有可导入的章节");
  // 最后一片已成功但响应在网络上丢失时，客户端会重发；completed 直接回报完成，
  // 不把一次成功导入伪装成失败。
  if (job.status === "completed") {
    return { done: true, imported: selectedIndices.length, bookId: job.bookId };
  }
  if (job.status !== "awaiting_confirmation" && job.status !== "importing") {
    throw new Error(`当前状态（${job.status}）不能确认导入`);
  }

  const volumeTitleForIndex = (index: number) =>
    reportData.meta?.chapters[index]?.volumeTitle?.trim() ||
    reportData.legacyChapters?.[index]?.volumeTitle?.trim() ||
    "正文";
  const titleForIndex = (index: number) =>
    reportData.meta?.chapters[index]?.title?.trim() ||
    reportData.legacyChapters?.[index]?.title?.trim() ||
    `\u7ae0\u8282 ${index + 1}`;
  const defaultVolumeTitle = volumeTitleForIndex(-1);
  const missingContentIndexes = new Set<number>();
  const missingContentWarning =
    "\u7ae0\u8282\u5185\u5bb9\u8bfb\u53d6\u5931\u8d25\uff0c\u5df2\u4fdd\u7559\u7a7a\u767d\u8349\u7a3f\uff0c\u8bf7\u7f16\u8f91\u540e\u8865\u5145\u6b63\u6587";
  const makeMissingContentEntry = (index: number): StagedImportChapter => {
    missingContentIndexes.add(index);
    return recoverStagedImportChapter(undefined, {
      title: titleForIndex(index),
      volumeTitle: volumeTitleForIndex(index),
      warning: missingContentWarning,
    });
  };
  const selectedVolumeTitles = selectedIndices.reduce<string[]>((result, index) => {
    const title = volumeTitleForIndex(index);
    if (!result.includes(title)) result.push(title);
    return result;
  }, []);
  const existingVolumes = await db
    .select()
    .from(volumes)
    .where(eq(volumes.bookId, job.bookId))
    .orderBy(volumes.sortOrder);
  const volumeByTitle = new Map(existingVolumes.map((volume) => [volume.title, volume]));
  let nextVolumeSortOrder =
    existingVolumes.reduce((max, volume) => Math.max(max, volume.sortOrder), -1) + 1;
  for (const [titleIndex, title] of selectedVolumeTitles.entries()) {
    if (volumeByTitle.has(title)) continue;
    const volumeId = `${jobId}-${titleIndex.toString(16).padStart(8, "0")}-03`;
    await db
      .insert(volumes)
      .values({
        id: volumeId,
        bookId: job.bookId,
        title,
        sortOrder: nextVolumeSortOrder,
      })
      .onConflictDoNothing();
    const inserted = await db.select().from(volumes).where(eq(volumes.id, volumeId)).get();
    if (!inserted) throw new Error(`创建卷目录“${title}”失败`);
    nextVolumeSortOrder += 1;
    volumeByTitle.set(title, inserted);
  }

  // 单请求按“章节数 + 正文字数”双阈值切片：短章一次多提交（最多 64 章），
  // 长章自动缩小批次；章节内容并发写 R2，减少大书确认导入的往返次数，
  // 同时避免一章特别肥时又把 Worker 顶到 1102。
  // 章节、版本与审核任务使用由 jobId/sourceIndex 派生的稳定 ID；即使网络超时后
  // 客户端重发，同一片也只会覆盖 R2 并忽略 D1 主键冲突，不会复制章节。
  const cursor = job.commitCursor ?? 0;
  // 追加导入必须接在已有章节之后：以书内当前最大 sortOrder 为基准。
  // 本任务已提交的 cursor 章每章占一个序号，扣除后即任务开始前的基准值，
  // 断点续传时基准保持稳定，不会与已有章节或本任务已导入部分撞号。
  const maxSortRow = await db
    .select({ max: sql<number>`coalesce(max(${chapters.sortOrder}), 0)` })
    .from(chapters)
    .where(eq(chapters.bookId, job.bookId))
    .get();
  const sortBase = Math.max(0, (maxSortRow?.max ?? 0) - cursor);
  if (cursor < selectedIndices.length) {
    const charCountForIndex = (index: number) =>
      reportData.meta?.chapters[index]?.charCount ??
      reportData.legacyChapters?.[index]?.charCount ??
      0;
    const chunkIndices: number[] = [];
    let chunkChars = 0;
    for (const index of selectedIndices.slice(cursor)) {
      const charCount = charCountForIndex(index);
      if (
        chunkIndices.length > 0 &&
        (chunkIndices.length >= commitChunkMaxChapters ||
          chunkChars + charCount > commitChunkTargetChars)
      ) {
        break;
      }
      chunkIndices.push(index);
      chunkChars += charCount;
    }
    const contents = new Map<number, StagedImportChapter>();
    if (reportData.meta) {
      const indicesByBatch = new Map<number, number[]>();
      for (const index of chunkIndices) {
        const batchIndex = Math.floor(index / parsedChapterBatchSize);
        const indices = indicesByBatch.get(batchIndex) ?? [];
        indices.push(index);
        indicesByBatch.set(batchIndex, indices);
      }
      await Promise.all(
        [...indicesByBatch.entries()].map(async ([batchIndex, indices]) => {
          const object = await bucket.get(importChapterBatchKey(job.bookId, jobId, batchIndex));
          const raw = await object?.text();
          if (raw) {
            let batch: StagedImportChapter[] | null = null;
            try {
              batch = JSON.parse(raw) as StagedImportChapter[];
            } catch {
              // 理论上不会缺失；保留兜底，避免单个章节阻塞整批导入。
            }
            for (const index of indices) {
              const entry = batch?.[index % parsedChapterBatchSize];
              contents.set(
                index,
                recoverStagedImportChapter(entry, {
                  title: titleForIndex(index),
                  volumeTitle: volumeTitleForIndex(index),
                  warning: missingContentWarning,
                })
              );
            }
            return;
          }

          // 兼容已解析的旧任务：仍可从每章一个对象的旧存储结构继续导入。
          await Promise.all(
            indices.map(async (index) => {
              const legacyObject = await bucket.get(importChapterKey(job.bookId, jobId, index));
              const legacyRaw = await legacyObject?.text();
              let entry: StagedImportChapter | null = null;
              if (legacyRaw) {
                try {
                  entry = JSON.parse(legacyRaw) as StagedImportChapter;
                } catch {
                  // 旧对象损坏时按内容缺失兜底，避免单个章节阻塞整批导入
                }
              }
              contents.set(
                index,
                recoverStagedImportChapter(entry, {
                  title: titleForIndex(index),
                  volumeTitle: volumeTitleForIndex(index),
                  warning: missingContentWarning,
                })
              );
            })
          );
        })
      );
    } else if (reportData.legacyChapters) {
      for (const index of chunkIndices) {
        const chapter = reportData.legacyChapters[index];
        if (chapter)
          contents.set(index, {
            ...chapter,
            volumeTitle: chapter.volumeTitle || volumeTitleForIndex(index),
          });
      }
    }
    const chapterRows: {
      id: string;
      bookId: string;
      volumeId: string;
      title: string;
      sortOrder: number;
      status: string;
      wordCount: number;
      currentVersionId: string;
      publishedAt: Date | null;
    }[] = [];
    const versionRows: {
      id: string;
      chapterId: string;
      version: number;
      r2Key: string;
      contentHash: string;
      title: string;
      wordCount: number;
      isPublished: boolean;
      createdBy: string;
    }[] = [];
    const reviewRows: {
      id: string;
      bookId: string;
      chapterId: string;
      versionId: string;
      status: string;
    }[] = [];
    // 同一片内的摘要计算与 R2 内容写入互不依赖，并发执行以缩短大书提交时间
    await runWithLimit(chunkIndices, commitContentWriteConcurrency, async (index, i) => {
      const globalIndex = cursor + i;
      const entry = contents.get(index);
      if (!entry) {
        // 理论上不会缺失；保留兜底，避免单个章节阻塞整批导入。
        contents.set(index, makeMissingContentEntry(index));
      }
      const resolvedEntry = contents.get(index);
      if (!resolvedEntry) throw new Error(`章节 ${index + 1} 创建失败`);
      const stableIndex = index.toString(16).padStart(8, "0");
      const chapterId = `${jobId}-${stableIndex}`;
      const versionId = `${jobId}-${stableIndex}-01`;
      const version = 1;
      const chapterTitle = actionByIndex.get(index)?.title?.trim() || resolvedEntry.title;
      const paragraphs = resolvedEntry.paragraphs.map((text, paragraphIndex) => ({
        id: `p${paragraphIndex + 1}`,
        text,
      }));
      const wordCount = resolvedEntry.paragraphs.reduce((sum, p) => sum + p.length, 0);
      const chapterHasMissingContent = resolvedEntry.contentMissing === true;
      const disposition = getImportChapterDisposition(publishMode, chapterHasMissingContent);
      const contentText = JSON.stringify({
        version,
        bookId: job.bookId,
        chapterId,
        title: chapterTitle,
        paragraphs,
        contentHash: "",
        wordCount,
      });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contentText));
      const contentHash = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const key = chapterVersionKey(job.bookId, chapterId, versionId);

      await putChapterContent(bucket, key, {
        version,
        bookId: job.bookId,
        chapterId,
        title: chapterTitle,
        paragraphs,
        contentHash,
        wordCount,
      });
      chapterRows.push({
        id: chapterId,
        bookId: job.bookId,
        volumeId:
          volumeByTitle.get(resolvedEntry.volumeTitle || defaultVolumeTitle)?.id ??
          volumeByTitle.get(defaultVolumeTitle)!.id,
        // 改名按候选章节自身的 index 查，不能用选中序号 globalIndex。
        title: chapterTitle,
        sortOrder: sortBase + globalIndex + 1,
        // 内容缺失的章节保持草稿，作者可以直接打开编辑器补正文。
        status: disposition.status,
        wordCount,
        currentVersionId: versionId,
        publishedAt: disposition.isPublished ? new Date() : null,
      });
      versionRows.push({
        id: versionId,
        chapterId,
        version,
        r2Key: key,
        contentHash,
        title: chapterTitle,
        wordCount,
        isPublished: disposition.isPublished,
        createdBy: userId,
      });
      if (disposition.submitForReview) {
        reviewRows.push({
          id: `${jobId}-${stableIndex}-02`,
          bookId: job.bookId,
          chapterId,
          versionId,
          status: "pending",
        });
      }
    });
    const nextCursor = cursor + chunkIndices.length;
    const writeStatements: BatchItem<"sqlite">[] = [
      // publishedAt 加入后章节 INSERT 为 9 列，按 D1 100 个绑定参数上限切片。
      ...chunkRows(chapterRows, 9).map((rows) =>
        db.insert(chapters).values(rows).onConflictDoNothing()
      ),
      ...chunkRows(versionRows, 9).map((rows) =>
        db.insert(chapterVersions).values(rows).onConflictDoNothing()
      ),
      ...chunkRows(reviewRows, 5).map((rows) =>
        db.insert(reviewTasks).values(rows).onConflictDoNothing()
      ),
      db
        .update(importJobs)
        .set({ commitCursor: nextCursor, updatedAt: new Date() })
        .where(eq(importJobs.id, jobId)),
    ];
    await db.batch(toBatch(writeStatements));
    if (nextCursor < selectedIndices.length) {
      return {
        done: false,
        imported: nextCursor,
        bookId: job.bookId,
        warnings: [...missingContentIndexes].map(
          (index) => `\u7b2c ${index + 1} \u7ae0\uff1a${missingContentWarning}`
        ),
      };
    }
  }

  // 全部章节已提交：先保存上传页选择的作品信息，再汇总字数与最新章节。
  await updateBookMetadata(db, job.bookId, {
    title: input.title,
    categoryId: input.categoryId,
    categoryName: input.categoryName,
    tags: input.tags,
    serialStatus: input.serialStatus,
    authorName: input.authorName,
  });
  const wordCountRow = await db
    .select({ total: sql<number>`coalesce(sum(${chapters.wordCount}), 0)` })
    .from(chapters)
    .where(eq(chapters.bookId, job.bookId))
    .get();
  const lastChapter = await db
    .select({ id: chapters.id, title: chapters.title })
    .from(chapters)
    .where(eq(chapters.bookId, job.bookId))
    .orderBy(desc(chapters.sortOrder))
    .limit(1)
    .get();
  await db.batch(
    toBatch([
      db
        .update(books)
        .set({
          wordCount: wordCountRow?.total ?? book.wordCount,
          latestChapterId: lastChapter?.id ?? book.latestChapterId,
          latestChapterTitle: lastChapter?.title ?? book.latestChapterTitle,
          latestChapterAt: new Date(),
          status: directPublish
            ? "published"
            : submitForReview && book.status === "draft"
              ? "pending_review"
              : book.status,
        })
        .where(eq(books.id, job.bookId)),
      db
        .update(importJobs)
        .set({ status: "completed", commitCursor: null, updatedAt: new Date() })
        .where(eq(importJobs.id, jobId)),
    ])
  );

  return { done: true, imported: selectedIndices.length, bookId: job.bookId };
}

export async function commitImportChunk(
  db: AppDb,
  bucket: R2Bucket,
  queue: Queue<unknown> | undefined,
  jobId: string
): Promise<{ skipped?: boolean; done?: boolean; imported?: number }> {
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job || job.status !== "importing") return { skipped: true };
  const raw = await (await bucket.get(importConfirmPayloadKey(job.bookId, jobId)))?.text();
  if (!raw) throw new Error("确认导入参数缺失，请重新点击确认导入");
  const payload = JSON.parse(raw) as ConfirmImportPayload;
  const result = await confirmImport(db, bucket, jobId, payload.createdBy, {
    actions: payload.actions,
    title: payload.title,
    publishMode: payload.publishMode,
    categoryId: payload.categoryId,
    categoryName: payload.categoryName,
    tags: payload.tags,
    serialStatus: payload.serialStatus,
    authorName: payload.authorName,
  });
  if (!result.done && queue) {
    try {
      await queue.send(
        createEnvelope(queueEventTypes.importCommit, jobId, { jobId }, payload.createdBy)
      );
    } catch {
      // 续片入队失败时保持 importing 状态，由前端轮询检测停滞后重新入队。
      console.warn("[import] commit:requeue failed", { jobId });
    }
  }
  return result;
}

export async function getImportJob(
  db: AppDb,
  bucket: R2Bucket,
  jobId: string,
  options?: { progressOnly?: boolean }
): Promise<ImportJobView> {
  const job = await db.select().from(importJobs).where(eq(importJobs.id, jobId)).get();
  if (!job) throw new Error("导入任务不存在");
  const book = await db
    .select({
      title: books.title,
      authorName: books.authorName,
      categoryId: books.categoryId,
      serialStatus: books.serialStatus,
    })
    .from(books)
    .leftJoin(authors, eq(books.authorId, authors.id))
    .where(eq(books.id, job.bookId))
    .get();
  const tagRows = await db
    .select({ name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(bookTags.tagId, tags.id))
    .where(eq(bookTags.bookId, job.bookId));
  const candidateRows = options?.progressOnly
    ? []
    : await db
        .select()
        .from(importChapterCandidates)
        .where(eq(importChapterCandidates.jobId, jobId));

  let warnings: string[] = [];
  let sourceAuthorName: string | null = null;
  let previews: Record<number, string> = {};
  let volumeTitles: Record<number, string> = {};
  let paragraphCounts: Record<number, number> = {};
  if (!options?.progressOnly && job.reportKey) {
    const reportData = await loadImportReport(bucket, job.reportKey);
    if (reportData.meta) {
      warnings = reportData.meta.warnings;
      sourceAuthorName = reportData.meta.metadata?.author?.trim() || null;
      previews = Object.fromEntries(
        reportData.meta.chapters.map((chapter) => [chapter.index, chapter.preview])
      );
      volumeTitles = Object.fromEntries(
        reportData.meta.chapters.map((chapter) => [chapter.index, chapter.volumeTitle || "正文"])
      );
      paragraphCounts = Object.fromEntries(
        reportData.meta.chapters.map((chapter) => [chapter.index, chapter.paragraphCount])
      );
    } else if (reportData.legacyChapters) {
      warnings = reportData.legacyWarnings ?? [];
      previews = reportData.legacyChapters.reduce<Record<number, string>>((acc, chapter, index) => {
        acc[index] = chapter.paragraphs[0]?.slice(0, 80) ?? "";
        return acc;
      }, {});
      paragraphCounts = reportData.legacyChapters.reduce<Record<number, number>>(
        (acc, chapter, index) => {
          acc[index] = chapter.paragraphs.length;
          return acc;
        },
        {}
      );
    }
  }

  return {
    id: job.id,
    bookId: job.bookId,
    commitCursor: job.commitCursor,
    bookTitle: book?.title ?? "",
    bookAuthorName: book?.authorName ?? "",
    sourceAuthorName,
    bookCategoryId: book?.categoryId ?? null,
    bookSerialStatus: book?.serialStatus === "completed" ? "completed" : "ongoing",
    bookTags: tagRows.map((row) => row.name),
    sourceName: job.sourceName,
    sourceSize: job.sourceSize,
    encoding: job.encoding,
    format: job.sourceName.split(".").pop()?.toLowerCase() ?? "",
    status: job.status,
    reportKey: job.reportKey,
    errorMessage: job.errorMessage,
    candidates: [...candidateRows]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((candidate, index) => ({
        index,
        title: candidate.title,
        volumeTitle: volumeTitles[index] ?? "正文",
        charCount: candidate.charCount,
        paragraphCount: paragraphCounts[index] ?? 0,
        warning: candidate.warning,
        preview: previews[index] ?? "",
      })),
    warnings,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export async function listImportJobs(db: AppDb, bucket: R2Bucket, userId: string, limit = 50) {
  const authorRow = await ensureAuthorProfile(db, userId);
  if (!authorRow) return [];
  const rows = await db
    .select({ id: importJobs.id })
    .from(importJobs)
    .innerJoin(books, eq(importJobs.bookId, books.id))
    .where(and(eq(books.authorId, authorRow.id), ne(importJobs.status, "completed")))
    .orderBy(desc(importJobs.createdAt))
    .limit(limit);
  // 已完成任务不再返回，保证导入成功后从解析列表与待导入池一起消失。
  return Promise.all(rows.map((row) => getImportJob(db, bucket, row.id)));
}
