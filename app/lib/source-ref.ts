/**
 * 把源站地址编码成不含域名的 token，用于站内路由参数。
 *
 * 为什么必须编码：客户端导航时 React Router 会请求
 * `/source/<id>/chapter.data?key=<地址>`。如果这里放的是原始 URL，
 * 请求地址里就内嵌了源站域名 —— 拦截插件按整个请求 URL 的子串匹配
 * 过滤规则，小说站域名普遍在名单里，于是整条 .data 请求被
 * ERR_BLOCKED_BY_CLIENT 掐掉：页面骨架（SSR）能显示，正文却永远拿不到。
 *
 * base64url 后域名不再以明文出现，请求也更短。
 */

/** 编码：UTF-8 → base64url（去掉 = 填充，+/ 换成 -_） */
export function encodeSourceRef(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 解码。
 *
 * 兼容原始 URL：早先发出去的链接、以及用户手工粘贴的地址仍是明文 http(s)，
 * 直接原样返回，避免旧链接全部失效。
 */
export function decodeSourceRef(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  // 明文地址直接放行（旧链接兼容）
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const padded = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  try {
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const decoded = new TextDecoder().decode(bytes);
    // 解出来必须是个地址，否则说明这不是我们编的 token
    return /^https?:\/\//i.test(decoded) ? decoded : "";
  } catch {
    return "";
  }
}
