import { guardedFetch } from "~/server/sources/fetch-guard";
import { toParagraphs, type SourceAdapter, type SourceBook, type SourceChapter } from "~/server/sources/types";

/**
 * 古腾堡计划适配器（Gutendex API）。
 *
 * 内容全部为公共领域，是最省心的合法源。Gutendex 只是索引，
 * 正文文件仍托管在 gutenberg.org 域下，因此两个域名都要在白名单里登记。
 *
 * 一本书对应一个纯文本文件，没有连载目录，故按整本单章处理。
 */

interface GutendexAuthor {
  name?: string;
}

interface GutendexBook {
  id?: number;
  title?: string;
  authors?: GutendexAuthor[];
  subjects?: string[];
  copyright?: boolean | null;
  formats?: Record<string, string>;
}

interface GutendexPage {
  count?: number;
  results?: GutendexBook[];
}

/** 优先纯文本，其次 HTML；两者都拿不到就跳过这本 */
function pickTextFormat(formats: Record<string, string> | undefined): string | null {
  if (!formats) return null;
  const preferred = [
    "text/plain; charset=utf-8",
    "text/plain; charset=us-ascii",
    "text/plain",
  ];
  for (const key of preferred) {
    const url = formats[key];
    // zip 包在 Workers 里解不了，直接排除
    if (url && !url.endsWith(".zip")) return url;
  }
  for (const [mime, url] of Object.entries(formats)) {
    if (mime.startsWith("text/plain") && !url.endsWith(".zip")) return url;
  }
  return null;
}

function toBook(raw: GutendexBook): SourceBook | null {
  const textUrl = pickTextFormat(raw.formats);
  if (!textUrl || !raw.title) return null;
  // copyright 为 true 表示仍在版权期内，不纳入
  if (raw.copyright === true) return null;
  return {
    externalId: textUrl,
    title: raw.title,
    author: raw.authors?.[0]?.name ?? null,
    description: raw.subjects?.slice(0, 5).join(" / ") || null,
    coverUrl: raw.formats?.["image/jpeg"] ?? null,
    rights: "Public domain (Project Gutenberg)",
  };
}

async function loadJson(
  ctx: Parameters<SourceAdapter["listBooks"]>[0],
  url: string
): Promise<GutendexPage> {
  ctx.countRequest();
  const response = await guardedFetch(ctx.db, url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(response.message);
  if (response.result.status >= 400) throw new Error(`源返回 HTTP ${response.result.status}`);
  try {
    return JSON.parse(response.result.body) as GutendexPage;
  } catch {
    throw new Error("返回内容不是合法 JSON，确认这是 Gutendex API 地址");
  }
}

/**
 * 古腾堡纯文本带固定的头尾声明块，需要剥掉再入库，
 * 否则每本书正文开头都是几十行许可说明。
 */
export function stripGutenbergBoilerplate(raw: string): string {
  const startPattern = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
  const endPattern = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
  let text = raw;
  const start = text.search(startPattern);
  if (start !== -1) {
    const match = text.match(startPattern);
    text = text.slice(start + (match?.[0].length ?? 0));
  }
  const end = text.search(endPattern);
  if (end !== -1) text = text.slice(0, end);
  return text.trim();
}

export const gutendexAdapter: SourceAdapter = {
  kind: "gutendex",
  label: "古腾堡计划（公共领域）",

  async probe(ctx) {
    try {
      const page = await loadJson(ctx, ctx.endpoint);
      const results = page.results ?? [];
      if (results.length === 0) {
        return { ok: false, message: "接口连通但没有结果，检查查询参数" };
      }
      const usable = results.map(toBook).filter((book): book is SourceBook => book !== null);
      return {
        ok: true,
        message: `连通，共 ${page.count ?? results.length} 本，本页 ${usable.length} 本可取纯文本`,
        sampleTitles: usable.slice(0, 5).map((book) => book.title),
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  async listBooks(ctx) {
    const page = await loadJson(ctx, ctx.endpoint);
    return (page.results ?? []).map(toBook).filter((book): book is SourceBook => book !== null);
  },

  async search(ctx, keyword) {
    const url = new URL(ctx.endpoint);
    url.searchParams.set("search", keyword);
    const page = await loadJson(ctx, url.toString());
    return (page.results ?? []).map(toBook).filter((book): book is SourceBook => book !== null);
  },

  async listChapters(ctx, book): Promise<SourceChapter[]> {
    return [{ externalKey: book.externalId, title: "全文" }];
  },

  async fetchChapter(ctx, chapter) {
    ctx.countRequest();
    const response = await guardedFetch(ctx.db, chapter.externalKey);
    if (!response.ok) throw new Error(response.message);
    if (response.result.status >= 400) throw new Error(`正文返回 HTTP ${response.result.status}`);
    if (response.result.truncated) {
      throw new Error("整本超过单次抓取体积上限，请下载后走本地导入");
    }
    const paragraphs = toParagraphs(stripGutenbergBoilerplate(response.result.body));
    if (paragraphs.length === 0) throw new Error("正文为空");
    return { paragraphs };
  },
};
