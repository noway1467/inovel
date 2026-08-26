import { createRequestHandler } from "react-router";
import { createRequestContext } from "~/server/context";
import type { Env } from "~/types/env";
import { createDb } from "~/server/db";
import { handleQueueMessage } from "~/server/queues/handlers";
import type { QueueMessageEnvelope } from "~/server/queues/messages";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

export default {
  fetch(request, env, ctx) {
    return requestHandler(request, createRequestContext({ env, ctx }));
  },
  async queue(batch, env) {
    const db = createDb(env.DB_APP);
    for (const message of batch.messages) {
      const result = await handleQueueMessage(
        db,
        env.R2_CONTENT,
        env.QUEUE_INGEST,
        message.body as QueueMessageEnvelope,
        "web-worker"
      );
      if (result.status === "failed") {
        // 抛错触发队列重试与死信策略
        throw new Error(result.reason);
      }
    }
  },
} satisfies ExportedHandler<Env>;
