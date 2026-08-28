import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Globe, LayoutGrid, List, Rows3 } from "lucide-react";
import { BookCover } from "~/components/book/book-cover";
import { Progress } from "~/components/ui/progress";
import { cn } from "~/lib/utils";

/**
 * 书架的三种排布。
 *
 * grid-lg 是原来唯一的样式（3~6 列大封面）；grid-sm 把列数翻上去，
 * 一屏能多放一倍；list 一行一本，带进度条与更新信息，适合书多了之后找书。
 */
export type ShelfView = "grid-lg" | "grid-sm" | "list";

const shelfViewKey = "yuedu-shelf-view";
const shelfViews: ShelfView[] = ["grid-lg", "grid-sm", "list"];

/**
 * 记住上次选的排布。
 *
 * 初值固定给 grid-lg、挂载后再读 localStorage：服务端渲染读不到 localStorage，
 * 直接在 useState 初始化里读会造成首屏 HTML 与客户端不一致（hydration 报错）。
 */
export function useShelfView(): [ShelfView, (next: ShelfView) => void] {
  const [view, setView] = useState<ShelfView>("grid-lg");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(shelfViewKey);
      if (stored && shelfViews.includes(stored as ShelfView)) setView(stored as ShelfView);
    } catch {
      // 隐私模式下读不到就用默认值
    }
  }, []);

  function update(next: ShelfView) {
    setView(next);
    try {
      localStorage.setItem(shelfViewKey, next);
    } catch {
      // 忽略隐私模式下的写入失败
    }
  }

  return [view, update];
}

const viewOptions: { key: ShelfView; label: string; icon: typeof LayoutGrid }[] = [
  { key: "grid-lg", label: "大图", icon: LayoutGrid },
  { key: "grid-sm", label: "小图", icon: Rows3 },
  { key: "list", label: "列表", icon: List },
];

export function ShelfViewToggle({
  value,
  onChange,
  className,
}: {
  value: ShelfView;
  onChange: (next: ShelfView) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="书架排布"
      className={cn("flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-surface p-0.5", className)}
    >
      {viewOptions.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          aria-label={option.label}
          aria-pressed={value === option.key}
          title={option.label}
          className={cn(
            "flex size-7 items-center justify-center rounded transition-colors",
            value === option.key
              ? "bg-secondary text-secondary-foreground"
              : "text-muted-foreground hover:bg-muted"
          )}
        >
          <option.icon className="size-4" />
        </button>
      ))}
    </div>
  );
}

/** 每种排布的栅格列数。list 不用栅格，单独走列表分支。 */
export const shelfGridClass: Record<Exclude<ShelfView, "list">, string> = {
  "grid-lg": "grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 sm:gap-x-4 md:grid-cols-5 lg:grid-cols-6",
  "grid-sm": "grid grid-cols-4 gap-x-2 gap-y-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10",
};

/**
 * 在线源的书，统一的一条数据。
 *
 * 这些书不入 books 表，没有封面与字数，只有书名 / 源名 / 读到哪一章，
 * 所以卡片与列表都按这几项排版，不去凑本地书那套元数据。
 */
export interface SourceShelfEntry {
  key: string;
  href: string;
  title: string;
  sourceName: string | null;
  /** 右侧那行小字：读到第几章、共几章、或什么时候读的 */
  meta: string | null;
}

/** 在线源的书按网格排：拿书名生成封面，与本地书混排时视觉一致 */
export function SourceBookCard({
  entry,
  seed = 0,
  dense = false,
}: {
  entry: SourceShelfEntry;
  seed?: number;
  dense?: boolean;
}) {
  return (
    <Link
      to={entry.href}
      className="group flex min-w-0 flex-col gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative aspect-[2/3] w-full transition-transform duration-200 group-hover:-translate-y-0.5">
        <BookCover title={entry.title} seed={seed} className="size-full" />
        {/* 角标标明来源，免得和本站书混淆 */}
        <span
          className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-black/45 px-1 py-0.5 text-[9px] text-white"
          title={entry.sourceName ?? "在线源"}
        >
          <Globe className="size-2.5" />
          {!dense && "在线"}
        </span>
      </div>
      <div className="min-w-0 px-0.5">
        <p
          className={cn(
            "line-clamp-1 font-semibold group-hover:text-primary",
            dense ? "text-xs leading-4" : "text-sm leading-5"
          )}
        >
          {entry.title}
        </p>
        <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
          {entry.sourceName ?? "在线源"}
        </p>
      </div>
    </Link>
  );
}

/** 在线源的书按列表排：一行装下书名、源名与读到哪一章 */
export function SourceBookRow({ entry }: { entry: SourceShelfEntry }) {
  return (
    <Link
      to={entry.href}
      className="group flex min-w-0 items-center gap-2 rounded-lg px-2 py-2.5 outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm font-medium group-hover:text-primary">
        {entry.title}
      </span>
      {entry.sourceName && (
        <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
          {entry.sourceName}
        </span>
      )}
      {entry.meta && (
        <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">
          {entry.meta}
        </span>
      )}
    </Link>
  );
}

/**
 * 本地书的列表行。
 *
 * 与 BookListItem 的差别：那个是搜索/历史用的详情行（大封面、更新章节、字数），
 * 书架要的是"接着读"，所以只留封面、书名、作者和进度，一行更矮，一屏装更多。
 */
export function ShelfBookRow({
  to,
  title,
  authorName,
  coverKey,
  seed = 0,
  progress,
  meta,
}: {
  to: string;
  title: string;
  authorName: string;
  coverKey?: string | null;
  seed?: number;
  progress?: number | null;
  meta?: string | null;
}) {
  return (
    <Link
      to={to}
      className="group flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BookCover
        src={coverKey}
        title={title}
        author={authorName}
        seed={seed}
        className="h-14 w-10 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-sm font-semibold group-hover:text-primary">{title}</p>
        <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
          {authorName}
          {meta && ` · ${meta}`}
        </p>
        {progress != null && progress > 0 && (
          <Progress value={progress} className="mt-1.5 h-1 w-full max-w-40" />
        )}
      </div>
      {progress != null && progress > 0 && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {Math.round(progress)}%
        </span>
      )}
    </Link>
  );
}
