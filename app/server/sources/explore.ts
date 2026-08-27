/**
 * 书源的「发现页」分类。
 *
 * 为什么需要：实测 244 个可导入源里有 48 个没有搜索地址（搜索规则要 JS 求值
 * 而被降级），这些源目前完全没有入口 —— 能读但找不到书。而它们大多带着
 * 发现页规则（清单实测 50 源里 47 个有），按分类浏览正好把这批源救回来。
 *
 * 只做「按源浏览」：选一个源 → 看它的分类 → 看书单。不做跨源合并 ——
 * 那样每开一个分类就要同时打 N 个源，压力和失败面都是 N 倍，还得对齐
 * 各源不一致的分类名。
 */

export interface ExploreCategory {
  title: string;
  /** 原始地址模板，含 {{page}} 等占位 */
  urlTemplate: string;
}

/**
 * 解析 exploreUrl / ruleFindUrl。两种真实格式都要认：
 *
 * 1. JSON 数组：`[{"title":"榜单","url":"/hot/index_{{page}}.html"}, ...]`
 * 2. 换行分隔：`火影:: /tag/{{page-1}}_huoying`（分隔符是 `::`）
 *
 * 解不出来返回空数组 —— 调用方据此判定「这个源没有可用分类」，
 * 而不是抛错让整个页面挂掉。
 */
export function parseExploreCategories(raw: unknown): ExploreCategory[] {
  if (typeof raw !== "string") return [];
  const text = raw.trim();
  if (!text) return [];

  // JSON 数组形式
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as { title?: unknown; url?: unknown }[];
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => ({
          title: typeof item?.title === "string" ? item.title.trim() : "",
          urlTemplate: typeof item?.url === "string" ? item.url.trim() : "",
        }))
        .filter((item) => item.title && item.urlTemplate);
    } catch {
      return [];
    }
  }

  // `名称:: 地址` 换行分隔形式
  return text
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf("::");
      if (at < 0) return null;
      const title = line.slice(0, at).trim();
      const urlTemplate = line.slice(at + 2).trim();
      return title && urlTemplate ? { title, urlTemplate } : null;
    })
    .filter((item): item is ExploreCategory => item !== null);
}

/**
 * 分类地址是否需要 JS 求值。
 *
 * `{{page}}`、`{{page-1}}` 这种纯算术能自己算；但
 * `{{page - 1 == 0 ? '': '_'+page}}` 这种带三元、字符串拼接的要真 JS 引擎。
 * 与其算错地址抓回一堆 404，不如明确跳过。
 */
export function categoryNeedsJs(urlTemplate: string): boolean {
  if (/@js:|<js>/i.test(urlTemplate)) return true;
  // 取出所有 {{...}} 内容，只放行纯 page 算术
  const placeholders = urlTemplate.match(/\{\{([^}]*)\}\}/g) ?? [];
  return placeholders.some((raw) => {
    const expr = raw.slice(2, -2).trim();
    return !/^page\s*(?:[+-]\s*\d+)?$/i.test(expr);
  });
}

/**
 * 把分类模板套成第 page 页的真实地址。
 *
 * 处理三件事：
 *  - `<A,B>`：Legado 的「首页用 A、后续页用 B」写法。第 1 页取逗号前，
 *    其余取逗号后。`<,index_{{page}}.html>` 于是第 1 页什么都不加。
 *  - `{{page}}` / `{{page-1}}` / `{{page+1}}`：按算术算出数字再替换。
 *  - 相对地址：交给调用方用 baseUrl 补全，这里只管模板。
 */
export function buildExploreUrl(urlTemplate: string, page = 1): string {
  // 先处理 <首页,后续页>
  const withPageForm = urlTemplate.replace(/<([^,>]*),([^>]*)>/g, (_all, first, rest) =>
    page <= 1 ? first : rest
  );

  return withPageForm.replace(/\{\{([^}]*)\}\}/g, (all, rawExpr: string) => {
    const expr = rawExpr.trim();
    const match = /^page\s*(?:([+-])\s*(\d+))?$/i.exec(expr);
    if (!match) return all;
    if (!match[1]) return String(page);
    const delta = Number(match[2]);
    return String(match[1] === "+" ? page + delta : page - delta);
  });
}

/** 取出源里可用的分类：能解析、且不需要 JS 求值的 */
export function usableCategories(raw: unknown): ExploreCategory[] {
  return parseExploreCategories(raw).filter((item) => !categoryNeedsJs(item.urlTemplate));
}
