import { describe, expect, it } from "vitest";
import { decodeSourceRef, encodeSourceRef } from "~/lib/source-ref";

/**
 * 回归：源站地址原先直接放进查询参数，客户端导航时请求形如
 * `/source/x/chapter.data?key=https%3A%2F%2F某站.com%2F...`。
 * 拦截插件按整个请求 URL 的子串匹配过滤规则，域名命中名单后整条
 * .data 请求被 ERR_BLOCKED_BY_CLIENT 掐掉 —— 页面骨架（SSR）能出，
 * 正文永远拿不到。编码后请求里不再出现明文域名。
 */

describe("encodeSourceRef / decodeSourceRef", () => {
  it("往返一致", () => {
    const urls = [
      "https://novels.example.org/c/1.html",
      "http://plain.example.net/book/123",
      "https://example.com/c/1?page=2&mode=full",
      "https://例子.测试/章节/1.html",
      "https://example.com/path%20with%20space",
    ];
    for (const url of urls) {
      expect(decodeSourceRef(encodeSourceRef(url))).toBe(url);
    }
  });

  it("编码结果不含明文域名（这才是修复的要点）", () => {
    const token = encodeSourceRef("https://blocked-domain.example.org/c/1.html");
    expect(token).not.toContain("blocked-domain");
    expect(token).not.toContain("example.org");
    expect(token).not.toContain("https");
  });

  it("编码结果可安全放进 URL，无需再转义", () => {
    const token = encodeSourceRef("https://example.com/c/1?a=1&b=2#x");
    // base64url 字符集：A-Z a-z 0-9 - _
    expect(token).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("中文与非 ASCII 地址往返不丢字符", () => {
    const url = "https://example.com/书籍/第一章.html";
    expect(decodeSourceRef(encodeSourceRef(url))).toBe(url);
  });

  it("明文地址原样放行（旧链接兼容）", () => {
    // 之前已发出的链接、用户手工粘贴的地址都是明文
    expect(decodeSourceRef("https://example.com/c/1")).toBe("https://example.com/c/1");
    expect(decodeSourceRef("http://example.com/c/1")).toBe("http://example.com/c/1");
    expect(decodeSourceRef("  https://example.com/c/1  ")).toBe("https://example.com/c/1");
  });

  it("空值与垃圾输入返回空串，不抛错", () => {
    expect(decodeSourceRef("")).toBe("");
    expect(decodeSourceRef("   ")).toBe("");
    expect(decodeSourceRef("!!!not-base64!!!")).toBe("");
    // 能解码但不是地址的，也不放行
    expect(decodeSourceRef(encodeSourceRef("just some text"))).toBe("");
  });

  it("解出来必须是 http(s) 地址，挡住 javascript: 之类", () => {
    const bad = encodeSourceRef("javascript:alert(1)");
    expect(decodeSourceRef(bad)).toBe("");
    const file = encodeSourceRef("file:///etc/passwd");
    expect(decodeSourceRef(file)).toBe("");
  });

  it("长地址也能处理", () => {
    const long = `https://example.com/c/1?${"k=v&".repeat(200)}end=1`;
    expect(decodeSourceRef(encodeSourceRef(long))).toBe(long);
  });
});
