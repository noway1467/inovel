import { UnsupportedRuleError, parseRule, stripListPrefix } from "~/server/sources/rule-expr";

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
  /**
   * 目录规则。tocMode === "rules" 时必需；"detect" 时为空，
   * 由适配器的通用目录探测接手。
   */
  tocList?: string | null;
  tocName?: string | null;
  tocUrl?: string | null;
  /**
   * 目录怎么来：按规则取，还是从页面结构探测。
   *
   * 有一类源（聚合站尤其多）目录规则整段是 JS：正则拼 HTML、章节地址
   * base64 藏在随机 data-* 里。这种规则无法翻译，但页面结构本身仍能
   * 探测出目录 —— 所以不再整源拒绝，改为标成 detect 交给探测器。
   */
  tocMode?: "rules" | "detect";
  /** 目录下一页地址；目录分多页时靠它翻完 */
  nextTocUrl?: string | null;
  /** 正文规则（必需） */
  contentRule: string;
  /** 正文下一页地址；长章节分多页时靠它拼完整 */
  nextContentUrl?: string | null;
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
  nextTocUrl?: string;
}

interface LegadoContentRule {
  content?: string;
  nextContentUrl?: string;
}

export interface LegadoBookSource {
  bookSourceName?: string;
  bookSourceUrl?: string;
  /** 书源自带权重，用作搜索排序的初始优先级 */
  weight?: number;
  bookSourceComment?: string;
  searchUrl?: string;
  ruleSearch?: LegadoSearchRule;
  ruleBookInfo?: LegadoInfoRule;
  ruleToc?: LegadoTocRule;
  ruleContent?: LegadoContentRule;
}

/**
 * 老版扁平格式的书源（`flyersoft: true` 那一代）。
 *
 * 规则不分组，全在顶层：`ruleBookContent` 而不是 `ruleContent.content`。
 * 合集里这种格式占比极高 —— 实测某份 50 源的清单里 49 个是扁平、0 个是嵌套，
 * 而我们只读嵌套，于是整份清单一个都进不来。这是"书源明明可用却被剔除"
 * 的主要原因，跟规则本身能不能翻译无关：连规则都还没看就已经判空了。
 */
interface LegadoFlatSource {
  ruleSearchUrl?: string;
  ruleSearchList?: string;
  ruleSearchName?: string;
  ruleSearchAuthor?: string;
  ruleSearchNoteUrl?: string;
  ruleBookName?: string;
  ruleBookAuthor?: string;
  ruleIntroduce?: string;
  ruleCoverUrl?: string;
  /** 目录页地址（`{{$.}}list.html` 这类拼法），对应 ruleBookInfo.tocUrl */
  ruleChapterUrl?: string;
  ruleChapterList?: string;
  ruleChapterName?: string;
  /**
   * 目录行里的章节链接（`a@href`），对应 ruleToc.chapterUrl。
   *
   * 名字和语义是反的：ruleContentUrl 不是正文地址，而是目录项指向的章节地址；
   * 真正的目录页地址在 ruleChapterUrl。搞反会让每个源的目录全空，
   * 所以这一对是照实际书源样本核对过的（ruleChapterList + ruleChapterName +
   * ruleContentUrl 明显是"列表、章名、链接"一组）。
   */
  ruleContentUrl?: string;
  ruleChapterUrlNext?: string;
  ruleBookContent?: string;
  ruleContentUrlNext?: string;
}

/** 仅在嵌套字段缺失时填入，嵌套格式的源完全不受影响 */
function fillMissing<T extends object>(target: T, key: keyof T, value: string | null): void {
  if (value === null) return;
  if (clean(target[key] as unknown) !== null) return;
  (target as Record<string, unknown>)[key as string] = value;
}

/**
 * 扁平格式规范化成嵌套格式。
 *
 * 就地补齐 source 上缺失的嵌套字段，之后所有下游读取（ruleContent.content
 * 等）无需再关心源用的是哪一代格式。两种格式并存时嵌套优先。
 */
export function normalizeFlatSource(raw: LegadoBookSource & LegadoFlatSource): void {
  fillMissing(raw, "searchUrl", clean(raw.ruleSearchUrl));

  const search = (raw.ruleSearch ??= {});
  fillMissing(search, "bookList", clean(raw.ruleSearchList));
  fillMissing(search, "name", clean(raw.ruleSearchName));
  fillMissing(search, "author", clean(raw.ruleSearchAuthor));
  fillMissing(search, "bookUrl", clean(raw.ruleSearchNoteUrl));

  const info = (raw.ruleBookInfo ??= {});
  fillMissing(info, "name", clean(raw.ruleBookName));
  fillMissing(info, "author", clean(raw.ruleBookAuthor));
  fillMissing(info, "intro", clean(raw.ruleIntroduce));
  fillMissing(info, "coverUrl", clean(raw.ruleCoverUrl));
  fillMissing(info, "tocUrl", clean(raw.ruleChapterUrl));

  const toc = (raw.ruleToc ??= {});
  fillMissing(toc, "chapterList", clean(raw.ruleChapterList));
  fillMissing(toc, "chapterName", clean(raw.ruleChapterName));
  fillMissing(toc, "chapterUrl", clean(raw.ruleContentUrl));
  fillMissing(toc, "nextTocUrl", clean(raw.ruleChapterUrlNext));

  const content = (raw.ruleContent ??= {});
  fillMissing(content, "content", clean(raw.ruleBookContent));
  fillMissing(content, "nextContentUrl", clean(raw.ruleContentUrlNext));
}

export interface ConversionResult {
  name: string;
  endpoint: string;
  config: RulesConfig;
  /**
   * 书源自带的 weight，作为搜索排序的初始优先级。
   * 站内搜索每次只查一小批源，得有个"先查谁"的依据。
   */
  weight: number;
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

/**
 * 含 JS 的规则里把还能用的 CSS 部分抢救出来。
 *
 * 合集里 JS 大多不是「非 JS 不可」，而是两种能降级的形态：
 *
 *  1. CSS 头 + JS 尾：`class.content@html@js:(去标签、解实体、删广告)`
 *     JS 干的活我们的正文管线（blockTextOf + toParagraphs）本来就做。
 *     砍掉 JS 尾巴，留下 `class.content@html` 即可。
 *
 *  2. 纯 JS 但内层就是一条规则：`@js:var c=java.getString('.mrx-cot@p@html');...`
 *     JS 外壳是「取不到就换源重试」之类的兜底，主路径仍是那条 CSS。
 *     把内层规则取出来单用，退化成「只走主路径」。
 *
 * 两种都取不到才算真的要 JS 引擎（正则拼 HTML、base64 解地址那类）。
 * 返回 null 表示无法降级，由调用方决定是警告还是拒绝。
 */
export function degradeJsRule(rule: string): { rule: string; note: string } | null {
  const input = stripListPrefix(rule.trim());
  if (!input) return null;

  // 形态 1：@js: 之前还有内容，那部分就是选择器
  const jsAt = input.search(/@js:/i);
  if (jsAt > 0) {
    const head = input.slice(0, jsAt).replace(/@+$/, "").trim();
    if (head && canTranslate(head)) {
      return { rule: head, note: "已丢弃 JS 后处理，保留 CSS 部分" };
    }
  }

  // 形态 2：JS 内层的 java.getString('规则') / java.getStringList("规则")
  const inner = input.match(/java\.getStringL?i?s?t?\s*\(\s*(['"])([\s\S]*?)\1/i);
  const candidate = inner?.[2]?.trim();
  if (candidate && canTranslate(candidate)) {
    return { rule: candidate, note: "已从 JS 中取出内层 CSS 规则，仅保留主路径" };
  }

  return null;
}

/** 规则能否被引擎理解。degradeJsRule 用它判断抢救出来的片段是否可用。 */
function canTranslate(rule: string): boolean {
  try {
    parseRule(rule);
    return true;
  } catch {
    return false;
  }
}

/**
 * 规则解析结果。必须区分「没写」和「写了但用不了」——
 * 前者是源本来就没这项能力，后者要给运营方明确的降级提示。
 */
type RuleOutcome =
  | { state: "absent" }
  | { state: "ok"; rule: string; note?: string }
  | { state: "unusable"; reason: string };

/** 解析一条规则，能直接用则用，含 JS 则先试降级 */
function resolveRule(raw: string | null): RuleOutcome {
  if (!raw) return { state: "absent" };
  try {
    parseRule(raw);
    // parseRule 会剥 +/- 前缀，存进 config 的也要是剥过的，两边保持一致
    return { state: "ok", rule: stripListPrefix(raw.trim()) };
  } catch (error) {
    const degraded = degradeJsRule(raw);
    if (degraded) return { state: "ok", rule: degraded.rule, note: degraded.note };
    return {
      state: "unusable",
      reason: error instanceof UnsupportedRuleError ? error.message : String(error),
    };
  }
}

/** 校验规则可被引擎理解；不可用时记为警告并返回 null */
function validate(rule: string | null, label: string, warnings: string[]): string | null {
  const outcome = resolveRule(rule);
  if (outcome.state === "absent") return null;
  if (outcome.state === "unusable") {
    warnings.push(`${label}：${outcome.reason}`);
    return null;
  }
  if (outcome.note) warnings.push(`${label}：${outcome.note}`);
  return outcome.rule;
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
  // 老版扁平格式先摊平成嵌套，后面的读取就不用管是哪一代格式了
  normalizeFlatSource(source);
  const name = clean(source.bookSourceName);
  const endpoint = clean(source.bookSourceUrl);
  if (!name) throw new LegadoConversionError("缺少 bookSourceName");
  if (!endpoint) throw new LegadoConversionError("缺少 bookSourceUrl");

  const warnings: string[] = [];

  const rawTocList = clean(source.ruleToc?.chapterList);
  // chapterName/chapterUrl 常写成裸属性名（"text" / "href"），
  // 缺失时按这两个默认值兜底 —— 真实书源里很常见
  const rawTocName = clean(source.ruleToc?.chapterName) ?? (rawTocList ? "text" : null);
  const rawTocUrl = clean(source.ruleToc?.chapterUrl) ?? (rawTocList ? "href" : null);

  /**
   * 正文规则是硬门槛：没有它这个源连一章都读不出来，装进来毫无意义。
   * 目录则不是 —— 页面结构能探测，见下面的 tocMode。
   */
  const contentOutcome = resolveRule(clean(source.ruleContent?.content));
  if (contentOutcome.state === "absent") {
    throw new LegadoConversionError("缺少正文规则（ruleContent.content）");
  }
  if (contentOutcome.state === "unusable") {
    throw new LegadoConversionError(`正文规则无法翻译 —— ${contentOutcome.reason}`);
  }
  const contentRule = contentOutcome.rule;
  if (contentOutcome.note) warnings.push(`正文：${contentOutcome.note}`);

  /**
   * 目录三件套要么整组可用，要么整组放弃转探测 —— 不能只留一半：
   * 有 chapterList 没 chapterUrl 的话，取出来的章节没有可访问地址。
   */
  const tocOutcomes = {
    tocList: resolveRule(rawTocList),
    tocName: resolveRule(rawTocName),
    tocUrl: resolveRule(rawTocUrl),
  } as const;
  const tocLabels = { tocList: "目录列表", tocName: "章节名", tocUrl: "章节地址" } as const;

  const tocUsable = Object.values(tocOutcomes).every((outcome) => outcome.state === "ok");
  const tocMode: "rules" | "detect" = tocUsable ? "rules" : "detect";
  if (tocUsable) {
    for (const [key, outcome] of Object.entries(tocOutcomes)) {
      if (outcome.state === "ok" && outcome.note) {
        warnings.push(`${tocLabels[key as keyof typeof tocLabels]}：${outcome.note}`);
      }
    }
  } else {
    // 说清是哪一项拖垮了整组，否则运营方看到"改用探测"无从判断该不该修规则
    const blockers = Object.entries(tocOutcomes)
      .filter(([, outcome]) => outcome.state !== "ok")
      .map(([key, outcome]) =>
        outcome.state === "unusable"
          ? `${tocLabels[key as keyof typeof tocLabels]}（${outcome.reason}）`
          : `${tocLabels[key as keyof typeof tocLabels]}（未提供）`
      );
    warnings.push(
      `目录规则不可用：${blockers.join("、")}。已改为从页面结构探测目录，正文规则不受影响。`
    );
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
    tocMode,
    tocList: tocMode === "rules" ? (tocOutcomes.tocList as { rule: string }).rule : null,
    tocName: tocMode === "rules" ? (tocOutcomes.tocName as { rule: string }).rule : null,
    tocUrl: tocMode === "rules" ? (tocOutcomes.tocUrl as { rule: string }).rule : null,
    // 分页规则可缺、可不可译：缺了只是拿不到后续页，不影响首页可用
    nextTocUrl: validate(clean(source.ruleToc?.nextTocUrl), "目录分页", warnings),
    contentRule,
    nextContentUrl: validate(clean(source.ruleContent?.nextContentUrl), "正文分页", warnings),
    baseUrl: endpoint,
  };

  const weight = typeof source.weight === "number" && Number.isFinite(source.weight)
    ? source.weight
    : 0;
  return { name, endpoint, config, weight, warnings };
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

/**
 * 把关键字填进搜索地址模板。
 *
 * `{{page}}` 必须一并替换掉。needsJsEvaluation 把它当作纯文本占位而放行
 * （它确实不需要 JS），但此前这里不替换 —— 地址里就留着字面量
 * `/s/修仙/{{page}}/`，请求必然 404。合集里 268 个有搜索地址的源中 56 个
 * 用了 `{{page}}`，即两成源"搜索永远失败"，进而被验证判失败、被清理删掉。
 *
 * 我们只取搜索结果首页，所以固定填 1。
 */
export function buildSearchUrl(template: string, keyword: string, page = 1): string {
  const encoded = encodeURIComponent(keyword);
  return template
    .replace(/\{\{\s*key\s*\}\}/gi, encoded)
    .replace(/\{\{\s*searchKey\s*\}\}/gi, encoded)
    .replace(/\{\{\s*page\s*\}\}/gi, String(page))
    .replace(/searchKey/g, encoded);
}
