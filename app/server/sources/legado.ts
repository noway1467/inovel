import { UnsupportedRuleError, parseRule } from "~/server/sources/rule-expr";

/**
 * 开源阅读（Legado）书源 JSON → 内部规则配置。
 *
 * 只做格式转换与可行性校验，不内置任何现成书源：域名仍要逐个过
 * source_domains 授权白名单才能抓取。
 *
 * Legado 字段远多于此，这里取订阅链路真正需要的那部分：
 * 目录列表、章节名、章节地址、正文。搜索与详情为可选增强。
 */

export interface RulesConfig {
  /** 书籍详情页/目录页地址模板，{{key}} 为搜索关键字占位 */
  searchUrl?: string | null;
  /** 搜索结果列表规则 */
  searchList?: string | null;
  searchName?: string | null;
  searchAuthor?: string | null;
  searchBookUrl?: string | null;
  /** 详情页规则 */
  infoName?: string | null;
  infoAuthor?: string | null;
  infoIntro?: string | null;
  infoCover?: string | null;
  infoTocUrl?: string | null;
  /** 目录规则（必需） */
  tocList: string;
  tocName: string;
  tocUrl: string;
  /** 正文规则（必需） */
  contentRule: string;
  /** 源站基地址，用于相对链接补全 */
  baseUrl?: string | null;
}

interface LegadoSearchRule {
  bookList?: string;
  name?: string;
  author?: string;
  bookUrl?: string;
}

interface LegadoInfoRule {
  name?: string;
  author?: string;
  intro?: string;
  coverUrl?: string;
  tocUrl?: string;
}

interface LegadoTocRule {
  chapterList?: string;
  chapterName?: string;
  chapterUrl?: string;
}

interface LegadoContentRule {
  content?: string;
}

export interface LegadoBookSource {
  bookSourceName?: string;
  bookSourceUrl?: string;
  bookSourceComment?: string;
  searchUrl?: string;
  ruleSearch?: LegadoSearchRule;
  ruleBookInfo?: LegadoInfoRule;
  ruleToc?: LegadoTocRule;
  ruleContent?: LegadoContentRule;
}

export interface ConversionResult {
  name: string;
  endpoint: string;
  config: RulesConfig;
  /** 无法翻译但不致命的规则，提示运营方手工调整 */
  warnings: string[];
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * 判断地址模板是否需要 JS 求值。
 *
 * 单纯的 {{key}} / {{searchKey}} 占位是纯文本替换，可以直接用；
 * 但含赋值、方法调用（java.ajax、source.getKey 等）的就要执行 JS。
 */
export function needsJsEvaluation(template: string): boolean {
  const trimmed = template.trim();
  // 整段就是脚本：@js: 前缀、<js> 包裹，或直接以 var/function 开头
  if (/^@js:/i.test(trimmed) || trimmed.includes("<js>")) return true;
  if (/^(var|let|const|function)\s/.test(trimmed)) return true;
  // 出现 Legado 注入的宿主对象，说明要执行脚本
  if (/\b(java|source|cookie|cache|result)\s*\./.test(trimmed)) return true;

  const placeholders = trimmed.match(/\{\{[\s\S]*?\}\}/g);
  if (!placeholders) return false;
  // 纯占位（{{key}}）是文本替换，可以直接用；带表达式的则需要求值
  return placeholders.some((raw) => {
    const body = raw.slice(2, -2).trim();
    return !/^(key|searchKey|page)$/i.test(body);
  });
}

/** 校验规则可被引擎理解；不可用时记为警告并返回 null */
function validate(rule: string | null, label: string, warnings: string[]): string | null {
  if (!rule) return null;
  try {
    parseRule(rule);
    return rule;
  } catch (error) {
    const reason = error instanceof UnsupportedRuleError ? error.message : String(error);
    warnings.push(`${label}：${reason}`);
    return null;
  }
}

export class LegadoConversionError extends Error {}

/**
 * 解析单个书源对象。缺目录或正文规则则无法订阅，直接报错 ——
 * 这两项是增量更新的最低要求。
 */
export function convertLegadoSource(raw: unknown): ConversionResult {
  if (typeof raw !== "object" || raw === null) {
    throw new LegadoConversionError("不是合法的书源对象");
  }
  const source = raw as LegadoBookSource;
  const name = clean(source.bookSourceName);
  const endpoint = clean(source.bookSourceUrl);
  if (!name) throw new LegadoConversionError("缺少 bookSourceName");
  if (!endpoint) throw new LegadoConversionError("缺少 bookSourceUrl");

  const warnings: string[] = [];

  const tocList = clean(source.ruleToc?.chapterList);
  // chapterName/chapterUrl 常写成裸属性名（"text" / "href"），
  // 缺失时按这两个默认值兜底 —— 真实书源里很常见
  const tocName = clean(source.ruleToc?.chapterName) ?? (tocList ? "text" : null);
  const tocUrl = clean(source.ruleToc?.chapterUrl) ?? (tocList ? "href" : null);
  const contentRule = clean(source.ruleContent?.content);

  if (!tocList || !tocName || !tocUrl) {
    throw new LegadoConversionError(
      "缺少目录规则（ruleToc.chapterList），无法做增量更新。有声源与仅供发现页的源通常没有这项。"
    );
  }
  if (!contentRule) {
    throw new LegadoConversionError("缺少正文规则（ruleContent.content）");
  }

  // 目录与正文规则必须能翻译，否则这个源装进来也跑不动
  for (const [rule, label] of [
    [tocList, "目录列表"],
    [tocName, "章节名"],
    [tocUrl, "章节地址"],
    [contentRule, "正文"],
  ] as const) {
    try {
      parseRule(rule);
    } catch (error) {
      const reason = error instanceof UnsupportedRuleError ? error.message : String(error);
      throw new LegadoConversionError(`${label}规则无法翻译 —— ${reason}`);
    }
  }

  // searchUrl 含 {{...}} JS 模板的占近四成。这类源目录与正文仍可用，
  // 只是不能搜索 —— 记为警告并丢弃搜索能力，不整源拒绝
  const rawSearchUrl = clean(source.searchUrl);
  const searchUrlUsable = rawSearchUrl ? !needsJsEvaluation(rawSearchUrl) : false;
  if (rawSearchUrl && !searchUrlUsable) {
    warnings.push("搜索地址需要 JS 求值，已禁用该源的搜索；目录与正文不受影响");
  }

  const config: RulesConfig = {
    searchUrl: searchUrlUsable ? rawSearchUrl : null,
    searchList: validate(clean(source.ruleSearch?.bookList), "搜索列表", warnings),
    searchName: validate(clean(source.ruleSearch?.name), "搜索结果书名", warnings),
    searchAuthor: validate(clean(source.ruleSearch?.author), "搜索结果作者", warnings),
    searchBookUrl: validate(clean(source.ruleSearch?.bookUrl), "搜索结果详情地址", warnings),
    infoName: validate(clean(source.ruleBookInfo?.name), "详情书名", warnings),
    infoAuthor: validate(clean(source.ruleBookInfo?.author), "详情作者", warnings),
    infoIntro: validate(clean(source.ruleBookInfo?.intro), "详情简介", warnings),
    infoCover: validate(clean(source.ruleBookInfo?.coverUrl), "详情封面", warnings),
    infoTocUrl: validate(clean(source.ruleBookInfo?.tocUrl), "详情目录地址", warnings),
    tocList,
    tocName,
    tocUrl,
    contentRule,
    baseUrl: endpoint,
  };

  return { name, endpoint, config, warnings };
}

export interface BatchConversionResult {
  converted: ConversionResult[];
  failed: { name: string; reason: string }[];
}

/**
 * 解析书源 JSON（单个对象或数组）。
 * 逐条转换，失败的记原因返回，不让一条坏规则毁掉整批。
 */
export function parseLegadoJson(text: string): BatchConversionResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LegadoConversionError("不是合法 JSON");
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) throw new LegadoConversionError("JSON 里没有书源");

  const converted: ConversionResult[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const item of list) {
    const label =
      (typeof item === "object" && item !== null
        ? clean((item as LegadoBookSource).bookSourceName)
        : null) ?? "未命名书源";
    try {
      converted.push(convertLegadoSource(item));
    } catch (error) {
      failed.push({
        name: label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { converted, failed };
}

/** 把关键字填进搜索地址模板 */
export function buildSearchUrl(template: string, keyword: string): string {
  const encoded = encodeURIComponent(keyword);
  return template
    .replace(/\{\{\s*key\s*\}\}/gi, encoded)
    .replace(/\{\{\s*searchKey\s*\}\}/gi, encoded)
    .replace(/searchKey/g, encoded);
}
