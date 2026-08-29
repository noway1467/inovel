import { useState } from "react";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import type { Route } from "./+types/notifications";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { notifications } from "drizzle/schema";
import { desc, eq } from "drizzle-orm";
import { pageMeta, pageTitle } from "~/lib/page-title";

export function meta() {
  return pageMeta(pageTitle("通知中心"));
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, notifications: [] };
  const db = createDb(env.DB_APP);
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, session.user.id))
    .orderBy(desc(notifications.createdAt))
    .limit(100);
  return { user: session.user, notifications: rows };
}

export default function NotificationsPage({ loaderData }: Route.ComponentProps) {
  const [items, setItems] = useState(loaderData.notifications);
  const [acting, setActing] = useState(false);

  async function markAll() {
    setActing(true);
    try {
      await fetch("/api/notifications/read-all", { method: "POST" });
      setItems((prev) => prev.map((item) => ({ ...item, readAt: new Date() })));
    } finally {
      setActing(false);
    }
  }

  async function markOne(id: string) {
    await fetch(`/api/notifications/${id}/read`, { method: "POST" });
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, readAt: new Date() } : item))
    );
  }

  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-id">
        <EmptyState title="登录后查看通知" />
      </div>
    );
  }

  const unread = items.filter((item) => !item.readAt).length;

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold">通知中心</h1>
          <span className="text-sm text-muted-foreground">
            {unread > 0 ? `${unread} 条未读` : "全部已读"}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={markAll} disabled={acting || unread === 0}>
          {acting ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
          全部已读
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState title="暂无通知" description="审核结果、作品更新等会显示在这里。" />
      ) : (
        // 单条改为紧凑行：p-4 → px-3 py-2.5，未读用左侧色条表示而不是额外徽章占一行
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => void markOne(item.id)}
              className={`flex w-full min-w-0 items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-muted ${
                item.readAt ? "opacity-60" : ""
              }`}
            >
              <span
                aria-hidden
                className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                  item.readAt ? "bg-transparent" : "bg-primary"
                }`}
              />
              <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">{item.title}</p>
                  <time className="shrink-0 text-[11px] text-muted-foreground">
                    {formatNotificationTime(item.createdAt)}
                  </time>
                </div>
                {item.body && (
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{item.body}</p>
                )}
              </div>
              {!item.readAt && <span className="sr-only">未读</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 通知时间：今天只显示时分，今年省略年份，避免原来直接 String(Date) 的长串。 */
function formatNotificationTime(value: Date | string | number) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "numeric", day: "numeric" });
}
