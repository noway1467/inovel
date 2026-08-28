import { UnsupportedRuleError, parseRule, stripListPrefix } from "~/server/sources/rule-expr";
import { splitUrlAndOptions, templateIsSupported } from "~/server/sources/url-options";
import { isSupportedAjaxRule } from "~/server/sources/java-ajax";

/**
 * v3: JSON 目录数组展开、目录/正文分页兜底、POST 目录选项、
 *     扁平格式、净化规则、java.ajax 与全局 header。
 * v4: 正文规则不可译时改走通用探测（contentMode）、清洗段里的
 *     `{{}}`/`<js>` 不再拖垮整条规则。
 * 修改转换器能力时递增，让老配置能在重新导入时升级。
 */
export const currentConverterVersion = 4;

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
  /**
   * 导入器能力版本。老版本导入的源缺这个字段；同地址重新导入时，
   * 新版转换结果可以覆盖旧配置，而不是被“已存在”直接复用。
   */
  converterVersion?: number;
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
  /**
   * 正文规则。contentMode === "rules" 时必需；"detect" 时为空，
   * 由适配器的通用正文探测接手。
   */
  contentRule?: string | null;
  /**
   * 正文怎么来：按规则取，还是从页面结构探测。
   *
   * 与 tocMode 同理。正文规则原先是硬门槛，翻译不了就整源拒收 —— 实测
   * 600 个真实书源里 35 个的正文规则是真 JS（AES 解密、Jsoup 调用），
   * 而它们的搜索与目录规则大多完好。正文页是最好探测的一类页面
   * （整页最大的一坨连续文字就是正文），没道理为此丢掉整个源。
   */
  contentMode?: "rules" | "detect";
  /** 正文下一页地址；长章节分多页时靠它拼完整 */
  nextContentUrl?: string | null;
  /**
   * 正文净化规则（书源的 replaceRegex）。原样存，取正文时才解析执行。
   *
   * 书源作者写好的清理规则，专治广告、"本章未完"、"一秒记住…"、页码标记
   * 这类删不掉的杂物。四种格式与安全边界见 purify.ts —— 这些正则来自第三方，
   * 必须限长限量并挡掉会灾难性回溯的形状，否则能烧穿 Worker 的 CPU。
   */
  contentReplaceRegex?: string | null;
  /** 源站基地址，用于相对链接补全 */
  baseUrl?: string | null;

  /** Legado 全局 header，用于搜索、目录、正文等所有请求。 */
  headers?: Record<string, string> | null;

  /**
   * 发现页（分类浏览）。原样存书源写的模板，取书单时才解析 ——
   * 这样解析器改进了不必重新导入一遍所有源。
   *
   * 存它的意义：有一批源搜索规则要 JS 求值、降级后没有搜索入口，
   * 能读却找不到书。发现页规则大多还在，按分类浏览正好救回这批源。
   */
  exploreUrl?: string | null;
  exploreList?: string | null;
  exploreName?: string | null;
  exploreAuthor?: string | null;
  exploreBookUrl?: string | null;
  exploreCover?: string | null;
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
  replaceRegex?: string;
}

interface LegadoExploreRule {
  bookList?: string;
  name?: string;
  author?: string;
  bookUrl?: string;
  coverUrl?: string;
}

export interface LegadoBookSource {
  bookSourceName?: string;
  bookSourceUrl?: string;
  /** 书源自带权重，用作搜索排序的初始优先级 */
  weight?: number;
  bookSourceComment?: string;
  header?: string | Record<string, unknown>;
  searchUrl?: string;
  ruleSearch?: LegadoSearchRule;
  ruleBookInfo?: LegadoInfoRule;
  ruleToc?: LegadoTocRule;
  ruleContent?: LegadoContentRule;
  exploreUrl?: string;
  ruleExplore?: LegadoExploreRule;
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
  /** 正文净化规则，见 purify.ts */
  ruleBookContentReplaceRegex?: string;
  /** 发现页（分类浏览）。ruleFindUrl 里是分类清单，两种格式见 explore.ts */
  ruleFindUrl?: string;
  ruleFindList?: string;
  ruleFindName?: string;
  ruleFindAuthor?: string;
  ruleFindNoteUrl?: string;
  ruleFindCoverUrl?: string;
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
  fillMissing(content, "replaceRegex", clean(raw.ruleBookContentReplaceRegex));

  fillMissing(raw, "exploreUrl", clean(raw.ruleFindUrl));
  const explore = (raw.ruleExplore ??= {});
  fillMissing(explore, "bookList", clean(raw.ruleFindList));
  fillMissing(explore, "name", clean(raw.ruleFindName));
  fillMissing(explore, "author", clean(raw.ruleFindAuthor));
  fillMissing(explore, "bookUrl", clean(raw.ruleFindNoteUrl));
  fillMissing(explore, "coverUrl", clean(raw.ruleFindCoverUrl));
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
 * 保留书源自带请求头，而不是只吃规则。
 * Legado 源经常靠 UA/Referer 过反爬；丢掉它，规则翻译得再对也会被源站拒掉。
 */
function parseHeaderMap(value: unknown): Record<string, string> | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    try {
      return parseHeaderMap(JSON.parse(text));
    } catch {
      const header = /["']?User-Agent["']?\s*:\s*(["'])([\s\S]*?)\1/i.exec(text);
      return header?.[2] ? { "user-agent": header[2] } : null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    if (/^(host|content-length|connection)$/i.test(key)) continue;
    out[key.toLowerCase()] = raw;
  }
  return Object.keys(out).length > 0 ? out : null;
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

/**
 * 这条规则是「地址模板」还是「选择器」。
 *
 * 地址模板用于目录走 JSON 接口的源：章节地址不是从节点上取 href，而是用条目
 * 字段拼出来（`@get:{url}p{{$.ordernum}}.html`）。判据是出现 `@get:{` 或
 * `{{$.` —— 前者读 java.put 存的变量，后者取条目里的字段，选择器语法里都不会有。
 */
function isUrlTemplate(raw: string): boolean {
  return /@get:\{/.test(raw) || /\{\{\s*\$\./.test(raw);
}

/**
 * 详情页目录地址：可能是普通选择器，也可能是「地址 + 选项」的请求描述。
 *
 * 后者是目录走接口的源（POST + body），此前被当成"需要 JS"丢掉，结果整个源
 * 退化成从详情页刮最新几章。这里只要表达式全都能求值就留下原文。
 */
function resolveTocUrlRule(raw: string | null, warnings: string[]): string | null {
  if (!raw) return null;
  const { url } = splitUrlAndOptions(raw);
  // 带 {{}} 的才需要判；普通选择器照旧走 validate
  if (!/\{\{/.test(url) && !/@get:\{/.test(url)) return validate(raw, "详情目录地址", warnings);
  if (templateIsSupported(url)) return raw;
  warnings.push("详情目录地址需要 JS 求值，已忽略");
  return null;
}

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

/** 正文专用 AJAX 兜底；搜索/目录 AJAX 形态更复杂，仍然不硬放行。 */
function resolveContentRule(raw: string | null): RuleOutcome {
  if (isSupportedAjaxRule(raw)) {
    return { state: "ok", rule: raw!, note: "已支持常见 java.ajax 正文规则" };
  }
  return resolveRule(raw);
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

  const headers = parseHeaderMap(source.header);
  if (headers) warnings.push("已启用书源自带请求头");

  const rawTocList = clean(source.ruleToc?.chapterList);
  // chapterName/chapterUrl 常写成裸属性名（"text" / "href"），
  // 缺失时按这两个默认值兜底 —— 真实书源里很常见
  const rawTocName = clean(source.ruleToc?.chapterName) ?? (rawTocList ? "text" : null);
  const rawTocUrl = clean(source.ruleToc?.chapterUrl) ?? (rawTocList ? "href" : null);

  /**
   * 正文规则不可用（缺失或翻译不了）时改标 detect，由通用正文探测接手。
   *
   * 正文页是最好探测的一类页面：整页最大的一坨连续文字就是正文。为一条
   * 正文规则丢掉整个源太浪费 —— 这类源的搜索与目录规则大多完好。
   *
   * 空壳源不是靠这一项挡的，而是靠下面的「三样全空」判断：合集里那 312 个
   * 空壳的搜索、目录、正文规则一并是空的，没有任何入口。
   */
  const contentOutcome = resolveContentRule(clean(source.ruleContent?.content));
  const contentMode: "rules" | "detect" = contentOutcome.state === "ok" ? "rules" : "detect";
  const contentRule = contentOutcome.state === "ok" ? contentOutcome.rule : null;
  if (contentOutcome.state === "ok" && contentOutcome.note) {
    warnings.push(`正文：${contentOutcome.note}`);
  }
  if (contentOutcome.state === "unusable") {
    warnings.push(
      `正文规则无法翻译（${contentOutcome.reason}），已改为从页面结构探测正文。` +
        `搜索与目录规则不受影响。`
    );
  }

  /**
   * chapterUrl 有两种形态，要分开判：
   *
   *  1. 选择器 —— `a@href`，从目录节点上取属性（绝大多数源）
   *  2. 地址模板 —— `@get:{url}p{{$.ordernum}}.html`，用条目字段拼出地址
   *
   * 第二种在「目录走 JSON 接口」的源里很常见（爱下电子书8 就是），按选择器
   * 去解会拒掉或解成碎片，于是整组降级、只能从详情页刮到最新几章。
   */
  const tocUrlIsTemplate = rawTocUrl ? isUrlTemplate(rawTocUrl) : false;
  const tocUrlOutcome: RuleOutcome = tocUrlIsTemplate
    ? templateIsSupported(rawTocUrl!)
      ? { state: "ok", rule: rawTocUrl! }
      : { state: "unusable", reason: "章节地址模板里有无法求值的表达式" }
    : resolveRule(rawTocUrl);

  /**
   * 目录三件套要么整组可用，要么整组放弃转探测 —— 不能只留一半：
   * 有 chapterList 没 chapterUrl 的话，取出来的章节没有可访问地址。
   */
  const tocOutcomes = {
    tocList: resolveRule(rawTocList),
    tocName: resolveRule(rawTocName),
    tocUrl: tocUrlOutcome,
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

  /**
   * 拒空壳源：搜索地址、目录规则、正文规则三样全无。
   *
   * 这是合集里 312/600 的形态 —— 导出时规则被清空，只剩个名字和网址。
   * 装进来只会让源列表看着多、实际一个都打不开。有任意一样就留下：
   * 目录规则在、正文靠探测能读；正文规则在、目录靠探测也能读。
   */
  const hasSearchRule = Boolean(searchUrlUsable || clean(source.ruleSearch?.bookList));
  if (!hasSearchRule && !rawTocList && contentOutcome.state === "absent") {
    throw new LegadoConversionError("书源没有可用规则（搜索、目录、正文都为空）");
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
    /**
     * 详情页里的目录地址。
     *
     * 不走 validate：这一项常是「地址 + 选项」形态（POST 取 JSON 目录，
     * 即源站那个「完整目录」按钮），validate 按选择器判会当成"需要 JS"丢掉。
     * 能不能用由 url-options.ts 逐个表达式判，存原文、取目录时才求值。
     */
    infoTocUrl: resolveTocUrlRule(clean(source.ruleBookInfo?.tocUrl), warnings),
    tocMode,
    tocList: tocMode === "rules" ? (tocOutcomes.tocList as { rule: string }).rule : null,
    tocName: tocMode === "rules" ? (tocOutcomes.tocName as { rule: string }).rule : null,
    tocUrl: tocMode === "rules" ? (tocOutcomes.tocUrl as { rule: string }).rule : null,
    // 分页规则可缺、可不可译：缺了只是拿不到后续页，不影响首页可用
    nextTocUrl: validate(clean(source.ruleToc?.nextTocUrl), "目录分页", warnings),
    contentMode,
    contentRule,
    nextContentUrl: validate(clean(source.ruleContent?.nextContentUrl), "正文分页", warnings),
    /**
     * 净化规则原样存，不走 validate —— 它是正则而不是选择器，
     * 按选择器那套判会被当成"无法翻译"丢掉。能不能安全执行由 purify.ts
     * 逐条判（限长限量、挡掉灾难性回溯的形状）。
     */
    contentReplaceRegex: clean(source.ruleContent?.replaceRegex),
    baseUrl: endpoint,
    converterVersion: currentConverterVersion,
    headers,

    /**
     * 发现页规则原样存下，不走 validate —— 分类地址里带 {{page}} 算术是常态，
     * 按搜索地址那套标准会被判成"需要 JS"而丢掉。真正能不能用，
     * 由 explore.ts 逐个分类判断（纯 page 算术能算，三元表达式跳过）。
     */
    exploreUrl: clean(source.exploreUrl),
    exploreList: clean(source.ruleExplore?.bookList),
    exploreName: clean(source.ruleExplore?.name),
    exploreAuthor: clean(source.ruleExplore?.author),
    exploreBookUrl: clean(source.ruleExplore?.bookUrl),
    exploreCover: clean(source.ruleExplore?.coverUrl),
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
