import { extractText, getDocumentProxy } from "unpdf";
import { parseTxt } from "~/server/imports/txt-parser";

export interface PdfParseResult {
  chapters: Awaited<ReturnType<typeof parseTxt>>["chapters"];
  metadata: { title?: string };
  warnings: string[];
  pageCount: number;
}

export async function parsePdf(bytes: Uint8Array): Promise<PdfParseResult> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  if (!text || text.trim().length === 0) {
    throw new Error("PDF 未提取到文本，可能为扫描版");
  }

  // 清理 PDF 常见的页眉/页脚与多余空白后按章节标题切分
  const cleaned = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => !/^\d{1,4}\s*$/.test(line))
    .join("\n");
  const { chapters, report } = parseTxt(cleaned);
  return {
    chapters,
    metadata: {},
    warnings: report.warnings,
    pageCount: totalPages,
  };
}
