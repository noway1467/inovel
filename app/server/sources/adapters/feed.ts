import { guardedFetch } from "~/server/sources/fetch-guard";
import { blockTextOf, findAll, findFirst, parseXml, textOf, type XmlNode } from "~/server/sources/xml";
import { resolveUrl, toParagraphs, type SourceAdapter, type SourceBook, type SourceChapter } from "~/server/sources/types";

/**
 * RSS / Atom 连载适配器。
 *
 * 一个 feed = 一本书，每个 item/entry = 一章。订阅与自动更新的语义天然吻合：
 * feed 只吐最新 N 条，新增条目就是新章节。
 *
 * 多数 feed 的 content:encoded / content 里已带全文，命中时省掉逐章抓取。
 */

interface FeedShape {
  title: string;
  description: string | null;
  items: { key: string; title: string; content: string | null; publishedAt: string | null }[];
}

/** RSS 与 Atom 结构不同，统一成一种形状 */
function normalizeFeed(root: XmlNode, base: string): FeedShape | null {
  const channel = findFirst(root, "channel");
  if (channel) {
    const items = findAll(channel, "item").map((item) => {
      const link = textOf(findFirst(item, "link"));
      const guid = textOf(findFirst(item, "guid"));
      // content:encoded 优于 description：后者常被截断成摘要
      const encoded = findFirst(item, "content:encoded");
      const description = findFirst(item, "description");
      return {
        key: link ? resolveUrl(base, link) : guid,
        title: textOf(findFirst(item, "title")) || "无标题",
        content: (encoded ?? description)?.text || null,
        publishedAt: textOf(findFirst(item, "pubDate")) || null,
      };
    });
    return {
      title: textOf(findFirst(channel, "title")) || "未命名订阅",
      description: textOf(findFirst(channel, "description")) || null,
      items: items.filter((item) => item.key),
    };
  }

  const feed = findFirst(root, "feed");
  if (feed) {
    const items = findAll(feed, "entry").map((entry) => {
      const alternate = findAll(entry, "link").find(
        (link) => !link.attrs.rel || link.attrs.rel === "alternate"
      );
      const href = alternate?.attrs.href ?? "";
      const id = textOf(findFirst(entry, "id"));
      const content = findFirst(entry, "content") ?? findFirst(entry, "summary");
      return {
        key: href ? resolveUrl(base, href) : id,
        title: textOf(findFirst(entry, "title")) || "无标题",
        content: content?.text || null,
        publishedAt: textOf(findFirst(entry, "updated")) || textOf(findFirst(entry, "published")) || null,
      };
    });
    return {
      title: textOf(findFirst(feed, "title")) || "未命名订阅",
      description: textOf(findFirst(feed, "subtitle")) || null,
      items: items.filter((item) => item.key),
    };
  }

  return null;
}

/** feed 内容多为转义后的 HTML 片段，需要先解析再按块级取文 */
function contentToParagraphs(content: string): string[] {
  const looksMarkup = content.includes("<");
  const text = looksMarkup ? blockTextOf(parseXml(content)) : content;
  return toParagraphs(text);
}

async function loadFeed(
  ctx: Parameters<SourceAdapter["listBooks"]>[0],
  url: string
): Promise<FeedShape> {
  ctx.countRequest();
  const response = await guardedFetch(ctx.db, url, {
    headers: { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8" },
  });
  if (!response.ok) throw new Error(response.message);
  if (response.result.status >= 400) throw new Error(`源返回 HTTP ${response.result.status}`);
  const shape = normalizeFeed(parseXml(response.result.body), url);
  if (!shape) throw new Error("既不是 RSS（channel）也不是 Atom（feed），无法识别");
  return shape;
}

export const feedAdapter: SourceAdapter = {
  kind: "feed",
  label: "RSS / Atom 连载订阅",

  async probe(ctx) {
    try {
      const feed = await loadFeed(ctx, ctx.endpoint);
      if (feed.items.length === 0) {
        return { ok: false, message: "解析成功但没有条目，确认 feed 地址正确" };
      }
      const withContent = feed.items.filter((item) => item.content).length;
      return {
        ok: true,
        message: `连通，《${feed.title}》共 ${feed.items.length} 条，其中 ${withContent} 条自带全文`,
        sampleTitles: feed.items.slice(0, 5).map((item) => item.title),
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },

  async listBooks(ctx): Promise<SourceBook[]> {
    const feed = await loadFeed(ctx, ctx.endpoint);
    // 整个 feed 就是一本书，externalId 用 endpoint 本身
    return [
      {
        externalId: ctx.endpoint,
        title: feed.title,
        description: feed.description,
      },
    ];
  },

  async listChapters(ctx): Promise<SourceChapter[]> {
    const feed = await loadFeed(ctx, ctx.endpoint);
    // feed 惯例是新→旧，阅读顺序要反过来
    const ordered = [...feed.items].reverse();
    return ordered.map((item) => ({
      externalKey: item.key,
      title: item.title,
      inlineParagraphs: item.content ? contentToParagraphs(item.content) : null,
    }));
  },

  async fetchChapter(ctx, chapter) {
    // 目录阶段没拿到全文时，回源抓单篇
    ctx.countRequest();
    const response = await guardedFetch(ctx.db, chapter.externalKey);
    if (!response.ok) throw new Error(response.message);
    if (response.result.status >= 400) throw new Error(`正文返回 HTTP ${response.result.status}`);
    const paragraphs = contentToParagraphs(response.result.body);
    if (paragraphs.length === 0) throw new Error("正文为空");
    return { paragraphs };
  },
};
