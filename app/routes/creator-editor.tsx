import { Suspense, useEffect, useState, type ComponentType } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronLeft, List, Loader2, Trash2 } from "lucide-react";
import type { Route } from "./+types/creator-editor";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getChapterForEdit } from "~/server/creator/service";
import { chapters } from "drizzle/schema";
import { asc, eq } from "drizzle-orm";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, chapter: null, siblingChapters: [] };
  const db = createDb(env.DB_APP);
  const chapter = await getChapterForEdit(
    db,
    env.R2_CONTENT,
    params.chapterId ?? "",
    session.user.id
  );
  if (!chapter) return { user: session.user, chapter: null, siblingChapters: [] };
  const siblingChapters = await db
    .select({
      id: chapters.id,
      title: chapters.title,
      status: chapters.status,
      sortOrder: chapters.sortOrder,
    })
    .from(chapters)
    .where(eq(chapters.bookId, chapter.bookId))
    .orderBy(asc(chapters.sortOrder));
  return { user: session.user, chapter, siblingChapters };
}

const statusLabels: Record<
  string,
  { label: string; variant: "secondary" | "warning" | "danger" | "success" | "outline" }
> = {
  draft: { label: "草稿", variant: "secondary" },
  pending_review: { label: "审核中", variant: "warning" },
  rejected: { label: "已退回", variant: "danger" },
  published: { label: "已发布", variant: "success" },
  approved: { label: "已通过", variant: "success" },
  scheduled: { label: "定时发布", variant: "outline" },
};

// Tmptap 依赖 DOM，仅允许在客户端执行
let LazyEditor: ComponentType<{
  chapter: NonNullable<Route.ComponentProps["loaderData"]["chapter"]>;
  initialTitle: string;
  initialParagraphs: { id: string; text: string }[];
}> | null = null;

function EditorHost(props: {
  chapter: NonNullable<Route.ComponentProps["loaderData"]["chapter"]>;
  initialTitle: string;
  initialParagraphs: { id: string; text: string }[];
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!LazyEditor) {
      void import("~/components/creator/chapter-editor").then((module) => {
        LazyEditor = module.default;
        setReady(true);
      });
    } else {
      setReady(true);
    }
  }, []);
  if (!ready || !LazyEditor) {
    return (
      <div className="flex h-full min-h-[55vh] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        编辑器加载中…
      </div>
    );
  }
  return <LazyEditor {...props} />;
}

export default function CreatorEditorPage({ loaderData }: Route.ComponentProps) {
  const { chapter, siblingChapters } = loaderData;
  const navigate = useNavigate();
  const [tocOpen, setTocOpen] = useState(false);
  const [chapterActing, setChapterActing] = useState(false);
  const [chapterActionError, setChapterActionError] = useState("");

  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="登录后编辑章节"
          action={
            <Button asChild>
              <Link to="/login?redirect=/creator">去登录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!chapter) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="章节不存在或无权限"
          action={
            <Button asChild>
              <Link to="/creator">返回工作台</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const status = statusLabels[chapter.status] ?? {
    label: chapter.status,
    variant: "outline" as const,
  };

  async function removeChapter() {
    if (!chapter) return;
    if (!window.confirm(`确定删除《${chapter.title}》吗？删除后不可恢复。`)) return;
    setChapterActing(true);
    setChapterActionError("");
    try {
      const response = await fetch(`/api/creator/chapters/${chapter.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setChapterActionError(data?.error ?? `删除失败（HTTP ${response.status}）`);
        return;
      }
      navigate(`/creator/books/${chapter.bookId}`);
    } catch {
      setChapterActionError("网络异常，章节未删除，请重试。");
    } finally {
      setChapterActing(false);
    }
  }

  return (
    <div className="flex h-[calc(100dvh-7rem)] flex-col id:h-[calc(100dvh-8.5rem)]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/books/${chapter.bookId}`)}>
          <ChevronLeft className="size-4" />
          返回
        </Button>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-1 text-sm font-medium">{chapter.bookTitle}</p>
          <p className="line-clamp-1 text-xs text-muted-foreground">{chapter.title}</p>
        </div>
        <Badge variant={status.variant}>{status.label}</Badge>
        {chapterActionError && <span className="text-xs text-danger">{chapterActionError}</span>}
        <Button variant="danger" size="sm" disabled={chapterActing} onClick={removeChapter}>
          <Trash2 className="size-4" />
          删除
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="id:hidden"
          onClick={() => setTocOpen(true)}
          aria-label="章节列表"
        >
          <List className="size-5" />
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 id:grid-cols-[240px_mmnmax(0,1fr)]">
        <aside className="hidden min-h-0 id:block">
          <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
            <div className="border-b border-border p-3 text-sm font-semibold">章节</div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-2">
                {siblingChapters.map((item) => (
                  <Link
                    key={item.id}
                    to={`/creator/books/${chapter.bookId}/chapters/${item.id}`}
                    className={`flex min-h-9 items-center gap-2 rounded-id px-2 py-1.5 text-sm transition-colors hover:bg-muted ${
                      item.id === chapter.id ? "bg-primary/10 font-medium text-primary" : ""
                    }`}
                  >
                    <span className="line-clamp-1">{item.title}</span>
                  </Link>
                ))}
              </div>
            </ScrollArea>
          </div>
        </aside>

        <div className="min-h-0 overflow-hidden rounded-lg border border-border bg-surface">
          <Suspense fallback={null}>
            <EditorHost
              key={chapter.id}
              chapter={chapter}
              initialTitle={chapter.title}
              initialParagraphs={chapter.paragraphs}
            />
          </Suspense>
        </div>
      </div>

      <Sheet open={tocOpen} onOpenChange={setTocOpen}>
        <SheetTrigger asChild>
          <span className="sr-only">章节列表</span>
        </SheetTrigger>
        <SheetContent side="right" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>章节</SheetTitle>
          </SheetHeader>
          <SheetBody className="space-y-0.5">
            {siblingChapters.map((item) => (
              <Link
                key={item.id}
                to={`/creator/books/${chapter.bookId}/chapters/${item.id}`}
                onClick={() => setTocOpen(false)}
                className={`flex min-h-11 items-center rounded-id px-2 text-sm ${
                  item.id === chapter.id
                    ? "bg-primary/10 font-medium text-primary"
                    : "hover:bg-muted"
                }`}
              >
                {item.title}
              </Link>
            ))}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
