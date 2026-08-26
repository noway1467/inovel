import { describe, expect, it } from "vitest";
import { translateAuthError } from "../../app/lib/auth-errors";

describe("better-auth 报错中文化", () => {
  it("当前密码错误映射为中文", () => {
    // 回归点：better-auth 原样返回 "Invalid password"，此前直接显示给用户
    expect(translateAuthError("Invalid password", "兜底")).toBe("当前密码不正确。");
  });

  it("常见错误都有对应文案", () => {
    expect(translateAuthError("Password too short", "兜底")).toBe("新密码太短，至少 8 位。");
    expect(translateAuthError("User not found", "兜底")).toBe("账号不存在。");
    expect(translateAuthError("Email already exists", "兜底")).toBe("该邮箱已被注册。");
    expect(translateAuthError("Too many requests", "兜底")).toBe("操作过于频繁，请稍后重试。");
  });

  it("大小写不敏感", () => {
    expect(translateAuthError("INVALID PASSWORD", "兜底")).toBe("当前密码不正确。");
  });

  it("认不出的英文用兜底文案，不透传英文", () => {
    expect(translateAuthError("Some unmapped internal failure", "保存失败。")).toBe("保存失败。");
  });

  it("已是中文则原样保留", () => {
    expect(translateAuthError("注册功能已关闭", "兜底")).toBe("注册功能已关闭");
  });

  it("缺失报错时用兜底文案", () => {
    expect(translateAuthError(undefined, "兜底")).toBe("兜底");
    expect(translateAuthError("", "兜底")).toBe("兜底");
  });
});
