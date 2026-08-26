/**
 * better-auth 的报错是英文的（"Invalid password"、"Password too short" 等），
 * 直接透传给用户会在中文界面里冒出英文。这里做一层映射，认不出来的再退回兜底文案。
 */
const messageMap: { match: RegExp; text: string }[] = [
  { match: /invalid password|incorrect password/i, text: "当前密码不正确。" },
  { match: /password too short|minimum.*length/i, text: "新密码太短，至少 8 位。" },
  { match: /password too long|maximum.*length/i, text: "新密码过长，请缩短后重试。" },
  { match: /user not found/i, text: "账号不存在。" },
  { match: /invalid email/i, text: "邮箱格式不正确。" },
  { match: /email already exists|already registered/i, text: "该邮箱已被注册。" },
  { match: /session|unauthorized|not authenticated/i, text: "登录状态已过期，请重新登录。" },
  { match: /credential account not found/i, text: "该账号未设置密码，无法修改。" },
  { match: /too many requests|rate limit/i, text: "操作过于频繁，请稍后重试。" },
];

export function translateAuthError(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const hit = messageMap.find((entry) => entry.match.test(raw));
  if (hit) return hit.text;
  // 已经是中文就直接用，否则用兜底文案，避免把英文原文抛给用户
  return /[一-龥]/.test(raw) ? raw : fallback;
}
