import * as React from "react";
import { cn } from "~/lib/utils";

function Progress({ className, value, ...props }: React.ComponentProps<"div"> & { value?: number }) {
  const percent = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
      {...props}
    >
      <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </div>
  );
}

export { Progress };

