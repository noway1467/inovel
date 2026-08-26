import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowUpDown, Bookmark, ChevronDown, ChevronRight } from "lucide-react";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export interface TocVolume {
  id: string;
  title: string;
  chapters: { id: string; title: string }[];
}

export function ReaderToc({
  open,
  onOpenChange,
  bookId,
  currentChapterId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  currentChapterId: string;
}) {
  const [descending, setDescending] = useState(false);
  const [collapsedVolumeIds, setCollapsedVolumeIds] = useState<Set<string>>(() => new Set());
  const [volumes, setVolumes] = useState<TocVolume[] | null>(null);
  const [error, setError] = useState(false);
  // 目录按需加载：同一本书只取一次，之后同一会话内切章复用
  const loadedBookId = useRef<string | null>(null);
  const currentChapterRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (loadedBookId.current !== bookId) {
      loadedBookId.current = null;
      setVolumes(null);
    }
    if (!open || loadedBookId.current === bookId) return;

    const controller = new AbortController();
    setError(false);
    void (async () => {
      try {
        const response = await fetch(`/api/books/${bookId}/toc`, { signal: controller.signal });
        if (!response.ok) throw new Error("toc failed");
        const data = (await response.json()) as { volumes?: TocVolume[] };
        setVolumes(data.volumes ?? []);
        loadedBookId.current = bookId;
      } catch (cause) {
        if ((cause as Error)?.name !== "AbortError") setError(true);
      }
    })();
    return () => controller.abort();
  }, [bookId, open]);

  const orderedVolumes = descending && volumes ? [...volumes].reverse() : (volumes ?? []);

  // 打开目录后滚到当前章节。长篇有上千章，原来总是停在第一章，得手动翻很久。
  // 依赖 volumes/descending：目录是异步加载的，节点要等数据回来才存在；
  // 切正倒序后位置也会变。
  useEffect(() => {
    if (!open || !volumes) return;
    const frame = requestAnimationFrame(() => {
      currentChapterRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, volumes, descending, currentChapterId]);

  function toggleVolume(volumeId: string) {
    setCollapsedVolumeIds((current) => {
      const next = new Set(current);
      if (next.has(volumeId)) next.delete(volumeId);
      else next.add(volumeId);
      return next;
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[min(92vw,380px)] pb-[env(safe-area-inset-bottom)]">
        <SheetHeader className="pr-14">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>目录</SheetTitle>
            <Button
              variant="ghost"
              size="sm"
              className="border-0 bg-transparent shadow-none hover:bg-transparent"
              onClick={() => setDescending((value) => !value)}
              aria-label={descending ? "切换为正序" : "切换为倒序"}
            >
              <ArrowUpDown className="size-3.5" />
              {descending ? "倒序" : "正序"}
            </Button>
          </div>
        </SheetHeader>
        <SheetBody className="p-0">
          <ScrollArea className="h-[calc(100dvh-80px)]">
            <div className="space-y-3 px-4 pb-6">
              {error && (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                  目录加载失败，请重新打开。
                </p>
              )}
              {!error &&
                volumes === null &&
                Array.from({ length: 8 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-10 animate-pulse rounded-lg bg-muted/60"
                    aria-hidden
                  />
                ))}
              {!error && volumes !== null && volumes.length === 0 && (
                <p className="px-1 py-6 text-center text-sm text-muted-foreground">暂无章节。</p>
              )}
              {orderedVolumes.map((volume) => {
                const collapsed = collapsedVolumeIds.has(volume.id);
                const containsCurrent = volume.chapters.some(
                  (chapter) => chapter.id === currentChapterId
                );
                return (
                  <section
                    key={volume.id}
                    className="overflow-hidden rounded-lg border border-border/80"
                  >
                    <button
                      type="button"
                      onClick={() => toggleVolume(volume.id)}
                      className={cn(
                        "flex min-h-10 w-full items-center gap-2 bg-muted/55 px-3 text-left text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted",
                        containsCurrent && "text-primary"
                      )}
                      aria-expanded={!collapsed}
                    >
                      {collapsed ? (
                        <ChevronRight className="size-4" />
                      ) : (
                        <ChevronDown className="size-4" />
                      )}
                      <span className="line-clamp-1 min-w-0 flex-1">{volume.title}</span>
                      <span className="shrink-0 font-normal">{volume.chapters.length} 章</span>
                    </button>
                    {!collapsed && (
                      <div className="space-y-0.5 p-1.5">
                        {(descending ? [...volume.chapters].reverse() : volume.chapters).map(
                          (chapter) => (
                            <Link
                              key={chapter.id}
                              ref={chapter.id === currentChapterId ? currentChapterRef : undefined}
                              to={`/read/${bookId}/${chapter.id}`}
                              onClick={() => onOpenChange(false)}
                              className={cn(
                                "flex min-h-9 items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted",
                                chapter.id === currentChapterId &&
                                  "bg-primary/10 font-medium text-primary"
                              )}
                            >
                              <span className="line-clamp-1">{chapter.title}</span>
                              {chapter.id === currentChapterId && (
                                <Bookmark className="ml-auto size-3.5 shrink-0" />
                              )}
                            </Link>
                          )
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </ScrollArea>
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
