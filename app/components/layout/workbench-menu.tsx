import {
  BookOpenCheck,
  BriefcaseBusiness,
  ChevronDown,
  ClipboardCheck,
  Rss,
  Settings,
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
            {/* 页面标题就是「导入小说」：它干的是导入，发布只是导入时的一个开关 */}
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/creator/upload")}>
              <UploadCloud className="size-4" />
              <span>
                <span className="block">导入小说</span>
                <span className="block text-[10px] text-muted-foreground">从 TXT / EPUB 建作品</span>
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
            {/*
              这几项的名字统一成落地页自己的标题：原来菜单叫「审核中心」、
              /admin 页上同一处又写「内容审核」，同一个页面两个名字。
              顺序按用得多少排，站点设置最少动，放最后。
            */}
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin/moderation")}>
              <ClipboardCheck className="size-4" />
              <span>
                <span className="block">内容审核</span>
                <span className="block text-[10px] text-muted-foreground">待审章节通过或退回</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin/users")}>
              <Users className="size-4" />
              <span>
                <span className="block">用户与角色</span>
                <span className="block text-[10px] text-muted-foreground">调整角色、启用或禁用</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin/operations")}>
              <SlidersHorizontal className="size-4" />
              <span>
                <span className="block">运营配置</span>
                <span className="block text-[10px] text-muted-foreground">分类、标签与推荐位</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin/sources")}>
              <Rss className="size-4" />
              <span>
                <span className="block">在线源</span>
                <span className="block text-[10px] text-muted-foreground">导入源、订阅与自动更新</span>
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openWorkbenchPage("/admin")}>
              <Settings className="size-4" />
              <span>
                <span className="block">站点设置</span>
                <span className="block text-[10px] text-muted-foreground">开放注册与上传上限</span>
              </span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
