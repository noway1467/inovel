import type { Route } from "./+types/api.source-reading";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import {
  getSourceReadingState,
  recordSourceProgress,
  setSourceShelved,
} from "~/server/services/source-reading";

/**
 * 在线源书籍的书架与阅读进度接口。
 *
 * 与本地书的 /api/library/shelf + /api/reader/progress 对应，只是键不同：
 * 在线源的书不在 books 表里，用 (sourceId, bookUrl) 定位。
 */

interface Payload {
  sourceId?: string;
  bookUrl?: string;
  bookTitle?: string;
  sourceName?: string | null;
  chapterCount?: number | null;
  /** shelve / unshelve / progress */
  action?: string;
  chapterKey?: string;
  chapterTitle?: string | null;
  chapterIndex?: number | null;
  pageIndex?: number | null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const sourceId = url.searchParams.get("sourceId") ?? "";
  const bookUrl = url.searchParams.get("bookUrl") ?? "";
  if (!sourceId || !bookUrl) {
    return Response.json({ error: "sourceId and bookUrl required" }, { status: 400 });
  }

  const db = createDb(env.DB_APP);
  const state = await getSourceReadingState(db, session.user.id, sourceId, bookUrl);
  return Response.json({ state });
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // 容忍畸形 JSON，别抛成 500
  let body: Payload;
  try {
    body = (await request.json()) as Payload;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }

  const sourceId = body.sourceId?.trim() ?? "";
  const bookUrl = body.bookUrl?.trim() ?? "";
  const bookTitle = body.bookTitle?.trim() || "未命名";
  if (!sourceId || !bookUrl) {
    return Response.json({ error: "sourceId and bookUrl required" }, { status: 400 });
  }

  const book = {
    sourceId,
    bookUrl,
    bookTitle,
    sourceName: body.sourceName ?? null,
    chapterCount: body.chapterCount ?? null,
  };
  const db = createDb(env.DB_APP);

  if (body.action === "shelve" || body.action === "unshelve") {
    const shelved = body.action === "shelve";
    await setSourceShelved(db, session.user.id, book, shelved);
    return Response.json({ ok: true, shelved });
  }

  if (body.action === "progress") {
    const chapterKey = body.chapterKey?.trim() ?? "";
    if (!chapterKey) return Response.json({ error: "chapterKey required" }, { status: 400 });
    await recordSourceProgress(db, session.user.id, book, {
      chapterKey,
      chapterTitle: body.chapterTitle ?? null,
      chapterIndex: body.chapterIndex ?? null,
      pageIndex: body.pageIndex ?? 0,
    });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
