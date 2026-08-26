import type { RulesConfig } from "~/server/sources/legado";
import { needsJsEvaluation } from "~/server/sources/legado";
import { canParseRule } from "~/server/sources/rule-expr";

/**
 * 开源阅读「订阅源」格式 → 内部规则配置。
 *
 * 字段与书源完全不同：sourceName / sourceUrl / ruleArticles，
 * 不能走 legado.ts 那条路。实测某订阅源（193）长这样：
 *   {"sourceName":"源仓库(官方纯净)","sourceUrl":"http://yckceo.vip",
 *    "singleUrl":true,"enableJs":true, ...}
 *
 * 两类形态要分开处理：
 *  - singleUrl 且无 ruleArticles：只是个书签，App 里直接开网页，
 *    没有可解析的列表结构 → 不能纳入订阅管线
 *  - 有 ruleArticles：可当"列表页 + 正文页"抓，映射到 toc/content 规则
 */

export interface LegadoRssSource {
  sourceName?: string;
  sourceUrl?: string;
  sourceGroup?: string;
  sourceIcon?: string;
  singleUrl?: boolean;
  enableJs?: boolean;
  enabled?: boolean;
  /** 文章列表规则 */
  ruleArticles?: string;
  ruleTitle?: string;
  ruleLink?: string;
  ruleContent?: string;
  rulePubDate?: string;
  ruleDescription?: string;
  ruleImage?: string;
}

export interface RssConversionResult {
  name: string;
  endpoint: string;
  /** feed = 走标准 RSS/Atom 解析；rules = 走 CSS 规则抓列表页 */
  kind: "feed" | "rules";
  config: RulesConfig | null;
  warnings: string[];
}

export class RssConversionError extends Error {}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function convertRssSource(raw: unknown): RssConversionResult {
  if (typeof raw !== "object" || raw === null) {
    throw new RssConversionError("不是合法的订阅源对象");
  }
  const source = raw as LegadoRssSource;
  const name = clean(source.sourceName);
  const endpoint = clean(source.sourceUrl);
  if (!name) throw new RssConversionError("缺少 sourceName");
  if (!endpoint) throw new RssConversionError("缺少 sourceUrl");

  const warnings: string[] = [];
  const articles = clean(source.ruleArticles);

  /**
   * 没有列表规则时，把它当标准 RSS/Atom 地址交给 feed 适配器。
   * 这类源在 App 里是直接开网页的书签，但地址往往本身就是个 feed，
   * 交给 feed 适配器试一次比直接拒绝更有用（probe 会告诉运营方结果）。
   */
  if (!articles) {
    if (source.singleUrl) {
      warnings.push("该源在原 App 里是直接打开网页的书签，已按标准 RSS/Atom 地址接入，请用「测试连通」确认");
    } else {
      warnings.push("没有 ruleArticles，已按标准 RSS/Atom 地址接入");
    }
    return { name, endpoint, kind: "feed", config: null, warnings };
  }

  if (needsJsEvaluation(articles)) {
    throw new RssConversionError("文章列表规则需要 JS 求值，本引擎不支持");
  }
  if (!canParseRule(articles)) {
    throw new RssConversionError(`文章列表规则无法翻译：${articles.slice(0, 60)}`);
  }

  // 标题与链接常省略，按裸属性名兜底，与书源目录规则同理
  const title = clean(source.ruleTitle) ?? "text";
  const link = clean(source.ruleLink) ?? "href";
  for (const [rule, label] of [
    [title, "文章标题"],
    [link, "文章地址"],
  ] as const) {
    if (needsJsEvaluation(rule) || !canParseRule(rule)) {
      throw new RssConversionError(`${label}规则无法翻译：${rule.slice(0, 60)}`);
    }
  }

  // 正文规则可缺：缺了就退回用列表页的描述字段
  let content = clean(source.ruleContent);
  if (content && (needsJsEvaluation(content) || !canParseRule(content))) {
    warnings.push("正文规则需要 JS 求值或无法翻译，已改用列表页描述作为正文");
    content = null;
  }
  if (!content) {
    const description = clean(source.ruleDescription);
    if (description && canParseRule(description) && !needsJsEvaluation(description)) {
      content = description;
      warnings.push("没有可用的正文规则，已改用 ruleDescription");
    }
  }
  if (!content) {
    throw new RssConversionError("既无可用正文规则也无 ruleDescription，无法取到内容");
  }

  return {
    name,
    endpoint,
    kind: "rules",
    config: {
      searchUrl: null,
      searchList: null,
      searchName: null,
      searchAuthor: null,
      searchBookUrl: null,
      infoName: null,
      infoAuthor: null,
      infoIntro: null,
      infoCover: clean(source.ruleImage),
      infoTocUrl: null,
      // 订阅源的"目录"就是文章列表，"正文"就是文章内容
      tocList: articles,
      tocName: title,
      tocUrl: link,
      contentRule: content,
      baseUrl: endpoint,
    },
    warnings,
  };
}

export interface RssBatchResult {
  converted: RssConversionResult[];
  failed: { name: string; reason: string }[];
}

export function parseRssSourceJson(text: string): RssBatchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RssConversionError("不是合法 JSON");
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) throw new RssConversionError("JSON 里没有订阅源");

  const converted: RssConversionResult[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const item of list) {
    const label =
      (typeof item === "object" && item !== null
        ? clean((item as LegadoRssSource).sourceName)
        : null) ?? "未命名订阅源";
    try {
      converted.push(convertRssSource(item));
    } catch (error) {
      failed.push({ name: label, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { converted, failed };
}
