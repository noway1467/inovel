import { useState } from "react";
import { Link } from "react-router";
import { Check, ChevronDown, ChevronLeft, Loader2, Send, Trash2, X } from "lucide-react";
import type { Route } from "./+types/admin-moderation";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Textarea } from "~/components/ui/textarea";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getUserRoleCodes } from "~/server/security/rbac";
import { listPendingReviewBookGroups } from "~/server/creator/service";
import { cn } from "~/lib/utils";

interface TaskSummary {
  id: string;
  bookId: string;
  chapterId: string;
  chapterTitle: string;
  createdAt: Date | string;
}

interface TaskDetail {
  id: string;
  bookId: string;
  chapterId: string;
  bookTitle: string;
  chapterTitle: string;
  chapterStatus: string;
  authorName: string;
  authorEmail: string;
  createdAt: string;
  content?: { paragraphs: { id: string; text: string }[] } | null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, admin: false, groups: [] };
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  const admin = roles.some((role) => ["moderator", "admin", "super_admin"].includes(role));
  // 首屏只加载按作品聚合的待审数量；展开时再懒加载该书任务，
  // 避免把上千条任务一次性序列化进页面导致卡顿
  return { user: session.user, admin, groups: admin ? await listPendingReviewBookGroups(db) : [] };
}

export default function AdminModerationPage({ loaderData }: Route.ComponentProps) {
  const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set());
  const [tasksByBook, setTasksByBook] = useState<Map<string, TaskSummary[]>>(new Map());
  const [loadingBooks, setLoadingBooks] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [reason, setReason] = useState("");
  const [acting, setActing] = useState(false);
  const [batchBusy, setBatchBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const groups = loaderData.groups;
  const totalPending = groups.reduce((sum, group) => sum + Number(group.pendingCount), 0);

  if (!loaderData.user || !loaderData.admin) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="需要审核权限"
          description="该页面仅限审核员与管理员访问。"
          action={
            <Button asChild>
              <Link to={loaderData.user ? "/admin" : "/login?redirect=/admin/moderation"}>
                {loaderData.user ? "返回管理后台" : "去登录"}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  async function loadBookTasks(bookId: string) {
    setLoadingBooks((prev) => new Set(prev).add(bookId));
    try {
      const response = await fetch(`/api/moderation/tasks?bookId=${encodeURIComponent(bookId)}`);
      const data = (await response.json()) as { tasks?: TaskSummary[]; error?: string };
      if (response.ok && data.tasks) {
        setTasksByBook((prev) => new Map(prev).set(bookId, data.tasks ?? []));
      } else {
        setMessage(data.error ?? "加载章节失败");
      }
    } finally {
      setLoadingBooks((prev) => {
        const next = new Set(prev);
        next.delete(bookId);
        return next;
      });
    }
  }

  function toggleExpand(bookId: string) {
    setExpandedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
        if (!tasksByBook.has(bookId)) void loadBookTasks(bookId);
      }
      return next;
    });
  }

  function toggleSelect(taskId: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  async function openTask(taskId: string) {
    setLoadingDetail(true);
    setMessage("");
    setReason("");
    try {
      const response = await fetch(`/api/moderation/tasks/${taskId}`);
      const data = (await response.json()) as { task?: TaskDetail; error?: string };
      if (response.ok && data.task) {
        setSelectedTask(data.task);
      } else {
        setMessage(data.error ?? "加载失败");
      }
    } finally {
      setLoadingDetail(false);
    }
  }

  async function decide(decision: "approve" | "reject") {
    if (!selectedTask) return;
    if (decision === "reject" && !reason.trim()) {
      setMessage("退回必须填写原因");
      return;
    }
    setActing(true);
    setMessage("");
    try {
      const response = await fetch(`/api/moderation/tasks/${selectedTask.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "处理失败");
        return;
      }
      setMessage(decision === "approve" ? "已通过并发布" : "已退回作者");
      setSelectedTask(null);
      window.location.reload();
    } finally {
      setActing(false);
    }
  }

  async function runApproveBook(bookId: string) {
    setBatchBusy(bookId);
    setMessage("");
    try {
      const response = await fetch("/api/moderation/tasks/batch-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookId, decision: "approve" }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "批量处理失败");
        return;
      }
      window.location.reload();
    } finally {
      setBatchBusy(null);
    }
  }

  async function deleteBook(bookId: string, bookTitle: string) {
    if (!window.confirm(`确定删除《${bookTitle}》及其全部章节吗？此操作不可恢复。`)) return;
    setBatchBusy(bookId);
    setMessage("");
    try {
      const response = await fetch(`/api/moderation/books/${bookId}`, { method: "DELETE" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "删除失败");
        return;
      }
      window.location.reload();
    } finally {
      setBatchBusy(null);
    }
  }

  async function runApproveSelected(taskIds: string[]) {
    if (taskIds.length === 0) {
      setMessage("没有可处理的章节");
      return;
    }
    setBatchBusy("selected");
    setMessage("");
    try {
      const response = await fetch("/api/moderation/tasks/batch-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds, decision: "approve" }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "批量处理失败");
        return;
      }
      window.location.reload();
    } finally {
      setBatchBusy(null);
    }
  }

  const selectedCount = selected.size;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        {/* 与工作台菜单同名：这页原来叫「审核工作台」，菜单叫「审核中心」 */}
        <h1 className="text-xl font-semibold">内容审核</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          待审章节 {totalPending} 条，共 {groups.length} 部作品
        </p>
      </div>

      {groups.length === 0 ? (
        <EmptyState title="暂无待审核内容" description="作者提交的章节会按作品归集在这里。" />
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const expanded = expandedBooks.has(group.bookId);
            const tasks = tasksByBook.get(group.bookId) ?? [];
            const loadingTasks = loadingBooks.has(group.bookId);
            const groupSelected = tasks.filter((task) => selected.has(task.id));
            return (
              <section key={group.bookId} className="rounded-lg border border-border bg-surface">
                <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <button
                    type="button"
                    onClick={() => toggleExpand(group.bookId)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ChevronDown
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform",
                          expanded ? "" : "-rotate-90"
                        )}
                      />
                      <span className="line-clamp-1 text-sm font-medium">{group.bookTitle}</span>
                      <Badge variant="warning">{group.pendingCount} 章</Badge>
                    </span>
                    <span className="mt-1 block pl-6 text-xs text-muted-foreground">
                      作者：{group.authorName}
                    </span>
                  </button>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={batchBusy !== null || Number(group.pendingCount) === 0}
                      onClick={() => runApproveBook(group.bookId)}
                    >
                      {batchBusy === group.bookId ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Check className="size-4" />
                      )}
                      全部通过
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={batchBusy !== null}
                      onClick={() => deleteBook(group.bookId, group.bookTitle)}
                    >
                      <Trash2 className="size-4" />
                      删除
                    </Button>
                  </div>
                </div>

                {expanded && (
                  <div className="border-t border-border p-2">
                    {loadingTasks ? (
                      <div className="flex justify-center py-6">
                        <Loader2 className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <div className="max-h-96 space-y-1 overflow-y-auto">
                        {tasks.map((task) => (
                          <div
                            key={task.id}
                            className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                          >
                            <Checkbox
                              checked={selected.has(task.id)}
                              onCheckedChange={(checked) => toggleSelect(task.id, checked === true)}
                              aria-label={`选择章节 ${task.chapterTitle}`}
                            />
                            <button
                              type="button"
                              className="min-w-0 flex-1 text-left"
                              onClick={() => openTask(task.id)}
                            >
                              <span className="line-clamp-1 text-sm">{task.chapterTitle}</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {groupSelected.length > 0 && (
                      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border px-2 py-2">
                        <span className="text-xs text-muted-foreground">已选 {groupSelected.length} 章</span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={batchBusy !== null}
                          onClick={() => runApproveSelected(groupSelected.map((task) => task.id))}
                        >
                          {batchBusy === "selected" ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Check className="size-4" />
                          )}
                          通过选中
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {selectedCount > 0 && !selectedTask && (
        <div className="rounded-lg border border-border bg-surface p-3 text-sm">
          已选 {selectedCount} 章，展开对应作品后可批量通过。
        </div>
      )}

      {selectedTask && (
        <section className="rounded-lg border border-border bg-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold">
                {selectedTask.bookTitle} · {selectedTask.chapterTitle}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                作者：{selectedTask.authorName}（{selectedTask.authorEmail}）
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setSelectedTask(null)}>
              <ChevronLeft className="size-4" />
              返回列表
            </Button>
          </div>

          <div className="mt-4 max-h-96 space-y-2 overflow-y-auto rounded-md border border-border bg-background p-4">
            {loadingDetail ? (
              <div className="flex justify-center py-10">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              (selectedTask.content?.paragraphs ?? []).map((paragraph) => (
                <p key={paragraph.id} className="text-sm leading-relaxed">
                  {paragraph.text}
                </p>
              ))
            )}
          </div>

          <div className="mt-4 space-y-3">
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="审核意见（退回时必填）"
              rows={3}
              aria-label="审核意见"
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => decide("approve")} disabled={acting}>
                {acting ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                通过并发布
              </Button>
              <Button variant="danger" onClick={() => decide("reject")} disabled={acting}>
                {acting ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                退回修改
              </Button>
              <Button variant="outline" onClick={() => setSelectedTask(null)} disabled={acting}>
                <Send className="size-4" />
                稍后处理
              </Button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
