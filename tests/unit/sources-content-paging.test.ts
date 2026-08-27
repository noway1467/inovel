import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import { toParagraphs } from "~/server/sources/types";
import { detectNextPageUrl, isSameChapterNextPage } from "~/server/sources/toc-detect";

/**
 * 分页正文的兜底探测。
 *
 * 真实来源：品书小说（www.pinshu8.com）。「斗破苍穹」第一章有 3 页，
 * 而整章只有一个翻页按钮、文字恒为「下一章」—— 指向下一页还是真的下一章
 * 由站点自己判断。只看文字会把每章截成第一页。
 */

/** 复刻 pinshu8 章节页底部的翻页区：两个按钮，文字都是「下一章」 */
function pinshu8Page(nextHref: string): string {
  return `<!DOCTYPE html><html><body>
    <div class="content"><p>斗气大陆，广袤无边。</p><p>而在这片大陆上，武之极道，便是斗气。</p></div>
    <div class="bottem">
      <a href="/0/143/">章节目录</a>
      <a id="next1" href="${nextHref}" data="${nextHref}">下一章</a>
      <a id="next" href="${nextHref}" data="${nextHref}">下一章</a>
    </div>
  </body></html>`;
}

describe("isSameChapterNextPage", () => {
  it("认出文件名 _N 后缀的续页", () => {
    const base = "https://www.pinshu8.com/0/143/155832.html";
    expect(isSameChapterNextPage(base, "https://www.pinshu8.com/0/143/155832_2.html")).toBe(true);
    expect(
      isSameChapterNextPage(
        "https://www.pinshu8.com/0/143/155832_2.html",
        "https://www.pinshu8.com/0/143/155832_3.html"
      )
    ).toBe(true);
  });

  it("挡住真正的章节边界", () => {
    // 品书小说第 3 页的「下一章」指向下一章，基名变了
    expect(
      isSameChapterNextPage(
        "https://www.pinshu8.com/0/143/155832_3.html",
        "https://www.pinshu8.com/0/143/155833.html"
      )
    ).toBe(false);
    expect(
      isSameChapterNextPage(
        "https://www.pinshu8.com/0/143/155832.html",
        "https://www.pinshu8.com/0/143/155833.html"
      )
    ).toBe(false);
  });

  it("页码必须递增，不接受回退或自指", () => {
    const p3 = "https://www.pinshu8.com/0/143/155832_3.html";
    expect(isSameChapterNextPage(p3, "https://www.pinshu8.com/0/143/155832_2.html")).toBe(false);
    expect(isSameChapterNextPage(p3, p3)).toBe(false);
    expect(isSameChapterNextPage(p3, "https://www.pinshu8.com/0/143/155832.html")).toBe(false);
  });

  it("支持 - 分隔与查询串分页", () => {
    expect(isSameChapterNextPage("https://a.com/c/1.html", "https://a.com/c/1-2.html")).toBe(true);
    expect(isSameChapterNextPage("https://a.com/read?id=9", "https://a.com/read?id=9&page=2")).toBe(
      true
    );
    expect(
      isSameChapterNextPage("https://a.com/read?id=9&page=2", "https://a.com/read?id=9&page=3")
    ).toBe(true);
    // 不同书/不同章的查询串不算续页
    expect(isSameChapterNextPage("https://a.com/read?id=9", "https://a.com/read?id=10&page=2")).toBe(
      false
    );
  });

  it("跨域不算续页", () => {
    expect(isSameChapterNextPage("https://a.com/c/1.html", "https://b.com/c/1_2.html")).toBe(false);
  });
});

describe("detectNextPageUrl：文字写「下一章」但其实是下一页", () => {
  it("第 1 页跟到第 2 页", () => {
    const doc = parseHtml(pinshu8Page("/0/143/155832_2.html"));
    expect(detectNextPageUrl(doc, "https://www.pinshu8.com/0/143/155832.html")).toBe(
      "https://www.pinshu8.com/0/143/155832_2.html"
    );
  });

  it("第 2 页跟到第 3 页", () => {
    const doc = parseHtml(pinshu8Page("/0/143/155832_3.html"));
    expect(detectNextPageUrl(doc, "https://www.pinshu8.com/0/143/155832_2.html")).toBe(
      "https://www.pinshu8.com/0/143/155832_3.html"
    );
  });

  it("末页停住，不把下一章拼进来", () => {
    // 这是回归的关键：155832_3 的「下一章」真的是下一章
    const doc = parseHtml(pinshu8Page("/0/143/155833.html"));
    expect(detectNextPageUrl(doc, "https://www.pinshu8.com/0/143/155832_3.html")).toBeNull();
  });

  it("写明「下一页」的仍然优先，且「下一章」不被误跟", () => {
    const doc = parseHtml(`<html><body>
      <a href="/0/143/155833.html">下一章</a>
      <a href="/0/143/155832_2.html">下一页</a>
    </body></html>`);
    expect(detectNextPageUrl(doc, "https://www.pinshu8.com/0/143/155832.html")).toBe(
      "https://www.pinshu8.com/0/143/155832_2.html"
    );
  });

  it("只有下一章链接、地址形状也不像续页时返回 null", () => {
    const doc = parseHtml(`<html><body>
      <a href="/0/143/">章节目录</a>
      <a href="/0/143/155833.html">下一章</a>
    </body></html>`);
    expect(detectNextPageUrl(doc, "https://www.pinshu8.com/0/143/155832.html")).toBeNull();
  });
});

/**
 * 目录分页。真实来源：7kbook（www.7kbook.com）斗破苍穹共 1907 章，
 * 目录每页约 100 章，分 20 页。分页器整排都没有「下一页」字样：
 *   <a class="page-link" href="/0/143/index_1.html">1</a>
 *   <a class="page-link" href="/0/143/index_2.html">2</a>
 *   <a class="page-link" href="/0/143/index_3.html">3</a>
 *   <a class="page-link" href="/0/143/index_2.html">&gt;</a>
 * 且第 1 页就挂在目录地址 `/0/143/` 上，不是 index_1.html。
 */
function sevenKPager(current: number, last = 20): string {
  const window = [current - 1, current, current + 1].filter((n) => n >= 1 && n <= last);
  const numbered = window
    .map((n) => `<a class="page-link" href="/0/143/index_${n}.html">${n}</a>`)
    .join("");
  const next =
    current < last
      ? `<a class="page-link" href="/0/143/index_${current + 1}.html">&gt;</a>`
      : "";
  return `<html><body>
    <div class="mulu">
      <a href="/0/143/155832.html">第一章 陨落的天才</a>
      <a href="/0/143/155833.html">第二章 斗之气三段</a>
    </div>
    <div class="pagination">${numbered}${next}</div>
  </body></html>`;
}

describe("目录分页：数字分页器与符号按钮", () => {
  it("从目录地址跟到第 2 页（第 1 页挂在目录上，不是 index_1）", () => {
    const doc = parseHtml(sevenKPager(1));
    expect(detectNextPageUrl(doc, "http://www.7kbook.com/0/143/")).toBe(
      "http://www.7kbook.com/0/143/index_2.html"
    );
  });

  it("中间页逐页往后", () => {
    expect(detectNextPageUrl(parseHtml(sevenKPager(2)), "http://www.7kbook.com/0/143/index_2.html")).toBe(
      "http://www.7kbook.com/0/143/index_3.html"
    );
    expect(
      detectNextPageUrl(parseHtml(sevenKPager(19)), "http://www.7kbook.com/0/143/index_19.html")
    ).toBe("http://www.7kbook.com/0/143/index_20.html");
  });

  it("末页停住（没有 21，也没有 > 按钮）", () => {
    const doc = parseHtml(sevenKPager(20));
    expect(detectNextPageUrl(doc, "http://www.7kbook.com/0/143/index_20.html")).toBeNull();
  });

  it("目录地址不会被章节链接骗走", () => {
    // 关键回归：`/0/143/` 拆出来页码算 1，若不挡住目录形式，
    // 章节地址 155833.html 会被当成「续页」
    const doc = parseHtml(`<html><body>
      <a href="/0/143/155832.html">第一章</a>
      <a href="/0/143/155833.html">第二章</a>
    </body></html>`);
    expect(detectNextPageUrl(doc, "http://www.7kbook.com/0/143/")).toBeNull();
  });

  it("只有符号按钮时也能翻", () => {
    const doc = parseHtml(`<html><body>
      <a href="/0/143/index_5.html">&lt;</a>
      <a href="/0/143/index_7.html">&gt;</a>
    </body></html>`);
    expect(detectNextPageUrl(doc, "http://www.7kbook.com/0/143/index_6.html")).toBe(
      "http://www.7kbook.com/0/143/index_7.html"
    );
  });

  it("不跟后退符号", () => {
    const doc = parseHtml(`<html><body>
      <a href="/0/143/index_5.html">&lt;</a>
      <a href="/0/143/index_5.html">上一页</a>
    </body></html>`);
    expect(detectNextPageUrl(doc, "http://www.7kbook.com/0/143/index_6.html")).toBeNull();
  });

  it("不跟「末页」——会跳过中间所有页", () => {
    const doc = parseHtml(`<html><body>
      <a href="/0/143/index_20.html">末页</a>
      <a href="/0/143/index_20.html">尾页</a>
    </body></html>`);
    expect(detectNextPageUrl(doc, "http://www.7kbook.com/0/143/index_2.html")).toBeNull();
  });

  it("章节号不会被当成页码（数字前必须有分隔符）", () => {
    // 目录里章节标题恰好是纯数字的站：模板 /0/143/15583N.html 数字前是数字，
    // 不是分隔符，不能当分页器
    const doc = parseHtml(`<html><body>
      <a href="/0/143/155832.html">1</a>
      <a href="/0/143/155833.html">2</a>
      <a href="/0/143/155834.html">3</a>
    </body></html>`);
    expect(detectNextPageUrl(doc, "http://www.7kbook.com/0/143/155832.html")).toBeNull();
  });

  it("跨目录、跨站的分页链接不跟", () => {
    const doc = parseHtml(`<html><body>
      <a href="/0/999/index_2.html">2</a>
      <a href="http://other.com/0/143/index_2.html">2</a>
    </body></html>`);
    expect(detectNextPageUrl(doc, "http://www.7kbook.com/0/143/")).toBeNull();
  });
});

/**
 * 跟随分页后，每页首尾的「第(N/3)页」都会落进正文中间 ——
 * 品书小说这一章拼完有 6 条。这些标记在正文容器里，必须在切段时滤掉。
 */
describe("toParagraphs 滤掉翻页提示", () => {
  it("滤掉页码标记的各种写法", () => {
    const lines = [
      "第(1/3)页",
      "第（2/3）页",
      "第 3/3 页",
      "(1/3)",
      "1／2",
      "本章未完，请点击下一页继续阅读",
      "本章未完，点击下一页继续阅读。",
    ].join("\n");
    expect(toParagraphs(lines)).toEqual([]);
  });

  it("不误删正文", () => {
    const prose = [
      "斗气大陆，广袤无边。",
      "萧炎的实力，在三年前便是九段斗之气，如今却只有 3/10 的水平。",
      "第三页纸上写着一行小字。",
      "他翻到第 2 页，看见了那句话。",
    ].join("\n");
    expect(toParagraphs(prose)).toHaveLength(4);
  });

  it("整章拼接后正文段落数不变、标记归零", () => {
    // 复刻真实形状：每页首尾各一条标记，中间是正文
    const page = (n: number) => [`第(${n}/3)页`, `第 ${n} 页的正文。`, `第(${n}/3)页`].join("\n");
    const chapter = [page(1), page(2), page(3)].join("\n");
    expect(toParagraphs(chapter)).toEqual(["第 1 页的正文。", "第 2 页的正文。", "第 3 页的正文。"]);
  });
});
