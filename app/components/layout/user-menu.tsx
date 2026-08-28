import { useNavigate } from "react-router";
import { Bell, LogOut, Settings2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { cn } from "~/lib/utils";

/**
 * 右上角头像菜单，桌面与移动顶栏共用一份。
 *
 * 两个顶栏原来各自抄了一遍同样的六十行，改文案得改两处、漏一处就左右不一致。
 *
 * 只管账号相关的三件事：设置、通知、退出。书架与最近阅读不在这里 ——
 * 桌面主导航和移动底栏都常显着这两个入口，菜单里再放一份是第三个入口，
 * 点开菜单才能到的那份还最难点。
 */
export function UserMenu({
  user,
  unreadCount,
  compact = false,
}: {
  user: { name: string; email: string; image?: string | null };
  unreadCount: number;
  /** 移动顶栏更矮，头像跟着小一号 */
  compact?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="用户菜单"
          className={cn(
            "flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
            compact ? "size-9" : "size-10"
          )}
        >
          <Avatar className={compact ? "size-7" : "size-8"}>
            {user.image && <AvatarImage src={user.image} alt={user.name} />}
            <AvatarFallback
              className={cn(
                "bg-secondary text-secondary-foreground",
                compact && "text-xs"
              )}
            >
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
        <DropdownMenuItem onSelect={() => navigate("/settings")}>
          <Settings2 className="size-4" />
          <span>
            <span className="block">账号设置</span>
            {/* 页面上就是这三块：资料、密码、站点配色。阅读排版在阅读器里，不在这 */}
            <span className="block text-[10px] text-muted-foreground">资料、密码与站点外观</span>
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
        <DropdownMenuSeparator />
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
  );
}
