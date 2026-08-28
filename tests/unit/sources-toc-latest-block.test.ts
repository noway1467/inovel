import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import { detectChapterList } from "~/server/sources/toc-detect";

/**
 * 目录页上的「最新章节」预告块不该进目录。
 *
 * 这类页面（kxdu.net/book/99/ 是典型）在同一个 <ul> 里放两段：先是
 * 「最新章节」9 条倒序，再是「全部章节」全书正序，两段地址有重叠。
 * 不分段的话有两个后果，都是用户直接能看到的：
 *
 *  1. 排版乱 —— 去重保留首次出现，倒序那 9 条先入列；再按「第N章」序号排序，
 *     它们就散落到第 5～15 章之间，目录里凭空多出一段乱序。
 *  2. 多余 —— 那 9 条本来就在全部章节里，是同一批章节的重复入口。
 *
 * 判据是「一个自身不含链接、文字很短的节点」，不看标签名：真实页面上
 * 这个小标题是 <h1>，别的站用 <dt>、<div class="title">、<b>，标签名指望不上。
 */

const html = readFileSync("tests/fixtures/toc-latest-block.html", "utf8");
const base = "https://www.kxdu.net/book/99/";

describe("目录探测：丢掉「最新章节」预告块", () => {
  const chapters = detectChapterList(parseHtml(html), base);

  it("只留「全部章节」那一段", () => {
    // 夹具里全部章节 15 条，最新章节 9 条（地址与前者重叠）
    expect(chapters).toHaveLength(15);
    expect(chapters[0]?.title).toContain("第一章");
    expect(chapters.at(-1)?.title).toContain("第十五章");
  });

  it("倒序块里的地址不出现在结果里", () => {
    // 7028565~7028573 是「最新章节」块专有的地址（正文页另有一套 3673xxx）
    const latestOnly = chapters.filter((c) => /\/70285\d\d\.html$/.test(c.url));
    expect(latestOnly).toHaveLength(0);
  });

  it("章节序号严格递增，没有插进来的乱序条目", () => {
    const ordinals = chapters.map((c) => c.title.match(/第([一二三四五六七八九十百千万零\d]+)章/)?.[1]);
    expect(ordinals.every(Boolean)).toBe(true);
    // 同一个序号不该出现两次 —— 重复入口就是这么冒出来的
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it("地址不重复", () => {
    expect(new Set(chapters.map((c) => c.url)).size).toBe(chapters.length);
  });
});

describe("卷次重编号的书不按序号重排", () => {
  /**
   * 长篇里「第N章」会重来：外传、第二部都从第一章起编号。这种页面的 DOM 顺序
   * 就是源站顺序，按序号排会把相隔上千章的同号章节拧在一起。
   * 真实案例：斗破苍穹 1683 章里有 70 个重复序号。
   */
  it("正文 1..20 后接外传 1..5 时，保持源站顺序", () => {
    const main = Array.from(
      { length: 20 },
      (_, i) => `<li><a href="/c/${1000 + i}.html">第${i + 1}章 正文</a></li>`
    ).join("");
    const extra = Array.from(
      { length: 5 },
      (_, i) => `<li><a href="/c/${2000 + i}.html">第${i + 1}章 外传</a></li>`
    ).join("");
    const chapters = detectChapterList(
      parseHtml(`<html><body><div><ul>${main}${extra}</ul></div></body></html>`),
      base
    );
    expect(chapters).toHaveLength(25);
    // 外传 5 章仍在末尾，没有被按序号插到正文前几章里
    expect(chapters.slice(20).map((c) => c.title)).toEqual([
      "第1章 外传",
      "第2章 外传",
      "第3章 外传",
      "第4章 外传",
      "第5章 外传",
    ]);
    expect(chapters[0]?.title).toBe("第1章 正文");
  });

  /**
   * 但「最新 N 章倒序在前」仍然要重排 —— 那种形态逆序密集，
   * 与换卷时只降一次区分得开。
   */
  it("倒序块在前时仍按序号重排", () => {
    const latest = [15, 14, 13, 12, 11]
      .map((n) => `<li><a href="/c/${2000 + n}.html">第${n}章 最新</a></li>`)
      .join("");
    const body = Array.from(
      { length: 10 },
      (_, i) => `<li><a href="/c/${1000 + i}.html">第${i + 1}章 正文</a></li>`
    ).join("");
    const chapters = detectChapterList(
      parseHtml(`<html><body><div><ul>${latest}${body}</ul></div></body></html>`),
      base
    );
    expect(chapters[0]?.title).toBe("第1章 正文");
    expect(chapters.at(-1)?.title).toBe("第15章 最新");
  });
});

describe("分段只在真能分出来时生效", () => {
  /**
   * 整页只有「最新章节」一段时不能把它清空 —— 那种页面上这一段就是全部内容，
   * 丢掉等于探测失败。多数留存判据（kept * 2 >= total）保证了这一点。
   */
  it("只有最新章节一段时照常返回", () => {
    const only = `<html><body><div class="box"><ul>
      <h3>最新章节</h3>
      ${Array.from(
        { length: 12 },
        (_, i) => `<li><a href="/c/${i + 1}.html">第${i + 1}章 标题</a></li>`
      ).join("")}
    </ul></div></body></html>`;
    const chapters = detectChapterList(parseHtml(only), base);
    expect(chapters).toHaveLength(12);
  });

  it("没有任何小标题时行为不变", () => {
    const plain = `<html><body><div class="listmain"><dl>
      ${Array.from(
        { length: 10 },
        (_, i) => `<dd><a href="/c/${i + 1}.html">第${i + 1}章 标题</a></dd>`
      ).join("")}
    </dl></div></body></html>`;
    expect(detectChapterList(parseHtml(plain), base)).toHaveLength(10);
  });
});
