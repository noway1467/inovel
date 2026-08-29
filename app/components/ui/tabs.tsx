import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "~/lib/utils";

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn("w-full", className)} {...props} />;
}

/**
 * 分段控件。
 *
 * 两处刻意的设计，都是踩过的坑：
 *
 * 1. 列表不写固定高度，只靠内边距撑开；标签用 `items-stretch` 填满内容盒。
 *    原先列表 `h-10` 撞上标签 `min-h-9`，调用处一改 `h-8` 内容盒就只剩
 *    24px，36px 的标签直接溢出，选中态的底色盖不住格子 —— 左边露出一条
 *    列表底色，看着就像"CSS 没写好"。现在高度由内容决定，怎么改都不会露。
 *
 * 2. 选中态用主题色（`bg-primary`），不是 `bg-surface`。面板本身就是
 *    surface 色，选中态跟它同色等于没有选中态。主题色也跟榜单页那套
 *    链接式分段（rankings.tsx）对齐，同一个控件在两处长得一样。
 */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "inline-flex items-stretch justify-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm data-[state=active]:hover:text-primary-foreground",
        className
      )}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("mt-3 outline-none", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };

