import { useCallback, useEffect, useState } from "react";
import { Form, useSearchParams } from "react-router";
import { Loader2, Search } from "lucide-react";
import type { Route } from "./+types/search";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { EmptyState } from "~/components/state/empty-state";
import { eq, sql } from "drizzle-orm";
import { contentSources } from "drizzle/schema";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { searchBooks } from "~/server/repositories/books";

const hotWords = ["星海拾荒者", "盛唐小吏", "剑出昆仑", "系统", "重生", "都市"];

export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return { query: "", results: [], sourceCount: 0 };
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);

  /**
   * loader 只查本站书库。
   *
   * 在线源搜索一律交给客户端分批调 /api/sources/search：
   * 每个源一次出站 + 一份 HTML 解析，250 个源放在一个请求里必然触发
   * Workers 资源上限（Error 1102）。分批后每批 8 个源，页面先出本站结果，
   * 源结果陆续补上。
   */
  /**
   * 源数量查询单独 catch。
   *
   * 在线源是附加能力，不能让它拖垮站内搜索：这张表缺失或查询出错时
   * （例如迁移还没应用），原先会让整个搜索页渲染成"页面出错了"，
   * 连本站书库结果都看不到。
   */
  const [results, sourceCount] = await Promise.all([
    searchBooks(db, q, 30),
    db
      .select({ count: sql<number>`count(*)` })
      .from(contentSources)
      .where(eq(contentSources.status, "enabled"))
      .get()
      .then((row) => Number(row?.count ?? 0))
      .catch(() => 0),
  ]);

  return { query: q, results, sourceCount };
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

interface SourceOption {
  sourceId: string;
  sourceName: string;
  externalId: string;
}

interface SourceBook {
  title: string;
  author: string | null;
  description: string | null;
  options: SourceOption[];
}

interface BatchResponse {
  books: SourceBook[];
  totals: {
    sourcesQueried: number;
    sourcesOk: number;
    sourcesAvailable: number;
    nextOffset: number | null;
  };
  error?: string;
}

/** 自动连查时，攒到这么多本就停，剩下的源留给用户按需展开 */
const minAutoResults = 5;
/** 自动连查的最大轮数，避免一次搜索把几百个源全打一遍 */
const maxAutoRounds = 6;

/**
 * 在线源结果，分批加载。
 *
 * 每批只查 8 个源，边查边把结果并进列表。这样单个请求的出站数与
 * CPU 都有界，不会像原先那样一次打 250 个源直接触发 Error 1102。
 */
function SourceResults({ query, sourceCount }: { query: string; sourceCount: number }) {
  const [books, setBooks] = useState<SourceBook[]>([]);
  const [queried, setQueried] = useState(0);
  const [okCount, setOkCount] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 换关键词时重置，避免上一次的结果串到下一次
  useEffect(() => {
    setBooks([]);
    setQueried(0);
    setOkCount(0);
    setNextOffset(0);
    setError("");
  }, [query]);

  const loadBatch = useCallback(
    async (offset: number): Promise<{ found: number; next: number | null } | null> => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(
          `/api/sources/search?q=${encodeURIComponent(query)}&offset=${offset}`
        );
        const data = (await response.json()) as BatchResponse;
        if (!response.ok) {
          setError(data.error ?? "在线源搜索失败");
          setNextOffset(null);
          return null;
        }
        // 同名同作者的书合并各源，不重复列
        setBooks((prev) => {
          const merged = new Map(prev.map((book) => [`${book.title}|${book.author ?? ""}`, book]));
          for (const incoming of data.books) {
            const key = `${incoming.title}|${incoming.author ?? ""}`;
            const existing = merged.get(key);
            if (!existing) {
              merged.set(key, incoming);
              continue;
            }
            const seen = new Set(
              existing.options.map((option) => `${option.sourceId}|${option.externalId}`)
            );
            for (const option of incoming.options) {
              const id = `${option.sourceId}|${option.externalId}`;
              if (!seen.has(id)) existing.options.push(option);
            }
            if (!existing.description && incoming.description) {
              existing.description = incoming.description;
            }
          }
          return [...merged.values()].sort((a, b) => b.options.length - a.options.length);
        });
        setQueried((prev) => prev + data.totals.sourcesQueried);
        setOkCount((prev) => prev + data.totals.sourcesOk);
        setNextOffset(data.totals.nextOffset);
        return { found: data.books.length, next: data.totals.nextOffset };
      } catch {
        setError("网络异常，稍后重试");
        setNextOffset(null);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [query]
  );

  /**
   * 自动往下查，直到攒够结果或源查完。
   *
   * 原先只自动查第一批，没结果就要手动点「继续搜索」—— 而多数关键字
   * 在前 8 个源里本来就搜不到，等于每次都得手点好几轮。
   *
   * 停止条件取「够用」而非「查完」：攒到 minAutoResults 本就停，
   * 剩下的源留给用户按需展开，避免为一次搜索把 250 个源全打一遍。
   */
  useEffect(() => {
    if (!query || sourceCount === 0) return;
    let cancelled = false;

    const run = async () => {
      let offset = 0;
      let collected = 0;
      let rounds = 0;

      while (!cancelled && rounds < maxAutoRounds) {
        rounds += 1;
        const result = await loadBatch(offset);
        if (!result) return;
        collected += result.found;
        if (collected >= minAutoResults || result.next === null) return;
        offset = result.next;
      }
    };

    void run();
    // 关键字变化或组件卸载时中止，避免上一次的轮询继续写状态
    return () => {
      cancelled = true;
    };
  }, [query, sourceCount, loadBatch]);

  if (sourceCount === 0) {
    return (
      <section>
        <h2 className="mb-3 text-sm font-semibold">在线源</h2>
        <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-muted-foreground">
          还没有启用在线源。管理员可在「在线源」里批量导入。
        </p>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">在线源</h2>
        <span className="text-xs text-muted-foreground">
          已查 {queried}/{sourceCount} 个源，{okCount} 个有结果
        </span>
        {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {error && <p className="mb-2 text-sm text-danger">{error}</p>}

      {books.length === 0 && !loading && queried > 0 && (
        <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-muted-foreground">
          已查的源里没有匹配结果{nextOffset !== null && "，可以继续搜索剩下的源"}。
        </p>
      )}

      {books.length > 0 && (
        <ul className="space-y-2">
          {books.map((book, i) => (
            <li key={`${book.title}-${i}`} className="rounded-lg border border-border bg-surface p-3">
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
                    {/* 新标签页打开：搜索结果通常要挨个试几个源，
                        原地跳转会丢掉这一页的搜索结果 */}
                    <a
                      href={`/source/${option.sourceId}/book?url=${encodeURIComponent(
                        option.externalId
                      )}&title=${encodeURIComponent(book.title)}`}
                      target="_blank"
                      rel="noopener noreferrer"
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

      {nextOffset !== null && (
        <Button
          className="mt-3"
          variant="secondary"
          size="sm"
          disabled={loading}
          onClick={() => void loadBatch(nextOffset)}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : null}
          继续搜索剩下的 {sourceCount - queried} 个源
        </Button>
      )}
    </section>
  );
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

          <SourceResults query={loaderData.query} sourceCount={loaderData.sourceCount} />

          {loaderData.results.length === 0 && loaderData.sourceCount === 0 && (
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
