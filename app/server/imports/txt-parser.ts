import {
  isLikelyTitle,
  isSeparatorLine,
  isVolumeTitle,
  maxChapterChars,
  maxChapterParagraphs,
} from "~/server/imports/chapter-rules";

export interface ParsedChapter {
  title: string;
  paragraphs: string[];
  startLine: number;
  endLine: number;
  charCount: number;
  warning?: string;
  volumeTitle?: string;
  sourceId?: string;
  sourceHref?: string;
  isVolume?: boolean;
  truncated?: boolean;
}

export interface TxtParseReport {
  encoding: string;
  lineCount: number;
  warnings: string[];
}

const textDecoderCache = new Map<string, TextDecoder>();

function decoder(label: string) {
  const cached = textDecoderCache.get(label);
  if (cached) return cached;
  const instance = new TextDecoder(label, { fatal: false });
  textDecoderCache.set(label, instance);
  return instance;
}

export function detectEncoding(bytes: Uint8Array): "utf-8" | "gb18030" {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  const probe = bytes.slice(0, Math.min(bytes.length, 8192));
  // 探测窗口可能恰好截断在多字节字符中间（最多 3 字节），逐字节回退重试，
  // 避免合法 UTF-8 文件被误判为 GB18030 导致整本乱码。
  for (let trim = 0; trim <= 3; trim++) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(probe.slice(0, Math.max(0, probe.length - trim)));
      return "utf-8";
    } catch {
      // 继续缩短探测窗口
    }
  }
  return "gb18030";
}

export function decodeText(bytes: Uint8Array, encoding: "utf-8" | "gb18030"): string {
  const text = decoder(encoding).decode(bytes);
  return text.replace(/^\uFEFF/, "");
}

// 队列消费者同样受 Worker CPU 配额约束，解析必须带墙钟预算；超预算时主动失败，
// 让用户看到可读错误而不是整个请求被 1102 掐断。
export const parseTxtTimeoutMs = 20_000;
const parseTimeoutCheckInterval = 1024;
export const defaultCharsPerChapter = 0;

export function parseTxt(
  text: string,
  options: { timeoutMs?: number; charsPerChapter?: number; forceSplitByChars?: boolean } = {}
): { chapters: ParsedChapter[]; report: TxtParseReport } {
  const timeoutMs = options.timeoutMs ?? parseTxtTimeoutMs;
  const charsPerChapter = options.charsPerChapter ?? defaultCharsPerChapter;
  const startedAt = Date.now();
  const lines = text.split(/\r?\n/);
  // 先探测源文件是否自带章节标题：有目录时严格按源文件结构解析，
  // 分隔线不生成虚拟章节；没有目录时才允许按分隔线/字数兜底生成章节。
  const hasRealTitle = lines.some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && isLikelyTitle(trimmed);
  });
  const warnings: string[] = [];
  const chapters: ParsedChapter[] = [];
  let current: ParsedChapter | null = null;
  let volumeOpen = false;
  let currentVolumeTitle = "正文";
  let lastTitleLine = -1;

  const closeCurrent = (endLine: number) => {
    if (current) {
      current.endLine = endLine;
      if (current.truncated) {
        current.warning = `章节超过 ${maxChapterChars} 字或 ${maxChapterParagraphs} 段，已截断`;
      }
      if (current.charCount > maxChapterChars) {
        current.warning = `章节超过 ${maxChapterChars} 字，建议拆分`;
        warnings.push(`“${current.title}”超过 ${maxChapterChars} 字`);
      }
      if (current.paragraphs.length > maxChapterParagraphs) {
        current.warning = `章节段落过多，建议拆分`;
      }
      chapters.push(current);
      current = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    if (i % parseTimeoutCheckInterval === 0 && Date.now() - startedAt > timeoutMs) {
      throw new Error(`文件过大，解析超过 ${Math.round(timeoutMs / 1000)} 秒预算，请拆分后重试`);
    }
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isVolumeTitle(trimmed)) {
      closeCurrent(i - 1);
      currentVolumeTitle = trimmed;
      volumeOpen = true;
      lastTitleLine = i;
      continue;
    }

    if (isSeparatorLine(trimmed)) {
      if (!hasRealTitle) {
        closeCurrent(i - 1);
        current = {
          title: `第 ${chapters.length + 1} 章`,
          paragraphs: [],
          startLine: i,
          endLine: i,
          charCount: 0,
          volumeTitle: currentVolumeTitle,
        };
        lastTitleLine = i;
      }
      continue;
    }

    if (isLikelyTitle(trimmed)) {
      closeCurrent(i - 1);
      current = {
        title: trimmed,
        paragraphs: [],
        startLine: i,
        endLine: i,
        charCount: 0,
       volumeTitle: currentVolumeTitle,
        isVolume: false,
      };
      lastTitleLine = i;
      continue;
    }

    if (current && i - lastTitleLine < 3) {
      // 标题后紧跟的短内容行并入标题章节
      current.paragraphs.push(trimmed);
      current.charCount += trimmed.length;
      continue;
    }

    if (!current) {
      if (chapters.length === 0) {
        current = {
          title: "正文",
          paragraphs: [],
          startLine: i,
          endLine: i,
          charCount: 0,
        volumeTitle: currentVolumeTitle,
        };
      } else {
        warnings.push(`第 ${i + 1} 行存在未归属内容，已并入前一个章节`);
        const last = chapters[chapters.length - 1];
        last?.paragraphs.push(trimmed);
        if (last) last.endLine = i;
        continue;
      }
    }
    const paragraphChars = trimmed.length;
    current.paragraphs.push(trimmed);
    current.charCount += paragraphChars;
  }

  closeCurrent(lines.length - 1);

  // 卷标题未被消费时记录
  if (volumeOpen && chapters.length === 0) {
    warnings.push("检测到卷标题，但没有识别到章节标题");
  }

  const split = hasRealTitle && !options.forceSplitByChars
    ? { chapters, warnings: [] as string[] }
    : splitOversizedChapters(chapters, charsPerChapter);
  warnings.push(...split.warnings);
  return {
    chapters: dedupeParsedChapters(split.chapters),
    report: { encoding: "utf-8", lineCount: lines.length, warnings },
  };
}

// 仅用于没有章节标题的文件：按设定字数兜底拆章，保证无目录大文本仍可分章阅读。
function splitOversizedChapters(
  chapters: ParsedChapter[],
  charsPerChapter: number
): { chapters: ParsedChapter[]; warnings: string[] } {
  if (!(charsPerChapter > 0)) return { chapters, warnings: [] };
  const result: ParsedChapter[] = [];
  const warnings: string[] = [];
  for (const chapter of chapters) {
    if (chapter.charCount <= charsPerChapter || chapter.paragraphs.length === 0) {
      result.push(chapter);
      continue;
    }
    const parts: ParsedChapter[] = [];
    let currentParagraphs: string[] = [];
    let currentChars = 0;
    let part = 1;
    for (const paragraph of chapter.paragraphs) {
      if (currentParagraphs.length > 0 && currentChars + paragraph.length > charsPerChapter) {
        parts.push(makeSplitPart(chapter, part, currentParagraphs, currentChars));
        currentParagraphs = [];
        currentChars = 0;
        part += 1;
      }
      currentParagraphs.push(paragraph);
      currentChars += paragraph.length;
    }
    if (currentParagraphs.length > 0) {
      parts.push(makeSplitPart(chapter, part, currentParagraphs, currentChars));
    }
    warnings.push(`“${chapter.title}”超过 ${charsPerChapter} 字，已按字数拆分为 ${parts.length} 章`);
    result.push(...parts);
  }
  return { chapters: result, warnings };
}

function makeSplitPart(
  base: ParsedChapter,
  part: number,
  paragraphs: string[],
  charCount: number
): ParsedChapter {
  const title =
    base.title === "正文" || !base.title
      ? `第 ${part} 章`
      : part === 1
        ? base.title
        : `${base.title}（${part}）`;
  return {
    title,
    paragraphs: [...paragraphs],
    startLine: base.startLine,
    endLine: base.endLine,
    charCount,
    volumeTitle: base.volumeTitle,
    sourceId: base.sourceId,
    sourceHref: base.sourceHref,
  };
}

// 章节标题只来自源文件；没有任何实际正文的标题行（常见于目录条目/空转页）
// 直接丢弃，避免导入 0 字数伪章节。同标题且正文完全相同时视为重复章节，
// 静默过滤；标题相同但正文不同的一律保留，避免把不同章节误删。
export function dedupeParsedChapters(chapters: ParsedChapter[]): ParsedChapter[] {
  const seen = new Set<string>();
  const result: ParsedChapter[] = [];
  for (const chapter of chapters) {
    if (!chapter.paragraphs.some((paragraph) => paragraph.trim().length > 0)) continue;
    const key = `${chapter.title.trim()}\u0000${normalizedParagraphs(chapter.paragraphs)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(chapter);
  }
  return result;
}

function normalizedParagraphs(paragraphs: string[]): string {
  return paragraphs.map((paragraph) => paragraph.trim().replace(/\s+/g, " ")).join("\n");
}
