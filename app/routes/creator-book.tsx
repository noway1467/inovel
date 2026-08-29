import { useEffect, useState } from "react";
import { Link } from "react-router";
import { BookOpen, ChevronLeft, ExternalLink, Loader2, Save, Send, Trash2 } from "lucide-react";
import type { Route } from "./+types/creator-book";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { Switch } from "~/components/ui/switch";
import { EmptyState } from "~/components/state/empty-state";
import { pageMeta, pageTitle } from "~/lib/page-title";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { ensureAuthorProfile } from "~/server/creator/profile";
import { bookTags, books, chapters, tags } from "drizzle/schema";
import { asc, eq } from "drizzle-orm";
import { listEnabledCategories } from "~/server/repositories/categories";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return {
      user: null,
      book: null,
      chapterRows: [],
      categories: [],
      penName: "",
      currentTags: [],
      availableTags: [],
    };
  }
  const db = createDb(env.DB_APP);
  const author = await ensureAuthorProfile(db, session.user.id);
  const book = await db
    .select()
    .from(books)
    .where(eq(books.id, params.bookId ?? ""))
    .get();
  if (!book || book.authorId !== author?.id) {
    return {
      user: session.user,
      book: null,
      chapterRows: [],
      categories: [],
      penName: "",
      currentTags: [],
      availableTags: [],
    };
  }
  const categories = await listEnabledCategories(db);
  const tagRows = await db
    .select({ name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(bookTags.tagId, tags.id))
    .where(eq(bookTags.bookId, book.id));
  const availableTags = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.enabled, true))
    .orderBy(asc(tags.name));
  const chapterRows = await db
    .select({
      id: chapters.id,
      title: chapters.title,
      status: chapters.status,
      sortOrder: chapters.sortOrder,
      rejectedReason: chapters.rejectedReason,
    })
    .from(chapters)
    .where(eq(chapters.bookId, book.id))
    .orderBy(asc(chapters.sortOrder));
  return {
    user: session.user,
    book,
    chapterRows,
    categories,
    penName: book?.authorName ?? "",
    currentTags: tagRows.map((row) => row.name),
    availableTags,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.book?.title;
  return pageMeta(pageTitle(title, "作品管理"));
}

const statusText: Record<string, string> = {
  draft: "草稿",
  pending_review: "审核中",
  approved: "已通过",
  published: "已发布",
  suspended: "已下架",
  archived: "已归档",
};

const chapterStatusText: Record<string, string> = {
  draft: "草稿",
  pending_review: "审核中",
  rejected: "已退回",
  published: "已发布",
};

export default function CreatorBookPage({ loaderData }: Route.ComponentProps) {
  const { book, chapterRows, categories, penName, currentTags, availableTags } = loaderData;

  const [penNameValue, setPenNameValue] = useState(penName);
  const [title, setTitle] = useState(book?.title ?? "");
  const [description, setDescription] = useState(book?.description ?? "");
  const [categoryId, setCategoryId] = useState(book?.categoryId ?? "");
  const [categoryName, setCategoryName] = useState("");
  const [serialStatus, setSerialStatus] = useState<"ongoing" | "completed">(
    book?.serialStatus === "completed" ? "completed" : "ongoing"
  );
  const [tagsText, setTagsText] = useState(currentTags.join("，"));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [acting, setActing] = useState(false);
  const directPublishStorageKey = loaderData.user
    ? `creator-book-direct-publish:${loaderData.user.id}`
    : "";
  const [directPublish, setDirectPublish] = useState(false);
  const [chapterPage, setChapterPage] = useState(1);
  const chapterPageSize = 100;

  useEffect(() => {
    if (!directPublishStorageKey || typeof localStorage === "undefined") return;
    const stored = localStorage.getItem(directPublishStorageKey);
    if (stored !== null) setDirectPublish(stored === "1");
  }, [directPublishStorageKey]);

  function updateDirectPublish(value: boolean) {
    setDirectPublish(value);
    if (directPublishStorageKey && typeof localStorage !== "undefined") {
      localStorage.setItem(directPublishStorageKey, value ? "1" : "0");
    }
  }

  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="登录后管理作品"
          action={
            <Button asChild>
              <Link to="/login?redirect=/creator">去登录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="作品不存在或无权限"
          action={
            <Button asChild>
              <Link to="/creator">返回工作台</Link>
            </Button>
          }
        />
      </div>
    );
  }

  async function saveBook(): Promise<boolean> {
    if (!book) return false;
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(`/api/creator/books/${book.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          authorName: penNameValue,
          categoryId: categoryId || null,
          categoryName: categoryName.trim() || undefined,
          serialStatus,
          tags: tagsText
            .split(/[,，、\s]+/)
            .map((name) => name.trim())
            .filter(Boolean),
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "保存失败");
        return false;
      }
      setMessage("已保存");
      return true;
    } catch {
      setMessage("网络异常，保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitAll() {
    if (!book) return;
    setActing(true);
    setMessage("");
    try {
      const saved = await saveBook();
      if (!saved) return;
      const endpoint = directPublish ? "publish-all" : "submit-all";
      const response = await fetch(`/api/creator/books/${book.id}/${endpoint}`, { method: "POST" });
      const data = (await response.json()) as {
        error?: string;
        submitted?: number;
        published?: number;
      };
      if (!response.ok) {
        setMessage(
          `作品信息已保存；${data.error ?? (directPublish ? "直接发布失败" : "提交失败")}`
        );
        return;
      }
      const count = directPublish ? data.published ?? 0 : data.submitted ?? 0;
      if (count === 0) {
        setMessage(
          directPublish ? "没有需要直接发布的章节，作品信息已保存" : "没有需要提交审核的章节，作品信息已保存"
        );
        return;
      }
      setMessage(directPublish ? "已直接发布并更新作品状态" : "已提交审核，刷新列表中…");
      window.location.reload();
    } finally {
      setActing(false);
    }
  }

  async function submitChapter(chapterId: string) {
    setActing(true);
    setMessage("");
    try {
      const endpoint = directPublish ? "publish" : "submit";
      const response = await fetch(`/api/creator/chapters/${chapterId}/${endpoint}`, {
        method: "POST",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "提交失败");
        return;
      }
      window.location.reload();
    } finally {
      setActing(false);
    }
  }

  function parseTagNames(value: string) {
    return [
      ...new Set(
        value
          .split(/[,\uFF0C\u3001\s]+/)
          .map((name) => name.trim())
          .filter(Boolean)
      ),
    ].slice(0, 10);
  }

  function toggleTag(tagName: string) {
    const current = parseTagNames(tagsText);
    const next = current.includes(tagName)
      ? current.filter((name) => name !== tagName)
      : [...current, tagName].slice(0, 10);
    setTagsText(next.join("\uFF0C"));
  }

  async function deleteBook() {
    if (!book) return;
    if (!window.confirm(`确定删除《${book.title}》吗？删除后公开页面不可见。`)) return;
    setActing(true);
    setMessage("");
    try {
      let response: Response;
      try {
        response = await fetch(`/api/creator/books/${book.id}`, { method: "DELETE" });
      } catch (error) {
        setMessage(error instanceof Error ? `删除失败：${error.message}` : "删除失败，请稍后重试");
        return;
      }
      let data: { error?: string } = {};
      try {
        data = (await response.json()) as { error?: string };
      } catch {
        data = {};
      }
      if (!response.ok) {
        setMessage(data.error ?? "删除失败，请稍后重试");
        return;
      }
      window.location.assign("/creator");
    } finally {
      setActing(false);
    }
  }

  async function togglePublication() {
    if (!book) return;
    setActing(true);
    setMessage("");
    try {
      const response = await fetch(`/api/creator/books/${book.id}/toggle-publication`, {
        method: "POST",
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "操作失败");
        return;
      }
      window.location.reload();
    } finally {
      setActing(false);
    }
  }

  const chapterPageCount = Math.max(1, Math.ceil(chapterRows.length / chapterPageSize));
  const visibleChapters = chapterRows.slice(
    (chapterPage - 1) * chapterPageSize,
    chapterPage * chapterPageSize
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/creator">
                <ChevronLeft className="size-4" />
                工作台
              </Link>
            </Button>
            <h1 className="truncate text-xl font-semibold">{book.title}</h1>
            <Badge variant={book.status === "published" ? "success" : "secondary"}>
              {statusText[book.status] ?? book.status}
            </Badge>
          </div>
          <p className="mt-1 pl-9 text-sm text-muted-foreground">
            {book.wordCount.toLocaleString()} 字 · 最新：{book.latestChapterTitle ?? "无章节"}
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link to={`/books/${book.id}`}>
            <ExternalLink className="size-4" />
            查看公开页
          </Link>
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={acting} onClick={togglePublication}>
            {book.status === "suspended" ? "重新上架" : "下架作品"}
          </Button>
          <Button size="sm" onClick={submitAll} disabled={acting}>
            {acting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            {directPublish ? "全部直接发布" : "全部提交审核"}
          </Button>
          <Button size="sm" variant="danger" onClick={deleteBook} disabled={acting}>
            <Trash2 className="size-4" />
            删除作品
          </Button>
        </div>
      </div>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-4 text-base font-semibold">作品信息</h2>
        <div className="grid gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="pen-name">作者名（仅本书）</Label>
            <Input
              id="pen-name"
              value={penNameValue}
              onChange={(event) => setPenNameValue(event.target.value)}
              maxLength={30}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="book-title">书名</Label>
            <Input
              id="book-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="book-description">简介</Label>
            <Textarea
              id="book-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={6}
              maxLength={2000}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="book-category">分类</Label>
              <Select
                value={categoryId || "__none__"}
                onValueChange={(value) => {
                  setCategoryId(value === "__none__" ? "" : value);
                  setCategoryName("");
                }}
              >
                <SelectTrigger id="book-category">
                  <SelectValue placeholder="选择已有分类" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">暂不分类</SelectItem>
                  {categories.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={categoryName}
                onChange={(event) => {
                  setCategoryName(event.target.value);
                  if (event.target.value) setCategoryId("");
                }}
                placeholder="没有合适分类？输入后自动创建"
                maxLength={20}
                aria-label="自定义分类"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="book-serial-status">连载状态</Label>
              <Select
                value={serialStatus}
                onValueChange={(value) => setSerialStatus(value as "ongoing" | "completed")}
              >
                <SelectTrigger id="book-serial-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ongoing">连载中</SelectItem>
                  <SelectItem value="completed">已完结</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="book-tags">标签（逗号分隔，最多 10 个）</Label>
            <Input
              id="book-tags"
              value={tagsText}
              onChange={(event) => setTagsText(event.target.value)}
              placeholder="输入新标签会自动创建，例如：玄幻、热血、成长"
              maxLength={200}
            />
            <p className="text-xs text-muted-foreground">
              支持自定义标签，最多 10 个；也可以点击已有标签快速选择。
            </p>
            {availableTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {availableTags.slice(0, 24).map((tag) => {
                  const selected = parseTagNames(tagsText).includes(tag.name);
                  return (
                    <Button
                      key={tag.id}
                      type="button"
                      variant={selected ? "secondary" : "ghost"}
                      size="sm"
                      className="h-7 rounded-full px-2.5 text-xs"
                      onClick={() => toggleTag(tag.name)}
                    >
                      {tag.name}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/25 p-4">
            <div>
              <Label htmlFor="direct-publish" className="text-sm font-semibold">
                无需审核，直接更新状态
              </Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                开启后，单章或全部发布会直接上线，并自动处理待审核状态。
              </p>
            </div>
            <Switch
              id="direct-publish"
              checked={directPublish}
              onCheckedChange={updateDirectPublish}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={submitAll} disabled={saving || acting}>
              {saving || acting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {saving || acting ? "保存并发布中…" : "保存并发布"}
            </Button>
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 text-base font-semibold">章节（{chapterRows.length}）</h2>
        {chapterRows.length === 0 ? (
          <EmptyState
            title="还没有章节"
            description="去上传页导入小说生成章节草稿。"
            action={
              <Button asChild>
                <Link to="/creator/upload">去导入</Link>
              </Button>
            }
          />
        ) : (
          <div className="max-h-96 space-y-1 overflow-y-auto">
            {visibleChapters.map((chapter) => (
              <div
                key={chapter.id}
                className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background p-2.5"
              >
                <Link
                  to={`/creator/books/${book.id}/chapters/${chapter.id}`}
                  className="flex min-w-0 flex-1 items-center gap-3 transition-colors hover:opacity-80"
                >
                  <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{chapter.title}</span>
                  {chapter.status === "rejected" && chapter.rejectedReason && (
                    <span
                      className="max-w-48 truncate text-xs text-danger"
                      title={chapter.rejectedReason}
                    >
                      {chapter.rejectedReason}
                    </span>
                  )}
                </Link>
                <Badge
                  variant={
                    chapter.status === "published"
                      ? "success"
                      : chapter.status === "pending_review"
                        ? "warning"
                        : chapter.status === "rejected"
                          ? "danger"
                          : "secondary"
                  }
                >
                  {chapterStatusText[chapter.status] ?? chapter.status}
                </Badge>
                {((directPublish &&
                  ["draft", "rejected", "pending_review"].includes(chapter.status)) ||
                  (!directPublish && ["draft", "rejected"].includes(chapter.status))) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={acting}
                    onClick={() => submitChapter(chapter.id)}
                  >
                    <Send className="size-3.5" />
                    {directPublish ? "直接发布" : "提交审核"}
                  </Button>
                )}
              </div>
            ))}
            {chapterPageCount > 1 && (
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={chapterPage <= 1}
                  onClick={() => setChapterPage((page) => Math.max(1, page - 1))}
                >
                  上一页
                </Button>
                <span className="text-xs text-muted-foreground">
                  第 {chapterPage} / {chapterPageCount} 页
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={chapterPage >= chapterPageCount}
                  onClick={() => setChapterPage((page) => Math.min(chapterPageCount, page + 1))}
                >
                  下一页
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
