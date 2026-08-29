import { elementChildren, textOf, type XmlNode } from "~/server/sources/xml";
import { buildExploreUrl, type ExploreCategory } from "~/server/sources/explore";
import { resolveUrl } from "~/server/sources/types";

/**
 * 发现页书单探测：从分类页结构里认出「书」的链接。
 *
 * 为什么不复用目录探测：目录探测找的是「第 N 章」这种规整序列，评分完全
 * 押在章节标题模式上。分类页没有这种模式，于是它退化成「挑链接最多的容器」
 * —— 分类页上链接最多的容器通常是顶部的标签云/导航，结果点开一个标签
 * 看到的还是一排标签。实测 152 个有分类的源里 54 个没有 exploreList 规则，
 * 全靠这条兜底路径，所以它必须自己判断什么是书。
 *
 * 判据是结构化的，不靠关键词黑名单：
 *  - 书链接与「本页自己」形状不同（标签指向的是同类分类页，形状一致）
 *  - 书链接不在源自己的分类地址模板里（那就是分类，不是书）
 *  - 同一批书共享一种地址形状，取占主导的那组
 */

export interface DetectedExploreBook {
  title: string;
  url: string;
}

/** 绝不是书页的后缀 */
const nonPageExtensions =
  /\.(zip|rar|7z|tar|gz|apk|ipa|exe|dmg|pkg|epub|mobi|azw3?|pdf|txt|doc|docx|jpg|jpeg|png|gif|css|js|mp3|mp4|m4a)(?:$|[?#])/i;

/** 导航、功能入口的常见文字。命中的一定不是书名。 */
const navTitles = new Set([
  "首页", "首頁", "home", "登录", "登陆", "註冊", "注册", "书架", "書架", "书城", "書城",
  "排行", "排行榜", "分类", "分類", "书库", "書庫", "搜索", "更多", "更多>>", "全部",
  "下一页", "上一页", "下页", "上页", "末页", "首页", "尾页", "下一頁", "上一頁",
  "帮助", "关于", "联系", "反馈", "手机版", "电脑版", "客户端", "app下载", "加入书架",
  "最新", "热门", "推荐", "完本", "免费", "vip", "签到", "充值", "我的",
]);

/**
 * 把地址抽象成形状：路径里的数字段换成 `#`。
 *
 * `/book/1234.html` 与 `/book/5678.html` 同形，`/sort/1/` 与它们不同形。
 * 查询串一并参与 —— 接口型源（`?action=tag&id=9000722`）全靠它区分。
 */
function urlShape(url: string): string | null {
  try {
    const parsed = new URL(url);
    const query = [...parsed.searchParams.keys()].sort().join(",");
    return `${parsed.host}${parsed.pathname.replace(/\d+/g, "#")}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

/** 收集页面上所有链接，一次遍历。文字取可见文字，退回 title/alt。 */
function collectAllLinks(root: XmlNode): { title: string; href: string }[] {
  const links: { title: string; href: string }[] = [];
  const walk = (node: XmlNode) => {
    for (const child of elementChildren(node)) {
      if (child.name === "a") {
        const href = child.attrs.href ?? "";
        const title =
          textOf(child).trim() ||
          child.attrs.title?.trim() ||
          child.attrs.alt?.trim() ||
          "";
        if (href) links.push({ title, href });
        // 书单项里的 <a> 常嵌一个封面 <a>，继续往下走不会漏
      }
      walk(child);
    }
  };
  walk(root);
  return links;
}

/** 源自己的分类地址集合 —— 命中的链接是分类，不是书 */
function categoryUrlSet(categories: ExploreCategory[], baseUrl: string): Set<string> {
  const set = new Set<string>();
  for (const category of categories) {
    // 前几页足够覆盖「标签云里指向自己分类」的情况
    for (const page of [1, 2, 3]) {
      const built = buildExploreUrl(category.urlTemplate, page);
      // 模板可能带 `,{'webView': true}` 这类尾巴，取逗号前
      const clean = built.split(",{")[0]!.trim();
      if (!clean) continue;
      try {
        set.add(resolveUrl(baseUrl, clean));
      } catch {
        /* 拼不出绝对地址就跳过 */
      }
    }
  }
  return set;
}

/** 标题像不像书名 */
function plausibleTitle(title: string): boolean {
  if (!title) return false;
  if (title.length > 40) return false;
  if (navTitles.has(title.toLowerCase())) return false;
  // 纯数字/纯符号是分页器
  if (/^[\d\s.\-_/·|>»<«]+$/.test(title)) return false;
  // 单个字符基本是图标或分页箭头
  return title.length >= 2;
}

/**
 * 探测分类页上的书单。
 *
 * @param root 解析后的页面
 * @param pageUrl 当前分类页地址
 * @param categories 源自己的分类列表，用来排除「链接其实是分类」
 */
export function detectExploreBooks(
  root: XmlNode,
  pageUrl: string,
  categories: ExploreCategory[] = []
): DetectedExploreBook[] {
  let host: string;
  try {
    host = new URL(pageUrl).host;
  } catch {
    return [];
  }

  const pageShape = urlShape(pageUrl);
  const categoryUrls = categoryUrlSet(categories, pageUrl);

  const kept: DetectedExploreBook[] = [];
  const seen = new Set<string>();

  for (const link of collectAllLinks(root)) {
    if (link.href.startsWith("#") || /^(javascript|mailto|tel):/i.test(link.href)) continue;
    if (!plausibleTitle(link.title)) continue;
    if (nonPageExtensions.test(link.href)) continue;

    let url: string;
    try {
      url = resolveUrl(pageUrl, link.href);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;

    const shape = urlShape(url);
    if (!shape || !shape.startsWith(host)) continue; // 站外链接
    /**
     * 与本页同形 = 兄弟分类页或分页器。这一条是「点标签下面还是标签」的正解：
     * 标签云里的每个标签都指向 `/fenlei/<别的编号>/1/`，与当前 `/fenlei/1/1/`
     * 完全同形，靠关键词永远认不完，靠形状一刀切干净。
     */
    if (pageShape && shape === pageShape) continue;
    if (categoryUrls.has(url)) continue;

    seen.add(url);
    kept.push({ title: link.title, url });
  }

  if (kept.length === 0) return [];

  // 按形状分组，取占主导的那组：同一批书的详情页地址必然同形
  const groups = new Map<string, DetectedExploreBook[]>();
  for (const item of kept) {
    const shape = urlShape(item.url)!;
    const group = groups.get(shape) ?? [];
    group.push(item);
    groups.set(shape, group);
  }

  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!best || best.length < 2) return [];
  return best;
}
