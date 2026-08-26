import { guardedFetch } from "~/server/sources/fetch-guard";
import { blockTextOf, findAll, findFirst, parseXml, textOf, type XmlNode } from "~/server/sources/xml";
import { resolveUrl, toParagraphs, type SourceAdapter, type SourceBook, type SourceChapter } from "~/server/sources/types";

/**
 * OPDS 目录适配器（Atom 格式）。
 *
 * 面向自建电子书库：Calibre-Web、Komga、Kavita 都原生提供 OPDS。
 * 这类源里"一本书"通常是一个完整文件（EPUB/TXT），没有连载目录，
 * 因此 listChapters 把整本当作单章；真正的多章导入仍走本地导入管线。
 */

const acquisitionRels = [
  "http://opds-spec.org/acquisition",
  "http://opds-spec.org/acquisition/open-access",
];

function linkByRel(entry: XmlNode, predicate: (rel: string) => boolean): string | null {
  for (const link of findAll(entry, "link")) {
    const rel = link.attrs.rel ?? "";
    if (predicate(rel)) return link.attrs.href ?? null;
  }
  return null;
}

function entryToBook(entry: XmlNode, base: string): SourceBook | null {
  const title = textOf(findFirst(entry, "title"));
  if (!title) return null;

  // 优先用 acquisition 链接作为标识，它才是可下载的正文入口
  const acquisition = linkByRel(entry, (rel) => acquisitionRels.some((r) => rel.startsWith(r)));
  const idText = textOf(findFirst(entry, "id"));
  const externalId = acquisition ? resolveUrl(base, acquisition) : idText;
  if (!externalId) return null;

  const authorNode = findFirst(entry, "author");
  const cover = linkByRel(entry, (rel) => rel.includes("image") || rel.includes("cover"));

  return {
    externalId,
    title,
    author: authorNode ? textOf(findFirst(authorNode, "name")) || null : null,
    description: textOf(findFirst(entry, "summary")) || textOf(findFirst(entry, "content")) || null,
    coverUrl: cover ? resolveUrl(base, cover) : null,
    rights: textOf(findFirst(entry, "rights")) || null,
  };
}

async function loadFeed(
  ctx: Parameters<SourceAdapter["listBooks"]>[0],
  url: string
): Promise<{ ok: true; root: XmlNode } | { ok: false; message: string }> {
  ctx.countRequest();
  const response = await guardedFetch(ctx.db, url, {
    headers: { Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8" },
  });
  if (!response.ok) return { ok: false, message: response.message };
  if (response.result.status >= 400) {
    return { ok: false, message: `源返回 HTTP ${response.result.status}` };
  }
  return { ok: true, root: parseXml(response.result.body) };
}

export const opdsAdapter: SourceAdapter = {
  kind: "opds",
  label: "OPDS 目录（Calibre-Web / Komga / Kavita 等）",

  async probe(ctx) {
    const feed = await loadFeed(ctx, ctx.endpoint);
    if (!feed.ok) return { ok: false, message: feed.message };
    const entries = findAll(feed.root, "entry");
    if (entries.length === 0) {
      return { ok: false, message: "解析成功但没有 entry，确认这是 OPDS 目录地址而不是网页地址" };
    }
    const titles = entries.slice(0, 5).map((entry) => textOf(findFirst(entry, "title"))).filter(Boolean);
    return { ok: true, message: `连通，发现 ${entries.length} 个条目`, sampleTitles: titles };
  },

  async listBooks(ctx) {
    const feed = await loadFeed(ctx, ctx.endpoint);
    if (!feed.ok) throw new Error(feed.message);
    const books: SourceBook[] = [];
    for (const entry of findAll(feed.root, "entry")) {
      const book = entryToBook(entry, ctx.endpoint);
      if (book) books.push(book);
    }
    return books;
  },

  async search(ctx, keyword) {
    // OPDS 搜索模板由 opensearch 描述文档给出；这里退化为在目录里过滤，
    // 避免为了搜索多打一轮请求。
    const books = await opdsAdapter.listBooks(ctx);
    const needle = keyword.trim().toLowerCase();
    if (!needle) return books;
    return books.filter(
      (book) =>
        book.title.toLowerCase().includes(needle) ||
        (book.author ?? "").toLowerCase().includes(needle)
    );
  },

  async listChapters(ctx, book): Promise<SourceChapter[]> {
    // OPDS 的条目是整本文件，没有章节概念
    return [{ externalKey: book.externalId, title: "全文" }];
  },

  async fetchChapter(ctx, chapter) {
    ctx.countRequest();
    const response = await guardedFetch(ctx.db, chapter.externalKey);
    if (!response.ok) throw new Error(response.message);
    if (response.result.status >= 400) {
      throw new Error(`正文返回 HTTP ${response.result.status}`);
    }
    const { body, contentType, truncated } = response.result;
    if (truncated) {
      throw new Error("正文超过单章体积上限，请改用本地导入处理整本文件");
    }
    // XHTML/HTML 走块级提取，纯文本直接分段
    const looksMarkup = contentType.includes("xml") || contentType.includes("html") || body.trimStart().startsWith("<");
    const text = looksMarkup ? blockTextOf(parseXml(body)) : body;
    const paragraphs = toParagraphs(text);
    if (paragraphs.length === 0) throw new Error("正文为空");
    return { paragraphs };
  },
};
