import { Link } from "react-router";
import { BookCover } from "~/components/book/book-cover";
import { openBookLinkProps } from "~/lib/open-book";
import { cn } from "~/lib/utils";

export interface BookSummary {
  id: string;
  title: string;
  authorName: string;
  categoryName?: string | null;
  tags?: string[];
  status: string;
  serialStatus?: string;
  latestChapterTitle?: string | null;
  wordCount: number;
  updatedAt?: string | null;
  coverKey?: string | null;
  progress?: number;
}

export function statusLabel(status: string, serialStatus?: string) {
  switch (status) {
    case "published":
      return serialStatus === "completed" ? "已完结" : "连载中";
    case "draft":
      return "草稿";
    case "pending_review":
      return "审核中";
    case "approved":
      return "已通过";
    case "suspended":
      return "已下架";
    case "archived":
      return "已归档";
    default:
      return status;
  }
}

export function BookCard({
  book,
  className,
  seed = 0,
  dense = false,
}: {
  book: BookSummary;
  className?: string;
  seed?: number;
  /** 小图模式：列多、卡片窄，标题字号收一档，副行只留作者 */
  dense?: boolean;
}) {
  const progress = Math.max(0, Math.min(100, book.progress ?? 0));
  return (
    <Link
      to={`/books/${book.id}`}
      {...openBookLinkProps}
      className={cn(
        "group flex min-w-0 flex-col gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <div className="relative aspect-[2/3] w-full transition-transform duration-200 group-hover:-translate-y-0.5">
        <BookCover
          src={book.coverKey}
          title={book.title}
          author={book.authorName}
          seed={seed}
          className="size-full"
        />
        {progress > 0 && (
          <div className="absolute inset-x-1 bottom-1 overflow-hidden rounded-full bg-black/30 p-[2px]">
            <div className="h-1 rounded-full bg-[#d8eadf]" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>
      <div className="min-w-0 px-0.5">
        <p
          className={cn(
            "line-clamp-1 font-semibold group-hover:text-primary",
            dense ? "text-xs leading-4" : "text-sm leading-5"
          )}
        >
          {book.title}
        </p>
        <div className="mt-0.5 flex items-center justify-between gap-1 text-[11px] text-muted-foreground">
          <span className="line-clamp-1 min-w-0">{book.authorName}</span>
          {/* 小图列窄，作者名已经快放不下，右侧那截就不挤了 */}
          {!dense && (
            <span className="shrink-0">
              {progress > 0
                ? `${Math.round(progress)}%`
                : (book.categoryName ?? statusLabel(book.status, book.serialStatus))}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
