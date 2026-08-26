export interface SourceTocNode {
  label: string;
  href: string;
  children?: SourceTocNode[];
}

export interface SourceResolvedHref {
  id: string;
  selector?: string;
}

export interface SourceTocChapter {
  title: string;
  volumeTitle: string;
  selector: string;
}

function normalizeTitle(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || fallback;
}

function resolveSafely(
  href: string,
  resolveHref: (href: string) => string | SourceResolvedHref | undefined
): SourceResolvedHref | undefined {
  try {
    const resolved = resolveHref(href);
    if (!resolved) return undefined;
    return typeof resolved === "string" ? { id: resolved, selector: "" } : resolved;
  } catch {
    return undefined;
  }
}

/**
 * 将 EPUB/MOBI 的树形 TOC 映射到正文 spine id。
 * 有子节点的条目作为卷名，叶子条目作为章节名；父卷本身有独立正文时也会保留。
 */
export function buildSourceTocIndex(
  toc: SourceTocNode[],
  resolveHref: (href: string) => string | SourceResolvedHref | undefined
): Map<string, SourceTocChapter[]> {
  const flattened: Array<SourceTocChapter & { id: string }> = [];

  const visit = (nodes: SourceTocNode[], parentVolumeTitle = "正文") => {
    for (const node of nodes) {
      const title = normalizeTitle(node.label, "未命名章节");
      const children = node.children?.filter(Boolean) ?? [];
      const volumeTitle = children.length > 0 ? title : parentVolumeTitle;
      const resolved = resolveSafely(node.href, resolveHref);

      if (children.length > 0) {
        const childStart = flattened.length;
        visit(children, volumeTitle);
        const childEntries = flattened.slice(childStart);
        const duplicatesChild =
          resolved &&
          childEntries.some(
            (entry) => entry.id === resolved.id && entry.selector === (resolved.selector ?? "")
          );
        if (resolved && !duplicatesChild) {
          // 父卷正文逻辑上位于子章节之前。
          flattened.splice(childStart, 0, {
            id: resolved.id,
            title,
            volumeTitle,
            selector: resolved.selector ?? "",
          });
        }
      } else if (resolved) {
        flattened.push({
          id: resolved.id,
          title,
          volumeTitle,
          selector: resolved.selector ?? "",
        });
      }
    }
  };

  visit(toc);
  const result = new Map<string, SourceTocChapter[]>();
  for (const entry of flattened) {
    const list = result.get(entry.id) ?? [];
    if (!list.some((item) => item.selector === entry.selector)) {
      list.push({ title: entry.title, volumeTitle: entry.volumeTitle, selector: entry.selector });
      result.set(entry.id, list);
    }
  }
  return result;
}

export function buildSourceTocMap(
  toc: SourceTocNode[],
  resolveHref: (href: string) => string | SourceResolvedHref | undefined
): Map<string, SourceTocChapter> {
  return new Map(
    [...buildSourceTocIndex(toc, resolveHref)].map(([id, entries]) => [id, entries[0]!])
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectorPosition(html: string, selector: string): number {
  if (!selector) return 0;
  const id = selector.match(/^\[id=["']([^"']+)["']\]$/)?.[1] ?? selector.match(/^#(.+)$/)?.[1];
  if (!id) return -1;
  const escaped = escapeRegex(id);
  const match = new RegExp(`<[^>]+\\bid=["']${escaped}["'][^>]*>`, "i").exec(html);
  return match?.index ?? -1;
}

/** 按 TOC fragment 将同一个 spine 文档切成多个章节。无法定位时安全回退为整份正文。 */
export function splitHtmlByToc(
  html: string,
  entries: SourceTocChapter[]
): Array<{ toc: SourceTocChapter; html: string }> {
  if (entries.length <= 1) {
    return entries.length === 1 ? [{ toc: entries[0]!, html }] : [];
  }
  const positioned = entries
    .map((toc, order) => ({ toc, order, start: selectorPosition(html, toc.selector) }))
    .filter((entry) => entry.start >= 0)
    .sort((left, right) => left.start - right.start || left.order - right.order);
  if (positioned.length <= 1) {
    return [{ toc: entries[0]!, html }];
  }
  return positioned.map((entry, index) => ({
    toc: entry.toc,
    html: html.slice(entry.start, positioned[index + 1]?.start ?? html.length),
  }));
}

export function sameTitle(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalize = (value: string) =>
    value
      .replace(/[\s\u3000]+/g, "")
      .replace(/[：:]/g, "")
      .trim();
  return normalize(left) === normalize(right);
}
