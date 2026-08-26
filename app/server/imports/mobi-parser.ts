import { initMobiFile, type MobiToc } from "@lingo-reader/mobi-parser";
import { htmlToParagraphs } from "~/server/imports/html-to-text";
import { isLikelyTitle } from "~/server/imports/chapter-rules";
import { buildSourceTocIndex, sameTitle, splitHtmlByToc, type SourceTocChapter } from "~/server/imports/source-toc";
import type { ParsedChapter } from "~/server/imports/txt-parser";

function titleFromHtml(html: string): string | null {
  const heading = html.match(/<(?:title|h[1-4])[^>]*>([\s\S]*?)<\/(?:title|h[1-4])>/i);
  if (!heading) return null;
  const title = (heading[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
  return title || null;
}
export interface MobiParseResult {
  chapters: ParsedChapter[];
  metadata: { title?: string; author?: string };
  warnings: string[];
}

export async function parseMobi(bytes: Uint8Array): Promise<MobiParseResult> {
  const mobi = await initMobiFile(bytes);
  try {
    const metadata = mobi.getMetadata();
    const spine = mobi.getSpine();
    const toc = mobi.getToc() as MobiToc;
    const tocIndex = buildSourceTocIndex(toc, (href) => mobi.resolveHref(href));
    const chapters: ParsedChapter[] = [];
    const warnings: string[] = [];
    let currentVolumeTitle = "正文";

    if (toc.length === 0) warnings.push("MOBI 未包含可用目录，已按正文标题识别章节");

    for (const spineChapter of spine) {
      // Workers 不实现 URL.createObjectURL；目录导入只需 spine 原始 HTML，
      // 不调用会改写图片资源的 loadChapter()。
      const html = spineChapter.text;
      const sourceEntries = tocIndex.get(spineChapter.id) ?? [];
      const segments: Array<{ toc?: SourceTocChapter; html: string }> =
        sourceEntries.length > 0 ? splitHtmlByToc(html, sourceEntries) : [{ html }];

      for (const segment of segments) {
        const paragraphs = htmlToParagraphs(segment.html);
        if (paragraphs.length === 0) continue;
        const sourceToc = segment.toc;
        if (sourceToc?.volumeTitle) currentVolumeTitle = sourceToc.volumeTitle;
        const firstParagraph = paragraphs[0];
        const htmlTitle = titleFromHtml(segment.html);
        const textTitle = firstParagraph && isLikelyTitle(firstParagraph) ? firstParagraph : null;
        const title = sourceToc?.title || htmlTitle || textTitle || `第 ${chapters.length + 1} 章`;
        if (!sourceToc && !htmlTitle && !textTitle) {
          warnings.push(`第 ${chapters.length + 1} 节未出现在 MOBI 目录且没有可识别标题，已按顺序命名`);
        }
        if (
          sameTitle(firstParagraph, title) ||
          (htmlTitle && sameTitle(firstParagraph, htmlTitle)) ||
          (textTitle && sameTitle(firstParagraph, textTitle))
        ) {
          paragraphs.shift();
        }
        chapters.push({
          title,
          paragraphs,
          startLine: 0,
          endLine: 0,
          charCount: paragraphs.join("").length,
          volumeTitle: sourceToc?.volumeTitle || currentVolumeTitle,
          sourceId: spineChapter.id,
          sourceHref: sourceToc?.selector || undefined,
        });
      }
    }

    if (chapters.length === 0) throw new Error("MOBI 未解析出任何章节");
    return {
      chapters,
      metadata: { title: metadata.title, author: metadata.author?.[0] },
      warnings,
    };
  } finally {
    mobi.destroy();
  }
}
