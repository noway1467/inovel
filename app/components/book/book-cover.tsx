import { cn } from "~/lib/utils";

const coverPalettes = [
  "bg-[#486b57] text-[#f7f2e7]",
  "bg-[#755c45] text-[#fff7e9]",
  "bg-[#3f5f68] text-[#eef7f4]",
  "bg-[#6c4e4a] text-[#fff3ed]",
  "bg-[#606544] text-[#faf7e8]",
  "bg-[#4d586d] text-[#f1f3fb]",
];

export function BookCover({
  src,
  title,
  author,
  seed = 0,
  className,
}: {
  src?: string | null;
  title: string;
  author?: string;
  seed?: number;
  className?: string;
}) {
  if (src) {
    return (
      <div className={cn("book-cover-shell relative overflow-hidden rounded-md border border-black/10 bg-muted", className)}>
        <img src={src} alt={title} loading="lazy" className="size-full object-cover" />
      </div>
    );
  }

  const palette = coverPalettes[Math.abs(seed) % coverPalettes.length];
  return (
    <div className={cn("book-cover-shell relative flex size-full flex-col overflow-hidden rounded-md border border-black/10 p-3", palette, className)}>
      <span className="absolute inset-y-0 left-0 w-1.5 bg-black/14" aria-hidden="true" />
      <span className="ml-auto text-[9px] tracking-[0.24em] opacity-65">悦读</span>
      <div className="my-auto pl-1 text-center">
        <p className="line-clamp-4 font-serif text-base font-semibold leading-relaxed tracking-[0.08em]">{title}</p>
      </div>
      {author && <p className="line-clamp-1 border-t border-current/20 pt-2 text-center text-[10px] opacity-75">{author}</p>}
    </div>
  );
}
