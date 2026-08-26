import { initEpubFile, type EpubToc } from "@lingo-reader/epub-parser";
import { htmlToParagraphs } from "~/server/imports/html-to-text";
import { buildSourceTocIndex, sameTitle, splitHtmlByToc, type SourceTocChapter } from "~/server/imports/source-toc";
import type { ParsedChapter } from "~/server/imports/txt-parser";

type WorkerFileReaderInput = Blob | Uint8Array | ArrayBuffer;

/** `@lingo-reader/epub-parser` 的 browser 构建依赖 FileReader，Workers 只有 Blob.arrayBuffer。 */
function ensureWorkerFileReader() {
  const scope = globalThis as unknown as { FileReader?: unknown };
  if (scope.FileReader) return;
  class WorkerFileReader {
    result: ArrayBuffer | null = null;
    error: unknown = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    readAsArrayBuffer(input: WorkerFileReaderInput) {
      const read =
        input instanceof Blob
          ? input.arrayBuffer()
          : input instanceof Uint8Array
            ? Promise.resolve(
                input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer
              )
            : Promise.resolve(input);
      read.then((result) => {
        this.result = result;
        this.onload?.();
      }).catch((error) => {
        this.error = error;
        this.onerror?.();
      });
    }
  }
  scope.FileReader = WorkerFileReader;
}
export interface EpubParseResult {
  chapters: ParsedChapter[];
  metadata: { title?: string; author?: string };
  warnings: string[];
}

function titleFromHtml(html: string): string | null {
  const heading = html.match(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i);
  if (!heading) return null;
  const text = (heading[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

export async function parseEpub(bytes: Uint8Array): Promise<EpubParseResult> {
  ensureWorkerFileReader();
  const epub = await initEpubFile(bytes);
  try {
    const metadata = epub.getMetadata();
    const spine = epub.getSpine();
    const toc = epub.getToc() as EpubToc;
    const tocIndex = buildSourceTocIndex(toc, (href) => epub.resolveHref(href));
    const chapters: ParsedChapter[] = [];
    const warnings: string[] = [];
    let currentVolumeTitle = "正文";

    if (toc.length === 0) {
      warnings.push("EPUB 未包含可用目录，已按正文文件和标题标签识别章节");
    }

    for (const item of spine) {
      const chapter = await epub.loadChapter(item.id);
      if (!chapter) continue;
      const sourceEntries = tocIndex.get(item.id) ?? [];
      const segments: Array<{ toc?: SourceTocChapter; html: string }> =
        sourceEntries.length > 0
          ? splitHtmlByToc(chapter.html, sourceEntries)
          : [{ html: chapter.html }];

      for (const segment of segments) {
        const paragraphs = htmlToParagraphs(segment.html);
        if (paragraphs.length === 0) continue;
        const sourceToc = segment.toc;
        if (sourceToc?.volumeTitle) currentVolumeTitle = sourceToc.volumeTitle;
        const heading = titleFromHtml(segment.html);
        const title = sourceToc?.title || heading || `第 ${chapters.length + 1} 章`;
        if (!sourceToc && !heading) {
          warnings.push(`第 ${chapters.length + 1} 节未出现在 EPUB 目录且没有标题标签，已按顺序命名`);
        }
        if (sameTitle(paragraphs[0], title) || (heading && sameTitle(paragraphs[0], heading))) {
          paragraphs.shift();
        }
        chapters.push({
          title,
          paragraphs,
          startLine: 0,
          endLine: 0,
          charCount: paragraphs.join("").length,
          volumeTitle: sourceToc?.volumeTitle || currentVolumeTitle,
          sourceId: item.id,
          sourceHref: `${item.href}${sourceToc?.selector ?? ""}`,
        });
      }
    }

    if (chapters.length === 0) throw new Error("EPUB 未解析出任何章节");
    return {
      chapters,
      metadata: { title: metadata.title, author: metadata.creator?.[0]?.contributor },
      warnings,
    };
  } finally {
    epub.destroy();
  }
}
