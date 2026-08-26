import { Link } from "react-router";
import type { Route } from "./+types/rankings";
import { BookListItem } from "~/components/book/book-list-item";
import type { BookSummary } from "~/components/book/book-card";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { getRankingBooks, type RankingType } from "~/server/rankings/service";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const db = createDb(env.DB_APP);
  const type = (params.type ?? "week") as RankingType;
  const entries = await getRankingBooks(db, type, 20);
  return { type, entries };
}

function toSummary(entry: Awaited<ReturnType<typeof getRankingBooks>>[number]): BookSummary {
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

const tabs = [
  { key: "week", label: "周榜" },
  { key: "month", label: "月榜" },
  { key: "total", label: "总榜" },
];

export default function RankingsPage({ loaderData }: Route.ComponentProps) {
  const sorted = [...loaderData.entries];
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">作品榜单</h1>
        <p className="mt-1 text-sm text-muted-foreground">统计口径以平台公示为准。</p>
      </div>
      <div className="flex gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            to={`/rankings/${tab.key}`}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              loaderData.type === tab.key
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        ))}
      </div>
      {sorted.length === 0 ? (
        <EmptyState title="榜单暂无数据" />
      ) : (
        <ol className="grid gap-2 rounded-xl border border-border bg-surface p-2 md:grid-cols-2">
          {sorted.map((book, i) => (
            <li key={book.bookId} className="flex items-start gap-3">
              <span
                className={`mt-3 w-7 shrink-0 text-center text-lg font-bold ${i < 3 ? "text-accent" : "text-muted-foreground"}`}
              >
                {i + 1}
              </span>
              <BookListItem book={toSummary(book)} seed={i} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
