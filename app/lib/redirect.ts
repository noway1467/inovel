/**
 * `?redirect=` 来自地址栏，属于不可信输入。登录/注册成功后若直接把它塞进
 * 服务端 `redirect()`，`https://evil.com` 或 `//evil.com` 会变成真实的
 * Location 跳转，形成开放重定向（钓鱼）。
 *
 * 这里只放行站内绝对路径：必须以单个 `/` 开头，且不能是 `//host` 形式。
 */
export const defaultRedirect = "/";

export function safeRedirectTarget(value: string | null | undefined): string {
  if (!value) return defaultRedirect;
  // 反斜杠会被部分浏览器等价于 `/`，`//` 与 `/\` 都可能被解析成协议相对地址
  if (!value.startsWith("/")) return defaultRedirect;
  if (value.startsWith("//") || value.startsWith("/\\")) return defaultRedirect;
  return value;
}
