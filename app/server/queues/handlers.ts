import type { Queue, R2Bucket } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { importJobs } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { commitImportChunk, parseImportJob } from "~/server/imports/service";
import { claimEvent, markEventFailed } from "~/server/queues/idempotency";
import { createEnvelope, queueEventTypes, type QueueMessageEnvelope } from "~/server/queues/messages";
import { syncRepo } from "~/server/sources/repos";
import { fetchPendingChapters, syncSource } from "~/server/sources/sync";

export interface QueueHandlerResult {
  status: "processed" | "skipped" | "failed";
  reason?: string;
}

export interface QueueBindings {
  /** 分片导入的续投队列，IMPORT_COMMIT 自己接自己 */
  ingest: Queue<unknown> | undefined;
  /** 在线源同步队列 */
  jobs: Queue<unknown> | undefined;
}

export async function handleQueueMessage(
  db: AppDb,
  bucket: R2Bucket,
  queues: QueueBindings,
  message: QueueMessageEnvelope,
  handlerName: string
): Promise<QueueHandlerResult> {
  const claim = await claimEvent(db, message.eventId, handlerName);
  if (claim === "duplicate") {
    return { status: "skipped", reason: "duplicate eventId" };
  }

  try {
    switch (message.eventType) {
      case "SEARCH_REINDEX_BOOK":
        // FTS 表由 migration 中的 SQLite trigger 自动维护；此处仅做幂等确认
        break;
      case "NOTIFY_REVIEW_RESULT":
      case "NOTIFY_BOOK_UPDATED":
      case "PUBLISH_SCHEDULED_CHAPTER":
      case "AGGREGATE_RANKING":
      case "CLEANUP_ORPHAN_OBJECTS":
        // 后续垂直链路接入真实处理；第一阶段保留统一外壳与幂等占位
        break;
      case "IMPORT_COMMIT": {
        const payload = message.payload as { jobId?: string } | undefined;
        if (!payload?.jobId) throw new Error("IMPORT_COMMIT payload.jobId 缺失");
        await commitImportChunk(db, bucket, queues.ingest, payload.jobId);
        break;
      }
      case "IMPORT_PARSE": {
        const payload = message.payload as
          | { jobId?: string; splitChars?: number; forceSplitByChars?: boolean }
          | undefined;
        if (!payload?.jobId) throw new Error("IMPORT_PARSE payload.jobId 缺失");
        await parseImportJob(db, bucket, payload.jobId, {
          splitChars: payload.splitChars,
          forceSplitByChars: payload.forceSplitByChars,
        });
        break;
      }
      case "SOURCE_SYNC_SOURCE": {
        const payload = message.payload as { sourceId?: string } | undefined;
        if (!payload?.sourceId) throw new Error("SOURCE_SYNC_SOURCE payload.sourceId 缺失");
        await syncSource(db, queues.jobs, payload.sourceId, "cron");
        break;
      }
      case "SOURCE_SYNC_REPO": {
        const payload = message.payload as { repoId?: string } | undefined;
        if (!payload?.repoId) throw new Error("SOURCE_SYNC_REPO payload.repoId 缺失");
        /*
          失败不抛错：syncRepo 自己把失败记进 source_repos（含连续失败次数，
          用于退避）。往外抛会触发队列重试，等于对一个已经失效的清单地址
          连撞几次 —— 记账已经完成，重试没有意义。
        */
        await syncRepo(db, payload.repoId, message.actorId ?? "cron");
        break;
      }
      case "SOURCE_FETCH_CHAPTERS": {
        const payload = message.payload as { subscriptionId?: string } | undefined;
        if (!payload?.subscriptionId) {
          throw new Error("SOURCE_FETCH_CHAPTERS payload.subscriptionId 缺失");
        }
        const result = await fetchPendingChapters(db, bucket, payload.subscriptionId);
        // 还有剩余待抓时继续投递，把长书拆成多轮，避免单次执行超时
        if (result.fetched > 0 && queues.jobs) {
          await queues.jobs.send(
            createEnvelope(queueEventTypes.sourceFetchChapters, payload.subscriptionId, {
              subscriptionId: payload.subscriptionId,
            })
          );
        }
        break;
      }
      default:
        throw new Error(`unknown event type: ${message.eventType}`);
    }
    return { status: "processed" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (message.eventType === "IMPORT_PARSE" || message.eventType === "IMPORT_COMMIT") {
      const payload = message.payload as { jobId?: string } | undefined;
      if (payload?.jobId) {
        const isCommit = message.eventType === "IMPORT_COMMIT";
        await db
          .update(importJobs)
          .set({
            status: isCommit ? "awaiting_confirmation" : "failed",
            errorCode: isCommit ? "COMMIT_FAILED" : "PARSE_FAILED",
            errorMessage: reason.slice(0, 500),
            updatedAt: new Date(),
          })
          .where(eq(importJobs.id, payload.jobId));
      }
    }
    await markEventFailed(db, message.eventId, handlerName, reason);
    return { status: "failed", reason };
  }
}
