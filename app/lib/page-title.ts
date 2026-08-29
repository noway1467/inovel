/**
 * 页面标题。
 *
 * 原先一个路由都没导出 `meta`，标题就退化成 URL —— 标签页开三本书全是
 * `novel.kdns.fr/source/…`，收藏夹和浏览历史里也认不出哪条是什么。
 *
 * 统一成「页面名 · 悦读」，书页用「书名 · 悦读」，章节页用
 * 「章节名 · 书名 · 悦读」—— 分隔符用 `·`，标签页窄的时候先被截掉的是
 * 站名而不是书名。
 */
export const siteName = "悦读";

/** 标题里的空白与控制字符会让标签页显示成一长串空格，抓来的书名尤其常见 */
function clean(part: string): string {
  return part.replace(/\s+/g, " ").trim();
}

/**
 * 拼一个 `<title>`。
 *
 * @param parts 由具体到宽泛，站名自动补在最后；空值会被丢掉，
 *   所以 `pageTitle(chapter, book)` 在 chapter 缺失时自然退化成书名。
 */
export function pageTitle(...parts: (string | null | undefined)[]): string {
  const named = parts.map((part) => clean(part ?? "")).filter(Boolean);
  return [...named, siteName].join(" · ");
}

/**
 * 给 `meta` 用的标准返回：标题 + 描述。
 *
 * 描述只在有值时才写，避免每页都是同一句没用的话 —— 那对搜索结果和
 * 分享卡片都是负担。
 */
export function pageMeta(title: string, description?: string | null) {
  const tags: ({ title: string } | { name: string; content: string })[] = [{ title }];
  const text = clean(description ?? "");
  if (text) tags.push({ name: "description", content: text });
  return tags;
}
