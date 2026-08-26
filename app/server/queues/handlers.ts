import type { Queue, R2Bucket } from "@cloudflare/workers-types";
import { eq } from "drizzle-orm";
import { importJobs } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { commitImportChunk, parseImportJob } from "~/server/imports/service";
import { claimEvent, markEventFailed } from "~/server/queues/idempotency";
import type { QueueMessageEnvelope } from "~/server/queues/messages";

export interface QueueHandlerResult {
  status: "processed" | "skipped" | "failed";
  reason?: string;
}

export async function handleQueueMessage(
  db: AppDb,
  bucket: R2Bucket,
  queue: Queue<unknown> | undefined,
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
        await commitImportChunk(db, bucket, queue, payload.jobId);
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
