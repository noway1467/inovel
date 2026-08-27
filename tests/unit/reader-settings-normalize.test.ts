import { describe, expect, it } from "vitest";
import {
  defaultReaderSettings,
  normalizePaginationMode,
  normalizeReaderTheme,
  resolveLineHeight,
  resolveReaderTheme,
} from "~/components/reader/reader-settings";

describe("normalizeReaderTheme", () => {
  it("放行受支持的主题", () => {
    for (const theme of ["system", "paper", "soft", "parchment", "ink", "oled"] as const) {
      expect(normalizeReaderTheme(theme)).toBe(theme);
    }
  });

  it("老库里的 sepia 这类陌生值回退，不会落到 data-reader-theme 上", () => {
    // 直接硬转会让 CSS 匹配不到任何变量，阅读器整页没配色
    expect(normalizeReaderTheme("sepia")).toBe("system");
    expect(normalizeReaderTheme("")).toBe("system");
    expect(normalizeReaderTheme(null)).toBe("system");
    expect(normalizeReaderTheme(undefined)).toBe("system");
    expect(normalizeReaderTheme(42)).toBe("system");
  });

  it("可以指定回退值", () => {
    expect(normalizeReaderTheme("sepia", "ink")).toBe("ink");
  });

  it("回退结果一定能解析成具体配色", () => {
    const resolved = resolveReaderTheme(normalizeReaderTheme("sepia"), false);
    expect(["paper", "soft", "parchment", "ink", "oled"]).toContain(resolved);
  });
});

describe("resolveLineHeight", () => {
  it("把面板存的百分数转成 CSS 倍数", () => {
    expect(resolveLineHeight(180)).toBeCloseTo(1.8);
    expect(resolveLineHeight(140)).toBeCloseTo(1.4);
    expect(resolveLineHeight(240)).toBeCloseTo(2.4);
  });

  it("整个滑块区间都落在合理行高内", () => {
    // 原来在线源阅读页把 180 当无单位倍数用，行高变成 fontSize×180，
    // 正文被推到列外，整页空白且页数暴涨
    for (let value = 140; value <= 240; value += 5) {
      const resolved = resolveLineHeight(value);
      expect(resolved).toBeGreaterThan(1);
      expect(resolved).toBeLessThan(3);
    }
  });

  it("入参已经是倍数时原样返回", () => {
    expect(resolveLineHeight(1.8)).toBeCloseTo(1.8);
    expect(resolveLineHeight(2)).toBeCloseTo(2);
  });

  it("非法值回退到默认行距", () => {
    const fallback = defaultReaderSettings.lineHeight / 100;
    expect(resolveLineHeight(0)).toBeCloseTo(fallback);
    expect(resolveLineHeight(-5)).toBeCloseTo(fallback);
    expect(resolveLineHeight(Number.NaN)).toBeCloseTo(fallback);
  });
});

describe("normalizePaginationMode", () => {
  it("放行受支持的分页模式", () => {
    for (const mode of ["scroll", "cover", "none"] as const) {
      expect(normalizePaginationMode(mode)).toBe(mode);
    }
  });

  it("陌生值回退到默认（cover）", () => {
    expect(normalizePaginationMode("page-turn")).toBe("cover");
    expect(normalizePaginationMode(null)).toBe("cover");
  });

  it("可以指定回退值", () => {
    expect(normalizePaginationMode("page-turn", "cover")).toBe("cover");
  });
});
