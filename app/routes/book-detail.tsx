import { useEffect, useState } from "react";
import { Link, useNavigate, useRevalidator } from "react-router";
import { BookmarkCheck, BookmarkPlus, BookOpen, ChevronDown, ChevronUp, Share2 } from "lucide-react";
import type { Route } from "./+types/book-detail";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { BookCover } from "~/components/book/book-cover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { EmptyState } from "~/components/state/empty-state";
import { openBookLinkProps } from "~/lib/open-book";
import { pageMeta, pageTitle } from "~/lib/page-title";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getBook, listBookChapters, listPublishedBooks } from "~/server/repositories/books";
import { isBookInShelf } from "~/server/repositories/shelf";
import { canPreviewUnpublished } from "~/server/security/chapter-access";
import { getProgress } from "~/server/services/reader";
import { statusLabel } from "~/components/book/book-card";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);
  const book = await getBook(db, params.bookId ?? "");
  if (!book) throw new Response("作品不存在", { status: 404 });

  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id ?? null;

  // 作者/审核员可预览未发布章节，普通读者只看已发布的（否则目录里全是 404 入口）
  const canPreview = await canPreviewUnpublished(db, userId, book.authorId);

  const [volumes, relatedBooks, progress, inShelf] = await Promise.all([
    listBookChapters(db, book.id, canPreview),
    listPublishedBooks(db, 12),
    userId ? getProgress(db, userId, book.id) : null,
    // 书架状态必须由服务端给出，否则刷新后“已在书架”会退回“加入书架”
    userId ? isBookInShelf(db, userId, book.id) : false,
  ]);
  const related = relatedBooks.filter((item) => item.id !== book.id).slice(0, 4);

  return { book, volumes, related, progress, inShelf };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const book = loaderData?.book;
  if (!book) return pageMeta(pageTitle("作品详情"));
  // 作者名也进标题：同名小说很多，光看书名分不出是哪本
  return pageMeta(pageTitle(book.title, book.authorName), book.description);
}

export default function BookDetailPage({ loaderData }: Route.ComponentProps) {
  const { book, volumes, related, progress } = loaderData;
  const [expanded, setExpanded] = useState(false);
  const [inShelf, setInShelf] = useState(loaderData.inShelf);
  const [shelfPending, setShelfPending] = useState(false);
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  // 服务端状态回流后同步本地开关（切换作品、重新校验 loader 都会走到）
  useEffect(() => {
    setInShelf(loaderData.inShelf);
  }, [loaderData.inShelf]);
  const visibleChapters = volumes.flatMap((volume) => volume.chapters);
  const firstChapter = visibleChapters[0];
  const resumeChapter =
    progress && visibleChapters.some((chapter) => chapter.id === progress.chapterId)
      ? progress.chapterId
      : firstChapter?.id;

  // 同一个按钮负责加入/移出：此前无论什么状态都发 POST，
  // 所以“取消加入书架”点下去状态不变。
  async function toggleShelf() {
    if (shelfPending) return;
    const nextInShelf = !inShelf;
    setShelfPending(true);
    setInShelf(nextInShelf);
    try {
      const response = await fetch("/api/library/shelf", {
        method: nextInShelf ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId: book.id }),
      });
      if (response.status === 401) {
        setInShelf(!nextInShelf);
        navigate("/login?redirect=/books/" + book.id);
        return;
      }
      if (!response.ok) {
        setInShelf(!nextInShelf);
        return;
      }
      // 让书架页下次进入时拿到新数据，而不是命中旧 loader 缓存
      void revalidator.revalidate();
    } catch {
      setInShelf(!nextInShelf);
    } finally {
      setShelfPending(false);
    }
  }

  return (
    <div className="pb-24 md:pb-8">
      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="mx-auto w-40 md:w-full">
          <BookCover
            src={book.coverKey}
            title={book.title}
            author={book.authorName}
            className="aspect-[3/4]"
          />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold leading-snug">{book.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            <Link to={`/authors/${book.authorId}`} className="text-primary hover:underline">
              {book.authorName}
            </Link>
            {book.categoryName ? ` · ${book.categoryName}` : ""} ·{" "}
            {statusLabel(book.status, book.serialStatus)} · {book.wordCount.toLocaleString()} 字
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {book.tags.map((tag) => (
              <Link key={tag} to={`/search?q=${encodeURIComponent(tag)}`}>
                <Badge variant="secondary">{tag}</Badge>
              </Link>
            ))}
          </div>
          <div className="mt-4 rounded-lg border border-border bg-surface p-4">
            <p
              className={`text-sm leading-relaxed text-muted-foreground ${expanded ? "" : "line-clamp-4"}`}
            >
              {book.description || "暂无简介"}
            </p>
            {book.description && (book.description.length > 120 || expanded) && (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline"
              >
                {expanded ? "收起" : "展开"}
                {expanded ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/* 无可读章节时给真正的 disabled button：
                原来是给 Link 传 disabled，属性对 <a> 无效，点下去会跳到空章节 URL */}
            {resumeChapter ? (
              <Button asChild>
                <Link to={`/read/${book.id}/${resumeChapter}`} prefetch="intent">
                  <BookOpen className="size-4" />
                  {progress ? "继续阅读" : "开始阅读"}
                </Link>
              </Button>
            ) : (
              <Button disabled>
                <BookOpen className="size-4" />
                暂无可读章节
              </Button>
            )}
            <Button
              variant="outline"
              onClick={toggleShelf}
              disabled={shelfPending}
              aria-pressed={inShelf}
              title={inShelf ? "点击移出书架" : "点击加入书架"}
            >
              {inShelf ? (
                <BookmarkCheck className="size-4" />
              ) : (
                <BookmarkPlus className="size-4" />
              )}
              {inShelf ? "已在书架" : "加入书架"}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="分享作品"
              onClick={() => {
                void navigator.clipboard?.writeText(window.location.href);
              }}
            >
              <Share2 className="size-4" />
            </Button>
          </div>
          {book.status !== "published" && (
            <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {book.status === "draft" && "该作品尚未公开。"}
              {book.status === "pending_review" && "该作品正在审核中。"}
              {book.status === "suspended" && "该作品因内容调整暂时下架。"}
              {book.status === "archived" && "该作品已归档。"}
            </p>
          )}
        </div>
      </div>

      <Tabs defaultValue="chapters" className="mt-8">
        <TabsList>
          <TabsTrigger value="chapters">目录 {visibleChapters.length}</TabsTrigger>
          <TabsTrigger value="info">作品信息</TabsTrigger>
          <TabsTrigger value="reviews">书评</TabsTrigger>
        </TabsList>
        <TabsContent value="chapters">
          {volumes.length === 0 ? (
            <EmptyState title="暂无章节" description="作者上传章节并通过审核后会显示。" />
          ) : (
            <div className="space-y-4">
              {volumes.map((volume) => (
                <section key={volume.id}>
                  <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
                    {volume.title}
                  </h3>
                  <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {volume.chapters.map((chapter) => (
                      <Link
                        key={chapter.id}
                        to={`/read/${book.id}/${chapter.id}`}
                        className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-sm transition-colors hover:bg-muted"
                      >
                        <span className="line-clamp-1">{chapter.title}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {chapter.wordCount.toLocaleString()} 字
                        </span>
                      </Link>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="info">
          <div className="rounded-lg border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold">作者</h3>
            <div className="mt-2 flex items-center gap-3">
              <BookCover
                src={null}
                title={book.authorName}
                author=""
                className="size-12 rounded-full"
              />
              <div className="min-w-0">
                <Link
                  to={`/authors/${book.authorId}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {book.authorName}
                </Link>
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {book.authorBio || "这个作者很神秘，还没有写简介。"}
                </p>
              </div>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="reviews">
          <EmptyState title="暂无书评" description="书评功能将在后续版本开放。" />
        </TabsContent>
      </Tabs>

      {related.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">同类推荐</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {related.map((item, i) => (
              <Link key={item.id} to={`/books/${item.id}`} {...openBookLinkProps} className="min-w-0">
                <BookCover
                  src={item.coverKey}
                  title={item.title}
                  author={item.authorName}
                  seed={i}
                  className="aspect-[3/4] w-full"
                />
                <p className="mt-2 line-clamp-1 text-sm font-medium">{item.title}</p>
                <p className="line-clamp-1 text-xs text-muted-foreground">{item.authorName}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t border-border bg-surface/95 p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur md:hidden">
        {resumeChapter ? (
          <Button className="flex-1" asChild>
            <Link to={`/read/${book.id}/${resumeChapter}`} prefetch="intent">
              {progress ? "继续阅读" : "开始阅读"}
            </Link>
          </Button>
        ) : (
          <Button className="flex-1" disabled>
            暂无可读章节
          </Button>
        )}
        <Button
          variant="outline"
          className="flex-1"
          onClick={toggleShelf}
          disabled={shelfPending}
          aria-pressed={inShelf}
        >
          {inShelf ? "已在书架" : "加入书架"}
        </Button>
      </div>
    </div>
  );
}
