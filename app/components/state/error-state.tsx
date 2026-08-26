import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "~/components/ui/button";

export function ErrorState({
  title = "加载失败",
  description = "暂时无法获取内容，请稍后重试。",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-lg border border-danger/30 bg-danger/5 p-6 text-center">
      <AlertTriangle className="size-8 text-danger" />
      <div>
        <p className="text-sm font-medium text-danger">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-4" />
          重试
        </Button>
      )}
    </div>
  );
}

