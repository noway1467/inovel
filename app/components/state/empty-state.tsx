import { Inbox } from "lucide-react";
import { cn } from "~/lib/utils";

export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-6 text-center", className)}>
      <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-6" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

