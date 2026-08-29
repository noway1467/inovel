import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, PrefetchPageLinks, redirect, useNavigate } from "react-router";
import {
  BookmarkCheck,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  List,
  Maximize,
  Minimize,
  Settings,
} from "lucide-react";
import type { Route } from "./+types/reader";
import { Button } from "~/components/ui/button";
import { ReaderSettingsPanel } from "~/components/reader/reader-settings-panel";
import { ReaderToc } from "~/components/reader/reader-toc";
import {
  defaultReaderSettings,
  loadLocalProgress,
  loadReaderSettings,
  normalizePaginationMode,
  normalizeReaderTheme,
  resolveLineHeight,
  resolveReaderTheme,
  resolveSideInset,
  systemDarkQuery,
  saveLocalProgress,
  saveReaderSettings,
  type LocalProgress,
  type ReaderSettings,
} from "~/components/reader/reader-settings";
import { pageMeta, pageTitle } from "~/lib/page-title";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getChapterMeta, getChapterNavigation } from "~/server/repositories/books";
import { canPreviewUnpublished } from "~/server/security/chapter-access";
import { isBookInShelf } from "~/server/repositories/shelf";
import { getPreferences, getProgress } from "~/server/services/reader";
import { getChapterContent } from "~/server/storage/chapter-content";
import { chapterVersionKey } from "~/server/storage/keys";
import { loginRedirectTo } from "~/server/http/request-path";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const bookId = params.bookId ?? "";
  const chapterId = params.chapterId ?? "";
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  const url = new URL(request.url);
  if (!session?.user) {
    return redirect(loginRedirectTo(url));
  }
  const userId = session.user.id;
  const db = createDb(env.DB_APP);
  const chapter = await getChapterMeta(db, chapterId);
  if (!chapter || chapter.bookId !== bookId) throw new Response("章节不存在", { status: 404 });

  // 未发布章节只对作者本人和审核/管理角色开放。
  // 此前阅读页完全不校验 status，任何登录用户改 URL 即可读到别人的草稿。
  const canPreview =
    chapter.status === "published"
      ? false
      : await canPreviewUnpublished(db, userId, chapter.bookAuthorId);
  if (chapter.status !== "published" && !canPreview) {
    throw new Response("章节不可阅读", { status: 404 });
  }
  if (!chapter.currentVersionId) throw new Response("章节内容未就绪", { status: 404 });

  // 目录不再进入首屏负载；剩下五件事互不依赖，并行发出以压掉串行往返
  const [navigation, content, progress, preferences, inShelf] = await Promise.all([
    getChapterNavigation(db, bookId, chapter.sortOrder, canPreview),
    getChapterContent(
      env.R2_CONTENT,
      chapterVersionKey(bookId, chapterId, chapter.currentVersionId)
    ),
    getProgress(db, userId, bookId),
    getPreferences(db, userId),
    // 顶栏书架按钮要显示当前状态，命中唯一索引的单行查询
    isBookInShelf(db, userId, bookId),
  ]);

  if (!content) throw new Response("章节内容未就绪", { status: 404 });
  if (content.paragraphs.length > 8000 || (chapter.wordCount ?? 0) > 1_000_000) {
    throw new Response("章节过大，暂时无法渲染", { status: 413 });
  }

  return {
    chapter,
    content,
    prev: navigation.prev,
    next: navigation.next,
    progress,
    preferences,
    inShelf,
    currentIndex: navigation.currentIndex,
    totalChapters: navigation.totalChapters,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const chapter = loaderData?.chapter;
  if (!chapter) return pageMeta(pageTitle("阅读"));
  return pageMeta(pageTitle(chapter.title, chapter.bookTitle));
}

export default function ReaderPage({ loaderData }: Route.ComponentProps) {
  const { chapter, content, prev, next, progress, preferences, currentIndex, totalChapters } =
    loaderData;
  const [inShelf, setInShelf] = useState(loaderData.inShelf);
  const [shelfPending, setShelfPending] = useState(false);
  // 系统深浅色偏好，仅在 theme === "system" 时参与解析
  const [systemDark, setSystemDark] = useState(false);
  const navigate = useNavigate();
  const [settings, setSettings] = useState<ReaderSettings>(defaultReaderSettings);
  const [uiVisible, setUiVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [currentParagraphId, setCurrentParagraphId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [turning, setTurning] = useState(false);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [flash, setFlash] = useState("");
  const [sliderIndex, setSliderIndex] = useState(currentIndex);
  // 待恢复的阅读锚点，以及分页是否已完成首次测量（用章节 ID 标记，防止跨章误用）
  const [pendingAnchor, setPendingAnchor] = useState<{
    chapterId: string;
    anchor: string | null;
  } | null>(null);
  const [measuredFor, setMeasuredFor] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const paginationRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSyncAt = useRef(0);
  const bookId = chapter.bookId;

  const isPaginated = settings.paginationMode !== "scroll";
  // 单页分页：每屏只显示一页，翻页步长与页宽一致
  const pageWidth = Math.max(1, viewport.width);
  const pageStep = pageWidth;
  const turnCount = Math.max(1, pageCount);

  useEffect(() => {
    const stored = loadReaderSettings();
    if (preferences) {
      setSettings({
        ...defaultReaderSettings,
        ...stored,
        // 服务端存的是自由文本，老库里有 "sepia" 这类早期值；硬转会让
        // data-reader-theme 落到 CSS 匹配不到的值上，阅读器直接没配色
        theme: normalizeReaderTheme(preferences.theme, stored.theme),
        fontSize: preferences.fontSize ?? stored.fontSize,
        lineHeight: preferences.lineHeight ?? stored.lineHeight,
        paginationMode: normalizePaginationMode(preferences.paginationMode, stored.paginationMode),
      });
    } else {
      setSettings(stored);
    }
  }, [preferences]);

  // settings.theme 可能是 "system"，而 CSS 只认具体配色，所以落 DOM 前先解析
  const resolvedTheme = resolveReaderTheme(settings.theme, systemDark);

  useEffect(() => {
    document.documentElement.setAttribute("data-reader-theme", resolvedTheme);
    saveReaderSettings(settings);
  }, [resolvedTheme, settings]);

  // 跟随系统时要响应系统深浅色切换，否则得重进页面才生效
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(systemDarkQuery);
    setSystemDark(query.matches);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!mainRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(mainRef.current);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!isPaginated) {
      const animationFrame = requestAnimationFrame(() => setPageCount(1));
      return () => cancelAnimationFrame(animationFrame);
    }
    const viewportElement = scrollRef.current;
    const contentElement = paginationRef.current;
    if (!viewportElement || !contentElement) return;

    let animationFrame = 0;
    const updatePageCount = () => {
      const width = viewportElement.clientWidth;
      if (width <= 0) return;
      const columnWidth = Math.max(1, width);
      const nextPageCount = Math.max(1, Math.round(contentElement.scrollWidth / columnWidth));
      setPageCount((current) => (current === nextPageCount ? current : nextPageCount));
      setPageIndex((current) => Math.min(current, nextPageCount - 1));
      // 通知锚点恢复：本章页数已量准
      setMeasuredFor(chapter.id);
    };
    const scheduleUpdate = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(updatePageCount);
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(viewportElement);
    observer.observe(contentElement);
    scheduleUpdate();
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [chapter.id, content.paragraphs, isPaginated, settings, viewport.width, viewport.height]);

  const pageAnchor = useCallback(
    (index: number) => {
      const paragraphIndex = Math.min(
        content.paragraphs.length - 1,
        Math.floor((index / Math.max(1, pageCount)) * content.paragraphs.length)
      );
      return content.paragraphs[Math.max(0, paragraphIndex)]?.id ?? null;
    },
    [content.paragraphs, pageCount]
  );

  // 换章时读出要恢复的锚点。
  // 恢复动作只做一次：原来这段依赖 pageCount，而 pageCount 由 ResizeObserver 重算，
  // 于是手机地址栏收起、工具栏显隐等任何尺寸变化都会把读者弹回锚点所在页。
  useEffect(() => {
    const local = loadLocalProgress(bookId);
    const source =
      local?.chapterId === chapter.id
        ? local
        : progress?.chapterId === chapter.id
          ? progress
          : null;
    scrollRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setCurrentParagraphId(source?.paragraphAnchor ?? null);
    setPendingAnchor({ chapterId: chapter.id, anchor: source?.paragraphAnchor ?? null });
    setPageIndex(0);
  }, [bookId, chapter.id, progress]);

  // 滚动模式：锚点就绪即可定位，与分页测量无关
  useEffect(() => {
    if (isPaginated || !pendingAnchor || pendingAnchor.chapterId !== chapter.id) return;
    const anchor = pendingAnchor.anchor;
    setPendingAnchor(null);
    if (!anchor) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [chapter.id, isPaginated, pendingAnchor]);

  // 分页模式：等首次测量出真实页数后再落到锚点所在页，然后就不再干预
  useEffect(() => {
    if (!isPaginated || !pendingAnchor || pendingAnchor.chapterId !== chapter.id) return;
    if (measuredFor !== chapter.id) return;
    const anchor = pendingAnchor.anchor;
    setPendingAnchor(null);
    if (!anchor) return;
    const paragraphIndex = content.paragraphs.findIndex((paragraph) => paragraph.id === anchor);
    if (paragraphIndex < 0) return;
    const index = Math.floor(
      (paragraphIndex / Math.max(1, content.paragraphs.length)) * Math.max(1, pageCount)
    );
    setPageIndex(Math.max(0, Math.min(index, Math.max(1, pageCount) - 1)));
  }, [chapter.id, content.paragraphs, isPaginated, measuredFor, pageCount, pendingAnchor]);

  // 滚动模式锚点观察
  useEffect(() => {
    if (settings.paginationMode !== "scroll") return;
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setCurrentParagraphId(visible[0].target.id);
      },
      { root, rootMargin: "-35% 0px -55% 0px", threshold: 0 }
    );
    for (const paragraph of content.paragraphs) {
      const node = document.getElementById(paragraph.id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [content.paragraphs, settings.paginationMode]);

  const persistProgress = useCallback(
    (anchor: string | null) => {
      const chapterProgress = anchor
        ? Math.round(
            (content.paragraphs.findIndex((p) => p.id === anchor) /
              Math.max(1, content.paragraphs.length)) *
              100
          )
        : 0;
      const bookProgress =
        totalChapters > 0 ? Math.round(((currentIndex + 1) / totalChapters) * 100) : 0;
      const local: LocalProgress = {
        bookId,
        chapterId: chapter.id,
        paragraphAnchor: anchor,
        charOffset: 0,
        chapterProgress,
        bookProgress,
        updatedAt: new Date().toISOString(),
        version: progress?.version ?? 0,
      };
      saveLocalProgress(bookId, local);

      const now = Date.now();
      if (now - lastSyncAt.current > 5000) {
        lastSyncAt.current = now;
        void fetch("/api/reader/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(local),
        }).catch(() => {});
      }
    },
    [bookId, chapter.id, content.paragraphs, currentIndex, progress?.version, totalChapters]
  );

  useEffect(() => {
    if (!currentParagraphId) return;
    const timer = setTimeout(() => persistProgress(currentParagraphId), 1200);
    return () => clearTimeout(timer);
  }, [currentParagraphId, persistProgress]);

  const hideUi = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setUiVisible(false);
  }, []);

  /** 常显，不自动收起：由点击屏幕中心显式切换。 */
  const showUi = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setUiVisible(true);
  }, []);

  // 进入页面先亮一下，让读者知道栏在哪，随后自动收起
  useEffect(() => {
    setUiVisible(true);
    hideTimer.current = setTimeout(() => setUiVisible(false), 3500);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const goPage = useCallback(
    (delta: number) => {
      if (!isPaginated || turning) return;
      if (delta > 0 && pageIndex >= turnCount - 1) {
        if (next) {
          if (turnTimer.current) clearTimeout(turnTimer.current);
          setTurning(false);
          navigate(`/read/${bookId}/${next.id}`);
        }
        return;
      }
      if (delta < 0 && pageIndex <= 0) {
        if (prev) {
          if (turnTimer.current) clearTimeout(turnTimer.current);
          setTurning(false);
          navigate(`/read/${bookId}/${prev.id}`);
        }
        return;
      }
      const nextIndex = Math.min(turnCount - 1, Math.max(0, pageIndex + delta));
      if (nextIndex === pageIndex) return;
      const anchor = pageAnchor(nextIndex);
      if (settings.paginationMode !== "cover") {
        if (anchor) {
          setCurrentParagraphId(anchor);
          persistProgress(anchor);
        }
        setPageIndex(nextIndex);
        return;
      }
      setTurning(true);
      if (turnTimer.current) clearTimeout(turnTimer.current);
      turnTimer.current = setTimeout(() => {
        if (anchor) {
          setCurrentParagraphId(anchor);
          persistProgress(anchor);
        }
        setPageIndex(nextIndex);
        setTurning(false);
      }, 90);
    },
    [
      bookId,
      isPaginated,
      navigate,
      next,
      pageAnchor,
      pageIndex,
      persistProgress,
      prev,
      settings.paginationMode,
      turnCount,
      turning,
    ]
  );

  useEffect(() => {
    return () => {
      if (turnTimer.current) clearTimeout(turnTimer.current);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  // 章节切换后把进度条拨回真实位置（拖动期间用本地值，避免回弹）
  useEffect(() => {
    setSliderIndex(currentIndex);
  }, [currentIndex]);

  // 换章/换书后服务端状态回流，同步本地开关
  useEffect(() => {
    setInShelf(loaderData.inShelf);
  }, [loaderData.inShelf]);

  // 跳章：目录已不在前端，用序号问一次服务端换取章节 ID
  const jumpToIndex = useCallback(
    async (targetIndex: number) => {
      if (targetIndex === currentIndex) return;
      try {
        const response = await fetch(`/api/books/${bookId}/toc?index=${targetIndex}`);
        if (!response.ok) throw new Error("jump failed");
        const data = (await response.json()) as { chapterId?: string };
        if (data.chapterId) navigate(`/read/${bookId}/${data.chapterId}`);
      } catch {
        setSliderIndex(currentIndex);
        setFlash("跳转失败，请重试");
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlash(""), 1600);
      }
    },
    [bookId, currentIndex, navigate]
  );

  const flashMessage = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(""), 1600);
  }, []);

  /**
   * 顶栏书架开关。
   *
   * 原来这个位置是「添加书签」：每点一次往 localStorage 和 bookmarks 表塞一条，
   * 站内没有任何地方能查看书签列表，等于只写不读。改成加入/移出书架，
   * 和作品详情页那颗按钮同一套语义。
   */
  const toggleShelf = useCallback(async () => {
    if (shelfPending) return;
    const nextInShelf = !inShelf;
    setShelfPending(true);
    setInShelf(nextInShelf);
    try {
      const response = await fetch("/api/library/shelf", {
        method: nextInShelf ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId }),
      });
      if (!response.ok) {
        setInShelf(!nextInShelf);
        flashMessage(response.status === 401 ? "请先登录" : "操作失败，请重试");
        return;
      }
      flashMessage(nextInShelf ? "已加入书架" : "已移出书架");
    } catch {
      setInShelf(!nextInShelf);
      flashMessage("网络异常，请重试");
    } finally {
      setShelfPending(false);
    }
  }, [bookId, flashMessage, inShelf, shelfPending]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement);
      setIsFullscreen(active);
      // 进全屏收起让正文占满，退出时恢复
      if (active) hideUi();
      else showUi();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [hideUi, showUi]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setTocOpen(false);
        return;
      }
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        goPage(-1);
      } else if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        goPage(1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        if (settings.paginationMode === "scroll") scrollRef.current?.scrollBy({ top: 48 });
        else goPage(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (settings.paginationMode === "scroll") scrollRef.current?.scrollBy({ top: -48 });
        else goPage(-1);
      } else if (event.key.toLowerCase() === "f") {
        toggleFullscreen();
      } else if (event.key.toLowerCase() === "s") {
        // 原来 m 键加书签，书签功能已移除，改成 s 切换书架
        void toggleShelf();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goPage, settings.paginationMode, toggleFullscreen, toggleShelf]);

  /**
   * 左右三成翻页，中间四成切换上下栏。
   *
   * 原来鼠标一移进正文就把栏亮出来（onMouseMove），桌面端等于常显、挡正文；
   * 现在只认点击，且只认屏幕中心那一段。
   */
  function onMainClick(event: React.MouseEvent<HTMLDivElement>) {
    /*
      划词的收尾点击既不该翻页也不该切栏。原来这道判断在翻页之后，
      开着「正文可复制」在左右两侧选字，松手就翻走了 —— 选区连着一起丢。
    */
    if ((window.getSelection()?.toString().length ?? 0) > 0) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    if (isPaginated) {
      if (ratio < 0.3) {
        goPage(-1);
        return;
      }
      if (ratio > 0.7) {
        goPage(1);
        return;
      }
    } else if (ratio < 0.3 || ratio > 0.7) {
      // 滚动模式两侧不翻页，但同样不该触发上下栏
      return;
    }
    if (uiVisible) hideUi();
    else showUi();
  }

  const touchStartX = useRef<number | null>(null);

  function onTouchStart(event: React.TouchEvent) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function onTouchEnd(event: React.TouchEvent) {
    if (touchStartX.current == null) return;
    const deltaX = (event.changedTouches[0]?.clientX ?? touchStartX.current) - touchStartX.current;
    if (Math.abs(deltaX) > 60 && isPaginated) {
      goPage(deltaX > 0 ? -1 : 1);
    }
    touchStartX.current = null;
  }

  const chapterProgress = isPaginated
    ? pageCount > 0
      ? Math.round((Math.min(pageCount, pageIndex + 1) / pageCount) * 100)
      : 0
    : currentParagraphId
      ? Math.round(
          (content.paragraphs.findIndex((p) => p.id === currentParagraphId) /
            Math.max(1, content.paragraphs.length)) *
            100
        )
      : 0;

  const bodyStyle = {
    fontSize: `${settings.fontSize}px`,
    lineHeight: resolveLineHeight(settings.lineHeight),
    textAlign: settings.align === "justify" ? ("justify" as const) : ("left" as const),
    letterSpacing: settings.letterSpacing === "wide" ? "0.06em" : "0",
    textIndent: settings.indent === "2char" ? "2em" : "0",
  };

  /**
   * 正文左右留白。
   *
   * 分页模式加在段落上（容器本身是多列，给容器加内边距会被每一列重复），
   * 滚动模式加在 article 上。两处都用同一个表达式，切换翻页模式时留白不变。
   */
  const sideInset = resolveSideInset(settings);

  // 上下栏同进同出：去掉 uiZone 后不再有"只亮顶部/只亮底部"的边缘悬停态
  const headerVisible = uiVisible;
  const footerVisible = uiVisible;

  return (
    <div
      ref={mainRef}
      data-reader-theme={resolvedTheme}
      data-ui-visible={uiVisible ? "true" : "false"}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      className="reader-surface relative flex h-dvh flex-col overflow-hidden"
    >
      <style>{`html, body { background: var(--reader-bg); }`}</style>

      <header
        className={`absolute inset-x-0 top-0 z-30 border-b border-black/10 bg-[var(--reader-bg)]/95 backdrop-blur transition-transform duration-200 ${
          headerVisible ? "translate-y-0" : "-translate-y-full"
        }`}
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex h-12 items-center gap-1 px-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="返回作品详情"
            onClick={() => navigate(`/books/${bookId}`)}
          >
            <ChevronLeft className="size-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{chapter.bookTitle}</p>
            <p className="truncate text-xs opacity-70">{chapter.title}</p>
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
            disabled={shelfPending}
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

      <main
        ref={scrollRef}
        onClick={onMainClick}
        /*
          正文可复制关掉时连键盘复制一起挡：user-select 只拦鼠标划选，
          Ctrl+A / Ctrl+C 照样能把整章带走。
        */
        onCopy={settings.allowCopy ? undefined : (event) => event.preventDefault()}
        className={`reader-viewport relative z-0 flex-1 overflow-x-hidden ${
          settings.allowCopy ? "select-text" : "select-none"
        } ${
          isPaginated
            ? "cursor-pointer overflow-y-hidden"
            : "cursor-auto overflow-y-auto pt-[max(3.5rem,env(safe-area-inset-top))] pb-[max(4.5rem,env(safe-area-inset-bottom))]"
        }`}
      >
        {isPaginated ? (
          <>
            <div
              ref={paginationRef}
              data-reader-pagination
              className="reader-body h-full"
              style={{
                ...bodyStyle,
                height: "100%",
                // 显式锁宽高只在量到真实尺寸后才加：首帧 viewport 还是 0，
                // blockSize:0 会把正文切成上千个空列
                ...(viewport.width > 0 && viewport.height > 0
                  ? {
                      width: `${pageWidth}px`,
                      inlineSize: `${pageWidth}px`,
                      blockSize: `${viewport.height}px`,
                    }
                  : null),
                columnWidth: `${pageWidth}px`,
                columnGap: 0,
                columnRule: "0 none transparent",
                columnFill: "auto",
                paddingTop: "max(3.5rem,env(safe-area-inset-top))",
                paddingBottom: "max(4.5rem,env(safe-area-inset-bottom))",
                transform: `translateX(-${pageIndex * pageStep}px)`,
              }}
            >
              <h1
                className="mb-8 text-center text-[1.4em] font-semibold"
                style={{
                  marginLeft: sideInset,
                  marginRight: sideInset,
                  textIndent: 0,
                  letterSpacing: 0,
                }}
              >
                {chapter.title}
              </h1>
              {content.paragraphs.map((paragraph) => (
                <p
                  key={paragraph.id}
                  id={paragraph.id}
                  data-paragraph-id={paragraph.id}
                  style={{
                    marginBottom: `${settings.paragraphSpacing / 100}em`,
                    marginLeft: sideInset,
                    marginRight: sideInset,
                  }}
                >
                  {paragraph.text}
                </p>
              ))}
            </div>
            <div
              aria-hidden
              className={`pointer-events-none absolute inset-0 z-10 bg-[var(--reader-bg)] transition-opacity duration-100 ${
                turning ? "opacity-100" : "opacity-0"
              }`}
            />
            <p
              className="reader-page-indicator pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 text-sm opacity-50"
              style={{ textIndent: 0, letterSpacing: 0 }}
            >
              第 {pageIndex + 1} / {pageCount} 页
            </p>
          </>
        ) : (
          // 不套 max-w + mx-auto：内边距的百分数按包含块（这里是 main）宽度解析，
          // 而 max-w 会让 article 比 main 窄，两个宽度不一致时留白就对不上 ——
          // 正文宽度改由 sideInset 里的行长上限收，与分页模式同一把尺子。
          <article
            className="reader-body min-h-full w-full"
            style={{
              ...bodyStyle,
              paddingLeft: sideInset,
              paddingRight: sideInset,
            }}
          >
            <h1
              className="mb-8 text-center text-[1.4em] font-semibold"
              style={{ textIndent: 0, letterSpacing: 0 }}
            >
              {chapter.title}
            </h1>
            {content.paragraphs.map((paragraph) => (
              <p
                key={paragraph.id}
                id={paragraph.id}
                data-paragraph-id={paragraph.id}
                style={{ marginBottom: `${settings.paragraphSpacing / 100}em` }}
              >
                {paragraph.text}
              </p>
            ))}
          </article>
        )}
      </main>

      <footer
        className={`absolute inset-x-0 bottom-0 z-30 border-t border-black/10 bg-[var(--reader-bg)]/95 backdrop-blur transition-transform duration-200 ${
          footerVisible ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex h-14 items-center gap-2 px-3">
          {/* prefetch=intent：指针悬停/聚焦即预取下一章数据，点下去基本无等待。
              没有相邻章时渲染真正的 disabled button，而不是套着 disabled 的 span。 */}
          {prev ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/read/${bookId}/${prev.id}`} prefetch="intent">
                <ChevronLeft className="size-4" />
                上一章
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled>
              <ChevronLeft className="size-4" />
              上一章
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <input
              type="range"
              min={0}
              max={Math.max(0, totalChapters - 1)}
              value={sliderIndex}
              aria-label="全书章节进度"
              aria-valuetext={`第 ${sliderIndex + 1} / ${totalChapters} 章`}
              // 拖动只动本地值，松手/抬键才跳章，避免拖过程中每一格都触发一次导航
              onChange={(event) => setSliderIndex(Number(event.target.value))}
              onPointerUp={() => void jumpToIndex(sliderIndex)}
              onKeyUp={(event) => {
                if (event.key.startsWith("Arrow") || event.key.startsWith("Page")) {
                  void jumpToIndex(sliderIndex);
                }
              }}
              className="w-full accent-[var(--reader-fg)]"
            />
            <div className="flex justify-between text-[11px] opacity-60">
              <span>本章 {chapterProgress}%</span>
              <span>
                第 {sliderIndex + 1}/{totalChapters} 章
              </span>
            </div>
          </div>
          {next ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/read/${bookId}/${next.id}`} prefetch="intent">
                下一章
                <ChevronRight className="size-4" />
              </Link>
            </Button>
          ) : (
            <Button variant="ghost" size="sm" disabled>
              下一章
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
      <ReaderToc
        open={tocOpen}
        onOpenChange={setTocOpen}
        bookId={bookId}
        currentChapterId={chapter.id}
      />

      {/* 顺序阅读时下一章命中率极高，进页面就预取，翻到章末几乎瞬时。
          用 PrefetchPageLinks 而不是隐藏 Link：只产出 <link>，不往 DOM 里塞多余的 <a>。 */}
      {next && <PrefetchPageLinks page={`/read/${bookId}/${next.id}`} />}

      {flash && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-40 -translate-x-1/2 rounded-md bg-foreground px-3 py-2 text-sm text-background shadow-lg">
          {flash}
        </div>
      )}
    </div>
  );
}
