import type { RulesConfig } from "~/server/sources/legado";

/**
 * 把站内的源导出成 Legado 书源 JSON。
 *
 * 与批量导入同一种格式（顶层是数组），所以导出的文件可以直接再导入回来，
 * 也能给开源阅读、其它同格式阅读器用。做的是嵌套格式 —— 那是现行格式，
 * 老版扁平格式只在导入侧兼容，不往外产出。
 *
 * 只导出我们真正用到的规则。站内没有的字段（发现页、登录、UA 等）一律不编，
 * 免得凭空造出源站并不支持的规则。
 */

export interface ExportableSource {
  name: string;
  endpoint: string;
  kind: string;
  config: unknown;
  weight?: number | null;
  status?: string | null;
  verifyStatus?: string | null;
  verifyMessage?: string | null;
}

/** Legado 书源对象。字段名与导入侧的 LegadoBookSource 对齐。 */
interface LegadoExport {
  bookSourceName: string;
  bookSourceUrl: string;
  bookSourceType: number;
  bookSourceGroup?: string;
  bookSourceComment?: string;
  enabled: boolean;
  weight?: number;
  searchUrl?: string;
  ruleSearch?: Record<string, string>;
  ruleBookInfo?: Record<string, string>;
  ruleToc?: Record<string, string>;
  ruleContent?: Record<string, string>;
}

/** 只把有值的键塞进去，空对象直接省掉 —— 导出的 JSON 不留一堆 null */
function compact(entries: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === "string" && value.trim()) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 导出时给个说明，注明来源与验证状态。
 *
 * 导出的源多半是要分享或迁移的，收到文件的人需要知道哪些源是验过能用的、
 * 哪些是「目录靠页面结构探测」这种降级过的。
 */
function buildComment(source: ExportableSource, config: RulesConfig): string {
  const parts: string[] = [];
  if (source.verifyStatus === "ok") parts.push("已验证可用");
  else if (source.verifyStatus === "skipped") parts.push("无法自动验证（需手工给书籍地址）");
  else if (source.verifyStatus === "failed") parts.push("验证未通过");
  if (config.tocMode === "detect") parts.push("目录靠页面结构探测，无目录规则");
  if (source.verifyMessage) parts.push(source.verifyMessage);
  return parts.join("；");
}

/**
 * 单个源转 Legado 对象。
 *
 * 只支持 kind === "rules"：其它类型（比如内置适配器）没有可导出的规则，
 * 导出个空壳给别人反而是误导，交给调用方过滤。
 */
export function toLegadoSource(source: ExportableSource): LegadoExport | null {
  if (source.kind !== "rules") return null;
  const config = source.config as RulesConfig | null;
  if (!config || typeof config !== "object" || !config.contentRule) return null;

  const comment = buildComment(source, config);
  const out: LegadoExport = {
    bookSourceName: source.name,
    bookSourceUrl: source.endpoint,
    // 0 = 文本小说。站内目前只做文本，没有有声/图片源
    bookSourceType: 0,
    enabled: source.status !== "disabled",
  };
  if (comment) out.bookSourceComment = comment;
  if (typeof source.weight === "number") out.weight = source.weight;
  if (config.searchUrl) out.searchUrl = config.searchUrl;

  out.ruleSearch = compact({
    bookList: config.searchList,
    name: config.searchName,
    author: config.searchAuthor,
    bookUrl: config.searchBookUrl,
  });
  out.ruleBookInfo = compact({
    name: config.infoName,
    author: config.infoAuthor,
    intro: config.infoIntro,
    coverUrl: config.infoCover,
    tocUrl: config.infoTocUrl,
  });
  out.ruleToc = compact({
    chapterList: config.tocList,
    chapterName: config.tocName,
    chapterUrl: config.tocUrl,
    nextTocUrl: config.nextTocUrl,
  });
  out.ruleContent = compact({
    content: config.contentRule,
    nextContentUrl: config.nextContentUrl,
  });

  return out;
}

/**
 * 批量导出。返回的字符串就是可直接保存的 .json 文件内容。
 *
 * 缩进 2 空格：导出的文件常要人工看一眼、改一改，压成一行没法读。
 */
export function exportLegadoJson(sources: ExportableSource[]): {
  json: string;
  exported: number;
  skipped: number;
} {
  const converted = sources.map(toLegadoSource).filter((item): item is LegadoExport => item !== null);
  return {
    json: JSON.stringify(converted, null, 2),
    exported: converted.length,
    skipped: sources.length - converted.length,
  };
}

/** 下载用的文件名，带日期便于区分几次导出 */
export function exportFileName(count: number, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10);
  return `yuedu-sources-${count}-${stamp}.json`;
}
