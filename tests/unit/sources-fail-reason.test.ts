import { describe, expect, it } from "vitest";
import { classifyFailure, failReasonLabels } from "~/server/sources/verify";

/**
 * 验证失败原因分类。
 *
 * 原先失败一律记 failed，里面混着性质完全不同的毛病 —— 403 被封的基本没救，
 * 503 多半是当时打太急过一阵还能用，规则失效的可以等作者更新。
 * 分类之后管理台才能只删某一类，而不是全删或全留。
 *
 * 走 message 反推而不是逐个 return 传参：抛错点散在适配器各处，
 * 而 message 本来就带着 HTTP 状态码和超时信息。
 */

describe("classifyFailure", () => {
  it("超时", () => {
    expect(classifyFailure("请求超时（15000ms）")).toBe("timeout");
    expect(classifyFailure("搜索失败：请求超时（15000ms）")).toBe("timeout");
    expect(classifyFailure("The operation was aborted")).toBe("timeout");
    // 网络层没给状态码的连接失败，表现与处置都跟超时一样
    expect(classifyFailure("fetch failed")).toBe("timeout");
  });

  it("403 类封禁", () => {
    expect(classifyFailure("源返回 HTTP 403")).toBe("http_403");
    expect(classifyFailure("能搜到书但取目录失败：源返回 HTTP 401")).toBe("http_403");
    expect(classifyFailure("源返回 HTTP 407")).toBe("http_403");
  });

  it("429 限流单列", () => {
    // 与 5xx 分开：429 是源站明确说"你太快了"，退避后大概率能用
    expect(classifyFailure("源返回 HTTP 429")).toBe("http_429");
  });

  it("5xx 源站故障", () => {
    expect(classifyFailure("源返回 HTTP 503")).toBe("http_5xx");
    expect(classifyFailure("源返回 HTTP 502")).toBe("http_5xx");
    expect(classifyFailure("搜索失败：源返回 HTTP 500")).toBe("http_5xx");
  });

  it("其余 4xx 是地址失效", () => {
    expect(classifyFailure("源返回 HTTP 404")).toBe("http_4xx");
    expect(classifyFailure("源返回 HTTP 400")).toBe("http_4xx");
  });

  it("规则失效的几种", () => {
    expect(classifyFailure("搜索无结果")).toBe("no_search");
    expect(classifyFailure("该源未配置搜索规则，请直接用详情页地址订阅")).toBe("no_search");
    expect(classifyFailure("搜索返回 20 条但均与关键字无关（该源未做关键字匹配）")).toBe(
      "irrelevant"
    );
    expect(classifyFailure("目录为空")).toBe("no_toc");
    expect(classifyFailure("能搜到书但目录为空")).toBe("no_toc");
    expect(classifyFailure("能搜到书但取目录失败：规则未命中")).toBe("no_toc");
    expect(classifyFailure("列目录失败：连接被拒")).toBe("no_toc");
    expect(classifyFailure("正文规则未命中内容")).toBe("no_content");
  });

  it("认不出的归入 other，而不是猜一个", () => {
    expect(classifyFailure("某种没见过的错误")).toBe("other");
    expect(classifyFailure("")).toBe("other");
  });

  it("超时优先于状态码 —— 先超时就没有状态码可言", () => {
    expect(classifyFailure("请求超时（15000ms），此前收到 HTTP 503")).toBe("timeout");
  });

  it("每个原因都有中文说明", () => {
    const reasons = [
      "timeout",
      "http_403",
      "http_429",
      "http_5xx",
      "http_4xx",
      "no_search",
      "irrelevant",
      "no_toc",
      "no_content",
      "other",
    ] as const;
    for (const reason of reasons) {
      expect(failReasonLabels[reason]).toBeTruthy();
      expect(typeof failReasonLabels[reason]).toBe("string");
    }
  });
});
