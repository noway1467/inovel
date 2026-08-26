import { Link, useNavigate } from "react-router";
import { Bell, BookOpenText, Clock3, Library, LogOut, Search, Settings2, User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { ThemeToggle } from "~/components/theme-toggle";
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
  const navigate = useNavigate();
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="用户菜单"
                className="flex size-9 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Avatar className="size-7">
                  {user.image && <AvatarImage src={user.image} alt={user.name} />}
                  <AvatarFallback className="bg-secondary text-xs text-secondary-foreground">
                    {user.name.slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel>
                <p className="truncate font-medium">{user.name}</p>
                <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="py-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
                阅读
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => navigate("/library")}>
                <Library className="size-4" />
                我的书架
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate("/history")}>
                <Clock3 className="size-4" />
                最近阅读
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="py-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
                账号
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => navigate("/settings")}>
                <Settings2 className="size-4" />
                <span>
                  <span className="block">账号设置</span>
                  <span className="block text-[10px] text-muted-foreground">资料、密码与阅读偏好</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate("/notifications")}>
                <Bell className="size-4" />
                通知中心
                {unreadCount > 0 && (
                  <span className="ml-auto flex size-5 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={async () => {
                  await fetch("/api/auth/sign-out", { method: "POST" });
                  window.location.reload();
                }}
              >
                <LogOut className="size-4" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button variant="ghost" size="icon-sm" aria-label="我的" asChild>
            <Link to="/settings">
              <User className="size-5" />
            </Link>
          </Button>
        )}
      </div>
    </header>
  );
}
