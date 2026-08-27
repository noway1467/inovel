import type { AppDb } from "~/server/db";

/**
 * 适配器统一契约。每种源只需实现这几个动作，
 * 同步引擎与 UI 完全不关心底层是 XML、JSON 还是 HTML 规则。
 */

export interface SourceContext {
  db: AppDb;
  /** 源配置（规则引擎的选择器等） */
  config: Record<string, unknown>;
  endpoint: string;
  /** 抓取计数，用于同步审计与配额观测 */
  countRequest: () => void;
}

/** 源上的一本书 */
export interface SourceBook {
  /** 源端唯一标识，通常是详情页 URL 或 API id */
  externalId: string;
  title: string;
  author?: string | null;
  description?: string | null;
  coverUrl?: string | null;
  /** 源端声明的授权/版权信息，会展示给运营方 */
  rights?: string | null;
}

/** 目录里的一章 */
export interface SourceChapter {
  /** 源端唯一标识，通常是正文 URL 或 guid；增量去重靠它 */
  externalKey: string;
  title: string;
  /** 部分源（如 RSS）在目录阶段就带了正文，可省一次请求 */
  inlineParagraphs?: string[] | null;
}

export interface SourceAdapter {
  kind: string;
  /** 人类可读的源类型说明，展示在管理台 */
  label: string;
  /** 校验配置与连通性，返回给运营方的诊断信息 */
  probe: (ctx: SourceContext) => Promise<{ ok: boolean; message: string; sampleTitles?: string[] }>;
  /** 搜索；不支持搜索的源返回空数组 */
  search?: (ctx: SourceContext, keyword: string) => Promise<SourceBook[]>;
  /** 列出源上可订阅的书（目录首页/最新列表） */
  listBooks: (ctx: SourceContext) => Promise<SourceBook[]>;
  /** 拉某本书的完整目录，顺序即阅读顺序 */
  listChapters: (ctx: SourceContext, book: { externalId: string }) => Promise<SourceChapter[]>;
  /** 拉单章正文，返回段落数组 */
  fetchChapter: (
    ctx: SourceContext,
    chapter: { externalKey: string }
  ) => Promise<{ paragraphs: string[] }>;
}

/**
 * 纯翻页提示行，不是正文。
 *
 * 分页站把「第(1/3)页」这类标记放在正文容器里，跟随分页后每页首尾各一条，
 * 一章下来就有六七行夹在正文中间。整行只有这个标记时才算提示 ——
 * 正文句子不会长成这样，所以不会误删。
 */
const pageMarkerPatterns = [
  /^第?\s*[(（]?\s*\d{1,4}\s*[/／]\s*\d{1,4}\s*[)）]?\s*页?$/,
  /^本章未完[，,]?\s*(请)?点击?下一页继续阅读[。.]?$/,
];

function isPageMarker(line: string): boolean {
  return pageMarkerPatterns.some((pattern) => pattern.test(line));
}

/** 把正文文本切成段落，过滤空行与翻页提示 */
export function toParagraphs(raw: string): string[] {
  return raw
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0 && !isPageMarker(line));
}

/** 相对地址补全为绝对地址 */
export function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}
