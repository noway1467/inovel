import { useState } from "react";
import { Link } from "react-router";
import { Library } from "lucide-react";
import type { Route } from "./+types/history";
import {
  ShelfBookRow,
  SourceBookRow,
  type SourceShelfEntry,
} from "~/components/book/shelf-view";
import { EmptyState } from "~/components/state/empty-state";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getBooksByIds } from "~/server/repositories/books";
import { listRecentSourceBooks } from "~/server/services/source-reading";
import { encodeSourceRef } from "~/lib/source-ref";
import { readingHistory } from "drizzle/schema";
import { desc, eq } from "drizzle-orm";
import { pageMeta, pageTitle } from "~/lib/page-title";

export function meta() {
  return pageMeta(pageTitle("阅读历史"));
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, history: [] };

  const db = createDb(env.DB_APP);
  const rows = await db
    .select()
    .from(readingHistory)
    .where(eq(readingHistory.userId, session.user.id))
    .orderBy(desc(readingHistory.readAt))
    .limit(50);

  // 先去重再批量取书，整页固定 3 条查询，替代逐本串行 getBook
  const seen = new Set<string>();
  const dedupedRows = rows.filter((row) => {
    if (seen.has(row.bookId)) return false;
    seen.add(row.bookId);
    return true;
  });
  const [bookMap, sourceRows] = await Promise.all([
    getBooksByIds(
      db,
      dedupedRows.map((row) => row.bookId)
    ),
    // 在线源读过的书同样算"最近阅读"，与本地书并列
    listRecentSourceBooks(db, session.user.id).catch(() => []),
  ]);
  const history = [];
  for (const row of dedupedRows) {
    const book = bookMap.get(row.bookId);
    if (!book) continue;
    // readAt 在这里就转成字符串：组件只要拿它算相对时间，不必关心是 Date 还是数字
    history.push({ book, bookProgress: row.bookProgress, readAt: row.readAt.toISOString() });
  }
  return {
    user: session.user,
    history,
    sourceHistory: sourceRows.map((row) => ({
      sourceId: row.sourceId,
      bookUrl: row.bookUrl,
      bookTitle: row.bookTitle,
      sourceName: row.sourceName,
      lastChapterTitle: row.lastChapterTitle,
      lastChapterKey: row.lastChapterKey,
      lastChapterIndex: row.lastChapterIndex,
      lastReadAt: row.lastReadAt?.toISOString() ?? null,
    })),
  };
}

interface SourceHistoryItem {
  sourceId: string;
  bookUrl: string;
  bookTitle: string;
  sourceName: string | null;
  lastChapterTitle: string | null;
  lastChapterKey: string | null;
  lastChapterIndex: number | null;
  lastReadAt: string | null;
}

/** 相对时间：列表里"3 天前"比完整时间戳好扫 */
function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}

function toSourceEntry(item: SourceHistoryItem): SourceShelfEntry {
  const href = item.lastChapterKey
    ? `/source/${item.sourceId}/chapter?key=${encodeSourceRef(
        item.lastChapterKey
      )}&title=${encodeURIComponent(item.bookTitle)}&book=${encodeSourceRef(item.bookUrl)}&i=${
        item.lastChapterIndex ?? 0
      }`
    : `/source/${item.sourceId}/book?url=${encodeSourceRef(
        item.bookUrl
      )}&title=${encodeURIComponent(item.bookTitle)}`;
  // 一行里塞不下"读到某章 + 何时读的"，时间更能说明这是历史
  return {
    key: `${item.sourceId}-${item.bookUrl}`,
    href,
    title: item.bookTitle,
    sourceName: item.sourceName,
    meta: relativeTime(item.lastReadAt) ?? item.lastChapterTitle,
  };
}

export default function HistoryPage({ loaderData }: Route.ComponentProps) {
  const sourceHistory = (loaderData.sourceHistory ?? []) as SourceHistoryItem[];
  const [tab, setTab] = useState(
    loaderData.history.length === 0 && sourceHistory.length > 0 ? "source" : "local"
  );

  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="登录后查看历史"
          description="最近读过的作品会记录在这里。"
          action={
            <Button asChild>
              <Link to="/login?redirect=/history">去登录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (loaderData.history.length === 0 && sourceHistory.length === 0) {
    return (
      <div className="paper-panel mx-auto max-w-lg rounded-2xl p-4">
        <EmptyState title="还没有阅读历史" description="读过的章节会按时间显示。" />
      </div>
    );
  }

  const sourceEntries = sourceHistory.map(toSourceEntry);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      {/* 与书架同一条工具行：分栏 + 计数在左，去书架的入口在右 */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TabsList>
          <TabsTrigger value="local">
            站内书
            <span className="ml-1.5 text-xs opacity-60">{loaderData.history.length}</span>
          </TabsTrigger>
          <TabsTrigger value="source">
            在线书
            <span className="ml-1.5 text-xs opacity-60">{sourceEntries.length}</span>
          </TabsTrigger>
        </TabsList>
        <Button variant="outline" size="sm" className="ml-auto" asChild>
          <Link to="/library">
            <Library className="size-4" />
            我的书架
          </Link>
        </Button>
      </div>

      <TabsContent value="local" className="mt-0">
        {loaderData.history.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-3 py-6 text-center text-sm text-muted-foreground">
            还没有读过站内的书。
          </p>
        ) : (
          <div className="paper-panel grid gap-0.5 rounded-xl p-2 md:grid-cols-2">
            {loaderData.history.map(({ book, bookProgress, readAt }, i) => (
              <ShelfBookRow
                key={book.id}
                to={`/books/${book.id}`}
                title={book.title}
                authorName={book.authorName}
                coverKey={book.coverKey}
                seed={i}
                progress={bookProgress}
                meta={relativeTime(readAt)}
              />
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="source" className="mt-0">
        {sourceEntries.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-3 py-6 text-center text-sm text-muted-foreground">
            还没有读过在线源的书。
          </p>
        ) : (
          <div className="paper-panel grid gap-0.5 rounded-xl p-2 md:grid-cols-2">
            {sourceEntries.map((entry) => (
              <SourceBookRow key={entry.key} entry={entry} />
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
