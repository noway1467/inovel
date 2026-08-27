import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportFileName, exportLegadoJson, toLegadoSource } from "~/server/sources/export";
import { parseLegadoJson } from "~/server/sources/legado";

/**
 * 导出书源为 Legado JSON。
 *
 * 关键要求：导出的文件能直接再导入回来 —— 这既是分享/迁移的用法，
 * 也是最有力的自检（往返一圈规则不变，说明两侧字段名是对齐的）。
 */

const base = {
  name: "测试源",
  endpoint: "https://example.com",
  kind: "rules",
  config: {
    searchUrl: "/s?q={{key}}",
    searchList: ".item",
    searchName: "a@text",
    searchBookUrl: "a@href",
    tocList: ".chapter a",
    tocName: "text",
    tocUrl: "href",
    contentRule: "#content@html",
    nextContentUrl: ".next@href",
  },
};

describe("toLegadoSource", () => {
  it("导出嵌套格式，字段名与导入侧一致", () => {
    const out = toLegadoSource(base);
    expect(out).toMatchObject({
      bookSourceName: "测试源",
      bookSourceUrl: "https://example.com",
      bookSourceType: 0,
      enabled: true,
      searchUrl: "/s?q={{key}}",
      ruleSearch: { bookList: ".item", name: "a@text", bookUrl: "a@href" },
      ruleToc: { chapterList: ".chapter a", chapterName: "text", chapterUrl: "href" },
      ruleContent: { content: "#content@html", nextContentUrl: ".next@href" },
    });
  });

  it("空规则不编成 null，整组为空时省掉那一层", () => {
    const out = toLegadoSource({
      ...base,
      config: { contentRule: "#content@html" },
    });
    expect(out?.ruleContent).toEqual({ content: "#content@html" });
    // 搜索、详情、目录都没有规则，不该出现空对象
    expect(out?.ruleSearch).toBeUndefined();
    expect(out?.ruleBookInfo).toBeUndefined();
    expect(out?.ruleToc).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("null");
  });

  it("非规则源与没有正文规则的源不导出", () => {
    expect(toLegadoSource({ ...base, kind: "builtin" })).toBeNull();
    expect(toLegadoSource({ ...base, config: {} })).toBeNull();
    expect(toLegadoSource({ ...base, config: null })).toBeNull();
  });

  it("停用的源导出时 enabled 为 false", () => {
    expect(toLegadoSource({ ...base, status: "disabled" })?.enabled).toBe(false);
    expect(toLegadoSource({ ...base, status: "enabled" })?.enabled).toBe(true);
  });

  it("验证状态与降级情况写进 comment", () => {
    expect(toLegadoSource({ ...base, verifyStatus: "ok" })?.bookSourceComment).toContain("已验证可用");
    expect(toLegadoSource({ ...base, verifyStatus: "skipped" })?.bookSourceComment).toContain(
      "无法自动验证"
    );
    const detect = toLegadoSource({
      ...base,
      config: { ...base.config, tocMode: "detect" },
    });
    expect(detect?.bookSourceComment).toContain("页面结构探测");
  });
});

describe("exportLegadoJson", () => {
  it("顶层是数组，与批量导入格式一致", () => {
    const { json, exported, skipped } = exportLegadoJson([base, base]);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(exported).toBe(2);
    expect(skipped).toBe(0);
  });

  it("跳过不可导出的源并计数", () => {
    const { exported, skipped } = exportLegadoJson([base, { ...base, kind: "builtin" }]);
    expect(exported).toBe(1);
    expect(skipped).toBe(1);
  });

  it("导出空列表得到空数组，不是 null", () => {
    expect(JSON.parse(exportLegadoJson([]).json)).toEqual([]);
  });
});

describe("导出再导入（往返）", () => {
  it("导出的 JSON 能被 parseLegadoJson 直接读回来，规则不变", () => {
    const { json } = exportLegadoJson([base]);
    const back = parseLegadoJson(json);
    expect(back.failed).toHaveLength(0);
    expect(back.converted).toHaveLength(1);

    const config = back.converted[0]!.config;
    expect(config.contentRule).toBe(base.config.contentRule);
    expect(config.tocList).toBe(base.config.tocList);
    expect(config.tocName).toBe(base.config.tocName);
    expect(config.tocUrl).toBe(base.config.tocUrl);
    expect(config.searchUrl).toBe(base.config.searchUrl);
    expect(config.nextContentUrl).toBe(base.config.nextContentUrl);
  });

  it("真实清单：导入 → 导出 → 再导入，数量不掉", () => {
    const fixture = readFileSync("tests/fixtures/legado-flat-sources.json", "utf8");
    const first = parseLegadoJson(fixture);

    const { json } = exportLegadoJson(
      first.converted.map((item) => ({
        name: item.name,
        endpoint: item.endpoint,
        kind: "rules",
        config: item.config,
      }))
    );
    const second = parseLegadoJson(json);

    // 往返一圈不该丢源：丢了就说明某个字段名两侧没对齐
    expect(second.converted.length).toBe(first.converted.length);
    expect(second.failed).toHaveLength(0);
  });
});

describe("exportFileName", () => {
  it("带数量与日期", () => {
    expect(exportFileName(42, new Date("2026-08-28T10:00:00Z"))).toBe(
      "yuedu-sources-42-2026-08-28.json"
    );
  });
});
