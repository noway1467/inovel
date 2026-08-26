import { Link } from "react-router";
import { Clock3, Compass, Library } from "lucide-react";
import type { Route } from "./+types/library";
import { BookCard, type BookSummary } from "~/components/book/book-card";
import { EmptyState } from "~/components/state/empty-state";
import { Button } from "~/components/ui/button";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getBooksByIds } from "~/server/repositories/books";
import { getProgressForBooks } from "~/server/services/reader";
import { shelfItems } from "drizzle/schema";
import { desc, eq } from "drizzle-orm";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, items: [] };

  const db = createDb(env.DB_APP);
  const rows = await db
    .select()
    .from(shelfItems)
    .where(eq(shelfItems.userId, session.user.id))
    .orderBy(desc(shelfItems.updatedAt))
    .limit(100);

  // 批量取书与进度：整页固定 4 条查询，避免逐本串行查询拖慢首屏并逼近子请求上限
  const bookIds = rows.map((row) => row.bookId);
  const [bookMap, progressMap] = await Promise.all([
    getBooksByIds(db, bookIds),
    getProgressForBooks(db, session.user.id, bookIds),
  ]);
  const items = [];
  for (const row of rows) {
    const book = bookMap.get(row.bookId);
    if (!book) continue;
    items.push({ shelf: row, book, progress: progressMap.get(row.bookId) ?? null });
  }
  return { user: session.user, items };
}

export default function LibraryPage({ loaderData }: Route.ComponentProps) {
  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="登录后查看书架"
          description="收藏的作品会同步到云端。"
          action={
            <Button asChild>
              <Link to="/login?redirect=/library">去登录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (loaderData.items.length === 0) {
    return (
      <div className="paper-panel mx-auto max-w-lg rounded-2xl p-4">
        <EmptyState
          title="书架还是空的"
          description="从发现页挑一本书，加入书架后就会出现在这里。"
          action={
            <Button asChild>
              <Link to="/">去发现好书</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="paper-panel flex flex-col justify-between gap-4 rounded-2xl p-5 sm:flex-row sm:items-end">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-primary"><Library className="size-4" /> 我的书架</p>
          <h1 className="mt-2 font-serif text-2xl font-semibold">随手翻开，接着上次读</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {loaderData.items.length} 本，阅读进度已同步。</p>
        </div>
        <div className="flex gap-2">
          <Link to="/history" className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm hover:bg-muted">
            <Clock3 className="size-4" /> 最近阅读
          </Link>
          <Link to="/" className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground">
            <Compass className="size-4" /> 发现新书
          </Link>
        </div>
      </header>

      <section className="paper-panel rounded-2xl p-4 sm:p-5" aria-label="书架图书">
        <div className="grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-4 sm:gap-x-5 md:grid-cols-5 lg:grid-cols-6">
          {loaderData.items.map(({ book, progress }, i) => {
            const summary: BookSummary = {
              id: book.id,
              title: book.title,
              authorName: book.authorName,
              categoryName: book.categoryName,
              tags: book.tags,
              status: book.status,
              latestChapterTitle: book.latestChapterTitle,
              wordCount: book.wordCount,
              updatedAt: book.updatedAt?.toISOString() ?? null,
              coverKey: book.coverKey,
              progress: progress?.bookProgress ?? 0,
            };
            return <BookCard key={book.id} book={summary} seed={i} />;
          })}
        </div>
      </section>
    </div>
  );
}
