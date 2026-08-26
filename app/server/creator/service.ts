import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
  authors,
  bookTags,
  bookmarks,
  books,
  categories,
  chapters,
  chapterVersions,
  importChapterCandidates,
  importJobs,
  notifications,
  readingHistory,
  readingProgress,
  recommendationItems,
  reviewTasks,
  shelfItems,
  tags,
  users,
  volumes,
} from "drizzle/schema";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { AppDb } from "~/server/db";
import { getChapterContent, putChapterContent } from "~/server/storage/chapter-content";
import { chapterVersionKey } from "~/server/storage/keys";
import { ensureAuthorProfile } from "~/server/creator/profile";

// 大书一次性更新几千行容易把 Worker 顶到 1102，批量提交/发布按小片推进。
const submitAllBatchSize = 20;
const publishAllBatchSize = 20;

export interface ChapterEditView {
  id: string;
  bookId: string;
  bookTitle: string;
  volumeId: string | null;
  title: string;
  status: string;
  wordCount: number;
  version: number;
  paragraphs: { id: string; text: string }[];
}

async function authorOf(db: AppDb, userId: string) {
  return ensureAuthorProfile(db, userId);
}

// D1 db.batch 要求非空元组 [U, ...U[]]，运行时数组需显式转成元组
function toBatchStatements<T extends BatchItem<"sqlite">>(items: T[]): [T, ...T[]] {
  return items as [T, ...T[]];
}

interface ReviewNotifyGroup {
  bookId: string;
  chapterCount: number;
  /** 仅 1 章时用于给出精确文案与直达链接 */
  singleChapterId?: string;
  singleChapterTitle?: string;
}

/**
 * 审核结果通知：一本书一次决策只发一条。
 *
 * 原来是「一个审核任务一条通知」，管理员对千章大书一键通过会瞬间灌进上千条，
 * 通知中心直接不可用（线上已累积 2 万余条）。这里按书聚合，只有单章时才保留
 * 章节标题和直达链接。
 */
async function notifyReviewDecision(
  db: AppDb,
  groups: ReviewNotifyGroup[],
  decision: "approve" | "reject",
  reason?: string
) {
  const usable = groups.filter((group) => group.chapterCount > 0);
  if (usable.length === 0) return;

  const bookRows = await db
    .select({
      bookId: books.id,
      bookTitle: books.title,
      userId: authors.userId,
    })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .where(inArray(books.id, [...new Set(usable.map((group) => group.bookId))]));
  const bookById = new Map(bookRows.map((row) => [row.bookId, row]));

  const now = new Date();
  const values = usable.flatMap((group) => {
    const book = bookById.get(group.bookId);
    if (!book) return [];

    const single = group.chapterCount === 1 && group.singleChapterTitle;
    const approved = decision === "approve";
    const scope = single ? group.singleChapterTitle : `${group.chapterCount} 章`;

    return [
      {
        id: crypto.randomUUID(),
        userId: book.userId,
        type: "review_result",
        title: approved ? "章节已通过审核" : "章节被退回",
        body: approved
          ? `《${book.bookTitle}》${scope}已通过审核并发布。`
          : `《${book.bookTitle}》${scope}被退回：${reason ?? ""}`,
        link:
          single && group.singleChapterId
            ? `/creator/books/${group.bookId}/chapters/${group.singleChapterId}`
            : `/creator/books/${group.bookId}`,
        // 同一本书同一秒的同类决策只留一条
        dedupKey: `review-batch:${group.bookId}:${decision}:${now.getTime()}`,
        createdAt: now,
      },
    ];
  });

  if (values.length === 0) return;
  await db.insert(notifications).values(values).onConflictDoNothing();
}

async function getOwnedChapter(db: AppDb, chapterId: string, userId: string) {
  const author = await authorOf(db, userId);
  if (!author) return null;
  const chapter = await db
    .select({
      id: chapters.id,
      bookId: chapters.bookId,
      volumeId: chapters.volumeId,
      title: chapters.title,
      status: chapters.status,
      sortOrder: chapters.sortOrder,
      wordCount: chapters.wordCount,
      currentVersionId: chapters.currentVersionId,
      bookTitle: books.title,
      bookAuthorId: books.authorId,
    })
    .from(chapters)
    .innerJoin(books, eq(chapters.bookId, books.id))
    .where(eq(chapters.id, chapterId))
    .get();
  if (!chapter || chapter.bookAuthorId !== author.id) return null;
  return chapter;
}

export async function getChapterForEdit(
  db: AppDb,
  bucket: R2Bucket,
  chapterId: string,
  userId: string
) {
  const chapter = await getOwnedChapter(db, chapterId, userId);
  if (!chapter) return null;

  let paragraphs: { id: string; text: string }[] = [];
  let version = 1;
  if (chapter.currentVersionId) {
    const content = await getChapterContent(
      bucket,
      chapterVersionKey(chapter.bookId, chapterId, chapter.currentVersionId)
    );
    if (content) {
      paragraphs = content.paragraphs;
      version = content.version;
    }
  }

  return {
    id: chapter.id,
    bookId: chapter.bookId,
    bookTitle: chapter.bookTitle,
    volumeId: chapter.volumeId,
    title: chapter.title,
    status: chapter.status,
    wordCount: chapter.wordCount,
    version,
    paragraphs,
  } satisfies ChapterEditView;
}

export async function saveChapterDraft(
  db: AppDb,
  bucket: R2Bucket,
  chapterId: string,
  userId: string,
  input: { title: string; paragraphs: string[] }
): Promise<ChapterEditView | null> {
  const chapter = await getOwnedChapter(db, chapterId, userId);
  if (!chapter) return null;
  if (chapter.status === "pending_review" || chapter.status === "scheduled") {
    throw new Error(`当前状态（${chapter.status}）不允许编辑`);
  }

  const title = input.title.trim();
  if (!title) throw new Error("章节标题不能为空");
  const paragraphs = input.paragraphs
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (paragraphs.length === 0) throw new Error("正文不能为空");

  const maxVersionRow = await db
    .select({ version: chapterVersions.version })
    .from(chapterVersions)
    .where(eq(chapterVersions.chapterId, chapterId))
    .orderBy(desc(chapterVersions.version))
    .limit(1)
    .get();
  const version = (maxVersionRow?.version ?? 0) + 1;
  const versionId = crypto.randomUUID();
  const normalizedParagraphs = paragraphs.map((text, index) => ({ id: `p${index + 1}`, text }));
  const wordCount = paragraphs.reduce((sum, text) => sum + text.length, 0);
  const contentText = JSON.stringify({
    version,
    bookId: chapter.bookId,
    chapterId,
    title,
    paragraphs: normalizedParagraphs,
    contentHash: "",
    wordCount,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contentText));
  const contentHash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = chapterVersionKey(chapter.bookId, chapterId, versionId);

  await putChapterContent(bucket, key, {
    version,
    bookId: chapter.bookId,
    chapterId,
    title,
    paragraphs: normalizedParagraphs,
    contentHash,
    wordCount,
  });
  await db.insert(chapterVersions).values({
    id: versionId,
    chapterId,
    version,
    r2Key: key,
    contentHash,
    title,
    wordCount,
    isPublished: chapter.status === "published",
    createdBy: userId,
  });
  const now = new Date();
  await db
    .update(chapters)
    .set({
      title,
      currentVersionId: versionId,
      wordCount,
      status: chapter.status === "rejected" ? "draft" : chapter.status,
      rejectedReason: null,
      updatedAt: now,
    })
    .where(eq(chapters.id, chapterId));

  const stats = await db
    .select({ total: sql<number>`coalesce(sum(${chapters.wordCount}), 0)` })
    .from(chapters)
    .where(and(eq(chapters.bookId, chapter.bookId), sql`${chapters.deletedAt} IS NULL`))
    .get();
  const latest = await db
    .select({ id: chapters.id, title: chapters.title })
    .from(chapters)
    .where(and(eq(chapters.bookId, chapter.bookId), sql`${chapters.deletedAt} IS NULL`))
    .orderBy(desc(chapters.sortOrder))
    .limit(1)
    .get();
  await db
    .update(books)
    .set({
      wordCount: stats?.total ?? 0,
      latestChapterId: latest?.id ?? null,
      latestChapterTitle: latest?.title ?? null,
      latestChapterAt: now,
    })
    .where(eq(books.id, chapter.bookId));

  return {
    id: chapter.id,
    bookId: chapter.bookId,
    bookTitle: chapter.bookTitle,
    volumeId: chapter.volumeId,
    title,
    status: chapter.status === "rejected" ? "draft" : chapter.status,
    wordCount,
    version,
    paragraphs: normalizedParagraphs,
  };
}

export async function submitChapterForReview(db: AppDb, chapterId: string, userId: string) {
  const chapter = await getOwnedChapter(db, chapterId, userId);
  if (!chapter) return null;
  if (chapter.status !== "draft" && chapter.status !== "rejected") {
    throw new Error(`当前状态（${chapter.status}）不能提交审核`);
  }
  if (!chapter.currentVersionId) throw new Error("章节还没有正文");

  const updated = await db
    .update(chapters)
    .set({ status: "pending_review", updatedAt: new Date() })
    .where(and(eq(chapters.id, chapterId), eq(chapters.status, chapter.status)))
    .returning()
    .get();
  if (!updated) throw new Error("提交审核失败，请刷新后重试");

  await db.insert(reviewTasks).values({
    id: crypto.randomUUID(),
    bookId: chapter.bookId,
    chapterId,
    versionId: chapter.currentVersionId,
    status: "pending",
  });
  return { id: chapter.id, status: "pending_review" };
}

export async function unpublishChapter(db: AppDb, chapterId: string, userId: string) {
  const chapter = await getOwnedChapter(db, chapterId, userId);
  if (!chapter) return null;
  if (chapter.status !== "published") throw new Error("仅已发布章节可下架");
  await db
    .update(chapters)
    .set({ status: "draft", publishedAt: null, updatedAt: new Date() })
    .where(eq(chapters.id, chapterId));
  return { id: chapterId, status: "draft" };
}

export async function deleteChapter(db: AppDb, chapterId: string, userId: string) {
  const chapter = await getOwnedChapter(db, chapterId, userId);
  if (!chapter) return null;
  await db
    .update(readingProgress)
    .set({ chapterId: null, paragraphAnchor: null, charOffset: 0, chapterProgress: 0 })
    .where(eq(readingProgress.chapterId, chapterId));
  await db.delete(readingHistory).where(eq(readingHistory.chapterId, chapterId));
  await db.delete(bookmarks).where(eq(bookmarks.chapterId, chapterId));
  await db.delete(reviewTasks).where(eq(reviewTasks.chapterId, chapterId));
  await db.delete(chapterVersions).where(eq(chapterVersions.chapterId, chapterId));
  await db.delete(chapters).where(eq(chapters.id, chapterId));
  const stats = await db
    .select({ total: sql<number>`coalesce(sum(${chapters.wordCount}), 0)` })
    .from(chapters)
    .where(and(eq(chapters.bookId, chapter.bookId), sql`${chapters.deletedAt} IS NULL`))
    .get();
  const latest = await db
    .select({ id: chapters.id, title: chapters.title })
    .from(chapters)
    .where(and(eq(chapters.bookId, chapter.bookId), sql`${chapters.deletedAt} IS NULL`))
    .orderBy(desc(chapters.sortOrder))
    .limit(1)
    .get();
  await db
    .update(books)
    .set({
      wordCount: stats?.total ?? 0,
      latestChapterId: latest?.id ?? null,
      latestChapterTitle: latest?.title ?? null,
      latestChapterAt: latest ? new Date() : null,
    })
    .where(eq(books.id, chapter.bookId));
  return { ok: true };
}

export type BookSerialStatus = "ongoing" | "completed";

export interface BookMetadataInput {
  title?: string;
  categoryId?: string | null;
  categoryName?: string;
  tags?: string[];
  serialStatus?: BookSerialStatus;
  authorName?: string | null;
}

/**
 * 统一保存作品分类、标签与连载状态。上传确认和作品编辑共用这一条路径，
 * 避免两个入口各写一套校验，久了必然长成两只不一样的小怪兽。
 */
export async function updateBookMetadata(db: AppDb, bookId: string, input: BookMetadataInput) {
  const updates: {
    title?: string;
    categoryId?: string | null;
    serialStatus?: BookSerialStatus;
    authorName?: string | null;
    updatedAt: Date;
  } = {
    updatedAt: new Date(),
  };
  let shouldUpdateBook = false;

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new Error("书名不能为空");
    if (title.length > 120) throw new Error("书名不能超过 120 字");
    updates.title = title;
    shouldUpdateBook = true;
  }

  const categoryName = input.categoryName?.trim();
  if (categoryName) {
    if (categoryName.length > 20) throw new Error("分类名称不能超过 20 个字");
    let category = await db
      .select({ id: categories.id, enabled: categories.enabled })
      .from(categories)
      .where(eq(categories.name, categoryName))
      .get();
    if (!category) {
      category = await db
        .insert(categories)
        .values({
          id: crypto.randomUUID(),
          name: categoryName,
          slug: `custom-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
          enabled: true,
          sortOrder: 999,
        })
        .returning({ id: categories.id, enabled: categories.enabled })
        .get();
    } else if (!category.enabled) {
      await db
        .update(categories)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(categories.id, category.id));
    }
    updates.categoryId = category.id;
    shouldUpdateBook = true;
  } else if (input.categoryId !== undefined) {
    if (input.categoryId) {
      const category = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.id, input.categoryId), eq(categories.enabled, true)))
        .get();
      if (!category) throw new Error("所选分类不存在或已停用");
    }
    updates.categoryId = input.categoryId || null;
    shouldUpdateBook = true;
  }

  if (input.serialStatus !== undefined) {
    if (!(["ongoing", "completed"] as const).includes(input.serialStatus)) {
      throw new Error("连载状态无效");
    }
    updates.serialStatus = input.serialStatus;
    shouldUpdateBook = true;
  }

  if (input.authorName !== undefined) {
    const authorName = input.authorName?.trim() || null;
    if (authorName && authorName.length > 30) throw new Error("作者名不能超过 30 个字");
    updates.authorName = authorName;
    shouldUpdateBook = true;
  }

  if (shouldUpdateBook) {
    await db.update(books).set(updates).where(eq(books.id, bookId));
  }

  if (input.tags === undefined) return;

  const tagNames = [
    ...new Set(
      input.tags
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => name.slice(0, 30))
    ),
  ].slice(0, 10);
  await db.delete(bookTags).where(eq(bookTags.bookId, bookId));
  if (tagNames.length === 0) return;

  const normalized = tagNames.map((name) => name.toLocaleLowerCase("zh-CN"));
  const existing = await db
    .select({ normalized: tags.normalized })
    .from(tags)
    .where(inArray(tags.normalized, normalized));
  const existingSet = new Set(existing.map((row) => row.normalized));
  const missing = tagNames.filter((name) => !existingSet.has(name.toLocaleLowerCase("zh-CN")));
  if (missing.length > 0) {
    await db
      .insert(tags)
      .values(
        missing.map((name) => ({
          id: crypto.randomUUID(),
          name,
          normalized: name.toLocaleLowerCase("zh-CN"),
          enabled: true,
        }))
      )
      .onConflictDoNothing();
  }
  await db.update(tags).set({ enabled: true }).where(inArray(tags.normalized, normalized));
  const allTags = await db
    .select({ id: tags.id })
    .from(tags)
    .where(inArray(tags.normalized, normalized));
  if (allTags.length > 0) {
    await db
      .insert(bookTags)
      .values(allTags.map((row) => ({ bookId, tagId: row.id })))
      .onConflictDoNothing();
  }
}

export async function toggleBookPublication(db: AppDb, bookId: string, userId: string) {
  const author = await ensureAuthorProfile(db, userId);
  if (!author) throw new Error("无作者权限");
  const book = await db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book || book.authorId !== author.id) throw new Error("无权操作该作品");
  if (book.status === "published") {
    await db
      .update(books)
      .set({ status: "suspended", updatedAt: new Date() })
      .where(eq(books.id, bookId));
    return { status: "suspended" };
  }
  if (book.status === "suspended") {
    await db
      .update(books)
      .set({ status: "published", updatedAt: new Date() })
      .where(eq(books.id, bookId));
    return { status: "published" };
  }
  throw new Error("只有已发布或已下架的作品可以切换显示状态");
}

export async function publishChapterDirectly(db: AppDb, chapterId: string, userId: string) {
  const chapter = await getOwnedChapter(db, chapterId, userId);
  if (!chapter) return null;
  if (!chapter.currentVersionId) throw new Error("\u7ae0\u8282\u8fd8\u6ca1\u6709\u6b63\u6587");

  const now = new Date();
  await db.batch(
    toBatchStatements([
      db
        .update(chapters)
        .set({
          status: "published",
          publishedAt: now,
          rejectedReason: null,
          updatedAt: now,
        })
        .where(eq(chapters.id, chapterId)),
      db
        .update(chapterVersions)
        .set({ isPublished: true })
        .where(eq(chapterVersions.id, chapter.currentVersionId)),
      db
        .update(reviewTasks)
        .set({
          status: "approved",
          decision: "approved",
          reason: "\u4f5c\u8005\u9009\u62e9\u76f4\u63a5\u53d1\u5e03",
          decidedBy: userId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(reviewTasks.chapterId, chapterId), eq(reviewTasks.status, "pending"))),
      db
        .update(books)
        .set({ status: "published", updatedAt: now })
        .where(eq(books.id, chapter.bookId)),
    ])
  );
  return { id: chapterId, status: "published" as const };
}

export async function publishAllChaptersDirectly(db: AppDb, bookId: string, userId: string) {
  const author = await ensureAuthorProfile(db, userId);
  if (!author) throw new Error("\u65e0\u4f5c\u8005\u6743\u9650");
  const book = await db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book || book.authorId !== author.id)
    throw new Error("\u65e0\u6743\u64cd\u4f5c\u8be5\u4f5c\u54c1");

  const now = new Date();
  let published = 0;
  while (true) {
    const batch = await db
      .select({ id: chapters.id, versionId: chapters.currentVersionId })
      .from(chapters)
      .where(
        and(
          eq(chapters.bookId, bookId),
          inArray(chapters.status, ["draft", "rejected", "pending_review"]),
          sql`${chapters.currentVersionId} IS NOT NULL`,
          sql`${chapters.deletedAt} IS NULL`
        )
      )
      .limit(publishAllBatchSize);
    if (batch.length === 0) break;
    const ids = batch.map((chapter) => chapter.id);
    const versionIds = batch
      .map((chapter) => chapter.versionId)
      .filter((versionId): versionId is string => versionId !== null);
    const results = await db.batch(
      toBatchStatements([
        db
          .update(chapterVersions)
          .set({ isPublished: true })
          .where(inArray(chapterVersions.id, versionIds)),
        db
          .update(chapters)
          .set({
            status: "published",
            publishedAt: now,
            rejectedReason: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(chapters.bookId, bookId),
              inArray(chapters.id, ids),
              inArray(chapters.status, ["draft", "rejected", "pending_review"])
            )
          ),
        db
          .update(reviewTasks)
          .set({
            status: "approved",
            decision: "approved",
            reason: "\u4f5c\u8005\u9009\u62e9\u76f4\u63a5\u53d1\u5e03",
            decidedBy: userId,
            decidedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(reviewTasks.bookId, bookId),
              inArray(reviewTasks.chapterId, ids),
              eq(reviewTasks.status, "pending")
            )
          ),
      ])
    );
    published += results[1]?.meta.changes ?? 0;
  }
  await db.update(books).set({ status: "published", updatedAt: now }).where(eq(books.id, bookId));
  return { published, status: "published" as const };
}

export async function submitAllChaptersForReview(db: AppDb, bookId: string, userId: string) {
  const author = await ensureAuthorProfile(db, userId);
  if (!author) throw new Error("无作者权限");
  const book = await db.select().from(books).where(eq(books.id, bookId)).get();
  if (!book || book.authorId !== author.id) throw new Error("无权操作该作品");

  const now = new Date();
  let submitted = 0;
  while (true) {
    const batch = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(
        and(
          eq(chapters.bookId, bookId),
          inArray(chapters.status, ["draft", "rejected"]),
          sql`${chapters.currentVersionId} IS NOT NULL`,
          sql`${chapters.deletedAt} IS NULL`,
          sql`NOT EXISTS (
            SELECT 1 FROM review_tasks rt
            WHERE rt.chapter_id = chapters.id AND rt.status = 'pending'
          )`
        )
      )
      .limit(submitAllBatchSize);
    if (batch.length === 0) break;
    const ids = batch.map((chapter) => chapter.id);
    const updateResult = await db
      .update(chapters)
      .set({ status: "pending_review", updatedAt: now })
      .where(
        and(
          eq(chapters.bookId, bookId),
          inArray(chapters.id, ids),
          inArray(chapters.status, ["draft", "rejected"])
        )
      )
      .run();
    await db.run(sql`
      INSERT INTO review_tasks (id, book_id, chapter_id, version_id, status, created_at, updated_at)
      SELECT lower(hex(randomblob(16))), c.book_id, c.id, c.current_version_id, 'pending',
             cast(strftime('%s','now') as integer) * 1000,
             cast(strftime('%s','now') as integer) * 1000
      FROM chapters c
      WHERE c.book_id = ${bookId}
        AND c.id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `
        )})
        AND c.status = 'pending_review'
        AND c.current_version_id IS NOT NULL
        AND c.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM review_tasks rt
          WHERE rt.chapter_id = c.id AND rt.status = 'pending'
        )
    `);
    submitted += updateResult.meta.changes ?? 0;
  }
  return { submitted };
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteBookPermanently(db: AppDb, bucket: R2Bucket, bookId: string) {
  // R2 不参与 D1 事务，所以先做幂等前缀清理；失败时保留数据库记录，用户可以安全重试。
  await deleteR2Prefix(bucket, `books/${bookId}/`);
  await deleteR2Prefix(bucket, `covers/${bookId}/`);
  // 按外键依赖顺序显式删除子表；db.batch 原子执行，避免中途失败留下半删的书。
  await db.batch([
    db.delete(reviewTasks).where(eq(reviewTasks.bookId, bookId)),
    db.delete(bookTags).where(eq(bookTags.bookId, bookId)),
    db.delete(readingHistory).where(eq(readingHistory.bookId, bookId)),
    db.delete(readingProgress).where(eq(readingProgress.bookId, bookId)),
    db.delete(shelfItems).where(eq(shelfItems.bookId, bookId)),
    db.delete(bookmarks).where(eq(bookmarks.bookId, bookId)),
    db.delete(recommendationItems).where(eq(recommendationItems.bookId, bookId)),
    db
      .delete(importChapterCandidates)
      .where(
        sql`${importChapterCandidates.jobId} IN (SELECT id FROM import_jobs WHERE book_id = ${bookId})`
      ),
    db.delete(importJobs).where(eq(importJobs.bookId, bookId)),
    db
      .delete(chapterVersions)
      .where(
        sql`${chapterVersions.chapterId} IN (SELECT id FROM chapters WHERE book_id = ${bookId})`
      ),
    db.delete(chapters).where(eq(chapters.bookId, bookId)),
    db.delete(volumes).where(eq(volumes.bookId, bookId)),
    db.delete(books).where(eq(books.id, bookId)),
  ]);
  return { ok: true };
}

export interface ModerationDecision {
  decision: "approve" | "reject";
  reason?: string;
}

/**
 * 待审任务按作品聚合的摘要。审核台首屏只加载每本书的待审数量，
 * 展开某本书时再按需拉取该书的任务列表，避免一次性把上千条任务
 * 序列化进 loader 载荷造成页面卡顿。
 */
export async function listPendingReviewBookGroups(db: AppDb) {
  return db
    .select({
      bookId: reviewTasks.bookId,
      bookTitle: books.title,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
      pendingCount: sql<number>`count(*)`,
      latestCreatedAt: sql<number>`max(${reviewTasks.createdAt})`,
    })
    .from(reviewTasks)
    .innerJoin(books, eq(reviewTasks.bookId, books.id))
    .innerJoin(authors, eq(books.authorId, authors.id))
    .where(eq(reviewTasks.status, "pending"))
    .groupBy(reviewTasks.bookId, books.title, books.authorName, authors.penName)
    .orderBy(desc(sql`max(${reviewTasks.createdAt})`))
    .limit(200);
}

export async function listPendingReviewTasksForBook(db: AppDb, bookId: string, limit = 500) {
  return db
    .select({
      id: reviewTasks.id,
      bookId: reviewTasks.bookId,
      chapterId: reviewTasks.chapterId,
      versionId: reviewTasks.versionId,
      status: reviewTasks.status,
      createdAt: reviewTasks.createdAt,
      chapterTitle: chapters.title,
    })
    .from(reviewTasks)
    .innerJoin(chapters, eq(reviewTasks.chapterId, chapters.id))
    .where(and(eq(reviewTasks.bookId, bookId), eq(reviewTasks.status, "pending")))
    .orderBy(chapters.sortOrder)
    .limit(limit);
}

export async function listPendingReviewTasks(db: AppDb, limit = 500) {
  return db
    .select({
      id: reviewTasks.id,
      bookId: reviewTasks.bookId,
      chapterId: reviewTasks.chapterId,
      versionId: reviewTasks.versionId,
      status: reviewTasks.status,
      createdAt: reviewTasks.createdAt,
      bookTitle: books.title,
      chapterTitle: chapters.title,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
    })
    .from(reviewTasks)
    .innerJoin(books, eq(reviewTasks.bookId, books.id))
    .innerJoin(chapters, eq(reviewTasks.chapterId, chapters.id))
    .innerJoin(authors, eq(books.authorId, authors.id))
    .where(eq(reviewTasks.status, "pending"))
    .orderBy(desc(reviewTasks.createdAt))
    .limit(limit);
}

// 每片 90 条：inArray 与通知 SQL 各占 90 个绑定参数，贴着 D1 单语句约 100 个参数的上限
export const maxBatchReviewTasks = 90;
// 单次请求最多处理的任务总量，按 90 条一片顺序执行
export const maxBatchReviewTotal = 900;

export async function decideReviewTasksBatch(
  db: AppDb,
  bucket: R2Bucket,
  adminUserId: string,
  input: ModerationDecision & { taskIds?: string[]; bookId?: string }
) {
  if (input.bookId) {
    const processed = await applyReviewDecisionByBook(db, input.bookId, adminUserId, input);
    return { processed, errors: [] };
  }
  const unique = [...new Set(input.taskIds ?? [])];
  if (unique.length === 0) throw new Error("请选择要处理的审核任务");
  if (unique.length > maxBatchReviewTotal) {
    throw new Error(`单次最多批量处理 ${maxBatchReviewTotal} 条，请分批操作`);
  }
  let processed = 0;
  // 跨分片累计每本书的处理量，最后按书各发一条通知
  const totalByBook = new Map<string, number>();
  const firstChapterByBook = new Map<string, string>();
  for (let i = 0; i < unique.length; i += maxBatchReviewTasks) {
    const result = await applyReviewDecisionChunk(
      db,
      bucket,
      unique.slice(i, i + maxBatchReviewTasks),
      adminUserId,
      input
    );
    processed += result.processed;
    for (const [bookId, count] of result.countByBook) {
      totalByBook.set(bookId, (totalByBook.get(bookId) ?? 0) + count);
      const chapterId = result.firstChapterByBook.get(bookId);
      if (chapterId && !firstChapterByBook.has(bookId)) {
        firstChapterByBook.set(bookId, chapterId);
      }
    }
  }

  if (totalByBook.size > 0) {
    const groups: ReviewNotifyGroup[] = [];
    for (const [bookId, chapterCount] of totalByBook) {
      const group: ReviewNotifyGroup = { bookId, chapterCount };
      if (chapterCount === 1) {
        const chapterId = firstChapterByBook.get(bookId);
        if (chapterId) {
          const chapter = await db
            .select({ title: chapters.title })
            .from(chapters)
            .where(eq(chapters.id, chapterId))
            .get();
          group.singleChapterId = chapterId;
          group.singleChapterTitle = chapter?.title;
        }
      }
      groups.push(group);
    }
    await notifyReviewDecision(db, groups, input.decision, input.reason);
  }

  return { processed, errors: [] };
}

async function applyReviewDecisionByBook(
  db: AppDb,
  bookId: string,
  adminUserId: string,
  input: ModerationDecision
): Promise<number> {
  const pendingCount = await db
    .select({ n: sql<number>`count(*)` })
    .from(reviewTasks)
    .where(and(eq(reviewTasks.bookId, bookId), eq(reviewTasks.status, "pending")))
    .get();
  const processed = pendingCount?.n ?? 0;
  if (processed === 0) return 0;

  // 只有一章时多查一次，让通知能给出章节名和直达链接；多章就聚合成一条
  const singleChapterHint =
    processed === 1
      ? await db
          .select({ singleChapterId: chapters.id, singleChapterTitle: chapters.title })
          .from(reviewTasks)
          .innerJoin(chapters, eq(chapters.id, reviewTasks.chapterId))
          .where(and(eq(reviewTasks.bookId, bookId), eq(reviewTasks.status, "pending")))
          .get()
      : undefined;

  const now = new Date();
  if (input.decision === "approve") {
    await db
      .update(reviewTasks)
      .set({
        status: "approved",
        decision: "approve",
        reason: null,
        decidedBy: adminUserId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(reviewTasks.bookId, bookId), eq(reviewTasks.status, "pending")));
    await db
      .update(chapters)
      .set({ status: "published", publishedAt: now, rejectedReason: null, updatedAt: now })
      .where(and(eq(chapters.bookId, bookId), eq(chapters.status, "pending_review")));
    await db
      .update(chapterVersions)
      .set({ isPublished: true })
      .where(
        sql`${chapterVersions.id} IN (SELECT version_id FROM review_tasks WHERE book_id = ${bookId} AND status = 'approved' AND decided_at = ${now.getTime()})`
      );
    await db
      .update(books)
      .set({
        latestChapterId: sql`(SELECT c.id FROM chapters c WHERE c.book_id = ${bookId} AND c.deleted_at IS NULL ORDER BY c.sort_order DESC LIMIT 1)`,
        latestChapterTitle: sql`(SELECT c.title FROM chapters c WHERE c.book_id = ${bookId} AND c.deleted_at IS NULL ORDER BY c.sort_order DESC LIMIT 1)`,
        latestChapterAt: now,
        status: sql`CASE WHEN ${books.status} IN ('pending_review','draft') THEN 'published' ELSE ${books.status} END`,
      })
      .where(eq(books.id, bookId));
    await notifyReviewDecision(
      db,
      [{ bookId, chapterCount: processed, ...singleChapterHint }],
      "approve"
    );
  } else {
    const reason = input.reason?.trim();
    if (!reason) throw new Error("退回必须填写原因");
    await db
      .update(reviewTasks)
      .set({
        status: "rejected",
        decision: "reject",
        reason,
        decidedBy: adminUserId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(reviewTasks.bookId, bookId), eq(reviewTasks.status, "pending")));
    await db
      .update(chapters)
      .set({ status: "rejected", rejectedReason: reason, updatedAt: now })
      .where(and(eq(chapters.bookId, bookId), eq(chapters.status, "pending_review")));
    await notifyReviewDecision(
      db,
      [{ bookId, chapterCount: processed, ...singleChapterHint }],
      "reject",
      reason
    );
  }
  return processed;
}

async function applyReviewDecisionChunk(
  db: AppDb,
  bucket: R2Bucket,
  taskIds: string[],
  adminUserId: string,
  input: ModerationDecision
): Promise<{
  processed: number;
  errors: [];
  countByBook: Map<string, number>;
  firstChapterByBook: Map<string, string>;
}> {
  const empty = {
    processed: 0,
    errors: [] as [],
    countByBook: new Map<string, number>(),
    firstChapterByBook: new Map<string, string>(),
  };
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return empty;
  const pending = await db
    .select({
      id: reviewTasks.id,
      bookId: reviewTasks.bookId,
      chapterId: reviewTasks.chapterId,
      versionId: reviewTasks.versionId,
    })
    .from(reviewTasks)
    .where(and(inArray(reviewTasks.id, unique), eq(reviewTasks.status, "pending")));
  if (pending.length === 0) return empty;

  const ids = pending.map((row) => row.id);
  const chapterIds = pending.map((row) => row.chapterId);
  const versionIds = pending.map((row) => row.versionId);
  const bookIds = [...new Set(pending.map((row) => row.bookId))];
  const now = new Date();

  if (input.decision === "approve") {
    await db
      .update(reviewTasks)
      .set({
        status: "approved",
        decision: "approve",
        reason: null,
        decidedBy: adminUserId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(inArray(reviewTasks.id, ids), eq(reviewTasks.status, "pending")));
    await db
      .update(chapters)
      .set({ status: "published", publishedAt: now, rejectedReason: null, updatedAt: now })
      .where(and(inArray(chapters.id, chapterIds), eq(chapters.status, "pending_review")));
    await db
      .update(chapterVersions)
      .set({ isPublished: true })
      .where(inArray(chapterVersions.id, versionIds));
    // 各书的最新章节回填合并为一次 db.batch，替代逐本书串行 UPDATE 的 N+1
    await db.batch(
      toBatchStatements(
        bookIds.map((bookId) =>
          db
            .update(books)
            .set({
              latestChapterId: sql`(SELECT c.id FROM chapters c WHERE c.book_id = ${bookId} AND c.deleted_at IS NULL ORDER BY c.sort_order DESC LIMIT 1)`,
              latestChapterTitle: sql`(SELECT c.title FROM chapters c WHERE c.book_id = ${bookId} AND c.deleted_at IS NULL ORDER BY c.sort_order DESC LIMIT 1)`,
              latestChapterAt: now,
              status: sql`CASE WHEN ${books.status} IN ('pending_review','draft') THEN 'published' ELSE ${books.status} END`,
            })
            .where(eq(books.id, bookId))
        )
      )
    );
    // 通知不在这里发：本函数按 90 条一片被反复调用，
    // 逐片发会把「一次批量」拆成多条。改由调用方汇总后统一发一次。
  } else {
    const reason = input.reason?.trim();
    if (!reason) throw new Error("退回必须填写原因");
    await db
      .update(reviewTasks)
      .set({
        status: "rejected",
        decision: "reject",
        reason,
        decidedBy: adminUserId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(inArray(reviewTasks.id, ids), eq(reviewTasks.status, "pending")));
    await db
      .update(chapters)
      .set({ status: "rejected", rejectedReason: reason, updatedAt: now })
      .where(and(inArray(chapters.id, chapterIds), eq(chapters.status, "pending_review")));
    // 同上：通知交给调用方汇总
  }

  // 回报本片各书处理量，供调用方按书聚合通知
  const countByBook = new Map<string, number>();
  for (const row of pending) {
    countByBook.set(row.bookId, (countByBook.get(row.bookId) ?? 0) + 1);
  }
  return {
    processed: pending.length,
    errors: [],
    countByBook,
    firstChapterByBook: new Map(pending.map((row) => [row.bookId, row.chapterId])),
  };
}

export async function getReviewTask(db: AppDb, bucket: R2Bucket, taskId: string) {
  const task = await db
    .select({
      id: reviewTasks.id,
      bookId: reviewTasks.bookId,
      chapterId: reviewTasks.chapterId,
      versionId: reviewTasks.versionId,
      status: reviewTasks.status,
      createdAt: reviewTasks.createdAt,
      bookTitle: books.title,
      chapterTitle: chapters.title,
      chapterStatus: chapters.status,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
      authorEmail: users.email,
    })
    .from(reviewTasks)
    .innerJoin(books, eq(reviewTasks.bookId, books.id))
    .innerJoin(chapters, eq(reviewTasks.chapterId, chapters.id))
    .innerJoin(authors, eq(books.authorId, authors.id))
    .innerJoin(users, eq(authors.userId, users.id))
    .where(eq(reviewTasks.id, taskId))
    .get();
  if (!task) return null;

  const version = await db
    .select()
    .from(chapterVersions)
    .where(eq(chapterVersions.id, task.versionId))
    .get();
  const content = version
    ? await getChapterContent(bucket, chapterVersionKey(task.bookId, task.chapterId, version.id))
    : null;
  return { ...task, content };
}

export async function decideReviewTask(
  db: AppDb,
  bucket: R2Bucket,
  taskId: string,
  adminUserId: string,
  input: ModerationDecision
) {
  const task = await db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId)).get();
  if (!task) throw new Error("审核任务不存在");
  if (task.status !== "pending") throw new Error(`任务已处理（${task.status}）`);
  if (input.decision === "reject" && !input.reason?.trim()) {
    throw new Error("退回必须填写原因");
  }

  const chapter = await db.select().from(chapters).where(eq(chapters.id, task.chapterId)).get();
  if (!chapter || chapter.status !== "pending_review") {
    // 章节已被删除或状态漂移（不再是待审）：自动关闭任务，避免它永远挂在待审列表里
    const now = new Date();
    await db
      .update(reviewTasks)
      .set({
        status: "rejected",
        decision: "reject",
        reason: "章节状态已变化，任务自动关闭",
        decidedBy: adminUserId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(reviewTasks.id, taskId), eq(reviewTasks.status, "pending")));
    return { ok: true, decision: "closed" as const };
  }

  const now = new Date();
  await db
    .update(reviewTasks)
    .set({
      status: input.decision === "approve" ? "approved" : "rejected",
      decision: input.decision,
      reason: input.reason ?? null,
      decidedBy: adminUserId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(and(eq(reviewTasks.id, taskId), eq(reviewTasks.status, "pending")));

  if (input.decision === "approve") {
    const published = await db
      .update(chapters)
      .set({ status: "published", publishedAt: now, rejectedReason: null, updatedAt: now })
      .where(and(eq(chapters.id, task.chapterId), eq(chapters.status, "pending_review")))
      .returning()
      .get();
    await db
      .update(chapterVersions)
      .set({ isPublished: true })
      .where(eq(chapterVersions.id, task.versionId));
    if (published) {
      await db
        .update(books)
        .set({
          latestChapterId: published.id,
          latestChapterTitle: published.title,
          latestChapterAt: now,
          status: sql`CASE WHEN ${books.status} IN ('pending_review','draft') THEN 'published' ELSE ${books.status} END`,
        })
        .where(eq(books.id, task.bookId));
    }
  } else {
    await db
      .update(chapters)
      .set({ status: "rejected", rejectedReason: input.reason ?? "", updatedAt: now })
      .where(and(eq(chapters.id, task.chapterId), eq(chapters.status, "pending_review")));
  }

  const authorRow = await db
    .select({ userId: authors.userId })
    .from(authors)
    .innerJoin(books, eq(books.authorId, authors.id))
    .where(eq(books.id, task.bookId))
    .get();
  if (authorRow) {
    await db
      .insert(notifications)
      .values({
        id: crypto.randomUUID(),
        userId: authorRow.userId,
        type: "review_result",
        title: input.decision === "approve" ? "章节已通过审核" : "章节被退回",
        body:
          input.decision === "approve"
            ? `${chapter.title} 已发布。`
            : `${chapter.title}：${input.reason ?? ""}`,
        link: `/creator/books/${task.bookId}/chapters/${task.chapterId}`,
        dedupKey: `review:${task.id}`,
      })
      .onConflictDoNothing();
  }

  return { ok: true, decision: input.decision };
}
