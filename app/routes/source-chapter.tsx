import { Link, redirect } from "react-router";
import { ChevronLeft, ChevronRight, List } from "lucide-react";
import type { Route } from "./+types/source-chapter";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getLiveChapter, getLiveToc } from "~/server/sources/live-read";
import { loginRedirectTo } from "~/server/http/request-path";

/**
 * 在线源单章阅读页。正文现抓（带 R2 缓存），上下章靠目录里的序号推导。
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return redirect(loginRedirectTo(new URL(request.url)));

  const url = new URL(request.url);
  const chapterKey = url.searchParams.get("key")?.trim() ?? "";
  const bookTitle = url.searchParams.get("title")?.trim() ?? "未命名";
  const bookUrl = url.searchParams.get("book")?.trim() ?? "";
  const index = Number.parseInt(url.searchParams.get("i") ?? "", 10);
  const sourceId = params.sourceId ?? "";

  if (!chapterKey) {
    return {
      error: "缺少章节地址",
      bookTitle,
      bookUrl,
      sourceId,
      chapter: null,
      nav: null,
    };
  }

  const db = createDb(env.DB_APP);
  try {
    // 目录多半已缓存，顺带取来算上下章
    const [chapter, toc] = await Promise.all([
      getLiveChapter(db, env.R2_CONTENT, sourceId, chapterKey),
      bookUrl ? getLiveToc(db, env.R2_CONTENT, sourceId, bookUrl).catch(() => null) : null,
    ]);

    let nav: {
      title: string;
      prev: { key: string; index: number } | null;
      next: { key: string; index: number } | null;
    } | null = null;

    if (toc) {
      const at = Number.isFinite(index)
        ? index
        : toc.chapters.findIndex((item) => item.key === chapterKey);
      const prev = at > 0 ? toc.chapters[at - 1] : undefined;
      const next = at >= 0 && at < toc.chapters.length - 1 ? toc.chapters[at + 1] : undefined;
      nav = {
        title: toc.chapters[at]?.title ?? "",
        prev: prev ? { key: prev.key, index: at - 1 } : null,
        next: next ? { key: next.key, index: at + 1 } : null,
      };
    }

    return { error: null, bookTitle, bookUrl, sourceId, chapter, nav };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "正文抓取失败",
      bookTitle,
      bookUrl,
      sourceId,
      chapter: null,
      nav: null,
    };
  }
}

export default function SourceChapterPage({ loaderData }: Route.ComponentProps) {
  const { chapter, nav, bookTitle, bookUrl, sourceId, error } = loaderData;

  const tocHref = `/source/${sourceId}/book?url=${encodeURIComponent(
    bookUrl
  )}&title=${encodeURIComponent(bookTitle)}`;

  if (error || !chapter) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="这一章打不开"
          description={error ?? "正文为空"}
          action={
            <Button asChild>
              <Link to={bookUrl ? tocHref : "/search"}>返回目录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const chapterLink = (target: { key: string; index: number }) =>
    `/source/${sourceId}/chapter?key=${encodeURIComponent(
      target.key
    )}&title=${encodeURIComponent(bookTitle)}&book=${encodeURIComponent(bookUrl)}&i=${target.index}`;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Button size="sm" variant="ghost" asChild>
          <Link to={tocHref}>
            <List className="size-4" />
            目录
          </Link>
        </Button>
        <span className="truncate text-sm text-muted-foreground">{bookTitle}</span>
        <Badge variant="secondary">{chapter.sourceName}</Badge>
        {chapter.fromCache && <Badge variant="outline">缓存</Badge>}
      </header>

      <article className="space-y-4 text-[17px] leading-8">
        {nav?.title && <h1 className="text-lg font-semibold">{nav.title}</h1>}
        {chapter.paragraphs.map((text, i) => (
          <p key={`p${i}`}>{text}</p>
        ))}
      </article>

      <footer className="flex items-center justify-between gap-2 border-t border-border pt-3">
        {nav?.prev ? (
          <Button size="sm" variant="secondary" asChild>
            <Link to={chapterLink(nav.prev)}>
              <ChevronLeft className="size-4" />
              上一章
            </Link>
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled>
            <ChevronLeft className="size-4" />
            上一章
          </Button>
        )}
        {nav?.next ? (
          <Button size="sm" asChild>
            <Link to={chapterLink(nav.next)}>
              下一章
              <ChevronRight className="size-4" />
            </Link>
          </Button>
        ) : (
          <Button size="sm" disabled>
            下一章
            <ChevronRight className="size-4" />
          </Button>
        )}
      </footer>
    </div>
  );
}
