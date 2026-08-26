import { Link } from "react-router";
import { BookOpenText, RefreshCw } from "lucide-react";
import type { Route } from "./+types/source-book";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getLiveToc } from "~/server/sources/live-read";
import { loginRedirectTo } from "~/server/http/request-path";
import { redirect } from "react-router";

/**
 * 在线源上某本书的目录页。
 *
 * 目录现抓（带 R2 缓存），不建 books/chapters —— 搜到就能点开看，
 * 不需要先订阅再发布。想长期收进书库时才用「订阅」。
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  // 抓取会产生出站请求，必须登录后才能触发
  if (!session?.user) return redirect(loginRedirectTo(new URL(request.url)));

  const url = new URL(request.url);
  const bookUrl = url.searchParams.get("url")?.trim() ?? "";
  const title = url.searchParams.get("title")?.trim() ?? "未命名";
  const sourceId = params.sourceId ?? "";
  if (!bookUrl) return { error: "缺少书籍地址", title, sourceId, bookUrl: "", toc: null };

  const db = createDb(env.DB_APP);
  try {
    const toc = await getLiveToc(db, env.R2_CONTENT, sourceId, bookUrl);
    return { error: null, title, sourceId, bookUrl, toc };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "目录抓取失败",
      title,
      sourceId,
      bookUrl,
      toc: null,
    };
  }
}

export default function SourceBookPage({ loaderData }: Route.ComponentProps) {
  const { toc, title, error, sourceId, bookUrl } = loaderData;

  if (error || !toc) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="打不开这本书"
          description={error ?? "目录为空"}
          action={
            <Button asChild>
              <Link to="/search">返回搜索</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <BookOpenText className="size-5 text-primary" />
          <h1 className="text-lg font-semibold">{title}</h1>
          <Badge variant="secondary">{toc.sourceName}</Badge>
          {toc.fromCache && <Badge variant="outline">缓存</Badge>}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          共 {toc.chapters.length} 章 · 内容来自在线源，点击章节即时抓取
        </p>
        <div className="mt-3 flex gap-2">
          {toc.chapters[0] && (
            <Button size="sm" asChild>
              <Link
                to={`/source/${sourceId}/chapter?key=${encodeURIComponent(
                  toc.chapters[0].key
                )}&title=${encodeURIComponent(title)}&book=${encodeURIComponent(bookUrl)}&i=0`}
              >
                从第一章开始
              </Link>
            </Button>
          )}
          <Button size="sm" variant="secondary" asChild>
            {/* 目录有缓存，加 refresh 参数绕过 */}
            <a href={`?url=${encodeURIComponent(bookUrl)}&title=${encodeURIComponent(title)}`}>
              <RefreshCw className="size-4" />
              刷新目录
            </a>
          </Button>
        </div>
      </header>

      <section className="rounded-lg border border-border bg-surface p-2">
        <ul className="divide-y divide-border/60">
          {toc.chapters.map((chapter, index) => (
            <li key={chapter.key}>
              <Link
                to={`/source/${sourceId}/chapter?key=${encodeURIComponent(
                  chapter.key
                )}&title=${encodeURIComponent(title)}&book=${encodeURIComponent(
                  bookUrl
                )}&i=${index}`}
                className="block truncate px-3 py-2.5 text-sm hover:bg-muted"
              >
                {chapter.title}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
