import type { Route } from "./+types/category";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { EmptyState } from "~/components/state/empty-state";
import { pageMeta, pageTitle } from "~/lib/page-title";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import {
  listPublishedBooksByCategorySlug,
  listUncategorizedBooks,
} from "~/server/repositories/books";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);
  const slug = params.slug ?? "";
  // uncategorized 是个伪 slug：走"category_id 为空"而不是查分类表
  const books =
    slug === "uncategorized"
      ? await listUncategorizedBooks(db, 50)
      : await listPublishedBooksByCategorySlug(db, slug, 50);
  return { slug, books };
}

/**
 * 分类名不在 loader 返回里，只能从书里反推：标题和 h1 共用这个函数，
 * 避免标签页写"玄幻"而正文写别的。
 */
function categoryLabel(slug: string, categoryName?: string | null): string {
  if (slug === "uncategorized") return "未分类";
  return categoryName ?? slug ?? "分类结果";
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return pageMeta(pageTitle("分类结果"));
  const name = categoryLabel(loaderData.slug, loaderData.books[0]?.categoryName);
  return pageMeta(pageTitle(name, "分类"), `${name}分类下共 ${loaderData.books.length} 部作品。`);
}

function toSummary(
  book: Awaited<ReturnType<typeof listPublishedBooksByCategorySlug>>[number]
): BookSummary {
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

export default function CategoryPage({ loaderData }: Route.ComponentProps) {
  const name = categoryLabel(loaderData.slug, loaderData.books[0]?.categoryName);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">共 {loaderData.books.length} 部作品</p>
      </div>
      {loaderData.books.length === 0 ? (
        <EmptyState
          title={loaderData.slug === "uncategorized" ? "没有未分类作品" : "该分类暂无作品"}
          description={
            loaderData.slug === "uncategorized"
              ? "所有已发布作品都已归类。"
              : "作者上传并通过审核后会显示在这里。"
          }
        />
      ) : (
        <div className="grid gap-1 rounded-xl border border-border bg-surface p-2 md:grid-cols-2">
          {loaderData.books.map((book, i) => (
            <BookListItem key={book.id} book={toSummary(book)} seed={i} />
          ))}
        </div>
      )}
    </div>
  );
}
