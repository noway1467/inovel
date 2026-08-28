/**
 * 书名/作者的匹配与相关度。客户端与服务端共用。
 *
 * 放在 lib 而不是 server/sources/search.ts：搜索页要在浏览器里把陆续到达的
 * 各批结果并成一条书，用的分组键必须和服务端分组时一模一样。各写一份的话
 * 一定会漂 —— 之前客户端按原始 `书名|作者` 拼键，服务端按规范化后拼，
 * 于是《剑来》和「剑来」被当成两本书，同一本书的源永远攒不到 5 个。
 *
 * 这里不引任何服务端依赖（db、env），可以安全打进客户端包。
 */

/** 全角空格。写成转义，避免源码里出现不可见字符。 */
const wideSpace = "\\u3000";

/** 比较用的规范化：去空白、去全角标点、转小写 */
export function normalizeForMatch(value: string): string {
  return value
    .replace(new RegExp(`[\\s${wideSpace}]+`, "g"), "")
    .replace(/[《》「」【】（）()、，,。.!！?？:：;；~～\-—_]/g, "")
    .toLowerCase();
}

/** 分组键：书名 + 作者，两者都规范化后比较 */
export function groupKey(title: string, author: string | null | undefined): string {
  return `${normalizeForMatch(title)}|${normalizeForMatch(author ?? "")}`;
}

/**
 * 关键字相关度分档。分数越高越"就是这本书"。
 *
 * 书源搜索页很少做严格匹配：不少站对任意关键字都回吐热门榜或整个分类页，
 * 于是搜「剑来」会混进几十本无关的书。只给一个 true/false 不够用 ——
 * 那样精确命中和"作者名里碰巧有这两个字"排在一起，用户要的书被埋在中间。
 * 分档后由调用方决定怎么排、怎么算"搜到了"。
 *
 *  4 书名与关键字完全一致（去标点空白后）
 *  3 书名以关键字开头（《剑来》→《剑来传》这类续作、精校版）
 *  2 书名包含关键字
 *  1 只有作者命中，或多词输入被书名/作者拆开命中
 *  0 不相关
 */
export const relevanceExact = 4;
/** 达到这个分档才算"精准命中"，用于判断搜索是否可以停下来 */
export const preciseRelevance = 3;

export function keywordRelevance(
  book: { title: string; author?: string | null },
  keyword: string
): number {
  const needle = normalizeForMatch(keyword);
  if (!needle) return relevanceExact;

  const title = normalizeForMatch(book.title);
  const author = normalizeForMatch(book.author ?? "");

  if (title === needle) return 4;
  if (title.startsWith(needle)) return 3;
  if (title.includes(needle)) return 2;
  if (author && author.includes(needle)) return 1;

  // 空格分词后逐词命中（书名里顺序可能与输入不同）
  const words = keyword
    .split(new RegExp(`[\\s${wideSpace}]+`))
    .map(normalizeForMatch)
    .filter((word) => word.length > 0);
  if (words.length > 1 && words.every((word) => title.includes(word) || author.includes(word))) {
    return 1;
  }
  return 0;
}

/**
 * 精准命中的书里，源最多的那本有几个源。
 *
 * 这是搜索停止条件的唯一判据：用户要的是这一本，多个源只是备用线路。
 * 单独拆出来是因为「继续搜索」也要用同一把尺子 —— 原先自动阶段按
 * 「攒够 5 个精准源」停，而继续搜索只固定跑一批就停，两条路两套规则，
 * 点了继续往往只多查 4 个源、一个都没攒上就又停住了。
 */
export function bestPreciseSourceCount(
  books: { relevance: number; options: unknown[] }[]
): number {
  let best = 0;
  for (const book of books) {
    if (book.relevance >= preciseRelevance && book.options.length > best) {
      best = book.options.length;
    }
  }
  return best;
}

/** 是否值得留下来展示。相关度 > 0 即可，排序交给 keywordRelevance。 */
export function matchesKeyword(
  book: { title: string; author?: string | null },
  keyword: string
): boolean {
  return keywordRelevance(book, keyword) > 0;
}
