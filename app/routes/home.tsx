import { Link } from "react-router";
import { ArrowRight, BookMarked, Compass, Search } from "lucide-react";
import type { Route } from "./+types/home";
import { BookListItem } from "~/components/book/book-list-item";
import { BookCard, type BookSummary } from "~/components/book/book-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { EmptyState } from "~/components/state/empty-state";
import { openBookLinkProps } from "~/lib/open-book";
import { pageMeta, siteName } from "~/lib/page-title";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { listPublishedBooks } from "~/server/repositories/books";
import {
  getActiveRecommendationBookIds,
  getActiveAnnouncements,
} from "~/server/operations/service";
import { listEnabledCategories } from "~/server/repositories/categories";
import { getRankingBooks } from "~/server/rankings/service";

// 首页不叠"发现 · 悦读"，直接站名加一句介绍，收藏夹里看着才像首页
export function meta(_: Route.MetaArgs) {
  return pageMeta(`${siteName} · 在线阅读`, "发现好书、追更新、管理书架的在线阅读站。");
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);
  // 六个独立查询并行执行，首屏时间从串行相加降为最慢一项
  const [books, categories, recommendedIds, announcements, weekly, monthly] = await Promise.all([
    listPublishedBooks(db, 24),
    listEnabledCategories(db),
    getActiveRecommendationBookIds(db, "home-editor", 5),
    getActiveAnnouncements(db, 3),
    getRankingBooks(db, "week", 10),
    getRankingBooks(db, "month", 10),
  ]);
  const featured =
    recommendedIds.length > 0
      ? recommendedIds
          .map((id) => books.find((book) => book.id === id))
          .filter((book): book is NonNullable<typeof book> => Boolean(book))
      : books.slice(0, 5);
  return { books, featured, categories, announcements, weekly, monthly };
}

function toSummary(book: Awaited<ReturnType<typeof listPublishedBooks>>[number]): BookSummary {
  return {
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
  };
}

function rankingToSummary(entry: Awaited<ReturnType<typeof getRankingBooks>>[number]): BookSummary {
  return {
    id: entry.bookId,
    title: entry.title,
    authorName: entry.authorName,
    categoryName: null,
    tags: [],
    status: "published",
    latestChapterTitle: null,
    wordCount: entry.wordCount,
    updatedAt: null,
    coverKey: null,
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const books = loaderData.books;
  const latest = books.slice(0, 8);
  const featured = loaderData.featured;

  return (
    <div className="space-y-4 md:space-y-5">
      {/* 原来这里是一整块 paper-panel 大标题区，首屏被它吃掉近 200px 且没有实际功能。
          改成一行标题 + 快捷入口，内容直接上浮。 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">发现</h1>
          <p className="text-sm text-muted-foreground">编辑推荐、最新更新与榜单</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            to="/library"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-transform active:translate-y-px"
          >
            <BookMarked className="size-4" />
            书架
          </Link>
          <Link
            to="/search"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            <Search className="size-4" />
            搜索
          </Link>
          {/*
            在线源的分类浏览原先只能从书架的「在线书」里绕进去，等于没人找得到。
            放进这一行不占额外高度，跟书架/搜索同一组快捷入口。
          */}
          <Link
            to="/explore"
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            <Compass className="size-4" />
            分类浏览
          </Link>
        </div>
      </div>

      {loaderData.announcements.length > 0 && (
        <div className="paper-panel divide-y divide-border overflow-hidden rounded-xl">
          {loaderData.announcements.map((announcement) => (
            <div key={announcement.id} className="px-4 py-3 sm:flex sm:items-baseline sm:gap-4">
              <p className="shrink-0 text-sm font-semibold text-primary">{announcement.title}</p>
              <p className="mt-1 line-clamp-1 text-sm text-muted-foreground sm:mt-0">
                {announcement.body}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-4">
          {featured.length > 0 && (
            <section className="paper-panel rounded-xl p-3 sm:p-4" aria-labelledby="editor-picks">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 id="editor-picks" className="text-base font-semibold">
                  编辑推荐
                </h2>
                <Link
                  to="/categories"
                  className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  查看更多 <ArrowRight className="size-3.5" />
                </Link>
              </div>
              <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:grid-cols-5">
                {featured.map((book, i) => (
                  <BookCard key={book.id} book={toSummary(book)} seed={i} />
                ))}
              </div>
            </section>
          )}

          <section className="paper-panel rounded-xl p-2 sm:p-3" aria-labelledby="latest-books">
            <div className="flex items-baseline justify-between px-2 pb-2">
              <h2 id="latest-books" className="text-base font-semibold">
                最新作品
              </h2>
              <Link
                to="/categories"
                className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                全部作品 <ArrowRight className="size-3.5" />
              </Link>
            </div>
            {books.length === 0 ? (
              <EmptyState title="还没有作品" description="内容上线后会显示在这里。" />
            ) : (
              <div className="grid gap-1 md:grid-cols-2">
                {latest.map((book, i) => (
                  <BookListItem key={book.id} book={toSummary(book)} seed={i} />
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24">
          <section className="paper-panel rounded-xl p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold">分类找书</h2>
              <div className="flex shrink-0 items-baseline gap-2 text-xs">
                <Link to="/categories" className="text-primary hover:underline">
                  全部
                </Link>
                {/* 站内分类之外还有在线源的分类，找分类的人多半也想看这个 */}
                <span className="text-border" aria-hidden>
                  |
                </span>
                <Link to="/explore" className="text-primary hover:underline">
                  在线源
                </Link>
              </div>
            </div>
            {/* 侧栏分类改为自适应换行的小 chip，一行能塞更多，不再固定两三列 */}
            <nav className="flex flex-wrap gap-1.5">
              {loaderData.categories.slice(0, 14).map((category) => (
                <Link
                  key={category.id}
                  to={`/categories/${category.slug}`}
                  className="rounded-md bg-muted/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-secondary-foreground"
                >
                  {category.name}
                </Link>
              ))}
            </nav>
          </section>

          <section className="paper-panel rounded-xl p-3" aria-labelledby="rankings">
            <Tabs defaultValue="week">
              <div className="flex items-center justify-between">
                <h2 id="rankings" className="text-base font-semibold">
                  热门榜单
                </h2>
                {/* 高度交给组件按内容撑开，写死 h-8 会让标签溢出、露出列表底色 */}
                <TabsList>
                  <TabsTrigger value="week" className="px-2.5 py-1 text-xs">
                    周榜
                  </TabsTrigger>
                  <TabsTrigger value="month" className="px-2.5 py-1 text-xs">
                    月榜
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="week">
                <RankingList books={loaderData.weekly.map(rankingToSummary)} />
              </TabsContent>
              <TabsContent value="month">
                <RankingList
                  books={[...loaderData.monthly].reverse().slice(0, 10).map(rankingToSummary)}
                />
              </TabsContent>
            </Tabs>
          </section>
        </aside>
      </div>
    </div>
  );
}

function RankingList({ books }: { books: BookSummary[] }) {
  if (books.length === 0) {
    return <EmptyState title="榜单暂无数据" description="榜单快照生成后会显示在这里。" />;
  }
  return (
    <ol className="mt-2 divide-y divide-border">
      {books.slice(0, 8).map((book, index) => (
        <li key={book.id}>
          <Link
            to={`/books/${book.id}`}
            {...openBookLinkProps}
            className="group flex items-center gap-2.5 py-2"
          >
            <span
              className={`w-5 shrink-0 text-center font-serif text-base font-semibold ${index < 3 ? "text-accent" : "text-muted-foreground"}`}
            >
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-sm font-medium group-hover:text-primary">
                {book.title}
              </p>
              <p className="line-clamp-1 text-[11px] text-muted-foreground">
                {book.authorName} · {book.wordCount.toLocaleString()} 字
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ol>
  );
}
