import { useState } from "react";
import { Link } from "react-router";
import { Clock3, Compass } from "lucide-react";
import type { Route } from "./+types/library";
import { BookCard, type BookSummary } from "~/components/book/book-card";
import {
  ShelfBookRow,
  ShelfViewToggle,
  SourceBookCard,
  SourceBookRow,
  shelfGridClass,
  useShelfView,
  type SourceShelfEntry,
} from "~/components/book/shelf-view";
import { EmptyState } from "~/components/state/empty-state";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getBooksByIds } from "~/server/repositories/books";
import { getProgressForBooks } from "~/server/services/reader";
import { listShelvedSourceBooks } from "~/server/services/source-reading";
import { encodeSourceRef } from "~/lib/source-ref";
import { shelfItems } from "drizzle/schema";
import { desc, eq } from "drizzle-orm";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, items: [] };

  const db = createDb(env.DB_APP);
  const rows = await db
    .select()
    .from(shelfItems)
    .where(eq(shelfItems.userId, session.user.id))
    .orderBy(desc(shelfItems.updatedAt))
    .limit(100);

  // 批量取书与进度：整页固定几条查询，避免逐本串行查询拖慢首屏并逼近子请求上限
  const bookIds = rows.map((row) => row.bookId);
  const [bookMap, progressMap, sourceBooks] = await Promise.all([
    getBooksByIds(db, bookIds),
    getProgressForBooks(db, session.user.id, bookIds),
    // 在线源的书不在 books 表里，单独取一份放在同一个书架里展示
    listShelvedSourceBooks(db, session.user.id).catch(() => []),
  ]);
  const items = [];
  for (const row of rows) {
    const book = bookMap.get(row.bookId);
    if (!book) continue;
    items.push({ shelf: row, book, progress: progressMap.get(row.bookId) ?? null });
  }
  return {
    user: session.user,
    items,
    sourceItems: sourceBooks.map((row) => ({
      sourceId: row.sourceId,
      bookUrl: row.bookUrl,
      bookTitle: row.bookTitle,
      sourceName: row.sourceName,
      lastChapterTitle: row.lastChapterTitle,
      lastChapterKey: row.lastChapterKey,
      lastChapterIndex: row.lastChapterIndex,
      chapterCount: row.chapterCount,
    })),
  };
}

/**
 * loader 里那份在线源书籍的形状。
 *
 * 不从 loader 返回类型里取：未登录分支返回的对象没有 sourceItems 这个键，
 * 联合类型上索引它会直接报错。
 */
interface SourceItem {
  sourceId: string;
  bookUrl: string;
  bookTitle: string;
  sourceName: string | null;
  lastChapterTitle: string | null;
  lastChapterKey: string | null;
  lastChapterIndex: number | null;
  chapterCount: number | null;
}

/** 在线源书籍 → 统一的书架条目：有读过的章节就直接续读，否则回书籍页 */
function toSourceEntry(item: SourceItem): SourceShelfEntry {
  const href = item.lastChapterKey
    ? `/source/${item.sourceId}/chapter?key=${encodeSourceRef(
        item.lastChapterKey
      )}&title=${encodeURIComponent(item.bookTitle)}&book=${encodeSourceRef(item.bookUrl)}&i=${
        item.lastChapterIndex ?? 0
      }`
    : `/source/${item.sourceId}/book?url=${encodeSourceRef(
        item.bookUrl
      )}&title=${encodeURIComponent(item.bookTitle)}`;
  return {
    key: `${item.sourceId}-${item.bookUrl}`,
    href,
    title: item.bookTitle,
    sourceName: item.sourceName,
    meta: item.lastChapterTitle
      ? `读到 ${item.lastChapterTitle}`
      : `共 ${item.chapterCount ?? "?"} 章`,
  };
}

export default function LibraryPage({ loaderData }: Route.ComponentProps) {
  const sourceItems = loaderData.sourceItems ?? [];
  const [view, setView] = useShelfView();
  /**
   * 默认停在有书的那一栏。
   *
   * 只用在线源的用户打开书架不该看到一个空的「站内」栏 —— 那看着像书丢了。
   */
  const [tab, setTab] = useState(
    loaderData.items.length === 0 && sourceItems.length > 0 ? "source" : "local"
  );

  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="登录后查看书架"
          description="收藏的作品会同步到云端。"
          action={
            <Button asChild>
              <Link to="/login?redirect=/library">去登录</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (loaderData.items.length === 0 && sourceItems.length === 0) {
    return (
      <div className="paper-panel mx-auto max-w-lg rounded-2xl p-4">
        <EmptyState
          title="书架还是空的"
          description="从发现页挑一本书，加入书架后就会出现在这里。"
          action={
            <Button asChild>
              <Link to="/">去发现好书</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const sourceEntries = sourceItems.map(toSourceEntry);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      {/*
        原来这里是一整块 paper-panel 标题头（大标题 + 副文案 + 两个入口），
        竖着吃掉近 140px 却不带信息。现在压成一行：左边分栏切换，
        右边排布切换与两个入口，书直接从第一屏开始。
      */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TabsList className="h-9">
          <TabsTrigger value="local" className="min-h-8 px-3">
            站内书
            <span className="ml-1.5 text-xs opacity-60">{loaderData.items.length}</span>
          </TabsTrigger>
          <TabsTrigger value="source" className="min-h-8 px-3">
            在线书
            <span className="ml-1.5 text-xs opacity-60">{sourceEntries.length}</span>
          </TabsTrigger>
        </TabsList>

        <div className="ml-auto flex items-center gap-2">
          <ShelfViewToggle value={view} onChange={setView} />
          <Button variant="outline" size="icon-sm" aria-label="最近阅读" title="最近阅读" asChild>
            <Link to="/history">
              <Clock3 className="size-4" />
            </Link>
          </Button>
          <Button variant="outline" size="icon-sm" aria-label="发现新书" title="发现新书" asChild>
            <Link to="/">
              <Compass className="size-4" />
            </Link>
          </Button>
        </div>
      </div>

      <TabsContent value="local" className="mt-0">
        {loaderData.items.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-3 py-6 text-center text-sm text-muted-foreground">
            站内书架还是空的，去
            <Link to="/" className="mx-1 text-primary hover:underline">
              发现页
            </Link>
            挑一本。
          </p>
        ) : view === "list" ? (
          // 列表两列：宽屏上单列会剩一大片空白，两列正好用满 1180px 的内容宽
          <div className="paper-panel grid gap-0.5 rounded-xl p-2 md:grid-cols-2">
            {loaderData.items.map(({ book, progress }, i) => (
              <ShelfBookRow
                key={book.id}
                to={`/books/${book.id}`}
                title={book.title}
                authorName={book.authorName}
                coverKey={book.coverKey}
                seed={i}
                progress={progress?.bookProgress ?? 0}
                meta={book.latestChapterTitle ? `更新至 ${book.latestChapterTitle}` : null}
              />
            ))}
          </div>
        ) : (
          <div className={`paper-panel rounded-xl p-3 sm:p-4 ${shelfGridClass[view]}`}>
            {loaderData.items.map(({ book, progress }, i) => {
              const summary: BookSummary = {
                id: book.id,
                title: book.title,
                authorName: book.authorName,
                categoryName: book.categoryName,
                tags: book.tags,
                status: book.status,
                latestChapterTitle: book.latestChapterTitle,
                wordCount: book.wordCount,
                updatedAt: book.updatedAt?.toISOString() ?? null,
                coverKey: book.coverKey,
                progress: progress?.bookProgress ?? 0,
              };
              return (
                <BookCard key={book.id} book={summary} seed={i} dense={view === "grid-sm"} />
              );
            })}
          </div>
        )}
      </TabsContent>

      <TabsContent value="source" className="mt-0">
        {sourceEntries.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface px-3 py-6 text-center text-sm text-muted-foreground">
            还没有收藏在线源的书。搜索时点开任意一本，在阅读页加入书架即可。
          </p>
        ) : view === "list" ? (
          <div className="paper-panel grid gap-0.5 rounded-xl p-2 md:grid-cols-2">
            {sourceEntries.map((entry) => (
              <SourceBookRow key={entry.key} entry={entry} />
            ))}
          </div>
        ) : (
          <div className={`paper-panel rounded-xl p-3 sm:p-4 ${shelfGridClass[view]}`}>
            {sourceEntries.map((entry, i) => (
              <SourceBookCard
                key={entry.key}
                entry={entry}
                seed={i}
                dense={view === "grid-sm"}
              />
            ))}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
