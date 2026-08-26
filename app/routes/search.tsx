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
import { aggregateSearch } from "~/server/sources/search";

const hotWords = ["星海拾荒者", "盛唐小吏", "剑出昆仑", "系统", "重生", "都市"];

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return { query: "", results: [], sourceBooks: [], sourceStats: null };
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);

  /**
   * 本站书库与在线源并行查。
   *
   * 在线源要出站抓取，慢且可能失败，所以单独 catch —— 源全挂也不能
   * 影响本站结果。整体再套一层时限，避免搜索页被慢源拖住。
   */
  const [results, aggregate] = await Promise.all([
    searchBooks(db, q, 30),
    aggregateSearch(db, q, { perSourceLimit: 5, timeoutMs: 8_000 }).catch(() => null),
  ]);

  return {
    query: q,
    results,
    sourceBooks: aggregate?.books.slice(0, 40) ?? [],
    sourceStats: aggregate
      ? {
          queried: aggregate.totals.sourcesQueried,
          ok: aggregate.totals.sourcesOk,
          books: aggregate.totals.books,
        }
      : null,
  };
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
        <div className="space-y-6">
          <section>
            <p className="mb-3 text-sm text-muted-foreground">
              本站书库：找到 {loaderData.results.length} 部
            </p>
            {loaderData.results.length === 0 ? (
              <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-muted-foreground">
                本站书库没有匹配结果。
              </p>
            ) : (
              <div className="grid gap-1 rounded-xl border border-border bg-surface p-2 md:grid-cols-2">
                {loaderData.results.map((book, i) => (
                  <BookListItem key={book.id} book={toSummary(book)} seed={i} />
                ))}
              </div>
            )}
          </section>

          {/* 在线源结果：点开即读，不需要先订阅或发布 */}
          <section>
            <div className="mb-3 flex flex-wrap items-baseline gap-2">
              <h2 className="text-sm font-semibold">在线源</h2>
              {loaderData.sourceStats && (
                <span className="text-xs text-muted-foreground">
                  查询 {loaderData.sourceStats.queried} 个源，{loaderData.sourceStats.ok} 个有响应，
                  合并 {loaderData.sourceStats.books} 本
                </span>
              )}
            </div>

            {loaderData.sourceBooks.length === 0 ? (
              <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-muted-foreground">
                {loaderData.sourceStats && loaderData.sourceStats.queried > 0
                  ? "在线源没有匹配结果。"
                  : "还没有启用支持搜索的在线源。"}
              </p>
            ) : (
              <ul className="space-y-2">
                {loaderData.sourceBooks.map((book, i) => (
                  <li
                    key={`${book.title}-${i}`}
                    className="rounded-lg border border-border bg-surface p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{book.title}</span>
                      {book.author && (
                        <span className="text-xs text-muted-foreground">{book.author}</span>
                      )}
                      <Badge variant="secondary">{book.options.length} 个源</Badge>
                    </div>
                    {book.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {book.description}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {book.options.map((option) => (
                        <Button
                          key={`${option.sourceId}-${option.externalId}`}
                          size="sm"
                          variant="secondary"
                          asChild
                        >
                          <a
                            href={`/source/${option.sourceId}/book?url=${encodeURIComponent(
                              option.externalId
                            )}&title=${encodeURIComponent(book.title)}`}
                          >
                            {option.sourceName}
                          </a>
                        </Button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {loaderData.results.length === 0 && loaderData.sourceBooks.length === 0 && (
            <EmptyState
              title="没有找到相关作品"
              description="换个关键词试试，或浏览热门标签。"
              action={
                <a href="/categories" className="text-sm text-primary hover:underline">
                  浏览全部分类
                </a>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
