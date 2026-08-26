import { describe, expect, it } from "vitest";
import {
  normalizePaginationMode,
  normalizeReaderTheme,
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
