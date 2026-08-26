import { Link } from "react-router";
import { Clock3 } from "lucide-react";
import type { Route } from "./+types/history";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { EmptyState } from "~/components/state/empty-state";
import { Button } from "~/components/ui/button";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getBooksByIds } from "~/server/repositories/books";
import { readingHistory } from "drizzle/schema";
import { desc, eq } from "drizzle-orm";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, history: [] };

  const db = createDb(env.DB_APP);
  const rows = await db
    .select()
    .from(readingHistory)
    .where(eq(readingHistory.userId, session.user.id))
    .orderBy(desc(readingHistory.readAt))
    .limit(50);

  // 先去重再批量取书，整页固定 3 条查询，替代逐本串行 getBook
  const seen = new Set<string>();
  const dedupedRows = rows.filter((row) => {
    if (seen.has(row.bookId)) return false;
    seen.add(row.bookId);
    return true;
  });
  const bookMap = await getBooksByIds(
    db,
    dedupedRows.map((row) => row.bookId)
  );
  const history = [];
  for (const row of dedupedRows) {
    const book = bookMap.get(row.bookId);
    if (!book) continue;
    history.push({ row, book });
  }
  return { user: session.user, history };
}

export default function HistoryPage({ loaderData }: Route.ComponentProps) {
  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="登录后查看历史"
          description="最近读过的作品会记录在这里。"
          action={
            <Button asChild>
              <Link to="/login?redirect=/history">去登录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (loaderData.history.length === 0) {
    return (
      <div className="paper-panel mx-auto max-w-lg rounded-2xl p-4">
        <EmptyState title="还没有阅读历史" description="读过的章节会按时间显示。" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="paper-panel rounded-2xl p-5">
        <p className="flex items-center gap-2 text-xs font-semibold tracking-[0.2em] text-primary">
          <Clock3 className="size-4" /> 最近阅读
        </p>
        <h1 className="mt-2 font-serif text-2xl font-semibold">翻过的页，都留在这里</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          按最近阅读时间排列，共 {loaderData.history.length} 本。
        </p>
      </header>
      <section className="paper-panel grid gap-1 rounded-2xl p-3 sm:p-4 md:grid-cols-2">
        {loaderData.history.map(({ book, row }, i) => {
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
            progress: row.bookProgress,
          };
          return <BookListItem key={book.id} book={summary} seed={i} />;
        })}
      </section>
    </div>
  );
}
