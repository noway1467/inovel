import { and, eq, or, sql } from "drizzle-orm";
import type { Queue, R2Bucket } from "@cloudflare/workers-types";
import {
  authors,
  bookStatus,
  books,
  chapterStatus,
  chapterVersions,
  chapters,
  contentSources,
  sourceChapterLinks,
  sourceSubscriptions,
  sourceSyncRuns,
  subscriptionStatus,
  users,
} from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { getAdapter } from "~/server/sources/registry";
import { delay, politeDelayMs } from "~/server/sources/fetch-guard";
import type { SourceChapter, SourceContext } from "~/server/sources/types";
import { putChapterContent } from "~/server/storage/chapter-content";
import { chapterVersionKey } from "~/server/storage/keys";
import { createEnvelope, queueEventTypes } from "~/server/queues/messages";

/**
 * 订阅同步引擎。
 *
 * 增量策略：拉源端目录 → 与 source_chapter_links 已有 externalKey 求差集 →
 * 只对新增项建章并抓正文。目录指纹未变时整本跳过，省掉一次目录请求之外的全部开销。
 *
 * 幂等：source_chapter_links 上 (subscription_id, external_key) 唯一，
 * 队列重投也不会重复建章。
 */

/** 单次同步内最多新建的章节数，防止首次订阅一本千章长书打爆队列 */
const maxNewChaptersPerRun = 50;
/** 单次抓正文的并发上限；源站友好优先，串行 + 固定间隔 */
const contentFetchLimit = 30;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeContext(db: AppDb, source: { endpoint: string; config: unknown }, counter: { count: number }): SourceContext {
  return {
    db,
    endpoint: source.endpoint,
    config: (source.config as Record<string, unknown>) ?? {},
    countRequest: () => {
      counter.count += 1;
    },
  };
}

/**
 * 源导入的书需要一个 author 行（books.author_id 非空）。
 * 每个源建一个"源作者"占位，归属登记该源的运营方；
 * 源端真实作者名写进 books.author_name。
 */
async function ensureSourceAuthor(db: AppDb, sourceId: string, sourceName: string, ownerId: string) {
  const penName = `源：${sourceName}`.slice(0, 60);
  const existing = await db
    .select({ id: authors.id })
    .from(authors)
    .where(and(eq(authors.userId, ownerId), eq(authors.penName, penName)))
    .get();
  if (existing) return existing.id;

  const owner = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).get();
  if (!owner) throw new Error("源的归属用户不存在，无法建立作者占位");

  const id = crypto.randomUUID();
  await db.insert(authors).values({
    id,
    userId: ownerId,
    penName,
    bio: `在线源「${sourceName}」自动同步的作品归集`,
    status: "active",
  });
  return id;
}

export interface SubscribeInput {
  sourceId: string;
  externalId: string;
  title: string;
  author?: string | null;
  description?: string | null;
  rights?: string | null;
  actorId: string;
}

/** 建立订阅：建本地 books 行 + source_subscriptions 行，不立即抓正文。 */
export async function createSubscription(db: AppDb, input: SubscribeInput) {
  const source = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.id, input.sourceId))
    .get();
  if (!source) throw new Error("源不存在");
  if (source.status !== "enabled") {
    throw new Error("源未启用（域名可能还未获授权确认），无法订阅");
  }

  const existing = await db
    .select({ id: sourceSubscriptions.id })
    .from(sourceSubscriptions)
    .where(
      and(
        eq(sourceSubscriptions.sourceId, input.sourceId),
        eq(sourceSubscriptions.externalId, input.externalId)
      )
    )
    .get();
  if (existing) return { subscriptionId: existing.id, created: false };

  const ownerId = source.createdBy ?? input.actorId;
  const authorId = await ensureSourceAuthor(db, source.id, source.name, ownerId);

  const bookId = crypto.randomUUID();
  await db.insert(books).values({
    id: bookId,
    authorId,
    title: input.title.slice(0, 120),
    slug: `${Date.now()}-${input.title.slice(0, 24)}`,
    authorName: input.author?.slice(0, 60) ?? null,
    description: input.description?.slice(0, 2000) ?? null,
    // 源导入内容默认不公开，需运营方过审后再发布
    status: bookStatus.draft,
    copyrightNotice: input.rights ?? source.attribution ?? `来源：${source.name}`,
  });

  const subscriptionId = crypto.randomUUID();
  await db.insert(sourceSubscriptions).values({
    id: subscriptionId,
    sourceId: input.sourceId,
    bookId,
    externalId: input.externalId,
    externalTitle: input.title.slice(0, 120),
    createdBy: input.actorId,
  });

  return { subscriptionId, created: true, bookId };
}

export interface SyncOutcome {
  status: "ok" | "skipped" | "failed";
  chaptersAdded: number;
  requestCount: number;
  message: string;
}

/**
 * 同步单个订阅的目录，把新增章节登记为 pending。
 * 正文抓取交给队列，避免长书把一次请求拖爆。
 */
export async function syncSubscriptionToc(
  db: AppDb,
  queue: Queue<unknown> | undefined,
  subscriptionId: string,
  trigger: "cron" | "manual"
): Promise<SyncOutcome> {
  const subscription = await db
    .select()
    .from(sourceSubscriptions)
    .where(eq(sourceSubscriptions.id, subscriptionId))
    .get();
  if (!subscription) return { status: "failed", chaptersAdded: 0, requestCount: 0, message: "订阅不存在" };

  const source = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.id, subscription.sourceId))
    .get();
  if (!source) return { status: "failed", chaptersAdded: 0, requestCount: 0, message: "源不存在" };
  if (source.status !== "enabled") {
    return { status: "skipped", chaptersAdded: 0, requestCount: 0, message: "源未启用" };
  }
  if (subscription.status === subscriptionStatus.paused) {
    return { status: "skipped", chaptersAdded: 0, requestCount: 0, message: "订阅已暂停" };
  }

  const counter = { count: 0 };
  const runId = crypto.randomUUID();
  await db.insert(sourceSyncRuns).values({
    id: runId,
    sourceId: source.id,
    subscriptionId,
    trigger,
    status: "running",
  });

  const finish = async (outcome: SyncOutcome) => {
    await db
      .update(sourceSyncRuns)
      .set({
        status: outcome.status,
        chaptersAdded: outcome.chaptersAdded,
        booksChecked: 1,
        requestCount: outcome.requestCount,
        message: outcome.message.slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(sourceSyncRuns.id, runId));
    return outcome;
  };

  try {
    const adapter = getAdapter(source.kind);
    const ctx = makeContext(db, source, counter);
    const remote = await adapter.listChapters(ctx, { externalId: subscription.externalId });

    // 目录指纹未变则整本跳过
    const fingerprint = await sha256Hex(remote.map((c) => c.externalKey).join("\n"));
    if (fingerprint === subscription.tocFingerprint) {
      await db
        .update(sourceSubscriptions)
        .set({ lastSyncAt: new Date(), lastError: null, consecutiveFailures: 0, updatedAt: new Date() })
        .where(eq(sourceSubscriptions.id, subscriptionId));
      return finish({
        status: "skipped",
        chaptersAdded: 0,
        requestCount: counter.count,
        message: "目录未变化",
      });
    }

    const known = await db
      .select({ externalKey: sourceChapterLinks.externalKey })
      .from(sourceChapterLinks)
      .where(eq(sourceChapterLinks.subscriptionId, subscriptionId))
      .all();
    const knownKeys = new Set(known.map((row) => row.externalKey));

    const fresh: { chapter: SourceChapter; sortOrder: number }[] = [];
    remote.forEach((chapter, index) => {
      if (knownKeys.has(chapter.externalKey)) return;
      fresh.push({ chapter, sortOrder: index + 1 });
    });

    const batch = fresh.slice(0, maxNewChaptersPerRun);
    if (batch.length > 0) {
      // 目录阶段就带正文的源（RSS）直接标 fetched 前先落链接行，
      // 正文仍由队列统一写入，保证 R2 与 D1 的写入路径只有一条
      await db
        .insert(sourceChapterLinks)
        .values(
          batch.map(({ chapter, sortOrder }) => ({
            id: crypto.randomUUID(),
            subscriptionId,
            externalKey: chapter.externalKey,
            externalTitle: chapter.title.slice(0, 200),
            sortOrder,
            fetchStatus: "pending",
          }))
        )
        .onConflictDoNothing();
    }

    await db
      .update(sourceSubscriptions)
      .set({
        tocFingerprint: fingerprint,
        lastSyncAt: new Date(),
        lastError: null,
        consecutiveFailures: 0,
        status: subscriptionStatus.active,
        updatedAt: new Date(),
      })
      .where(eq(sourceSubscriptions.id, subscriptionId));

    if (queue && batch.length > 0) {
      await queue.send(
        createEnvelope(queueEventTypes.sourceFetchChapters, subscriptionId, { subscriptionId })
      );
    }

    const remaining = fresh.length - batch.length;
    return finish({
      status: "ok",
      chaptersAdded: batch.length,
      requestCount: counter.count,
      message: remaining > 0
        ? `新增 ${batch.length} 章，剩余 ${remaining} 章将在下次同步继续`
        : `新增 ${batch.length} 章`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(sourceSubscriptions)
      .set({
        lastSyncAt: new Date(),
        lastError: message.slice(0, 500),
        consecutiveFailures: sql`${sourceSubscriptions.consecutiveFailures} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(sourceSubscriptions.id, subscriptionId));
    return finish({ status: "failed", chaptersAdded: 0, requestCount: counter.count, message });
  }
}

/**
 * 抓取某订阅下所有 pending 章节的正文，写 R2 + chapters/chapter_versions。
 * 逐章串行并留出礼貌间隔，不把源站打挂。
 */
export async function fetchPendingChapters(
  db: AppDb,
  bucket: R2Bucket,
  subscriptionId: string
): Promise<{ fetched: number; failed: number; requestCount: number }> {
  const subscription = await db
    .select()
    .from(sourceSubscriptions)
    .where(eq(sourceSubscriptions.id, subscriptionId))
    .get();
  if (!subscription) throw new Error("订阅不存在");

  const source = await db
    .select()
    .from(contentSources)
    .where(eq(contentSources.id, subscription.sourceId))
    .get();
  if (!source) throw new Error("源不存在");
  if (source.status !== "enabled") return { fetched: 0, failed: 0, requestCount: 0 };

  const pending = await db
    .select()
    .from(sourceChapterLinks)
    .where(
      and(
        eq(sourceChapterLinks.subscriptionId, subscriptionId),
        eq(sourceChapterLinks.fetchStatus, "pending")
      )
    )
    .limit(contentFetchLimit)
    .all();
  if (pending.length === 0) return { fetched: 0, failed: 0, requestCount: 0 };

  const adapter = getAdapter(source.kind);
  const counter = { count: 0 };
  const ctx = makeContext(db, source, counter);

  /**
   * 部分源（RSS/Atom）在目录里就带了全文。先取一次目录建立
   * externalKey → 正文 的映射，命中的章节就不必再逐个回源：
   * 一次目录请求换掉 N 次正文请求，对源站也更友好。
   * 目录取不到时不算失败，退回逐章抓取。
   */
  const inlineByKey = new Map<string, string[]>();
  try {
    const toc = await adapter.listChapters(ctx, { externalId: subscription.externalId });
    for (const item of toc) {
      if (item.inlineParagraphs?.length) {
        inlineByKey.set(item.externalKey, item.inlineParagraphs);
      }
    }
  } catch {
    // 目录暂时不可用不影响逐章抓取
  }

  let fetched = 0;
  let failed = 0;
  let latestTitle: string | null = null;

  for (const [index, link] of pending.entries()) {
    const inline = inlineByKey.get(link.externalKey);
    // 用 inline 正文时没有出站请求，不需要礼貌间隔
    if (index > 0 && !inline) await delay(politeDelayMs);
    try {
      const { paragraphs } = inline
        ? { paragraphs: inline }
        : await adapter.fetchChapter(ctx, { externalKey: link.externalKey });

      // 章节 id 由订阅 id + 序号推导，重投时同一链接always落到同一章
      const stableIndex = link.sortOrder.toString(16).padStart(8, "0");
      const chapterId = `${subscriptionId}-${stableIndex}`;
      const versionId = `${chapterId}-01`;
      const wordCount = paragraphs.reduce((sum, p) => sum + p.length, 0);
      const docParagraphs = paragraphs.map((text, i) => ({ id: `p${i + 1}`, text }));

      const contentHash = await sha256Hex(
        JSON.stringify({
          version: 1,
          bookId: subscription.bookId,
          chapterId,
          title: link.externalTitle,
          paragraphs: docParagraphs,
          contentHash: "",
          wordCount,
        })
      );
      const key = chapterVersionKey(subscription.bookId, chapterId, versionId);
      await putChapterContent(bucket, key, {
        version: 1,
        bookId: subscription.bookId,
        chapterId,
        title: link.externalTitle,
        paragraphs: docParagraphs,
        contentHash,
        wordCount,
      });

      await db.batch([
        db
          .insert(chapters)
          .values({
            id: chapterId,
            bookId: subscription.bookId,
            title: link.externalTitle,
            sortOrder: link.sortOrder,
            // 源同步内容一律先落草稿，由运营方决定是否发布
            status: chapterStatus.draft,
            wordCount,
            currentVersionId: versionId,
          })
          .onConflictDoNothing(),
        db
          .insert(chapterVersions)
          .values({
            id: versionId,
            chapterId,
            version: 1,
            r2Key: key,
            contentHash,
            title: link.externalTitle,
            wordCount,
            isPublished: false,
          })
          .onConflictDoNothing(),
        db
          .update(sourceChapterLinks)
          .set({ chapterId, fetchStatus: "fetched", fetchError: null, updatedAt: new Date() })
          .where(eq(sourceChapterLinks.id, link.id)),
      ]);
      fetched += 1;
      latestTitle = link.externalTitle;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(sourceChapterLinks)
        .set({ fetchStatus: "failed", fetchError: message.slice(0, 500), updatedAt: new Date() })
        .where(eq(sourceChapterLinks.id, link.id));
      failed += 1;
    }
  }

  if (fetched > 0) {
    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(sourceChapterLinks)
      .where(
        and(
          eq(sourceChapterLinks.subscriptionId, subscriptionId),
          eq(sourceChapterLinks.fetchStatus, "fetched")
        )
      )
      .get();
    await db
      .update(sourceSubscriptions)
      .set({ syncedChapterCount: Number(total?.count ?? 0), updatedAt: new Date() })
      .where(eq(sourceSubscriptions.id, subscriptionId));
    if (latestTitle) {
      await db
        .update(books)
        .set({ latestChapterTitle: latestTitle, latestChapterAt: new Date(), updatedAt: new Date() })
        .where(eq(books.id, subscription.bookId));
    }
  }

  return { fetched, failed, requestCount: counter.count };
}

/** 找出到期该同步的源（按 sync_interval_minutes），供 Cron 调度。 */
export async function findDueSources(db: AppDb, now = new Date()) {
  const rows = await db
    .select({
      id: contentSources.id,
      name: contentSources.name,
      lastSyncAt: contentSources.lastSyncAt,
      syncIntervalMinutes: contentSources.syncIntervalMinutes,
    })
    .from(contentSources)
    .where(eq(contentSources.status, "enabled"))
    .all();

  return rows.filter((row) => {
    if (!row.lastSyncAt) return true;
    const dueAt = row.lastSyncAt.getTime() + row.syncIntervalMinutes * 60_000;
    return dueAt <= now.getTime();
  });
}

/** 同步一个源下的全部活跃订阅。 */
export async function syncSource(
  db: AppDb,
  queue: Queue<unknown> | undefined,
  sourceId: string,
  trigger: "cron" | "manual"
): Promise<{ booksChecked: number; chaptersAdded: number }> {
  const subs = await db
    .select({ id: sourceSubscriptions.id })
    .from(sourceSubscriptions)
    .where(
      and(
        eq(sourceSubscriptions.sourceId, sourceId),
        or(
          eq(sourceSubscriptions.status, subscriptionStatus.active),
          eq(sourceSubscriptions.status, subscriptionStatus.stale)
        )
      )
    )
    .all();

  let chaptersAdded = 0;
  let failures = 0;
  for (const [index, sub] of subs.entries()) {
    if (index > 0) await delay(politeDelayMs);
    const outcome = await syncSubscriptionToc(db, queue, sub.id, trigger);
    chaptersAdded += outcome.chaptersAdded;
    if (outcome.status === "failed") failures += 1;
  }

  await db
    .update(contentSources)
    .set({
      lastSyncAt: new Date(),
      lastSyncStatus: failures === 0 ? "ok" : "partial",
      lastSyncMessage:
        failures === 0
          ? `检查 ${subs.length} 本，新增 ${chaptersAdded} 章`
          : `检查 ${subs.length} 本，${failures} 本失败，新增 ${chaptersAdded} 章`,
      consecutiveFailures: failures > 0 && subs.length > 0 && failures === subs.length
        ? sql`${contentSources.consecutiveFailures} + 1`
        : 0,
      updatedAt: new Date(),
    })
    .where(eq(contentSources.id, sourceId));

  return { booksChecked: subs.length, chaptersAdded };
}
