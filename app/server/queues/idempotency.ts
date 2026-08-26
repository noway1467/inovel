import { eq, and } from "drizzle-orm";
import { jobDedup } from "drizzle/schema";
import type { AppDb } from "~/server/db";

/**
 * Queues 为 at-least-once 投递：消费前先占位，重复消息直接跳过。
 */
export async function claimEvent(db: AppDb, eventId: string, handler: string): Promise<"claimed" | "duplicate"> {
  const result = await db
    .insert(jobDedup)
    .values({ id: crypto.randomUUID(), eventId, handler })
    .onConflictDoNothing()
    .returning({ id: jobDedup.id });
  return result.length > 0 ? "claimed" : "duplicate";
}

export async function markEventFailed(db: AppDb, eventId: string, handler: string, errorMessage: string) {
  await db
    .update(jobDedup)
    .set({ status: `failed:${errorMessage.slice(0, 200)}` })
    .where(and(eq(jobDedup.eventId, eventId), eq(jobDedup.handler, handler)));
}

