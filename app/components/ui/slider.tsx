import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "~/lib/utils";

/**
 * 无障碍标签要落在滑块本体上。
 *
 * Radix 把 role="slider" 放在 Thumb 上，Root 只是个容器。调用方习惯给 Root
 * 传 aria-label（阅读设置面板里的行距、段距都是这么写的），标签就挂在了
 * 没有语义角色的那一层：读屏念到滑块时只有数值，说不出这是在调什么，
 * 按角色 + 名字定位也找不到它。这里把标签转发给 Thumb。
 */
function Slider({
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn("relative flex w-full touch-none select-none items-center", className)}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-muted">
        <SliderPrimitive.Range className="absolute h-full bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        className="block size-4 rounded-full border border-primary bg-surface shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
