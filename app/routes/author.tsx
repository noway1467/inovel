import { Link } from "react-router";
import type { Route } from "./+types/author";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { EmptyState } from "~/components/state/empty-state";
import { pageMeta, pageTitle } from "~/lib/page-title";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { listPublishedBooks } from "~/server/repositories/books";
import { authors } from "drizzle/schema";
import { eq } from "drizzle-orm";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);
  const author = await db
    .select()
    .from(authors)
    .where(eq(authors.id, params.authorId ?? ""))
    .get();
  if (!author) throw new Response("作者不存在", { status: 404 });
  const allBooks = await listPublishedBooks(db, 50);
  const books = allBooks.filter((book) => book.authorName === author.penName);
  return { author, books };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const author = loaderData?.author;
  if (!author) return pageMeta(pageTitle("作者"));
  return pageMeta(
    pageTitle(author.penName, "作者"),
    author.bio ?? `${author.penName}的作品列表。`
  );
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

export default function AuthorPage({ loaderData }: Route.ComponentProps) {
  const { author, books } = loaderData;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="flex items-center gap-4 rounded-lg border border-border bg-surface p-5">
        <div className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary/10 text-2xl font-semibold text-primary">
          {author.penName.slice(0, 1)}
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{author.penName}</h1>
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {author.bio || "这个作者很神秘。"}
          </p>
        </div>
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold">作品 {books.length}</h2>
        {books.length === 0 ? (
          <EmptyState title="暂无公开作品" />
        ) : (
          <div className="grid gap-1 rounded-xl border border-border bg-surface p-2 md:grid-cols-2">
            {books.map((book, i) => (
              <BookListItem key={book.id} book={toSummary(book)} seed={i} />
            ))}
          </div>
        )}
      </section>
      <p className="text-sm text-muted-foreground">
        <Link to="/" className="text-primary hover:underline">
          返回首页
        </Link>
      </p>
    </div>
  );
}
