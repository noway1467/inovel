import { describe, expect, it } from "vitest";
import { bestPreciseSourceCount, preciseRelevance } from "~/lib/book-match";

/** 造一本书：relevance + 几个源 */
function book(relevance: number, sourceCount: number) {
  return { relevance, options: Array.from({ length: sourceCount }, (_, i) => ({ id: `s${i}` })) };
}

describe("bestPreciseSourceCount", () => {
  it("空列表是 0", () => {
    expect(bestPreciseSourceCount([])).toBe(0);
  });

  it("取精准命中里源最多的那本，而不是所有源加起来", () => {
    expect(bestPreciseSourceCount([book(4, 3), book(4, 5), book(3, 2)])).toBe(5);
  });

  it("不精准的书不算，哪怕它源最多", () => {
    // relevance 2 = 书名包含关键字，够展示但不够"就是这本书"
    expect(bestPreciseSourceCount([book(2, 9), book(4, 2)])).toBe(2);
  });

  it("一本精准的都没有就是 0", () => {
    expect(bestPreciseSourceCount([book(2, 6), book(1, 8), book(0, 4)])).toBe(0);
  });

  it("正好卡在 preciseRelevance 上的算精准", () => {
    expect(bestPreciseSourceCount([book(preciseRelevance, 4)])).toBe(4);
    expect(bestPreciseSourceCount([book(preciseRelevance - 1, 4)])).toBe(0);
  });

  /**
   * 「继续搜索」的语义：目标 = 当前最好成绩 + 5。
   *
   * 这条锁住的是"点继续之后不会立刻又停"—— 之前的写法是固定跑一批，
   * 换成循环后如果目标不抬，hasEnough 第一批跑完就成立。
   */
  it("继续搜索抬高目标后，原有结果不再满足停止条件", () => {
    const books = [book(4, 5)];
    const target = bestPreciseSourceCount(books) + 5;
    expect(target).toBe(10);
    expect(bestPreciseSourceCount(books) >= target).toBe(false);
  });

  it("攒到新目标才停", () => {
    const books = [book(4, 10)];
    expect(bestPreciseSourceCount(books) >= 10).toBe(true);
  });
});
