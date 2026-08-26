import type { Route } from "./+types/api.creator-imports";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { importJobs } from "drizzle/schema";
import { eq } from "drizzle-orm";
import {
  abortChunkedImport,
  completeChunkedImport,
  createImportJob,
  enqueueImportCommit,
  getImportJob,
  listImportJobs,
  reparseImportJob,
  retryImportParse,
  startChunkedImport,
  uploadChunkPart,
  type ChunkedImportStartInput,
  type ConfirmAction,
  type ImportPublishMode,
} from "~/server/imports/service";
import type { BookSerialStatus } from "~/server/creator/service";
import type { R2UploadedPart } from "@cloudflare/workers-types";

async function requireUser(
  request: Request,
  env: { DB_APP: D1Database; BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string }
) {
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return { user: null, auth };
  }
  return { user: session.user, auth };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const { user } = await requireUser(request, env);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = createDb(env.DB_APP);
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // 路由为 /api/creator/imports/*：只有带实际 jobId 的请求（四段以上）才查单任务，
  // 否则 /api/creator/imports 会被误当成 jobId=imports 返回 404。
  const jobId = segments.length > 3 ? segments[segments.length - 1] : undefined;
  if (jobId) {
    const owned = await db
      .select({ id: importJobs.id, createdBy: importJobs.createdBy })
      .from(importJobs)
      .where(eq(importJobs.id, jobId))
      .get();
    if (!owned || owned.createdBy !== user.id) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const progressOnly = url.searchParams.get("progress") === "1";
    const job = await getImportJob(db, env.R2_CONTENT, jobId, { progressOnly });
    return Response.json({ job });
  }
  return Response.json({ jobs: await listImportJobs(db, env.R2_CONTENT, user.id) });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const { user } = await requireUser(request, env);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const db = createDb(env.DB_APP);
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const chunkedIndex = segments.indexOf("chunked");
  if (chunkedIndex > 0) {
    const chunkedJobId = segments[chunkedIndex + 1];
    const sub = segments.slice(chunkedIndex + 2);
    try {
      if (request.method === "POST" && sub.length === 0) {
        const body = (await request.json()) as ChunkedImportStartInput;
        const started = await startChunkedImport(db, env.R2_CONTENT, user.id, body);
        return Response.json({ ok: true, ...started });
      }
      if (request.method === "PUT" && sub[0] === "part" && chunkedJobId) {
        const partNumber = Number(sub[1]);
        const bytes = new Uint8Array(await request.arrayBuffer());
        const part = await uploadChunkPart(
          db,
          env.R2_CONTENT,
          user.id,
          chunkedJobId,
          partNumber,
          bytes
        );
        return Response.json({ ok: true, part });
      }
      if (request.method === "POST" && sub[0] === "complete" && chunkedJobId) {
        const body = (await request.json()) as { parts?: R2UploadedPart[]; splitChars?: number };
        const job = await completeChunkedImport(
          db,
          env.R2_CONTENT,
          env.QUEUE_INGEST,
          user.id,
          chunkedJobId,
          body.parts ?? [],
          body.splitChars
        );
        return Response.json({ ok: true, job });
      }
      if (request.method === "POST" && sub[0] === "abort" && chunkedJobId) {
        await abortChunkedImport(db, env.R2_CONTENT, user.id, chunkedJobId);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "method not allowed" }, { status: 405 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }
  const confirmIndex = segments.indexOf("confirm");
  const retryIndex = segments.indexOf("retry");
  const reparseIndex = segments.indexOf("reparse");
  if (request.method === "POST" && retryIndex > 0) {
    const retryJobId = segments[retryIndex - 1];
    if (!retryJobId) return Response.json({ error: "job id required" }, { status: 400 });
    try {
      const body = (await request.json().catch(() => ({}))) as { splitChars?: number };
      const job = await retryImportParse(
        db,
        env.R2_CONTENT,
        env.QUEUE_INGEST,
        user.id,
        retryJobId,
        Number.isFinite(body.splitChars) ? body.splitChars : undefined
      );
      return Response.json({ ok: true, job });
    } catch (error) {
      const message = error instanceof Error ? error.message : "重试失败";
      return Response.json({ error: message }, { status: 400 });
    }
  }
  if (request.method === "POST" && reparseIndex > 0) {
    const reparseJobId = segments[reparseIndex - 1];
    if (!reparseJobId) return Response.json({ error: "job id required" }, { status: 400 });
    try {
      const body = (await request.json().catch(() => ({}))) as { splitChars?: number };
      const job = await reparseImportJob(
        db,
        env.R2_CONTENT,
        env.QUEUE_INGEST,
        user.id,
        reparseJobId,
        Number.isFinite(body.splitChars) ? body.splitChars : undefined
      );
      return Response.json({ ok: true, job });
    } catch (error) {
      const message = error instanceof Error ? error.message : "重新划分章节失败";
      return Response.json({ error: message }, { status: 400 });
    }
  }
  const isConfirm = request.method === "POST" && confirmIndex > 0;
  const jobId = isConfirm
    ? segments[confirmIndex - 1]
    : segments.length > 2
      ? segments[segments.length - 1]
      : undefined;

  if (isConfirm) {
    if (!jobId) return Response.json({ error: "job id required" }, { status: 400 });
    try {
      const body = (await request.json()) as {
        actions?: ConfirmAction[];
        title?: string;
        publishMode?: ImportPublishMode;
        submitForReview?: boolean;
        categoryId?: string | null;
        categoryName?: string;
        tags?: string[];
        serialStatus?: BookSerialStatus;
        authorName?: string | null;
      };
      const result = await enqueueImportCommit(
        db,
        env.R2_CONTENT,
        env.QUEUE_INGEST,
        jobId,
        user.id,
        {
          actions: body.actions ?? [],
          title: body.title,
          publishMode: body.publishMode,
          submitForReview: body.submitForReview,
          categoryId: body.categoryId,
          categoryName: body.categoryName,
          tags: body.tags,
          serialStatus: body.serialStatus,
          authorName: body.authorName,
        }
      );
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "确认导入失败";
      return Response.json({ error: message }, { status: 400 });
    }
  }

  if (request.method === "POST") {
    try {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return Response.json({ error: "file required" }, { status: 400 });
      }
      const bookId = (formData.get("bookId") as string | null) ?? undefined;
      const title = (formData.get("title") as string | null) ?? undefined;
      const rawSplit = formData.get("splitChars");
      const splitChars = rawSplit === null || rawSplit === "" ? undefined : Number(rawSplit);
      const job = await createImportJob(db, env.R2_CONTENT, env.QUEUE_INGEST, user.id, {
        bookId,
        title,
        file,
        splitChars: Number.isFinite(splitChars) ? splitChars : undefined,
      });
      return Response.json({ ok: true, job });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 400 });
    }
  }

  return Response.json({ error: "method not allowed" }, { status: 405 });
}
