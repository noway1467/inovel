import { useCallback, useEffect, useRef, useState } from "react";
import { Link, redirect, useNavigate } from "react-router";
import {
  ArrowUpDown,
  BookmarkCheck,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  List,
  Maximize,
  Minimize,
  Settings,
} from "lucide-react";
import type { Route } from "./+types/source-chapter";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { EmptyState } from "~/components/state/empty-state";
import { PagedText } from "~/components/reader/paged-text";
import { ReaderSettingsPanel } from "~/components/reader/reader-settings-panel";
import {
  defaultReaderSettings,
  loadReaderSettings,
  normalizePaginationMode,
  normalizeReaderTheme,
  resolveReaderTheme,
  saveReaderSettings,
  systemDarkQuery,
  type ReaderSettings,
} from "~/components/reader/reader-settings";
import { decodeSourceRef, encodeSourceRef } from "~/lib/source-ref";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getLiveChapter, getLiveToc } from "~/server/sources/live-read";
import { getPreferences } from "~/server/services/reader";
import { getSourceReadingState } from "~/server/services/source-reading";
import { loginRedirectTo } from "~/server/http/request-path";

/**
 * 目录抽屉每页章数。500 是权衡：再多手机上滑动掉帧，再少千章的书要翻十几页。
 * 定位当前章和渲染分页共用，写死两处会悄悄脱节。
 */
const tocPageSize = 500;

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
  // 参数是编码后的 token，见 lib/source-ref
  const chapterKey = decodeSourceRef(url.searchParams.get("key") ?? "");
  const bookTitle = url.searchParams.get("title")?.trim() ?? "未命名";
  const bookUrl = decodeSourceRef(url.searchParams.get("book") ?? "");
  const index = Number.parseInt(url.searchParams.get("i") ?? "", 10);
  const sourceId = params.sourceId ?? "";

  if (!chapterKey) {
    return { error: "缺少章节地址", bookTitle, bookUrl, sourceId, chapter: null, nav: null };
  }

  const db = createDb(env.DB_APP);
  try {
    // 目录多半已缓存，顺带取来算上下章；阅读偏好与书架状态一起取，省往返
    const [chapter, toc, preferences, state] = await Promise.all([
      getLiveChapter(db, env.R2_CONTENT, sourceId, chapterKey),
      bookUrl ? getLiveToc(db, env.R2_CONTENT, sourceId, bookUrl).catch(() => null) : null,
      getPreferences(db, session.user.id).catch(() => null),
      bookUrl
        ? getSourceReadingState(db, session.user.id, sourceId, bookUrl).catch(() => null)
        : null,
    ]);

    let nav: {
      title: string;
      prev: { key: string; index: number } | null;
      next: { key: string; index: number } | null;
      position: string;
      currentIndex: number;
      totalChapters: number;
    } | null = null;
    // 目录给阅读页内的目录抽屉用，与本地阅读器一致
    let chapters: { key: string; title: string }[] = [];

    if (toc) {
      chapters = toc.chapters;
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
        currentIndex: at,
        totalChapters: toc.chapters.length,
      };
    }

    return {
      error: null,
      bookTitle,
      bookUrl,
      sourceId,
      chapter,
      nav,
      chapters,
      preferences,
      inShelf: Boolean(state?.shelved),
      // 同一章续读时恢复页码；换章就从头开始
      resumePageIndex:
        state?.lastChapterKey === chapterKey ? (state?.lastPageIndex ?? 0) : 0,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "正文抓取失败",
      bookTitle,
      bookUrl,
      sourceId,
      chapter: null,
      nav: null,
      chapters: [] as { key: string; title: string }[],
      preferences: null,
      inShelf: false,
      resumePageIndex: 0,
    };
  }
}

export default function SourceChapterPage({ loaderData }: Route.ComponentProps) {
  const {
    chapter,
    nav,
    // loader 顶部有 redirect 分支，联合类型里 chapters 可能缺；
    // 目录定位的 hook 在提前 return 之前跑，必须有值
    chapters = [],
    bookTitle,
    bookUrl,
    sourceId,
    error,
    preferences,
  } = loaderData;
  const navigate = useNavigate();

  const [settings, setSettings] = useState<ReaderSettings>(defaultReaderSettings);
  const [systemDark, setSystemDark] = useState(false);
  const [pageIndex, setPageIndex] = useState<number>(loaderData.resumePageIndex ?? 0);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageCount: 1 });
  const [uiVisible, setUiVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [tocDescending, setTocDescending] = useState(false);
  const [tocPage, setTocPage] = useState(0);
  const currentTocRef = useRef<HTMLAnchorElement | null>(null);
  const [inShelf, setInShelf] = useState(loaderData.inShelf);
  const [shelfPending, setShelfPending] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 复用本地阅读器的设置，字号/行距/主题在两处保持一致；
  // 服务端偏好优先，与本地阅读器同一套归一化逻辑
  useEffect(() => {
    const stored = loadReaderSettings();
    if (preferences) {
      setSettings({
        ...defaultReaderSettings,
        ...stored,
        theme: normalizeReaderTheme(preferences.theme, stored.theme),
        fontSize: preferences.fontSize ?? stored.fontSize,
        lineHeight: preferences.lineHeight ?? stored.lineHeight,
        paginationMode: normalizePaginationMode(preferences.paginationMode, stored.paginationMode),
      });
      return;
    }
    setSettings(stored);
  }, [preferences]);

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
    saveReaderSettings(settings);
  }, [resolvedTheme, settings]);

  // 换章时回到续读页（同章续读）或第一页
  useEffect(() => {
    setPageIndex(loaderData.resumePageIndex ?? 0);
  }, [chapter?.chapterKey, loaderData.resumePageIndex]);

  // 进页面先亮一下上下栏告诉读者控件在哪，随后自动收起
  useEffect(() => {
    setUiVisible(true);
    hideTimer.current = setTimeout(() => setUiVisible(false), 2500);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const chapterLink = useCallback(
    (target: { key: string; index: number }) =>
      `/source/${sourceId}/chapter?key=${encodeSourceRef(
        target.key
      )}&title=${encodeURIComponent(bookTitle)}&book=${encodeSourceRef(bookUrl)}&i=${target.index}`,
    [sourceId, bookTitle, bookUrl]
  );

  const tocHref = `/source/${sourceId}/book?url=${encodeSourceRef(
    bookUrl
  )}&title=${encodeURIComponent(bookTitle)}`;

  /** 书架与进度都打到 /api/sources/reading，键是 (sourceId, bookUrl) */
  const postReading = useCallback(
    (payload: Record<string, unknown>) =>
      fetch("/api/sources/reading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId,
          bookUrl,
          bookTitle,
          sourceName: chapter?.sourceName ?? null,
          chapterCount: nav?.totalChapters ?? null,
          ...payload,
        }),
      }),
    [sourceId, bookUrl, bookTitle, chapter?.sourceName, nav?.totalChapters]
  );

  /**
   * 记录读到哪一章第几页。
   *
   * 防抖 1.2 秒：连续翻页不该每页打一次接口。bookUrl 为空（直接带 key 进来、
   * 没带 book 参数）时不记 —— 那种情况没法定位是哪本书。
   */
  useEffect(() => {
    if (!chapter?.chapterKey || !bookUrl) return;
    const timer = setTimeout(() => {
      void postReading({
        action: "progress",
        chapterKey: chapter.chapterKey,
        chapterTitle: nav?.title ?? null,
        chapterIndex: nav?.currentIndex ?? null,
        pageIndex: pagination.pageIndex,
      }).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [chapter?.chapterKey, bookUrl, nav?.title, nav?.currentIndex, pagination.pageIndex, postReading]);

  /**
   * 打开目录时先跳到当前章所在那一页。
   *
   * 之前抽屉总是停在第一章 —— 读到第八百章想看看前后有什么，得自己翻十几页。
   * 换章、切正倒序后当前章所在页也会变，所以这几个都要跟。
   *
   * 放在提前 return（error / !chapter）之前：hook 必须每次渲染都调用，
   * 顺序不能变。所以这里用 chapter?.chapterKey 而不是解构后的值。
   */
  const currentTocIndex = chapters.findIndex((item) => item.key === chapter?.chapterKey);
  useEffect(() => {
    if (!tocOpen || currentTocIndex < 0) return;
    const position = tocDescending ? chapters.length - 1 - currentTocIndex : currentTocIndex;
    setTocPage(Math.floor(position / tocPageSize));
  }, [tocOpen, currentTocIndex, tocDescending, chapters.length]);

  /** 跳到正确页之后，再把当前章滚到视野中间 */
  useEffect(() => {
    if (!tocOpen) return;
    // 等抽屉动画和列表渲染完，否则量到的位置是旧的
    const frame = requestAnimationFrame(() => {
      currentTocRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [tocOpen, tocPage, tocDescending]);

  async function toggleShelf() {
    if (!bookUrl || shelfPending) return;
    setShelfPending(true);
    const next = !inShelf;
    try {
      const response = await postReading({ action: next ? "shelve" : "unshelve" });
      if (response.ok) setInShelf(next);
    } catch {
      // 网络失败就保持原状，不谎报成功
    } finally {
      setShelfPending(false);
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }
    void document.documentElement.requestFullscreen().catch(() => {});
  }

  /** 点正文中间三分之一切换上下栏，两侧交给 PagedText 翻页 */
  function onSurfaceClick(event: React.MouseEvent) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    if (ratio < 0.33 || ratio > 0.67) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setUiVisible((visible) => !visible);
  }

  if (error || !chapter) {
    return (
      <div className="mx-auto mt-10 max-w-md">
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

  /**
   * 目录抽屉的倒序与分页。
   *
   * 每页 500 章：千章的书全铺在抽屉里，打开就卡一下。
   * 序号用章节真实位置，倒序只改显示顺序 —— 否则倒序时「第 1 章」指向最后一章。
   */
  const orderedToc = chapters.map((item, index) => ({ item, index }));
  if (tocDescending) orderedToc.reverse();
  const tocPageCount = Math.max(1, Math.ceil(orderedToc.length / tocPageSize));
  const tocSafePage = Math.min(tocPage, tocPageCount - 1);
  const visibleToc = orderedToc.slice(tocSafePage * tocPageSize, (tocSafePage + 1) * tocPageSize);

  return (
    <div
      data-reader-theme={resolvedTheme}
      data-ui-visible={uiVisible ? "true" : "false"}
      className="reader-surface relative flex h-dvh flex-col overflow-hidden"
    >
      <style>{`html, body { background: var(--reader-bg); }`}</style>

      {/* 上下栏绝对定位、可整条滑出：正文因此能占满整屏 */}
      <header
        className={`absolute inset-x-0 top-0 z-30 border-b border-black/10 bg-[var(--reader-bg)]/95 backdrop-blur transition-transform duration-200 ${
          uiVisible ? "translate-y-0" : "-translate-y-full"
        }`}
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex h-12 items-center gap-1 px-2">
          <Button variant="ghost" size="icon-sm" aria-label="返回目录" asChild>
            <Link to={tocHref}>
              <ChevronLeft className="size-5" />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{bookTitle}</p>
            <p className="truncate text-xs opacity-70">
              {nav?.title || chapter.sourceName}
              {chapter.fromCache && " · 缓存"}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="目录" onClick={() => setTocOpen(true)}>
            <List className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={inShelf ? "移出书架" : "加入书架"}
            aria-pressed={inShelf}
            title={inShelf ? "移出书架" : "加入书架"}
            disabled={shelfPending || !bookUrl}
            onClick={() => void toggleShelf()}
          >
            {inShelf ? (
              <BookmarkCheck className="size-5 text-primary" />
            ) : (
              <BookmarkPlus className="size-5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="阅读设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={isFullscreen ? "退出全屏" : "全屏"}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <Minimize className="size-5" /> : <Maximize className="size-5" />}
          </Button>
        </div>
      </header>

      {/* 正文占满整屏，上下留出安全边距免得被浮栏压住首末行 */}
      <main
        className="relative z-0 min-h-0 flex-1 px-3"
        style={{
          paddingTop: "max(3.25rem,env(safe-area-inset-top))",
          paddingBottom: "max(3.25rem,env(safe-area-inset-bottom))",
        }}
        onClick={onSurfaceClick}
      >
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

      <footer
        className={`absolute inset-x-0 bottom-0 z-30 border-t border-black/10 bg-[var(--reader-bg)]/95 backdrop-blur transition-transform duration-200 ${
          uiVisible ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex h-12 items-center justify-between gap-2 px-2">
          {/* 不在首页时先翻页，到首页才显示「上一章」 */}
          {isFirstPage ? (
            <Button size="sm" variant="ghost" disabled={!nav?.prev} asChild={Boolean(nav?.prev)}>
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
            <Button size="sm" variant="ghost" onClick={() => setPageIndex((v) => v - 1)}>
              <ChevronLeft className="size-4" />
              上一页
            </Button>
          )}

          <span className="text-xs opacity-70">
            {pagination.pageIndex + 1}/{pagination.pageCount} 页
            {nav?.position && ` · ${nav.position} 章`}
          </span>

          {/* 末页才变成「下一章」，之前一直是「下一页」 */}
          {isLastPage ? (
            <Button size="sm" variant="ghost" disabled={!nav?.next} asChild={Boolean(nav?.next)}>
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
            <Button size="sm" variant="ghost" onClick={() => setPageIndex((v) => v + 1)}>
              下一页
              <ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      </footer>

      <ReaderSettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onChange={setSettings}
      />

      {/* 目录抽屉：章节列表 loader 已经取到，不必再请求 */}
      <Sheet open={tocOpen} onOpenChange={setTocOpen}>
        <SheetContent side="left" className="max-w-[420px]">
          <SheetHeader>
            <SheetTitle>目录（{chapters.length} 章）</SheetTitle>
          </SheetHeader>
          <SheetBody className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setTocDescending((v) => !v)}
                aria-label={tocDescending ? "切换为正序" : "切换为倒序"}
              >
                <ArrowUpDown className="size-4" />
                {tocDescending ? "倒序" : "正序"}
              </Button>
              {tocPageCount > 1 && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={tocSafePage === 0}
                    onClick={() => setTocPage(Math.max(0, tocSafePage - 1))}
                  >
                    上一页
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {tocSafePage + 1}/{tocPageCount}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={tocSafePage >= tocPageCount - 1}
                    onClick={() => setTocPage(Math.min(tocPageCount - 1, tocSafePage + 1))}
                  >
                    下一页
                  </Button>
                </div>
              )}
            </div>
            <ScrollArea className="h-[calc(100dvh-8rem)]">
              <ul className="divide-y divide-border/60">
                {visibleToc.map(({ item, index }) => {
                  const current = item.key === chapter.chapterKey;
                  return (
                    <li key={`${item.key}-${index}`}>
                      <Link
                        ref={current ? currentTocRef : undefined}
                        to={chapterLink({ key: item.key, index })}
                        onClick={() => setTocOpen(false)}
                        className={`flex items-baseline gap-2 px-4 py-2.5 text-sm hover:bg-muted ${
                          current ? "font-semibold text-primary" : ""
                        }`}
                      >
                        {/* 序号是章节真实位置，倒序只改显示顺序 */}
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {index + 1}
                        </span>
                        <span className="truncate">{item.title}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
