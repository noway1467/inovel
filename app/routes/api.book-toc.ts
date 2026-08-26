import type { Route } from "./+types/api.book-toc";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { getBook, getChapterIdByIndex, listBookTocMinimal } from "~/server/repositories/books";
import { canPreviewUnpublished } from "~/server/security/chapter-access";

/**
 * 阅读页目录 / 跳章接口。目录只在用户点开抽屉时才请求，
 * 避免长篇作品的整份章节表进入每次翻页的 loader 负载。
 *
 * GET ?index=N -> { chapterId }  底部进度条跳章
 * GET          -> { volumes }    目录抽屉
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const bookId = params.bookId ?? "";
  if (!bookId) return Response.json({ error: "bookId required" }, { status: 400 });

  const db = createDb(env.DB_APP);
  const book = await getBook(db, bookId);
  if (!book) return Response.json({ error: "book not found" }, { status: 404 });

  // 与阅读页保持同一套可见性，否则目录里会出现点开就 404 的章节
  const canPreview = await canPreviewUnpublished(db, session.user.id, book.authorId);
  const indexParam = new URL(request.url).searchParams.get("index");

  if (indexParam !== null) {
    const index = Number.parseInt(indexParam, 10);
    if (!Number.isInteger(index) || index < 0) {
      return Response.json({ error: "invalid index" }, { status: 400 });
    }
    const chapterId = await getChapterIdByIndex(db, bookId, index, canPreview);
    if (!chapterId) return Response.json({ error: "chapter not found" }, { status: 404 });
    return Response.json({ chapterId });
  }

  return Response.json({ volumes: await listBookTocMinimal(db, bookId, canPreview) });
}
