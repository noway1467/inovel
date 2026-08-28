import { useCallback, useEffect, useRef, useState } from "react";
import { Form, Link, useSearchParams } from "react-router";
import { Compass, Loader2, Pause, Play, Search, X } from "lucide-react";
import type { Route } from "./+types/search";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { EmptyState } from "~/components/state/empty-state";
import { eq, sql } from "drizzle-orm";
import { cn } from "~/lib/utils";
import { encodeSourceRef } from "~/lib/source-ref";
import { bestPreciseSourceCount, groupKey } from "~/lib/book-match";
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
 *
 * 也是「继续搜索」每次抬高目标的步长：点一次再攒 5 个。
 */
const enoughSourcesForOneBook = 5;

/**
 * 自动阶段的批次上限。
 *
 * 只是防死循环的保险，不是"搜够了"的判据 —— 该由 hasEnough 说停。
 * 原先是 3，于是 12 个源之后就报「已够用」，而那时往往一本书都没攒到
 * 5 个精准源：用户要的是搜满 5 个，不是搜三批。每批一次独立 HTTP 请求、
 * 服务端 maxSourcesPerSearch 封顶 4 个源，批数多不会让单个请求变长，
 * 不涉及 Error 1102。
 *
 * 80 批 × 4 源 = 320 个源，比现有启用源总数还多，实际总是先被
 * 「源查完了」或「搜够了」终止。
 */
const maxAutoBatches = 80;

/**
 * 在线源结果，分批加载。
 *
 * 每批只查 8 个源，边查边把结果并进列表。这样单个请求的出站数与
 * CPU 都有界，不会像原先那样一次打 250 个源直接触发 Error 1102。
 */
/**
 * 合并两批结果：同名同作者的书并到一条，各源作为可选项挂上去。
 *
 * 键必须用 groupKey（规范化后再拼），与服务端分组时一致。按原始
 * `书名|作者` 拼会把《剑来》/「剑来」/`剑来 ` 当成不同的书，各源分散在
 * 好几条里，于是"某一本攒够 5 个源"永远不成立，搜索停不下来。
 */
function mergeBooks(prev: SourceBook[], incoming: SourceBook[]): SourceBook[] {
  const merged = new Map(prev.map((book) => [groupKey(book.title, book.author), book]));
  for (const book of incoming) {
    const key = groupKey(book.title, book.author);
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

/** 是否已攒到目标个数的精准源 */
function hasEnough(books: SourceBook[], target: number): boolean {
  return bestPreciseSourceCount(books) >= target;
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
  /**
   * 用户主动取消了这一轮搜索。
   *
   * 与 paused 分开：暂停是"先停一下，等下继续"，取消是"这本我不搜了" ——
   * 停掉之后不再显示暂停/继续，只留一个「重新搜索」。原先没有这个出口，
   * 循环会一直往下打源，用户要么等它自己停，要么离开页面。
   */
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  /**
   * 当前这一轮要攒够几个精准源。
   *
   * 每点一次「继续搜索」就再加 5：点继续的实际场景是手里那几个源打不开
   * （403/503/超时），需要的是"再来 5 条备用线路"，不是把已有的 5 条重数一遍。
   * 不加的话 hasEnough 立刻又成立，循环刚起步就停。
   */
  const [target, setTarget] = useState(enoughSourcesForOneBook);

  // 循环靠 ref 读取暂停状态与进度：state 要等重渲染才可见，循环里读不到
  const pausedRef = useRef(false);
  const offsetRef = useRef(0);
  const booksRef = useRef<SourceBook[]>([]);
  const runningRef = useRef(false);
  const autoBatchesRef = useRef(maxAutoBatches);
  const targetRef = useRef(enoughSourcesForOneBook);
  const batchCooldownMs = 1_200;

  // 换关键词时重置，避免上一次的结果串到下一次
  useEffect(() => {
    setBooks([]);
    setQueried(0);
    setOkCount(0);
    setNextOffset(0);
    setPaused(false);
    setDone(false);
    setSatisfied(false);
    setCancelled(false);
    setError("");
    setTarget(enoughSourcesForOneBook);
    pausedRef.current = false;
    offsetRef.current = 0;
    booksRef.current = [];
    autoBatchesRef.current = maxAutoBatches;
    targetRef.current = enoughSourcesForOneBook;
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
          setError(
            response.status === 429 || response.status >= 500
              ? "源查询触发限流或源站过载，已暂停；稍后可点「继续下一批」"
              : data.error ?? "在线源搜索失败"
          );
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
        if (hasEnough(booksRef.current, targetRef.current) || autoBatchesRef.current <= 0) {
          // 搜够或到达批次上限就停，保留手动「继续搜索」的余地
          setSatisfied(true);
          return;
        }
        autoBatchesRef.current -= 1;
        await new Promise((resolve) => setTimeout(resolve, batchCooldownMs));
        if (cancelledRef.current || pausedRef.current) return;
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
      /*
        恢复时把批次预算补满。暂停是用户的动作、不是配额事件，
        原先只补到 1 —— 若暂停前预算已见底，一恢复就跑一批又停，
        看着像"点了继续没反应"。
      */
      autoBatchesRef.current = Math.max(autoBatchesRef.current, maxAutoBatches);
      void runLoop();
      return;
    }
    setPaused(true);
    pausedRef.current = true;
  }

  /**
   * 继续搜索：把目标再抬 5 个精准源，然后按和自动阶段一样的规则继续跑。
   *
   * 原先固定只跑一批就停。每批服务端封顶 4 个源，等于点一次只多查 4 个 ——
   * 想凑够备用线路得连点十几次，而每次点完还得等它自己停下。现在用同一把
   * 尺子：攒满目标、源查完、或用户按暂停才停。
   *
   * 预算也要补回来：若上一轮是撞批次上限停的（autoBatches 见底），
   * 不补的话循环第一批跑完就又被判成到顶。
   */
  function continueSearch() {
    targetRef.current = bestPreciseSourceCount(booksRef.current) + enoughSourcesForOneBook;
    setTarget(targetRef.current);
    autoBatchesRef.current = Math.max(autoBatchesRef.current, maxAutoBatches);
    setSatisfied(false);
    setCancelled(false);
    cancelledRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    void runLoop();
  }

  /**
   * 取消搜索：把循环彻底停下。
   *
   * cancelledRef 是循环每次迭代都会看的那面旗子，置起来后当前这一批返回即止。
   * 已经查到的结果留在页面上 —— 用户要的是"别再往下打源了"，
   * 不是"把结果清掉"。想再搜按同一位置继续。
   */
  function stopSearch() {
    cancelledRef.current = true;
    pausedRef.current = false;
    setCancelled(true);
    setPaused(false);
  }

  /** 取消之后重新开搜：从上次的 offset 接着走，已查过的源不重复打 */
  function resumeSearch() {
    setCancelled(false);
    cancelledRef.current = false;
    autoBatchesRef.current = Math.max(autoBatchesRef.current, maxAutoBatches);
    setSatisfied(false);
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

  const running = loading || (!paused && !cancelled && !done && !satisfied && nextOffset !== null);
  /** 还有源没查完，且当前是停着的 —— 这时才给「继续搜索」 */
  const canContinue = satisfied && !cancelled && nextOffset !== null && !loading;
  /**
   * 暂停按钮的显示条件。
   *
   * 只要还有源没查完、且不是停在 satisfied 上，就该给暂停 ——
   * 包括「继续搜索」跑起来之后：那一段现在也是循环，同样得能中途叫停。
   */
  const canPause = nextOffset !== null && !done && !satisfied && !cancelled;
  /** 取消：只要循环还可能往下跑就给，取消后换成「重新搜索」 */
  const canStop = !cancelled && !done && nextOffset !== null;

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
          {/*
            「已够用」只在真的攒够时说。satisfied 也包含"手动那一批跑完了"，
            那种情况下并没有搜够，标成已够用会让用户以为不必再点继续。
          */}
          {cancelled
            ? " · 已取消"
            : paused
              ? " · 已暂停"
              : done
                ? " · 已查完"
                : satisfied
                  ? hasEnough(books, target)
                    ? ` · 已够用（${bestPreciseSourceCount(books)} 个精准源）`
                    : " · 已暂停"
                  : ""}
        </span>

        {/*
          搜够但还有源没查时给「继续搜索」：命中的那几个源可能 403/503/超时
          打不开，需要再找几条备用线路。点下去按同样的规则再攒 5 个。
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

        {canPause && (
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

        {/*
          取消搜索。暂停只是挂起，循环还在等着接着打源；这个 X 直接把它停死。
          之前唯一的出路是换关键词或离开页面，一本书能一直搜下去。
        */}
        {canStop && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label="取消搜索"
            title="取消搜索"
            onClick={stopSearch}
          >
            <X className="size-3.5" />
          </Button>
        )}

        {cancelled && nextOffset !== null && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2"
            onClick={resumeSearch}
          >
            <Play className="size-3.5" />
            重新搜索
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
            className={cn("h-10 pl-10", query && "pr-10")}
          />
          {/*
            清空关键词。走链接而不是清 input：搜索结果由 URL 上的 q 决定，
            只把输入框擦掉的话页面还停在上一次的结果上。
          */}
          {query && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute right-1 top-1/2 size-8 -translate-y-1/2 text-muted-foreground"
              aria-label="清空搜索"
              title="清空搜索"
              asChild
            >
              <Link to="/search">
                <X className="size-4" />
              </Link>
            </Button>
          )}
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
