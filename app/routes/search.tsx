import { useCallback, useEffect, useRef, useState } from "react";
import { Form, Link, useSearchParams } from "react-router";
import { Compass, Loader2, Pause, Play, Search } from "lucide-react";
import type { Route } from "./+types/search";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { EmptyState } from "~/components/state/empty-state";
import { eq, sql } from "drizzle-orm";
import { encodeSourceRef } from "~/lib/source-ref";
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
  /** 与关键字的相关度，见服务端 keywordRelevance */
  relevance: number;
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

/**
 * 停下来的条件：有一本"精准命中"的书攒够这么多个源。
 *
 * 判据是「同一本书有几个源」而不是「一共搜到几本」：用户要的是这一本，
 * 多个源只是备用线路，够 5 条就不必再打剩下的源了。凑不够就一直往下查，
 * 由用户手动暂停 —— 原先攒到 5 本任意书就停，常常那 5 本都不是想搜的。
 */
const enoughSourcesForOneBook = 5;
/** 达到这个相关度才算精准命中，与服务端 preciseRelevance 对齐 */
const preciseRelevance = 3;

/**
 * 在线源结果，分批加载。
 *
 * 每批只查 8 个源，边查边把结果并进列表。这样单个请求的出站数与
 * CPU 都有界，不会像原先那样一次打 250 个源直接触发 Error 1102。
 */
/** 合并两批结果：同名同作者的书并到一条，各源作为可选项挂上去 */
function mergeBooks(prev: SourceBook[], incoming: SourceBook[]): SourceBook[] {
  const merged = new Map(prev.map((book) => [`${book.title}|${book.author ?? ""}`, book]));
  for (const book of incoming) {
    const key = `${book.title}|${book.author ?? ""}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...book, options: [...book.options] });
      continue;
    }
    const seen = new Set(
      existing.options.map((option) => `${option.sourceId}|${option.externalId}`)
    );
    for (const option of book.options) {
      const id = `${option.sourceId}|${option.externalId}`;
      if (!seen.has(id)) existing.options.push(option);
    }
    if (!existing.description && book.description) existing.description = book.description;
    existing.relevance = Math.max(existing.relevance, book.relevance);
  }
  // 与服务端同序：先相关度，再可选源数量
  return [...merged.values()].sort(
    (a, b) => b.relevance - a.relevance || b.options.length - a.options.length
  );
}

/** 是否已经把用户要的那本书搜够了 */
function hasEnough(books: SourceBook[]): boolean {
  return books.some(
    (book) => book.relevance >= preciseRelevance && book.options.length >= enoughSourcesForOneBook
  );
}

function SourceResults({ query, sourceCount }: { query: string; sourceCount: number }) {
  const [books, setBooks] = useState<SourceBook[]>([]);
  const [queried, setQueried] = useState(0);
  const [okCount, setOkCount] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [done, setDone] = useState(false);
  /**
   * 搜够了、但还有源没查完。
   *
   * 与 done 分开：done 是源真的查完了，没有下一批可查；satisfied 只是达到了
   * 「某本书攒够 5 个源」的停止条件。原先两者都记成 done，于是攒够 5 个源就
   * 彻底停住 —— 而那 5 个源里可能有几个实际打不开（403/503/超时），
   * 用户看着有 5 条线路却一条也读不了，还没法让它继续找。
   */
  const [satisfied, setSatisfied] = useState(false);
  const [error, setError] = useState("");

  // 循环靠 ref 读取暂停状态与进度：state 要等重渲染才可见，循环里读不到
  const pausedRef = useRef(false);
  const offsetRef = useRef(0);
  const booksRef = useRef<SourceBook[]>([]);
  const runningRef = useRef(false);
  /**
   * 用户点过「继续搜索」后置位，本轮不再受 hasEnough 约束。
   * 不然清掉 satisfied 重启循环，第一批回来 hasEnough 依旧成立，又立刻停住。
   */
  const keepGoingRef = useRef(false);

  // 换关键词时重置，避免上一次的结果串到下一次
  useEffect(() => {
    setBooks([]);
    setQueried(0);
    setOkCount(0);
    setNextOffset(0);
    setPaused(false);
    setDone(false);
    setSatisfied(false);
    setError("");
    pausedRef.current = false;
    offsetRef.current = 0;
    booksRef.current = [];
    keepGoingRef.current = false;
  }, [query]);

  const loadBatch = useCallback(
    async (offset: number): Promise<{ next: number | null } | null> => {
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
        // 循环要立刻据此判断够不够，所以先算出合并结果再交给 state
        const merged = mergeBooks(booksRef.current, data.books);
        booksRef.current = merged;
        setBooks(merged);
        setQueried((prev) => prev + data.totals.sourcesQueried);
        setOkCount((prev) => prev + data.totals.sourcesOk);
        setNextOffset(data.totals.nextOffset);
        return { next: data.totals.nextOffset };
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
   * 一直往下查，直到搜够、源查完、出错，或用户按暂停。
   *
   * 不再有轮数上限，也不需要用户点「继续搜索」—— 原先两者叠在一起：
   * 多数关键字在前 8 个源里搜不到，自动查 6 轮就停手，剩下的全靠手点。
   *
   * 停止条件是「用户要的那本书攒够 5 个源」（见 hasEnough），
   * 凑不够就继续打剩下的源，要停由用户自己决定。
   */
  const cancelledRef = useRef(false);
  const runLoop = useCallback(async () => {
    // 同一时刻只允许一个循环在跑，避免暂停/恢复连点跑出两条
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        if (cancelledRef.current || pausedRef.current) return;
        const offset = offsetRef.current;
        if (offset === null) return;
        const result = await loadBatch(offset);
        if (!result) return;
        if (result.next === null) {
          setDone(true);
          return;
        }
        offsetRef.current = result.next;
        if (!keepGoingRef.current && hasEnough(booksRef.current)) {
          // 搜够就暂停，但保留「继续搜索」的余地 —— 不当作查完
          setSatisfied(true);
          return;
        }
      }
    } finally {
      runningRef.current = false;
    }
  }, [loadBatch]);

  useEffect(() => {
    if (!query || sourceCount === 0) return;
    cancelledRef.current = false;
    void runLoop();
    // 关键字变化或组件卸载时中止，避免上一次的轮询继续写状态
    return () => {
      cancelledRef.current = true;
    };
  }, [query, sourceCount, runLoop]);

  function togglePause() {
    if (paused) {
      setPaused(false);
      pausedRef.current = false;
      void runLoop();
      return;
    }
    setPaused(true);
    pausedRef.current = true;
  }

  /**
   * 搜够之后继续往下查剩余的源。
   *
   * 用途很实际：命中的那几个源可能有 403/503/超时打不开，得再找几条备用线路。
   * 清掉 satisfied 再启动循环 —— 否则 hasEnough 仍然成立，会立刻又停下。
   */
  function continueSearch() {
    setSatisfied(false);
    keepGoingRef.current = true;
    void runLoop();
  }

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

  const running = loading || (!paused && !done && !satisfied && nextOffset !== null);
  /** 还有源没查完，且当前是停着的 —— 这时才给「继续搜索」 */
  const canContinue = satisfied && nextOffset !== null && !loading;

  return (
    <section>
      {/* 一行装下标题、进度、状态和暂停按钮：加载图标只此一处 */}
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">在线源</h2>
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {queried}/{sourceCount} 个源 · {okCount} 个有结果 · {books.length} 本
          {paused ? " · 已暂停" : done ? " · 已查完" : satisfied ? " · 已够用" : ""}
        </span>

        {/*
          搜够但还有源没查时给「继续搜索」：命中的那几个源可能 403/503/超时
          打不开，需要再找几条备用线路。
        */}
        {canContinue && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2"
            onClick={continueSearch}
          >
            <Play className="size-3.5" />
            继续搜索
          </Button>
        )}

        {nextOffset !== null && !done && !satisfied && (
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" onClick={togglePause}>
            {paused ? (
              <>
                <Play className="size-3.5" />
                继续
              </>
            ) : (
              <>
                <Pause className="size-3.5" />
                暂停
              </>
            )}
          </Button>
        )}
      </div>

      {/* 进度条：比纯数字更直观地反映"还在查" */}
      {sourceCount > 0 && (
        <div className="mb-2 h-0.5 w-full overflow-hidden rounded-full bg-border">
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${Math.min(100, Math.round((queried / sourceCount) * 100))}%` }}
          />
        </div>
      )}

      {error && <p className="mb-2 text-sm text-danger">{error}</p>}

      {books.length === 0 && !loading && queried > 0 && (
        <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-muted-foreground">
          {done ? "所有源都查过了，没有匹配结果。" : "已查的源里还没有匹配结果，正在继续查…"}
        </p>
      )}

      {books.length > 0 && (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-surface">
          {books.map((book, i) => (
            <li key={`${book.title}-${i}`} className="px-3 py-2">
              <div className="flex items-baseline gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{book.title}</span>
                {book.author && (
                  <span className="shrink-0 text-xs text-muted-foreground">{book.author}</span>
                )}
                {/*
                  不再显示「精准」标记：相关度已经决定了排序，最贴题的本来就在最前面，
                  再挂个徽章反而让列表变花。relevance 仍然参与排序与停查判断。
                */}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {book.options.length} 源
                </span>
              </div>
              {book.description && (
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                  {book.description}
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {book.options.map((option) => (
                  <Button
                    key={`${option.sourceId}-${option.externalId}`}
                    size="sm"
                    variant="secondary"
                    className="h-6 px-2 text-xs"
                    asChild
                  >
                    {/* 新标签页打开：搜索结果通常要挨个试几个源，
                        原地跳转会丢掉这一页的搜索结果 */}
                    <a
                      href={`/source/${option.sourceId}/book?url=${encodeSourceRef(
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
    </section>
  );
}

export default function SearchPage({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const query = params.get("q")?.trim() ?? "";
  const hasQuery = Boolean(loaderData.query);

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <Form
        action="/search"
        role="search"
        className="sticky top-12 z-30 bg-background py-1.5 md:top-14"
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={query}
            placeholder="搜索书名、作者、标签"
            aria-label="搜索书名、作者、标签"
            autoFocus
            className="h-10 pl-10"
          />
        </div>
      </Form>

      {!hasQuery ? (
        <div className="space-y-4">
          {/*
            分类浏览入口放在这里：一部分在线源的搜索规则需要 JS 求值、
            降级后没有搜索能力，按分类浏览是它们唯一的进入方式。
            搜索页空态正是「想找书但还没输入」的时刻。
          */}
          <Button variant="outline" className="w-full justify-start" asChild>
            <Link to="/explore">
              <Compass className="size-4" />
              按分类浏览在线源
            </Link>
          </Button>
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
        <div className="space-y-4">
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h2 className="text-sm font-semibold">本站书库</h2>
              <span className="text-xs text-muted-foreground">
                找到 {loaderData.results.length} 部
              </span>
            </div>
            {loaderData.results.length === 0 ? (
              <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-muted-foreground">
                本站书库没有匹配结果。
              </p>
            ) : (
              <div className="grid gap-0.5 rounded-lg border border-border bg-surface p-1.5 md:grid-cols-2">
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
