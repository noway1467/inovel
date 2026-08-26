import { describe, expect, it } from "vitest";
import {
  readerThemes,
  resolveReaderTheme,
  type ReaderTheme,
} from "../../app/components/reader/reader-settings";

describe("阅读器主题解析", () => {
  it("跟随系统时按系统深浅色给出配色", () => {
    expect(resolveReaderTheme("system", true)).toBe("ink");
    expect(resolveReaderTheme("system", false)).toBe("paper");
  });

  it("显式选定的主题不受系统偏好影响", () => {
    const explicit: ReaderTheme[] = ["paper", "soft", "parchment", "ink", "oled"];
    for (const theme of explicit) {
      expect(resolveReaderTheme(theme, true)).toBe(theme);
      expect(resolveReaderTheme(theme, false)).toBe(theme);
    }
  });

  it("解析结果一定是 CSS 里存在的具体配色，不会漏出 system", () => {
    // data-reader-theme 只对这几个值有变量定义
    const cssThemes = ["paper", "soft", "parchment", "ink", "oled"];
    for (const theme of readerThemes.map((entry) => entry.key)) {
      expect(cssThemes).toContain(resolveReaderTheme(theme, true));
      expect(cssThemes).toContain(resolveReaderTheme(theme, false));
    }
  });

  it("主题列表把跟随系统排在首位", () => {
    expect(readerThemes[0]?.key).toBe("system");
    expect(readerThemes[0]?.label).toBe("跟随系统");
    expect(readerThemes).toHaveLength(6);
  });
});
