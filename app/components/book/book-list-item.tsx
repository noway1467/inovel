import { Link } from "react-router";
import { BookCover } from "~/components/book/book-cover";
import { statusLabel, type BookSummary } from "~/components/book/book-card";
import { Progress } from "~/components/ui/progress";

export function BookListItem({ book, seed = 0 }: { book: BookSummary; seed?: number }) {
  return (
    <Link
      to={`/books/${book.id}`}
      className="group flex min-w-0 gap-3 rounded-xl px-2 py-3 outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BookCover
        src={book.coverKey}
        title={book.title}
        author={book.authorName}
        seed={seed}
        className="h-24 w-16 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <p className="line-clamp-1 text-[15px] font-semibold group-hover:text-primary">
              {book.title}
            </p>
            <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-secondary-foreground">
              {book.categoryName ?? statusLabel(book.status, book.serialStatus)}
            </span>
          </div>
          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{book.authorName}</p>
          {book.latestChapterTitle && (
            <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">
              更新至 {book.latestChapterTitle}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">
            {book.wordCount.toLocaleString()} 字
          </span>
          {book.progress != null && (
            <span className="flex items-center gap-2">
              <Progress value={book.progress} className="w-20" />
              <span className="w-9 text-right text-[11px] text-muted-foreground">
                {Math.round(book.progress)}%
              </span>
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
