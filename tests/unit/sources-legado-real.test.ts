import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildSearchUrl,
  degradeJsRule,
  needsJsEvaluation,
  parseLegadoJson,
} from "~/server/sources/legado";
import { canParseRule } from "~/server/sources/rule-expr";
import { templateIsSupported } from "~/server/sources/url-options";

interface RawSource {
  bookSourceName?: string;
  ruleToc?: { chapterList?: string; chapterName?: string; chapterUrl?: string };
  ruleContent?: { content?: string };
  ruleSearch?: { bookList?: string; name?: string; bookUrl?: string };
}

/**
 * 针对真实书源合集的转换率回归。
 *
 * `_bs.json` 是从书源站抓下来的 600 条合集，体积近 2MB，不入库
 * （见 .gitignore）。文件不存在时整组跳过，避免 CI 因缺文件而红。
 *
 * 这组用例的价值在于：把"能导入多少"变成一个可观测、会回归的数字，
 * 而不是靠感觉判断。
 */

const fixturePath = "_bs.json";
const hasFixture = existsSync(fixturePath);

describe.skipIf(!hasFixture)("真实书源合集转换率", () => {
  const text = hasFixture ? readFileSync(fixturePath, "utf8") : "[]";
  const raw = hasFixture ? (JSON.parse(text) as unknown[]) : [];
  const result = hasFixture ? parseLegadoJson(text) : { converted: [], failed: [] };

  it("合集规模符合预期", () => {
    expect(raw.length).toBeGreaterThan(500);
  });

  /**
   * 实测基线（600 条合集）：
   *   可导入 209 (34.8%)，其中支持搜索 174 (29.0%)
   *   被拒 391：无目录规则 314 (52.3%)、规则需 JS 求值 77 (12.8%)
   *
   * 无目录规则的那 314 条是有声源与只供发现页的源，天生不适用订阅，
   * 不该算进分母。所以真正的指标是"在适用源里的转换率"。
   */
  const applicable = raw.filter((s) => {
    const src = s as { ruleToc?: { chapterList?: string }; ruleContent?: { content?: string } };
    return Boolean(src.ruleToc?.chapterList) && Boolean(src.ruleContent?.content);
  });

  it("适用源（有目录+正文规则）的转换率不低于七成", () => {
    const rate = result.converted.length / applicable.length;
    expect(applicable.length).toBeGreaterThan(200);
    expect(rate).toBeGreaterThan(0.7);
  });

  it("整体可导入比例不低于三成，防止回退", () => {
    expect(result.converted.length / raw.length).toBeGreaterThan(0.3);
  });

  it("转换成功的源里，多数保留了搜索能力", () => {
    const withSearch = result.converted.filter((c) => c.config.searchUrl).length;
    expect(withSearch / result.converted.length).toBeGreaterThan(0.7);
  });

  /**
   * 目录规则要么可求值，要么整组为空并标成 detect（交给页面结构探测）。
   * 不允许"留一半"：有 tocList 没 tocUrl 的话章节没有可访问地址。
   */
  it("转换成功的源，目录规则可求值或明确标为探测", () => {
    for (const item of result.converted) {
      /**
       * 正文与目录一样有两种合法形态：规则可求值，或整条为空并标成 detect
       * （正文靠页面结构探测）。同样不允许"留一半"。
       */
      if (item.config.contentMode === "detect") {
        expect(item.config.contentRule).toBeNull();
      } else {
        expect(canParseRule(item.config.contentRule!)).toBe(true);
      }
      if (item.config.tocMode === "detect") {
        expect(item.config.tocList).toBeNull();
        expect(item.config.tocName).toBeNull();
        expect(item.config.tocUrl).toBeNull();
        continue;
      }
      expect(canParseRule(item.config.tocList!)).toBe(true);
      expect(canParseRule(item.config.tocName!)).toBe(true);
      /**
       * 章节地址有两种合法形态：选择器（`a@href`，从节点取属性）和地址模板
       * （`@get:{url}p{{$.ordernum}}.html`，用条目字段拼）。后者用于目录走
       * JSON 接口的源 —— 那种目录里根本没有 href，地址是算出来的，
       * 拿去 canParseRule 判必然不通过。
       */
      const tocUrl = item.config.tocUrl!;
      const isTemplate = /@get:\{/.test(tocUrl) || /\{\{\s*\$\./.test(tocUrl);
      expect(isTemplate || canParseRule(tocUrl)).toBe(true);
      if (isTemplate) expect(templateIsSupported(tocUrl)).toBe(true);
    }
  });

  /**
   * 填完关键字的搜索地址里不能残留 `{{}}` 占位。
   *
   * `{{page}}` 曾被漏掉：needsJsEvaluation 认它是纯文本占位而放行，
   * buildSearchUrl 却不替换，于是地址里留着字面量 `{{page}}`，请求必然
   * 404。合集里两成有搜索地址的源是这种写法，表现为"搜索永远失败"，
   * 再被验证判失败清理掉 —— 症状看起来像"源不可用"，根因却在这一行。
   */
  it("搜索地址填完后不残留任何占位", () => {
    const withSearch = result.converted.filter((c) => c.config.searchUrl);
    expect(withSearch.length).toBeGreaterThan(100);
    for (const item of withSearch) {
      const built = buildSearchUrl(item.config.searchUrl!, "修仙");
      expect(built, `残留占位：${built}`).not.toMatch(/\{\{|\}\}/);
    }
  });

  it("保留了搜索能力的源，搜索规则也一定可求值", () => {
    for (const item of result.converted) {
      if (!item.config.searchUrl) continue;
      // 搜索地址不需要 JS，才会被保留
      expect(item.config.searchUrl).not.toMatch(/java\.|source\.|cookie\./);
      if (item.config.searchList) {
        expect(canParseRule(item.config.searchList)).toBe(true);
      }
    }
  });

  it("每条失败都带可读原因，不静默丢弃", () => {
    for (const fail of result.failed) {
      expect(fail.reason.length).toBeGreaterThan(0);
      expect(fail.name.length).toBeGreaterThan(0);
    }
    expect(result.converted.length + result.failed.length).toBe(raw.length);
  });

  /**
   * 直接校验引擎能吃下真实合集里的 || 与 !n 规则本身。
   *
   * 早先这条断言的是"含 || 的源不被拒"，但一个源被拒可能是另一条规则
   * 需要 JS 求值 —— 与 || 无关，断言因此不成立。改成只测规则本身。
   */
  it("真实合集里的 || 与 !n 规则都能被引擎解析", () => {
    const collect = (predicate: (rule: string) => boolean) => {
      const found: string[] = [];
      for (const s of raw) {
        const src = s as RawSource;
        const rules = [
          src.ruleToc?.chapterList,
          src.ruleToc?.chapterName,
          src.ruleToc?.chapterUrl,
          src.ruleContent?.content,
          src.ruleSearch?.bookList,
          src.ruleSearch?.name,
          src.ruleSearch?.bookUrl,
        ];
        for (const rule of rules) {
          if (typeof rule !== "string") continue;
          // 需要 JS 求值的规则本就不在支持范围内，排除
          if (needsJsEvaluation(rule)) continue;
          /**
           * 带 JS 段的规则也排除：它们不直接过 parseRule，而是先经
           * degradeJsRule 抢救出 CSS/JSONPath 部分（下一条用例专门测）。
           * needsJsEvaluation 判的是地址模板，认不出中段的 `@js:`。
           */
          if (/@js:/i.test(rule) || rule.includes("<js>")) continue;
          if (predicate(rule)) found.push(rule);
        }
      }
      return found;
    };

    const withOr = collect((rule) => rule.includes("||"));
    const withBang = collect((rule) => /![-\d]/.test(rule));

    expect(withOr.length).toBeGreaterThan(0);
    expect(withBang.length).toBeGreaterThan(0);
    for (const rule of [...withOr, ...withBang]) {
      expect(canParseRule(rule), `无法解析：${rule}`).toBe(true);
    }
  });

  /**
   * 带 JS 段的规则不能被"静默错解"。
   *
   * 此前 JS 判别只看规则开头，中段带 `@js:` 的会被拆进选择器（或整段当成
   * JSONPath），parseRule 照样返回成功 —— 源导入成功、运行时永远空手而归，
   * 且不报任何错。这是最难排查的一类失效，用真实合集守住。
   */
  it("中段带 @js: 的规则被识破，且能抢救出 CSS/JSONPath 头", () => {
    const midJs: string[] = [];
    for (const s of raw) {
      const src = s as RawSource;
      for (const rule of [src.ruleToc?.chapterList, src.ruleContent?.content]) {
        if (typeof rule !== "string") continue;
        if (rule.search(/@js:/i) > 0) midJs.push(rule);
      }
    }
    expect(midJs.length).toBeGreaterThan(0);

    for (const rule of midJs) {
      // 不能被当成可直接求值的规则
      expect(canParseRule(rule), `本应判为不可解析：${rule.slice(0, 60)}`).toBe(false);
      // 但 JS 之前的部分应能抢救出来
      const degraded = degradeJsRule(rule);
      if (degraded) expect(canParseRule(degraded.rule)).toBe(true);
    }
  });

  /**
   * `+` / `-` 前缀的列表规则同样不能静默错解。
   * `+@js:(...)` 此前绕过 JS 判别，被解析成一堆永不命中的选择器碎片。
   */
  it("+/- 前缀 + JS 的列表规则被识破", () => {
    const prefixed: string[] = [];
    for (const s of raw) {
      const rule = (s as RawSource).ruleToc?.chapterList;
      if (typeof rule !== "string") continue;
      if (/^\s*[+-]/.test(rule) && /@js:|<js>/i.test(rule)) prefixed.push(rule);
    }
    for (const rule of prefixed) {
      expect(canParseRule(rule), `本应判为不可解析：${rule.slice(0, 60)}`).toBe(false);
    }
  });

  /**
   * 转换成功的源里，走探测的那部分应当是少数。
   *
   * 探测是兜底而非常态：如果这个比例失控，说明规则翻译层退化了 ——
   * 大量本可按规则取目录的源被降级成"猜"。
   */
  it("走探测的源只占少数，探测是兜底不是主路径", () => {
    const detect = result.converted.filter((c) => c.config.tocMode === "detect").length;
    expect(detect / result.converted.length).toBeLessThan(0.5);
  });
});
