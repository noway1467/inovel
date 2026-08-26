import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectListFormat } from "~/server/sources/import-url";
import { parseRssSourceJson } from "~/server/sources/rss-source";

/**
 * 针对真实订阅源文件的回归。
 *
 * `_rss.json` 从订阅源站抓下来，不入库（见 .gitignore）。
 * 文件不存在时整组跳过。
 */

const fixturePath = "_rss.json";
const hasFixture = existsSync(fixturePath);

describe.skipIf(!hasFixture)("真实订阅源文件", () => {
  const text = hasFixture ? readFileSync(fixturePath, "utf8") : "[]";

  it("被判别为订阅源格式，而不是书源", () => {
    // 两种格式字段完全不同，判别错就会用错转换器
    expect(detectListFormat(text)).toBe("rssSource");
  });

  it("能完成转换，不因缺列表规则而整条拒绝", () => {
    const result = parseRssSourceJson(text);
    expect(result.converted.length + result.failed.length).toBeGreaterThan(0);
    // 实测这条是 singleUrl 书签式，应按标准 feed 接入并给出提示
    expect(result.converted.length).toBeGreaterThan(0);
    const first = result.converted[0]!;
    expect(first.name.length).toBeGreaterThan(0);
    expect(first.endpoint).toMatch(/^https?:\/\//);
    expect(first.kind).toBe("feed");
    expect(first.warnings.length).toBeGreaterThan(0);
  });

  it("每条失败都带可读原因", () => {
    const result = parseRssSourceJson(text);
    for (const fail of result.failed) {
      expect(fail.reason.length).toBeGreaterThan(0);
    }
  });
});
