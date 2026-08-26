import { parseEpub } from "~/server/imports/epub-parser";
import { parseMobi } from "~/server/imports/mobi-parser";
import { parsePdf } from "~/server/imports/pdf-parser";
import {
  decodeText,
  defaultCharsPerChapter,
  dedupeParsedChapters,
  detectEncoding,
  parseTxt,
  type ParsedChapter,
} from "~/server/imports/txt-parser";

export const supportedExtensions = ["txt", "epub", "mobi", "pdf"] as const;
export type SupportedExtension = (typeof supportedExtensions)[number];

// 全本大书分片提交能落库，但解析阶段章节对象要整本驻留内存做报告；
// 章节数没有上限时报告会反向拖垮 Worker，这里给一个可执行的硬上限。
export const maxChaptersPerImport = 5000;

export interface ParsedBook {
  format: SupportedExtension;
  chapters: ParsedChapter[];
  warnings: string[];
  encoding?: string;
  metadata?: { title?: string; author?: string };
  pageCount?: number;
}

export interface ParseBookOptions {
  charsPerChapter?: number;
  forceSplitByChars?: boolean;
}

export function detectExtension(fileName: string): SupportedExtension | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return supportedExtensions.includes(ext as SupportedExtension)
    ? (ext as SupportedExtension)
    : null;
}

export async function parseBookFile(
  bytes: Uint8Array,
  fileName: string,
  options: ParseBookOptions = {}
): Promise<ParsedBook> {
  const ext = detectExtension(fileName);
  if (!ext) {
    throw new Error(`不支持的文件格式：${fileName}`);
  }

  let parsed: ParsedBook;
  if (ext === "txt") {
    const encoding = detectEncoding(bytes);
    const text = decodeText(bytes, encoding);
    const { chapters, report } = parseTxt(text, {
      charsPerChapter: options.charsPerChapter ?? defaultCharsPerChapter,
      forceSplitByChars: options.forceSplitByChars,
    });
    parsed = { format: ext, chapters, warnings: report.warnings, encoding };
  } else if (ext === "epub") {
    const { chapters, metadata, warnings } = await parseEpub(bytes);
    parsed = { format: ext, chapters, warnings, metadata };
  } else if (ext === "mobi") {
    const { chapters, metadata, warnings } = await parseMobi(bytes);
    parsed = { format: ext, chapters, warnings, metadata };
  } else {
    const { chapters, warnings, pageCount } = await parsePdf(bytes);
    parsed = { format: ext, chapters, warnings, pageCount };
  }

  // 分片只是解析/写入手段，最终章节结构以源文件目录为准：
  // 同标题且正文相同视为重复，静默过滤；同标题正文不同则全部保留。
  // TXT 解析器内部已经完成去重；这里仅处理其他格式，避免大文本重复扫描和拼接正文。
  if (ext !== "txt") parsed.chapters = dedupeParsedChapters(parsed.chapters);

  if (parsed.chapters.length > maxChaptersPerImport) {
    throw new Error(`章节数超过 ${maxChaptersPerImport} 章上限，请拆分后导入`);
  }
  return parsed;
}
