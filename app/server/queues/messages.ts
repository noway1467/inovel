export const queueEventTypes = {
  importParse: "IMPORT_PARSE",
  importCommit: "IMPORT_COMMIT",
  searchReindexBook: "SEARCH_REINDEX_BOOK",
  notifyReviewResult: "NOTIFY_REVIEW_RESULT",
  notifyBookUpdated: "NOTIFY_BOOK_UPDATED",
  publishScheduledChapter: "PUBLISH_SCHEDULED_CHAPTER",
  aggregateRanking: "AGGREGATE_RANKING",
  cleanupOrphanObjects: "CLEANUP_ORPHAN_OBJECTS",
  /** 同步一个在线源下的全部订阅（拉目录、登记新章） */
  sourceSyncSource: "SOURCE_SYNC_SOURCE",
  /** 重拉一份书源清单（订阅地址），建新源并升级已有源 */
  sourceSyncRepo: "SOURCE_SYNC_REPO",
  /** 抓取某订阅下待取正文的章节 */
  sourceFetchChapters: "SOURCE_FETCH_CHAPTERS",
} as const;

export type QueueEventType = (typeof queueEventTypes)[keyof typeof queueEventTypes];

export interface QueueMessageEnvelope<T = unknown> {
  eventId: string;
  eventType: QueueEventType;
  schemaVersion: number;
  aggregateId: string;
  occurredAt: string;
  actorId?: string | null;
  traceId: string;
  payload: T;
}

export function newEventId() {
  return crypto.randomUUID();
}

export function createEnvelope<T>(eventType: QueueEventType, aggregateId: string, payload: T, actorId?: string): QueueMessageEnvelope<T> {
  return {
    eventId: newEventId(),
    eventType,
    schemaVersion: 1,
    aggregateId,
    occurredAt: new Date().toISOString(),
    actorId,
    traceId: crypto.randomUUID(),
    payload,
  };
}

