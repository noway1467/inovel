import { Link, redirect, useSearchParams } from "react-router";
import { BookOpenText, ChevronLeft, ChevronRight, Compass, Tag } from "lucide-react";
import type { Route } from "./+types/explore-sources";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/state/empty-state";
import { encodeSourceRef } from "~/lib/source-ref";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { browseExplore, listSourcesWithExplore } from "~/server/sources/explore-browse";
import { loginRedirectTo } from "~/server/http/request-path";

/**
 * 在线源的分类浏览区。
 *
 * 为什么要有：实测 244 个可导入源里 48 个没有搜索地址（搜索规则要 JS 求值
 * 被降级），这些源能读却完全没有入口。它们大多带着发现页规则，
 * 按分类浏览就是它们唯一的进入方式。
 *
 * 刻意做成「按源浏览」而不是跨源合并：跨源每开一个分类要同时打 N 个源，
 * Worker 的 CPU 与子请求都吃不住，任一源慢就拖住整页；按源一次只打一个。
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  // 浏览会产生出站抓取，必须登录
  if (!session?.user) return redirect(loginRedirectTo(new URL(request.url)));

  const db = createDb(env.DB_APP);
  const url = new URL(request.url);
  const sourceId = url.searchParams.get("source")?.trim() ?? "";
  const category = url.searchParams.get("cat")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);

  // 没选源：只列出有可用分类的源，不发任何出站请求
  if (!sourceId) {
    return {
      mode: "sources" as const,
      sources: await listSourcesWithExplore(db),
      result: null,
      error: null,
    };
  }

  try {
    return {
      mode: "books" as const,
      sources: [],
      result: await browseExplore(db, sourceId, category || null, page),
      error: null,
    };
  } catch (error) {
    return {
      mode: "books" as const,
      sources: [],
      result: null,
      error: error instanceof Error ? error.message : "浏览失败",
    };
  }
}

export default function ExploreSourcesPage({ loaderData }: Route.ComponentProps) {
  const [params] = useSearchParams();
  const { mode, sources, result, error } = loaderData;

  if (mode === "sources") {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="rounded-lg border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <Compass className="size-5 text-primary" />
            <h1 className="text-lg font-semibold">分类浏览</h1>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            按分类找书，不用先知道书名。没有搜索入口的源排在前面 —— 分类是它们唯一的进入方式。
          </p>
        </header>

        {sources.length === 0 ? (
          <EmptyState
            title="还没有带分类的源"
            description="导入书源后，带发现页规则的源会出现在这里"
            action={
              <Button asChild>
                <Link to="/admin/sources">去导入书源</Link>
              </Button>
            }
          />
        ) : (
          <ul className="space-y-2">
            {sources.map((source) => (
              <li key={source.id}>
                <Link
                  to={`/explore?source=${encodeURIComponent(source.id)}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 hover:bg-muted"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{source.name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {source.categoryCount} 个分类
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {!source.searchable && <Badge variant="outline">仅分类</Badge>}
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (error || !result) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          title="浏览失败"
          description={error ?? "没有取到书单"}
          action={
            <Button asChild>
              <Link to="/explore">换个源</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const currentSource = params.get("source") ?? "";
  const categoryHref = (title: string, page = 1) =>
    `/explore?source=${encodeURIComponent(currentSource)}&cat=${encodeURIComponent(title)}&page=${page}`;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/explore">
              <ChevronLeft className="size-4" />
              全部源
            </Link>
          </Button>
          <h1 className="text-lg font-semibold">{result.sourceName}</h1>
        </div>

        {/* 分类标签。当前分类高亮，切换即换 URL，刷新也停在同一处 */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {result.categories.map((item) => (
            <Button
              key={item.title}
              variant={item.title === result.category ? "default" : "outline"}
              size="sm"
              asChild
            >
              <Link to={categoryHref(item.title)}>
                <Tag className="size-3.5" />
                {item.title}
              </Link>
            </Button>
          ))}
        </div>
      </header>

      {result.books.length === 0 ? (
        <EmptyState
          title="这个分类没取到书"
          description="可能是源站改版，或这一页确实为空。换个分类或换个源试试。"
        />
      ) : (
        <section className="rounded-lg border border-border bg-surface p-2">
          <ul className="divide-y divide-border/60">
            {result.books.map((book) => (
              <li key={book.url}>
                {/* 点进去就是已有的详情页，目录、阅读、书架全部复用 */}
                <Link
                  to={`/source/${result.sourceId}/book?url=${encodeSourceRef(
                    book.url
                  )}&title=${encodeURIComponent(book.title)}`}
                  className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted"
                >
                  <BookOpenText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{book.title}</span>
                    {book.author && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {book.author}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 翻页：分类地址带页码，或页面上探测到下一页时才显示 */}
      {(result.page > 1 || result.hasMore) && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={result.page <= 1}
            asChild={result.page > 1}
          >
            {result.page > 1 ? (
              <Link to={categoryHref(result.category ?? "", result.page - 1)}>
                <ChevronLeft className="size-4" />
                上一页
              </Link>
            ) : (
              <span>
                <ChevronLeft className="size-4" />
                上一页
              </span>
            )}
          </Button>
          <span className="text-xs text-muted-foreground">第 {result.page} 页</span>
          <Button variant="outline" size="sm" disabled={!result.hasMore} asChild={result.hasMore}>
            {result.hasMore ? (
              <Link to={categoryHref(result.category ?? "", result.page + 1)}>
                下一页
                <ChevronRight className="size-4" />
              </Link>
            ) : (
              <span>
                下一页
                <ChevronRight className="size-4" />
              </span>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
