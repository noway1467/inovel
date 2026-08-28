import { resolveUrl, type SourceChapter } from "~/server/sources/types";

/**
 * 杰奇（jieqi）CMS 的完整目录接口。
 *
 * ## 为什么需要专门认它
 *
 * 这套模板的详情页上「全部章节」只渲染第一页 10 条，翻页按钮是纯 JS：
 *
 *     <a onclick="allchapter(99,2)" id="nextpage">下页</a>
 *
 * 没有 href。通用分页探测（detectNextPageUrl）只看 `<a href>`，对它完全无解 ——
 * 表现就是斗破苍穹 1683 章只抓到 16 章，而源站明明标着「第1/168页」。
 * 按数字分页器认也不行：页码同样是 onclick。
 *
 * 但翻页并不需要 JS 引擎。那个函数背后就是一个普通 GET 接口：
 *
 *     /ajaxService?action=chapterlist&articleno=99&index=<页码-1>&size=<每页>&sort=1
 *
 * 返回 `{ code, pages, items: [{ chaptername, url, ... }] }`。把 size 放大到 1000，
 * 1683 章两次请求就取完，比跟着 168 页翻省两个数量级。
 *
 * 这是套模板而不是单站特例：m.95dxs.com、m.92dxs.org 等一批站都是它，
 * 合集里这套 CMS 的源不少，且全都栽在同一个地方。
 */

/** 每次取多少章。1000 章约 400KB，稳在 maxResponseBytes（2MB）之内。 */
const pageSize = 1000;
/** 最多翻几页接口。20 × 1000 章足够覆盖任何连载，同时挡住 pages 字段异常时的死循环。 */
const maxPages = 20;

interface JieqiItem {
  chaptername?: unknown;
  url?: unknown;
}

interface JieqiResponse {
  code?: unknown;
  pages?: unknown;
  items?: unknown;
}

/**
 * 从页面 HTML 认出杰奇目录接口，取出书号。
 *
 * 判据只能取自页面本身。`/ajaxService` 这个地址写在外部 wap.js 里，
 * 页面上根本不出现 —— 早先要求页面提到 ajaxService，于是真实的 95dxs 页面
 * 一次都没命中过。页面上真正稳定的痕迹是这两样：
 *
 *  - `onclick="allchapter(99,2)"` 这类翻页调用（`getchapterList` 同源）
 *  - `<table id="allchapter_2">` 这类分页容器
 *
 * 两个数字参数是必需的（书号 + 页码）：只有一个参数的同名函数是别的东西。
 * 判错的代价也有限 —— 接口请求失败会回落到通用探测，见 fetchJieqiToc。
 *
 * @returns 书号；不是这套模板时返回 null
 */
export function detectJieqiArticleNo(html: string, pageUrl: string): string | null {
  // 优先从 onclick 里取，那是真正传给接口的书号
  const fromCall = /\b(?:allchapter|getchapterList)\s*\(\s*(\d{1,12})\s*,\s*[^)]/i.exec(html)?.[1];
  if (fromCall) return fromCall;

  /**
   * 兜底：页面有 allchapter 分页容器，但书号只在地址里。
   * 杰奇详情页形如 `/info/<分卷>/<书号>.html`，书号是最后那段数字。
   */
  const hasPager = /id\s*=\s*["']?allchapter[_\d]/i.test(html);
  if (!hasPager) return null;
  const fromUrl = /\/info\/\d+\/(\d{1,12})\.html/i.exec(pageUrl)?.[1];
  return fromUrl ?? null;
}

/** 拼一页目录接口地址 */
export function buildJieqiTocUrl(pageUrl: string, articleNo: string, index: number): string {
  const url = new URL("/ajaxService", pageUrl);
  url.searchParams.set("action", "chapterlist");
  url.searchParams.set("articleno", articleNo);
  url.searchParams.set("index", String(index));
  url.searchParams.set("size", String(pageSize));
  // sort=1 是正序（第一章在前）；倒序会让整本书的阅读顺序反过来
  url.searchParams.set("sort", "1");
  return url.toString();
}

/** 解析一页接口响应 */
export function parseJieqiPage(
  body: string,
  pageUrl: string
): { chapters: SourceChapter[]; pages: number } | null {
  let parsed: JieqiResponse;
  try {
    parsed = JSON.parse(body) as JieqiResponse;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.items)) return null;

  const chapters: SourceChapter[] = [];
  for (const raw of parsed.items as JieqiItem[]) {
    if (!raw || typeof raw !== "object") continue;
    const title = typeof raw.chaptername === "string" ? raw.chaptername.trim() : "";
    const href = typeof raw.url === "string" ? raw.url.trim() : "";
    if (!title || !href) continue;
    chapters.push({ externalKey: resolveUrl(pageUrl, href), title });
  }

  const pages = Number(parsed.pages);
  return { chapters, pages: Number.isFinite(pages) && pages > 0 ? pages : 1 };
}

/**
 * 取完整目录。
 *
 * @param fetchPage 由调用方注入的抓取器 —— 出站必须经 guardedFetch，
 *                  这个模块本身不碰网络（也因此可以直接单测）。
 * @returns 章节列表；不是杰奇模板或接口取不到时返回空数组
 */
export async function fetchJieqiToc(
  html: string,
  pageUrl: string,
  fetchPage: (url: string) => Promise<string>
): Promise<SourceChapter[]> {
  const articleNo = detectJieqiArticleNo(html, pageUrl);
  if (!articleNo) return [];

  const chapters: SourceChapter[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < maxPages; index += 1) {
    let body: string;
    try {
      body = await fetchPage(buildJieqiTocUrl(pageUrl, articleNo, index));
    } catch {
      // 首页就失败说明这条路走不通；已经拿到章节则保留既有结果
      break;
    }
    const page = parseJieqiPage(body, pageUrl);
    if (!page) break;

    for (const chapter of page.chapters) {
      if (seen.has(chapter.externalKey)) continue;
      seen.add(chapter.externalKey);
      chapters.push(chapter);
    }

    // 本页空了或已到最后一页就停
    if (page.chapters.length === 0 || index + 1 >= page.pages) break;
  }

  return chapters;
}
