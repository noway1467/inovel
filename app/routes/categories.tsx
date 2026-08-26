import { Link } from "react-router";
import type { Route } from "./+types/categories";
import { Badge } from "~/components/ui/badge";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { listPublishedBooks } from "~/server/repositories/books";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import {
  countUncategorizedBooks,
  listEnabledCategoriesWithCounts,
} from "~/server/repositories/categories";

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);
  const [books, categories, uncategorizedCount] = await Promise.all([
    listPublishedBooks(db, 50),
    listEnabledCategoriesWithCounts(db),
    countUncategorizedBooks(db),
  ]);
  return { books, categories, uncategorizedCount };
}

function toSummary(book: Awaited<ReturnType<typeof listPublishedBooks>>[number]): BookSummary {
  return {
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
  };
}

export default function CategoriesPage({ loaderData }: Route.ComponentProps) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">全部分类</h1>
        <p className="text-sm text-muted-foreground">
          {loaderData.categories.length} 个分类 · 按题材浏览
        </p>
      </div>
      {/* 分类格改成紧凑 chip：原来每格 min-h-20 + p-4，还写死一行"浏览该分类"，
          纵向占了三倍空间却没信息量。现在一行放得下 3–6 个，副标题换成真实作品数。 */}
      <section className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {loaderData.categories.map((category) => (
          <Link
            key={category.slug}
            to={`/categories/${category.slug}`}
            className="flex items-baseline justify-between gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 transition-colors hover:bg-muted hover:text-primary"
          >
            <span className="min-w-0 truncate text-sm font-medium">{category.name}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {category.bookCount}
            </span>
          </Link>
        ))}
        {/* 导入时未指定分类的作品：以前被默认塞进第一个分类，现在留空并在这里露出 */}
        {loaderData.uncategorizedCount > 0 && (
          <Link
            to="/categories/uncategorized"
            className="flex items-baseline justify-between gap-1.5 rounded-lg border border-dashed border-border bg-surface px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
          >
            <span className="min-w-0 truncate text-sm font-medium">未分类</span>
            <span className="shrink-0 text-[11px] tabular-nums">
              {loaderData.uncategorizedCount}
            </span>
          </Link>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-base font-semibold">热门标签</h2>
        <div className="flex flex-wrap gap-1.5">
          {["热血", "系统", "重生", "穿越", "无敌流", "种田", "甜宠", "末世", "悬疑", "轻小说"].map(
            (tag) => (
              <Link key={tag} to={`/search?q=${encodeURIComponent(tag)}`}>
                <Badge variant="secondary">{tag}</Badge>
              </Link>
            )
          )}
        </div>
      </section>
      <section>
        {/* 这一段是全站最新，不受上面分类选择影响，标题写清楚免得误读为"该分类下的更新" */}
        <h2 className="mb-2 text-base font-semibold">全站最近更新</h2>
        <div className="grid gap-1 rounded-xl border border-border bg-surface p-2 md:grid-cols-2">
          {loaderData.books.slice(0, 12).map((book, i) => (
            <BookListItem key={book.id} book={toSummary(book)} seed={i} />
          ))}
        </div>
      </section>
    </div>
  );
}
