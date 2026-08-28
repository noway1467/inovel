import { describe, expect, it } from "vitest";
import { isRepoDue, unwrapShareUrl } from "~/server/sources/repos";

const minute = 60_000;

describe("unwrapShareUrl", () => {
  it("普通 http(s) 地址原样返回", () => {
    expect(unwrapShareUrl("https://example.com/sources.json")).toBe("https://example.com/sources.json");
    expect(unwrapShareUrl("  http://example.com/a.json  ")).toBe("http://example.com/a.json");
  });

  it("剥掉 legado:// 壳，取 src 参数里的真地址", () => {
    expect(
      unwrapShareUrl("legado://import/bookSource?src=https%3A%2F%2Fexample.com%2Fs.json")
    ).toBe("https://example.com/s.json");
  });

  it("认 yuedu:// 等变体和 url 参数", () => {
    expect(unwrapShareUrl("yuedu://booksource?url=https://example.com/b.json")).toBe(
      "https://example.com/b.json"
    );
  });

  it("没有查询参数、真地址直接拼在路径里也能取出来", () => {
    expect(unwrapShareUrl("legado://import/bookSource/https://example.com/c.json")).toBe(
      "https://example.com/c.json"
    );
  });

  it("认不出壳就原样返回，让 parseSourceUrl 去报错", () => {
    expect(unwrapShareUrl("不是地址")).toBe("不是地址");
    expect(unwrapShareUrl("file:///etc/passwd")).toBe("file:///etc/passwd");
  });
});

describe("isRepoDue", () => {
  const now = new Date("2026-08-28T12:00:00Z");

  it("从没同步过的立即到期", () => {
    expect(isRepoDue({ syncIntervalMinutes: 1440, lastSyncAt: null, consecutiveFailures: 0 }, now)).toBe(
      true
    );
  });

  it("间隔没到不重拉", () => {
    const lastSyncAt = new Date(now.getTime() - 60 * minute);
    expect(isRepoDue({ syncIntervalMinutes: 1440, lastSyncAt, consecutiveFailures: 0 }, now)).toBe(false);
  });

  it("间隔到了就重拉", () => {
    const lastSyncAt = new Date(now.getTime() - 1440 * minute);
    expect(isRepoDue({ syncIntervalMinutes: 1440, lastSyncAt, consecutiveFailures: 0 }, now)).toBe(true);
  });

  it("连续失败按 2 的幂退避：失败 2 次要等 4 倍间隔", () => {
    const repo = (ageMinutes: number) => ({
      syncIntervalMinutes: 360,
      lastSyncAt: new Date(now.getTime() - ageMinutes * minute),
      consecutiveFailures: 2,
    });
    expect(isRepoDue(repo(360), now)).toBe(false);
    expect(isRepoDue(repo(4 * 360 - 1), now)).toBe(false);
    expect(isRepoDue(repo(4 * 360), now)).toBe(true);
  });

  it("退避等待封顶 7 天：每天一次连失败 4 次也不会推到 16 天", () => {
    const repo = (ageMinutes: number) => ({
      syncIntervalMinutes: 1440,
      lastSyncAt: new Date(now.getTime() - ageMinutes * minute),
      consecutiveFailures: 4,
    });
    // 不封顶的话是 1440 * 16 = 16 天
    expect(isRepoDue(repo(7 * 24 * 60 - 1), now)).toBe(false);
    expect(isRepoDue(repo(7 * 24 * 60), now)).toBe(true);
  });

  it("失败次数再涨也不会超过封顶", () => {
    const lastSyncAt = new Date(now.getTime() - 7 * 24 * 60 * minute);
    expect(isRepoDue({ syncIntervalMinutes: 1440, lastSyncAt, consecutiveFailures: 99 }, now)).toBe(true);
  });
});
