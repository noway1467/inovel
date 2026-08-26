import { Link } from "react-router";
import { BookOpen, FileUp, FolderOpen } from "lucide-react";
import type { Route } from "./+types/creator";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { books } from "drizzle/schema";
import { desc, eq } from "drizzle-orm";
import { ensureAuthorProfile } from "~/server/creator/profile";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, author: null, books: [] };

  const db = createDb(env.DB_APP);
  const author = await ensureAuthorProfile(db, session.user.id);
  if (!author) return { user: session.user, author: null, books: [] };
  const bookRows = await db
    .select({
      id: books.id,
      title: books.title,
      status: books.status,
      wordCount: books.wordCount,
      latestChapterTitle: books.latestChapterTitle,
      updatedAt: books.updatedAt,
    })
    .from(books)
    .where(eq(books.authorId, author.id))
    .orderBy(desc(books.updatedAt))
    .limit(50);
  return { user: session.user, author, books: bookRows };
}

function statusText(status: string) {
  const map: Record<string, string> = {
    draft: "草稿",
    pending_review: "审核中",
    approved: "已通过",
    published: "已发布",
    suspended: "已下架",
    archived: "已归档",
  };
  return map[status] ?? status;
}

export default function CreatorPage({ loaderData }: Route.ComponentProps) {
  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="登录后进入作者工作台"
          description="创建作品、导入小说、管理章节。"
          action={
            <Button asChild>
              <Link to="/login?redirect=/creator">去登录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!loaderData.author) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="需要作者权限"
          description="作品发布与编辑仅向作者开放，请联系管理员为账号添加作者角色。"
          action={
            <Button variant="outline" asChild>
              <Link to="/library">返回书架</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">我的作品</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            管理作品、上传小说、编辑章节与作品信息（{loaderData.author.penName} ·{" "}
            {loaderData.books.length} 部作品）
          </p>
        </div>
        <Button asChild>
          <Link to="/creator/upload">
            <FileUp className="size-4" />
            上传小说
          </Link>
        </Button>
      </div>

      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          <FolderOpen className="size-4" />
          我的作品
        </h2>
        {loaderData.books.length === 0 ? (
          <EmptyState
            title="还没有作品"
            description="上传一本 TXT / EPUB / MOBI / PDF 小说开始创作。"
            action={
              <Button asChild>
                <Link to="/creator/upload">
                  <FileUp className="size-4" />
                  上传第一本
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {loaderData.books.map((book) => (
              <Link
                key={book.id}
                to={`/creator/books/${book.id}`}
                className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:bg-muted"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <BookOpen className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-medium">{book.title}</p>
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {book.wordCount.toLocaleString()} 字 · 最新：
                    {book.latestChapterTitle ?? "无章节"}
                  </p>
                </div>
                <Badge variant={book.status === "published" ? "success" : "secondary"}>
                  {statusText(book.status)}
                </Badge>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
