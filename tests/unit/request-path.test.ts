import { describe, expect, it } from "vitest";
import { getVisiblePath, loginRedirectTo } from "~/server/http/request-path";
import { safeRedirectTarget } from "~/lib/redirect";

describe("getVisiblePath", () => {
  it("还原 single fetch 的 .data 请求路径", () => {
    expect(getVisiblePath(new URL("http://x/register.data")).pathname).toBe("/register");
    expect(getVisiblePath(new URL("http://x/login.data")).pathname).toBe("/login");
  });

  it("普通页面路径原样返回", () => {
    expect(getVisiblePath(new URL("http://x/register")).pathname).toBe("/register");
    expect(getVisiblePath(new URL("http://x/")).pathname).toBe("/");
  });

  it("剔除 single fetch 内部查询参数，保留业务参数", () => {
    const { fullPath } = getVisiblePath(
      new URL("http://x/categories.data?_routes=root%2Croutes%2Fapp-layout&page=2")
    );
    expect(fullPath).toBe("/categories?page=2");
  });

  it("只有内部参数时不留下空的问号", () => {
    expect(getVisiblePath(new URL("http://x/library.data?_routes=root")).fullPath).toBe("/library");
  });
});

describe("loginRedirectTo", () => {
  it("redirect 参数指向用户可见路径，不含 .data", () => {
    expect(loginRedirectTo(new URL("http://x/read/b1/c1.data"))).toBe(
      "/login?redirect=%2Fread%2Fb1%2Fc1"
    );
  });

  it("公开页被误判时也不会套娃出 login.data", () => {
    const target = loginRedirectTo(new URL("http://x/login.data?redirect=%2F"));
    expect(target).not.toContain(".data");
  });
});

describe("safeRedirectTarget", () => {
  it("放行站内绝对路径", () => {
    expect(safeRedirectTarget("/library")).toBe("/library");
    expect(safeRedirectTarget("/read/b1/c1?page=2")).toBe("/read/b1/c1?page=2");
  });

  it("空值回落到首页", () => {
    expect(safeRedirectTarget(null)).toBe("/");
    expect(safeRedirectTarget("")).toBe("/");
  });

  it("拦截开放重定向", () => {
    expect(safeRedirectTarget("https://evil.com")).toBe("/");
    expect(safeRedirectTarget("//evil.com")).toBe("/");
    expect(safeRedirectTarget("/\\evil.com")).toBe("/");
    expect(safeRedirectTarget("javascript:alert(1)")).toBe("/");
  });
});
