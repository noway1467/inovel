import type { D1Database, Queue, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  DB_APP: D1Database;
  R2_CONTENT: R2Bucket;
  QUEUE_INGEST: Queue<unknown>;
  QUEUE_JOBS: Queue<unknown>;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  ADMIN_NAME?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
}
