import { Link } from "react-router";
import { BookOpenText, Search } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ThemeToggle } from "~/components/theme-toggle";
import { UserMenu } from "~/components/layout/user-menu";
import { WorkbenchMenu } from "~/components/layout/workbench-menu";

export function MobileHeader({
  user,
  isAuthor,
  isAdmin,
  unreadCount,
}: {
  user?: { name: string; email: string; image?: string | null } | null;
  isAuthor: boolean;
  isAdmin: boolean;
  unreadCount: number;
}) {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 shadow-[0_1px_10px_rgba(31,45,36,0.05)] backdrop-blur md:hidden">
      <Link to="/library" className="flex min-w-0 items-center gap-2.5 text-foreground">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary text-primary-foreground">
          <BookOpenText className="size-4" strokeWidth={1.8} />
        </span>
        <span className="truncate text-[15px] font-semibold tracking-[0.08em]">悦读</span>
      </Link>
      <div className="ml-auto flex items-center gap-0.5">
        <Button variant="ghost" size="icon-sm" aria-label="搜索" asChild>
          <Link to="/search">
            <Search className="size-5" />
          </Link>
        </Button>
        <WorkbenchMenu isAuthor={isAuthor} isAdmin={isAdmin} compact />
        <ThemeToggle />
        {user ? (
          <UserMenu user={user} unreadCount={unreadCount} compact />
        ) : (
          /*
            未登录直接去登录页。原来这个图标叫「我的」、指向 /settings，
            那页未登录只画一句"请先登录"再让人点一次；底栏也有个「我的」
            指向同一处，两个入口两次跳转才到登录。
          */
          <Button variant="ghost" size="sm" asChild>
            <Link to="/login">登录</Link>
          </Button>
        )}
      </div>
    </header>
  );
}
