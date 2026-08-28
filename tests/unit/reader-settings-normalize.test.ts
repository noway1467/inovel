import { describe, expect, it } from "vitest";
import {
  defaultReaderSettings,
  normalizePaginationMode,
  normalizeReaderTheme,
  normalizeSideMargin,
  resolveLineHeight,
  resolveReaderTheme,
  resolveSideInset,
  sideMarginRange,
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

describe("normalizeSideMargin", () => {
  it("放行区间内的值", () => {
    for (let value = sideMarginRange.min; value <= sideMarginRange.max; value += 1) {
      expect(normalizeSideMargin(value)).toBe(value);
    }
  });

  it("越界的值夹回区间", () => {
    expect(normalizeSideMargin(-10)).toBe(sideMarginRange.min);
    expect(normalizeSideMargin(999)).toBe(sideMarginRange.max);
  });

  it("老版本存的设置里没有这个字段，回退到默认值", () => {
    expect(normalizeSideMargin(undefined)).toBe(defaultReaderSettings.sideMargin);
    expect(normalizeSideMargin(null)).toBe(defaultReaderSettings.sideMargin);
    expect(normalizeSideMargin("很宽")).toBe(defaultReaderSettings.sideMargin);
    expect(normalizeSideMargin(Number.NaN)).toBe(defaultReaderSettings.sideMargin);
  });
});

describe("resolveSideInset", () => {
  it("把用户调的比例写进 max()，任何屏宽都生效", () => {
    const inset = resolveSideInset({ ...defaultReaderSettings, sideMargin: 12 });
    expect(inset).toContain("12%");
  });

  it("同时带上行长上限那一项，宽屏上把行压短", () => {
    // 三个约束取最大：留白下限、用户比例、(100% - 行长上限)/2
    const inset = resolveSideInset({ ...defaultReaderSettings, margin: "standard" });
    expect(inset).toContain("calc((100% - 68rem) / 2)");
  });

  it("行长上限随「正文宽度」变化，窄档正文最窄", () => {
    const narrow = resolveSideInset({ ...defaultReaderSettings, margin: "narrow" });
    const wide = resolveSideInset({ ...defaultReaderSettings, margin: "wide" });
    // 此前这张表是反的：选「窄」给的是 96rem，行反而更长
    expect(narrow).toContain("52rem");
    expect(wide).toContain("88rem");
  });

  it("留白调到 0 也保留下限，正文不贴屏幕边", () => {
    const inset = resolveSideInset({ ...defaultReaderSettings, sideMargin: 0 });
    expect(inset).toContain("0.75rem");
  });

  it("下限可以按调用方的容器改", () => {
    expect(resolveSideInset(defaultReaderSettings, "1rem")).toContain("1rem");
  });

  it("存进来的非法比例也不会漏进 CSS", () => {
    // 直接拼进 max() 的话，NaN% 会让整条声明失效，留白全丢
    const inset = resolveSideInset({
      ...defaultReaderSettings,
      sideMargin: Number.NaN,
    });
    expect(inset).not.toContain("NaN");
    expect(inset).toContain(`${defaultReaderSettings.sideMargin}%`);
  });
});
