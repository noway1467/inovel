import { NavLink } from "react-router";
import { Clock3, Compass, Library, User } from "lucide-react";
import { cn } from "~/lib/utils";

const items = [
  { to: "/library", label: "书架", icon: Library },
  { to: "/", label: "发现", icon: Compass },
  { to: "/history", label: "最近", icon: Clock3 },
  { to: "/settings", label: "我的", icon: User },
];

export function MobileNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/96 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(31,45,36,0.06)] backdrop-blur md:hidden" aria-label="移动端导航">
      <div className="grid grid-cols-4">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "relative flex min-h-16 flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground transition-colors active:bg-muted",
                isActive && "font-semibold text-primary"
              )
            }
          >
            {({ isActive }) => (
              <>
                <span className={cn("flex h-7 min-w-11 items-center justify-center rounded-full", isActive && "bg-secondary")}>
                  <item.icon className="size-5" strokeWidth={isActive ? 2.2 : 1.8} />
                </span>
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
