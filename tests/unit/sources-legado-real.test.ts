import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { needsJsEvaluation, parseLegadoJson } from "~/server/sources/legado";
import { canParseRule } from "~/server/sources/rule-expr";

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

  it("转换成功的源，目录与正文规则一定可被引擎求值", () => {
    for (const item of result.converted) {
      expect(canParseRule(item.config.tocList)).toBe(true);
      expect(canParseRule(item.config.tocName)).toBe(true);
      expect(canParseRule(item.config.tocUrl)).toBe(true);
      expect(canParseRule(item.config.contentRule)).toBe(true);
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
});
