import { Form, Link, NavLink } from "react-router";
import { BookOpenText, Clock3, Compass, LayoutGrid, Library, Search, Trophy } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ThemeToggle } from "~/components/theme-toggle";
import { UserMenu } from "~/components/layout/user-menu";
import { WorkbenchMenu } from "~/components/layout/workbench-menu";
import { cn } from "~/lib/utils";

const navItems = [
  { to: "/library", label: "书架", icon: Library },
  { to: "/", label: "发现", icon: Compass },
  { to: "/categories", label: "分类", icon: LayoutGrid },
  { to: "/rankings/week", label: "榜单", icon: Trophy },
  { to: "/history", label: "最近", icon: Clock3 },
];

export function AppHeader({
  user,
  registrationEnabled,
  isAuthor,
  isAdmin,
  unreadCount,
}: {
  user?: { name: string; email: string; image?: string | null } | null;
  registrationEnabled: boolean;
  isAuthor: boolean;
  isAdmin: boolean;
  unreadCount: number;
}) {
  return (
    <header className="sticky top-0 z-40 hidden h-16 border-b border-border bg-surface/95 shadow-[0_1px_12px_rgba(31,45,36,0.05)] backdrop-blur md:flex">
      <div className="mx-auto flex w-full max-w-[1180px] items-center gap-4 px-5">
        <Link to="/library" className="flex min-w-0 shrink-0 items-center gap-2.5 text-foreground">
          <span className="flex size-9 items-center justify-center rounded-[10px] bg-primary text-primary-foreground shadow-sm">
            <BookOpenText className="size-[18px]" strokeWidth={1.8} />
          </span>
          <span className="text-[17px] font-semibold tracking-[0.08em]">悦读</span>
        </Link>

        <nav className="flex items-center gap-0.5" aria-label="主导航">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  isActive && "bg-secondary font-semibold text-secondary-foreground"
                )
              }
            >
              <item.icon className="size-4" strokeWidth={1.8} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <Form action="/search" role="search" className="ml-1 min-w-0 flex-1">
          <div className="relative ml-auto max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              name="q"
              placeholder="搜书名、作者或标签"
              aria-label="搜索书名、作者、标签"
              className="h-10 rounded-xl border-border bg-background/75 pl-9 shadow-none"
            />
          </div>
        </Form>

        <div className="ml-auto flex items-center gap-1">
          <WorkbenchMenu isAuthor={isAuthor} isAdmin={isAdmin} />
          <ThemeToggle />
          {user ? (
            <UserMenu user={user} unreadCount={unreadCount} />
          ) : (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" asChild>
                <Link to="/login">登录</Link>
              </Button>
              {registrationEnabled && (
                <Button size="sm" asChild>
                  <Link to="/register">注册</Link>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
