import type { Route } from "./+types/category";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { EmptyState } from "~/components/state/empty-state";
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
  const name =
    loaderData.slug === "uncategorized"
      ? "未分类"
      : (loaderData.books[0]?.categoryName ?? loaderData.slug);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{name ?? "分类结果"}</h1>
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
