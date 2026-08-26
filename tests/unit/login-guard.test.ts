import { describe, expect, it } from "vitest";
import { getClientIp, ipCooldownSeconds, maxLoginFailures } from "../../app/server/security/login-guard";
import { clearLocalLoginFailures, loadLoginGuard, remainingBlockSeconds } from "../../app/lib/login-guard";

describe("login-guard", () => {
  it("从 Cloudflare 头解析客户端 IP", () => {
    const request = new Request("http://localhost", {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    expect(getClientIp(request)).toBe("203.0.113.9");
  });

  it("支持 x-forwarded-for 回退", () => {
    const request = new Request("http://localhost", {
      headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" },
    });
    expect(getClientIp(request)).toBe("198.51.100.7");
  });

  it("无代理头时回退本机地址", () => {
    expect(getClientIp(new Request("http://localhost"))).toBe("127.0.0.1");
  });

  it("阈值与冷却时间可配置且合理", () => {
    expect(maxLoginFailures).toBe(5);
    expect(ipCooldownSeconds).toBe(15 * 60);
  });

  it("无本地存储时前端守卫安全回退", () => {
    expect(loadLoginGuard()).toEqual({ failedCount: 0, blockedUntil: 0 });
    expect(remainingBlockSeconds()).toBe(0);
    clearLocalLoginFailures();
  });
});

