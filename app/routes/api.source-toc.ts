import type { Route } from "./+types/api.source-toc";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { decodeSourceRef } from "~/lib/source-ref";
import { getLiveToc } from "~/server/sources/live-read";

/**
 * 在线源阅读页的目录抽屉接口。
 *
 * 为什么要单独一条：目录原先跟在章节 loader 的返回里，一千九百章的书每翻
 * 一页就要把整份章节表重新序列化一遍塞进 turbo-stream —— 光这一项就够让
 * Worker 撞上 1102。本地阅读器早就是按需取（api.book-toc.ts），这里对齐。
 *
 * GET ?book=<编码后的书页地址> -> { chapters: [{ title, key }] }
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const sourceId = params.sourceId ?? "";
  if (!sourceId) return Response.json({ error: "sourceId required" }, { status: 400 });

  // 参数是编码后的 token，与阅读页同一套编解码，见 lib/source-ref
  const bookUrl = decodeSourceRef(new URL(request.url).searchParams.get("book") ?? "");
  if (!bookUrl) return Response.json({ error: "book required" }, { status: 400 });

  const db = createDb(env.DB_APP);
  try {
    const toc = await getLiveToc(db, env.R2_CONTENT, sourceId, bookUrl);
    return Response.json({ chapters: toc.chapters });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "目录抓取失败" },
      { status: 502 }
    );
  }
}
