import { createRequestHandler } from "react-router";
import { createRequestContext } from "~/server/context";
import type { Env } from "~/types/env";
import { createDb } from "~/server/db";
import { handleQueueMessage } from "~/server/queues/handlers";
import { createEnvelope, queueEventTypes, type QueueMessageEnvelope } from "~/server/queues/messages";
import { findDueSources } from "~/server/sources/sync";
import { findDueRepos } from "~/server/sources/repos";

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
        { ingest: env.QUEUE_INGEST, jobs: env.QUEUE_JOBS },
        message.body as QueueMessageEnvelope,
        "web-worker"
      );
      if (result.status === "failed") {
        // 抛错触发队列重试与死信策略
        throw new Error(result.reason);
      }
    }
  },
  /**
   * 在线源自动更新入口。
   * 只做调度：挑出到期的源投队列，真正的抓取在消费者里跑，
   * 避免 Cron 单次执行时长限制拖住整批同步。
   */
  async scheduled(_controller, env) {
    const db = createDb(env.DB_APP);
    const due = await findDueSources(db);
    for (const source of due) {
      await env.QUEUE_JOBS.send(
        createEnvelope(queueEventTypes.sourceSyncSource, source.id, { sourceId: source.id })
      );
    }

    /*
      书源订阅（清单地址）到期也在这里派发。

      同样只投队列不直接跑：重拉一份清单要抓一个上兆的 JSON 再建几百个源，
      放在 Cron 里必然撞执行时长上限。
    */
    const dueRepos = await findDueRepos(db);
    for (const repo of dueRepos) {
      await env.QUEUE_JOBS.send(
        createEnvelope(queueEventTypes.sourceSyncRepo, repo.id, { repoId: repo.id })
      );
    }
  },
} satisfies ExportedHandler<Env>;
