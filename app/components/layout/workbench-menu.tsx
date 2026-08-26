import {
  BookOpenCheck,
  BriefcaseBusiness,
  ChevronDown,
  ClipboardCheck,
  SlidersHorizontal,
  UploadCloud,
  Users,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

export interface WorkbenchMenuProps {
  isAuthor: boolean;
  isAdmin: boolean;
  compact?: boolean;
}

function openWorkbenchPage(path: string) {
  // Radix 菜单在触摸模拟下会先卸载菜单项，显式导航可避免链接点击丢失。
  window.location.assign(path);
}

export function WorkbenchMenu({ isAuthor, isAdmin, compact = false }: WorkbenchMenuProps) {
  if (!isAuthor && !isAdmin) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size={compact ? "icon-sm" : "sm"}
          aria-label="工作台"
          className={compact ? "rounded-full" : "rounded-lg border border-primary/10 px-3"}
        >
          <BriefcaseBusiness className="size-4" />
          {!compact && (
            <>
              工作台
              <ChevronDown className="size-3.5 opacity-60" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {isAuthor && (
          <>
            <DropdownMenuLabel className="py-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              创作
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/creator")}>
              <BookOpenCheck className="size-4" />
              <span>
                <span className="block">作品管理</span>
                <span className="block text-[10px] text-muted-foreground">编辑作品与章节</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/creator/upload")}>
              <UploadCloud className="size-4" />
              <span>
                <span className="block">发布作品</span>
                <span className="block text-[10px] text-muted-foreground">导入小说并发布</span>
              </span>
            </DropdownMenuItem>
          </>
        )}

        {isAuthor && isAdmin && <DropdownMenuSeparator />}

        {isAdmin && (
          <>
            <DropdownMenuLabel className="py-1 text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">
              管理
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin/moderation")}>
              <ClipboardCheck className="size-4" />
              审核中心
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin")}>
              <BriefcaseBusiness className="size-4" />
              管理首页
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin/users")}>
              <Users className="size-4" />
              用户管理
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin/operations")}>
              <SlidersHorizontal className="size-4" />
              内容运营
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
