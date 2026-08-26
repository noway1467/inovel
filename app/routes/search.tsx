import { Form, useSearchParams } from "react-router";
import { Search } from "lucide-react";
import type { Route } from "./+types/search";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { searchBooks } from "~/server/repositories/books";

const hotWords = ["星海拾荒者", "盛唐小吏", "剑出昆仑", "系统", "重生", "都市"];

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return { query: "", results: [] };
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);
  const results = await searchBooks(db, q, 30);
  return { query: q, results };
}

function toSummary(book: Awaited<ReturnType<typeof searchBooks>>[number]): BookSummary {
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

export default function SearchPage({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const query = params.get("q")?.trim() ?? "";
  const hasQuery = Boolean(loaderData.query);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Form
        action="/search"
        role="search"
        className="sticky top-12 z-30 bg-background py-2 md:top-14"
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={query}
            placeholder="搜索书名、作者、标签"
            aria-label="搜索书名、作者、标签"
            autoFocus
            className="h-12 pl-11 text-base"
          />
        </div>
      </Form>

      {!hasQuery ? (
        <div className="space-y-4">
          <section>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">热门搜索</h2>
            <div className="flex flex-wrap gap-2">
              {hotWords.map((word) => (
                <Button key={word} variant="outline" size="sm" asChild>
                  <a href={`/search?q=${encodeURIComponent(word)}`}>{word}</a>
                </Button>
              ))}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">热门标签</h2>
            <div className="flex flex-wrap gap-2">
              {[
                "热血",
                "系统",
                "重生",
                "穿越",
                "无敌流",
                "种田",
                "甜宠",
                "末世",
                "悬疑",
                "轻小说",
              ].map((tag) => (
                <Badge key={tag} variant="secondary" className="cursor-pointer">
                  <a href={`/search?q=${encodeURIComponent(tag)}`}>{tag}</a>
                </Badge>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <section>
          <p className="mb-3 text-sm text-muted-foreground">
            关键词“{loaderData.query}”共找到 {loaderData.results.length} 部作品
          </p>
          {loaderData.results.length === 0 ? (
            <EmptyState
              title="没有找到相关作品"
              description="换个关键词试试，或浏览热门标签。"
              action={
                <a href="/categories" className="text-sm text-primary hover:underline">
                  浏览全部分类
                </a>
              }
            />
          ) : (
            <div className="grid gap-1 rounded-xl border border-border bg-surface p-2 md:grid-cols-2">
              {loaderData.results.map((book, i) => (
                <BookListItem key={book.id} book={toSummary(book)} seed={i} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
