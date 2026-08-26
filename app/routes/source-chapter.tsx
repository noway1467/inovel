import { useCallback, useEffect, useState } from "react";
import { Link, redirect, useNavigate } from "react-router";
import { ChevronLeft, ChevronRight, List, Minus, Plus } from "lucide-react";
import type { Route } from "./+types/source-chapter";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/state/empty-state";
import { PagedText } from "~/components/reader/paged-text";
import {
  defaultReaderSettings,
  loadReaderSettings,
  resolveReaderTheme,
  saveReaderSettings,
  systemDarkQuery,
  type ReaderSettings,
} from "~/components/reader/reader-settings";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getLiveChapter, getLiveToc } from "~/server/sources/live-read";
import { loginRedirectTo } from "~/server/http/request-path";

/**
 * 在线源单章阅读页。
 *
 * 正文由适配器把该章的所有分页拼成完整一份（跟随 nextContentUrl，
 * 规则缺失时用通用探测兜底），到这里已经是全文；本页只负责把全文
 * 按屏分页显示 —— 翻到末页才进下一章，与本地导入的书行为一致。
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
    return { error: "缺少章节地址", bookTitle, bookUrl, sourceId, chapter: null, nav: null };
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
      position: string;
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
        position: at >= 0 ? `${at + 1}/${toc.chapters.length}` : "",
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
  const navigate = useNavigate();

  const [settings, setSettings] = useState<ReaderSettings>(defaultReaderSettings);
  const [systemDark, setSystemDark] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageCount: 1 });

  // 复用本地阅读器的设置，字号/行距/主题在两处保持一致
  useEffect(() => {
    setSettings(loadReaderSettings());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(systemDarkQuery);
    setSystemDark(query.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme = resolveReaderTheme(settings.theme, systemDark);
  useEffect(() => {
    document.documentElement.setAttribute("data-reader-theme", resolvedTheme);
  }, [resolvedTheme]);

  // 换章时回到第一页
  useEffect(() => {
    setPageIndex(0);
  }, [chapter?.chapterKey]);

  const chapterLink = useCallback(
    (target: { key: string; index: number }) =>
      `/source/${sourceId}/chapter?key=${encodeURIComponent(
        target.key
      )}&title=${encodeURIComponent(bookTitle)}&book=${encodeURIComponent(bookUrl)}&i=${target.index}`,
    [sourceId, bookTitle, bookUrl]
  );

  const tocHref = `/source/${sourceId}/book?url=${encodeURIComponent(
    bookUrl
  )}&title=${encodeURIComponent(bookTitle)}`;

  const adjustFontSize = (delta: number) => {
    setSettings((prev) => {
      const next = { ...prev, fontSize: Math.min(30, Math.max(12, prev.fontSize + delta)) };
      saveReaderSettings(next);
      return next;
    });
  };

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

  const isLastPage = pagination.pageIndex >= pagination.pageCount - 1;
  const isFirstPage = pagination.pageIndex <= 0;

  return (
    <div className="flex h-[calc(100dvh-8rem)] flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <Button size="sm" variant="ghost" asChild>
          <Link to={tocHref}>
            <List className="size-4" />
            目录
          </Link>
        </Button>
        <span className="truncate text-sm text-muted-foreground">{bookTitle}</span>
        <Badge variant="secondary">{chapter.sourceName}</Badge>
        {chapter.fromCache && <Badge variant="outline">缓存</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="缩小字号" onClick={() => adjustFontSize(-1)}>
            <Minus className="size-4" />
          </Button>
          <span className="w-8 text-center text-xs text-muted-foreground">{settings.fontSize}</span>
          <Button size="icon-sm" variant="ghost" aria-label="放大字号" onClick={() => adjustFontSize(1)}>
            <Plus className="size-4" />
          </Button>
        </div>
      </header>

      <main className="min-h-0 flex-1 py-3">
        <PagedText
          paragraphs={chapter.paragraphs}
          heading={nav?.title ?? null}
          fontSize={settings.fontSize}
          lineHeight={settings.lineHeight}
          pageIndex={pageIndex}
          onPageIndexChange={setPageIndex}
          onPaginationChange={setPagination}
          // 首页再往前 / 末页再往后时才跨章，与本地阅读器一致
          onOverflowPrev={() => {
            if (nav?.prev) navigate(chapterLink(nav.prev));
          }}
          onOverflowNext={() => {
            if (nav?.next) navigate(chapterLink(nav.next));
          }}
        />
      </main>

      <footer className="flex items-center justify-between gap-2 border-t border-border pt-2">
        {/* 不在首页时先翻页，到首页才显示「上一章」 */}
        {isFirstPage ? (
          <Button size="sm" variant="secondary" disabled={!nav?.prev} asChild={Boolean(nav?.prev)}>
            {nav?.prev ? (
              <Link to={chapterLink(nav.prev)}>
                <ChevronLeft className="size-4" />
                上一章
              </Link>
            ) : (
              <span>
                <ChevronLeft className="size-4" />
                上一章
              </span>
            )}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setPageIndex((v) => v - 1)}>
            <ChevronLeft className="size-4" />
            上一页
          </Button>
        )}

        <span className="text-xs text-muted-foreground">
          第 {pagination.pageIndex + 1}/{pagination.pageCount} 页
          {nav?.position && ` · 第 ${nav.position} 章`}
        </span>

        {/* 末页才变成「下一章」，之前一直是「下一页」 */}
        {isLastPage ? (
          <Button size="sm" disabled={!nav?.next} asChild={Boolean(nav?.next)}>
            {nav?.next ? (
              <Link to={chapterLink(nav.next)}>
                下一章
                <ChevronRight className="size-4" />
              </Link>
            ) : (
              <span>
                下一章
                <ChevronRight className="size-4" />
              </span>
            )}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setPageIndex((v) => v + 1)}>
            下一页
            <ChevronRight className="size-4" />
          </Button>
        )}
      </footer>
    </div>
  );
}
