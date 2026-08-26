import { parseTxt } from "~/server/imports/txt-parser";
import type { SourceChapter } from "~/server/sources/types";

/**
 * 目录规则失效时的兜底。
 *
 * 书源规则常年失修，站点改版后 tocList 就选不中任何东西。与其直接报
 * 「目录规则未命中」把书判死，不如退一步：把整页（或书籍详情页）的正文
 * 当作一份长文本，用本地导入那套章节识别引擎切出章节。
 *
 * 复用 imports/txt-parser 的 parseTxt，不另写一套：它已经能识别
 * 「第N章」「序章」「1、」等多种标题形态，识别不到时按字数切。
 * 两条路用同一个引擎，行为一致，也不会各自长歪。
 */

/** 兜底切分的每章目标字数。规则与识别都失效时按这个长度切。 */
export const fallbackCharsPerChapter = 5_000;

/** 少于这么多字就不值得当一本书切 */
const minTextLength = 500;

/** 单段超过这个长度就先在句末切开 */
const maxParagraphChars = 1_000;

/**
 * 把超长段落在句末切成多段。
 *
 * parseTxt 的按字数切分只在段落之间下刀，段落内部不切。而网页常把
 * 整章塞在一个 <p> 里（或只用 <br> 分隔），到这里就是一个上万字的
 * 单行 —— 按字数切分对它完全无效，兜底会退化成"只有一章"。
 *
 * 优先在句末（。！？…）断开，句子本身也超长时才硬切，避免切在半句中间。
 */
function splitLongParagraphs(text: string): string {
  const out: string[] = [];

  for (const line of text.split(/\n/)) {
    if (line.length <= maxParagraphChars) {
      out.push(line);
      continue;
    }
    // 在句末标点后切开，保留标点
    const sentences = line.split(/(?<=[。！？……])/);
    let buffer = "";
    for (const sentence of sentences) {
      // 单句就超长（无标点的整段），硬切成定长块
      if (sentence.length > maxParagraphChars) {
        if (buffer) {
          out.push(buffer);
          buffer = "";
        }
        for (let at = 0; at < sentence.length; at += maxParagraphChars) {
          out.push(sentence.slice(at, at + maxParagraphChars));
        }
        continue;
      }
      if (buffer.length + sentence.length > maxParagraphChars) {
        out.push(buffer);
        buffer = sentence;
        continue;
      }
      buffer += sentence;
    }
    if (buffer) out.push(buffer);
  }

  return out.join("\n");
}

export interface FallbackResult {
  chapters: SourceChapter[];
  /** title = 靠标题识别切出；chars = 识别不到标题，按字数切 */
  strategy: "title" | "chars";
}

/**
 * 把一段长文本切成章节。
 *
 * 先让引擎按标题识别切；只切出一章说明没认出任何标题，
 * 这时再强制按字数切一遍。
 */
export function fallbackChaptersFromText(
  text: string,
  options?: { charsPerChapter?: number }
): FallbackResult | null {
  const trimmed = text.trim();
  if (trimmed.length < minTextLength) return null;

  const charsPerChapter = options?.charsPerChapter ?? fallbackCharsPerChapter;

  const byTitle = parseTxt(trimmed, { charsPerChapter: 0 });
  if (byTitle.chapters.length > 1) {
    return { chapters: toSourceChapters(byTitle.chapters), strategy: "title" };
  }

  // 没认出标题，按字数切。先拆开超长段落，否则"整章一个 <p>"的页面切不动
  const byChars = parseTxt(splitLongParagraphs(trimmed), {
    charsPerChapter,
    forceSplitByChars: true,
  });
  if (byChars.chapters.length === 0) return null;
  return { chapters: toSourceChapters(byChars.chapters), strategy: "chars" };
}

/**
 * 兜底章节的正文直接内联在目录结果里 —— 它本来就是从同一份文本切出来的，
 * 没有独立的章节地址可以回源。
 */
function toSourceChapters(
  parsed: { title: string; paragraphs: string[] }[]
): SourceChapter[] {
  return parsed.map((chapter, index) => ({
    // 没有真实 URL，用序号造一个稳定的 key，供增量去重使用
    externalKey: `fallback:${index}`,
    title: chapter.title,
    inlineParagraphs: chapter.paragraphs,
  }));
}
