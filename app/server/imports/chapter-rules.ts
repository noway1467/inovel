/**
 * 中文小说章节标题规则。
 * 规则思路参考开源阅读器/小说导入项目（legado 阅读、轻小说机翻等）的通用约定：
 * 章节标题独立成行、长度受限、以“第 N 章/节/回/卷/集/部/篇”或常见卷末标记开头。
 * 数字类支持阿拉伯、中文以及两者混搭（如“第一百零5章”“第053节”）。
 */

const cnNum = "0-9零〇一二三四五六七八九十百千万两";

// 可选“正文”前缀 + 第 N 章/节/回/集/部/篇；也覆盖“第五卷、第九章”这类卷章同行的组合标题
export const chapterTitlePattern = new RegExp(
  `^\\s*(?:正文\\s*)?(第\\s*[${cnNum}]+\\s*[章节回卷集部篇][^\\n]{0,60})\\s*$`
);

export const specialTitlePattern = new RegExp(
  "^\\s*(序章|序言|序文|序幕|自序|前言|楔子|引子|引言|尾声|终章|终幕|大结局|结局|结语|后记|附录|作品相关|完本感言|完结感言|番外(?:篇|外传|特别篇)?[^\\n]{0,40})\\s*$"
);

// 1、标题 / 001. 标题 / 3：标题
export const numberedTitlePattern = new RegExp("^\\s*\\d{1,4}[、.．:：]\\s*\\S{1,40}\\s*$");

// 纯数字独立成行（001 / 42），或两位以上数字 + 空格 + 短标题（012 风起）；
// 排除“3 天后”“10 分钟后”这类时间短句（标题首字不允许是时间单位）
export const bareNumberTitlePattern = new RegExp(
  "^\\s*(?:\\d{1,4}|\\d{2,4}\\s+(?![天年月日时分秒])[^\\s。！？，,]{1,24})\\s*$"
);

// 中文数字序号：一、开端 / 十二.重逢
export const cnNumberedTitlePattern = new RegExp(
  "^\\s*[零〇一二三四五六七八九十百千两]{1,8}[、.．]\\s*\\S{1,40}\\s*$"
);

// （3）标题 / (十二) 标题
export const parenNumberTitlePattern = new RegExp(
  `^\\s*[（(]\\s*[${cnNum}]{1,8}\\s*[)）]\\s*\\S{0,40}\\s*$`
);

export const bracketedTitlePattern = new RegExp(
  `^\\s*[【\\[]\\s*(第\\s*[${cnNum}]+\\s*[章节回卷集部篇][^\\]】]{0,60})\\s*[\\]】]\\s*$`
);

export const englishChapterPattern = new RegExp("^\\s*(?:chapter)\\s+\\d{1,5}\\s*(?:[:：.\\-—]\\s*.*)?$", "i");

export const separatorLinePattern = new RegExp("^\\s*[-=_*]{3,}\\s*$");

// 纯卷标题；带负向前瞻排除“第五卷、第九章”这类卷章同行的组合（那是章节标题，不能当卷吞掉）
export const volumeTitlePattern = new RegExp(
  `^\\s*(?:正文\\s*)?第\\s*[${cnNum}]+\\s*卷(?![^\\n]*[章节回集])[^\\n]{0,50}\\s*$`
);

export const maxTitleLength = 60;
export const maxChapterParagraphs = 4000;
export const maxChapterChars = 400_000;

export function isLikelyTitle(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 1 || trimmed.length > maxTitleLength) return false;
  // 完整语句即使以“第一章…”开头，也不能被吞成目录标题。
  if (/[。！？!?]$/.test(trimmed)) return false;
  return (
    chapterTitlePattern.test(trimmed) ||
    specialTitlePattern.test(trimmed) ||
    numberedTitlePattern.test(trimmed) ||
    bareNumberTitlePattern.test(trimmed) ||
    cnNumberedTitlePattern.test(trimmed) ||
    parenNumberTitlePattern.test(trimmed) ||
    bracketedTitlePattern.test(trimmed) ||
    englishChapterPattern.test(trimmed)
  );
}

export function isVolumeTitle(line: string): boolean {
  return volumeTitlePattern.test(line.trim());
}

export function isSeparatorLine(line: string): boolean {
  return separatorLinePattern.test(line.trim());
}
