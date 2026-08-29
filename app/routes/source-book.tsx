import { useState } from "react";
import { Link } from "react-router";
import {
  ArrowUpDown,
  BookmarkCheck,
  BookmarkPlus,
  BookOpenText,
  Play,
  RefreshCw,
} from "lucide-react";
import type { Route } from "./+types/source-book";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/state/empty-state";
import { decodeSourceRef, encodeSourceRef } from "~/lib/source-ref";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getLiveToc } from "~/server/sources/live-read";
import { getSourceReadingState } from "~/server/services/source-reading";
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
  // 参数是编码后的 token，见 lib/source-ref
  const bookUrl = decodeSourceRef(url.searchParams.get("url") ?? "");
  const title = url.searchParams.get("title")?.trim() ?? "未命名";
  const sourceId = params.sourceId ?? "";
  // 「刷新目录」按钮带上它，跳过 30 分钟缓存重抓
  const refresh = url.searchParams.get("refresh") === "1";
  if (!bookUrl) {
    return {
      error: "缺少书籍地址",
      title,
      sourceId,
      bookUrl: "",
      toc: null,
      inShelf: false,
      lastRead: null,
    };
  }

  const db = createDb(env.DB_APP);
  try {
    // 书架状态与上次读到哪一起取，用于「继续阅读」
    const [toc, state] = await Promise.all([
      getLiveToc(db, env.R2_CONTENT, sourceId, bookUrl, refresh),
      getSourceReadingState(db, session.user.id, sourceId, bookUrl).catch(() => null),
    ]);
    return {
      error: null,
      title,
      sourceId,
      bookUrl,
      toc,
      inShelf: Boolean(state?.shelved),
      lastRead: state?.lastChapterKey
        ? {
            chapterKey: state.lastChapterKey,
            chapterTitle: state.lastChapterTitle,
            chapterIndex: state.lastChapterIndex,
          }
        : null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "目录抓取失败",
      title,
      sourceId,
      bookUrl,
      toc: null,
      inShelf: false,
      lastRead: null,
    };
  }
}

export default function SourceBookPage({ loaderData }: Route.ComponentProps) {
  const { toc, title, error, sourceId, bookUrl, lastRead } = loaderData;
  const [inShelf, setInShelf] = useState(loaderData.inShelf);
  const [shelfPending, setShelfPending] = useState(false);
  /**
   * 目录倒序与分页都放客户端：整份目录 loader 已经取到了（在线源的目录是
   * 一次抓完的），翻页再发请求纯属浪费，也会让已缓存的目录又走一遍网络。
   */
  const [descending, setDescending] = useState(false);
  const [tocPage, setTocPage] = useState(0);

  async function toggleShelf() {
    if (shelfPending) return;
    setShelfPending(true);
    const next = !inShelf;
    try {
      const response = await fetch("/api/sources/reading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId,
          bookUrl,
          bookTitle: title,
          sourceName: toc?.sourceName ?? null,
          chapterCount: toc?.chapters.length ?? null,
          action: next ? "shelve" : "unshelve",
        }),
      });
      if (response.ok) setInShelf(next);
    } catch {
      // 网络失败保持原状，不谎报成功
    } finally {
      setShelfPending(false);
    }
  }

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

  /**
   * 每页章数。500 是权衡：再多手机上滑动开始掉帧，再少则千章的书要翻十几页。
   * 序号始终是章节在书里的真实位置，倒序只改显示顺序，不改序号 ——
   * 否则倒序时点「第 1 章」跳到的是最后一章。
   */
  const tocPageSize = 500;
  const ordered = descending
    ? toc.chapters.map((chapter, index) => ({ chapter, index })).reverse()
    : toc.chapters.map((chapter, index) => ({ chapter, index }));
  const tocPageCount = Math.max(1, Math.ceil(ordered.length / tocPageSize));
  // 章数变化（换书、刷新目录）后页码可能越界
  const safePage = Math.min(tocPage, tocPageCount - 1);
  const visibleChapters = ordered.slice(safePage * tocPageSize, (safePage + 1) * tocPageSize);
  const tocRange = {
    from: visibleChapters.length > 0 ? visibleChapters[0]!.index + 1 : 0,
    to: visibleChapters.length > 0 ? visibleChapters[visibleChapters.length - 1]!.index + 1 : 0,
  };

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
          {lastRead?.chapterTitle && ` · 上次读到《${lastRead.chapterTitle}》`}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {/*
            读过就从上次那章续读，没读过才从第一章开始 —— 与本地书的
            「开始阅读」一致，不必让读者自己在目录里找位置。
          */}
          {(lastRead ?? toc.chapters[0]) && (
            <Button size="sm" asChild>
              <Link
                to={`/source/${sourceId}/chapter?key=${encodeSourceRef(
                  lastRead?.chapterKey ?? toc.chapters[0]!.key
                )}&title=${encodeURIComponent(title)}&book=${encodeSourceRef(bookUrl)}&i=${
                  lastRead?.chapterIndex ?? 0
                }`}
              >
                <Play className="size-4" />
                {lastRead ? "继续阅读" : "开始阅读"}
              </Link>
            </Button>
          )}
          <Button
            size="sm"
            variant={inShelf ? "secondary" : "outline"}
            aria-pressed={inShelf}
            disabled={shelfPending}
            onClick={() => void toggleShelf()}
          >
            {inShelf ? (
              <>
                <BookmarkCheck className="size-4 text-primary" />
                已在书架
              </>
            ) : (
              <>
                <BookmarkPlus className="size-4" />
                加入书架
              </>
            )}
          </Button>
          <Button size="sm" variant="secondary" asChild>
            <a href={bookUrl} target="_blank" rel="noopener noreferrer">
              查看源站页面
            </a>
          </Button>
          <Button size="sm" variant="secondary" asChild>
            {/* 目录缓存 30 分钟，refresh=1 跳过缓存重抓 */}
            <a
              href={`?url=${encodeSourceRef(bookUrl)}&title=${encodeURIComponent(
                title
              )}&refresh=1`}
            >
              <RefreshCw className="size-4" />
              刷新目录
            </a>
          </Button>
        </div>
      </header>

      <section className="rounded-lg border border-border bg-surface p-2">
        {/*
          分页与倒序条。千章以上的书整页铺开有几万个 DOM 节点，
          手机上滑动会卡，找最新章也得一路拉到底。
        */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-2 pb-2">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDescending((v) => !v);
                // 翻转后停在原来那一页没有意义，回第一页
                setTocPage(0);
              }}
            >
              <ArrowUpDown className="size-4" />
              {descending ? "倒序" : "正序"}
            </Button>
            <span className="text-xs text-muted-foreground">
              第 {tocRange.from}–{tocRange.to} 章
            </span>
          </div>

          {tocPageCount > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage === 0}
                onClick={() => setTocPage(Math.max(0, safePage - 1))}
              >
                上一页
              </Button>
              <span className="text-xs text-muted-foreground">
                {safePage + 1}/{tocPageCount}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={safePage >= tocPageCount - 1}
                onClick={() => setTocPage(Math.min(tocPageCount - 1, safePage + 1))}
              >
                下一页
              </Button>
            </div>
          )}
        </div>

        <ul className="divide-y divide-border/60">
          {visibleChapters.map(({ chapter, index }) => (
            <li key={chapter.key}>
              <Link
                to={`/source/${sourceId}/chapter?key=${encodeSourceRef(
                  chapter.key
                )}&title=${encodeURIComponent(title)}&book=${encodeSourceRef(
                  bookUrl
                )}&i=${index}`}
                className={`flex items-baseline gap-2 px-3 py-2.5 text-sm hover:bg-muted ${
                  chapter.key === lastRead?.chapterKey ? "font-semibold text-primary" : ""
                }`}
              >
                {/* 倒序时序号仍是章节在书里的真实位置，不跟着显示顺序变 */}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="truncate">{chapter.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
