import { Skeleton } from "~/components/ui/skeleton";

export function BookCardSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="aspect-[3/4] w-full rounded-lg" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <Skeleton className="h-24 w-16 shrink-0 rounded-md" />
          <div className="flex-1 space-y-2 py-1">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

