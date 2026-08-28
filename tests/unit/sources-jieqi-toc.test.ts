import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildJieqiTocUrl,
  detectJieqiArticleNo,
  fetchJieqiToc,
  parseJieqiPage,
} from "~/server/sources/jieqi-toc";
import { parseHtml } from "~/server/sources/html";
import { detectChapterList, detectNextPageUrl } from "~/server/sources/toc-detect";

/**
 * 杰奇（jieqi）CMS 的完整目录接口。
 *
 * 这套模板的详情页只渲染第一页 10 条，翻页按钮是 onclick 没有 href，
 * 于是斗破苍穹 1683 章只能抓到 10 条 —— m.95dxs.com、m.92dxs.org 等一批站
 * 都栽在这里。翻页并不需要 JS 引擎：那个函数背后是个普通 GET 接口。
 */

const html = readFileSync("tests/fixtures/jieqi-info-page.html", "utf8");
const page0 = readFileSync("tests/fixtures/jieqi-chapterlist-p0.json", "utf8");
const page1 = readFileSync("tests/fixtures/jieqi-chapterlist-p1.json", "utf8");
const pageUrl = "https://m.95dxs.com/info/0/99.html";

describe("通用探测在这类页面上的确不够", () => {
  it("页面上只有第一页 10 条", () => {
    expect(detectChapterList(parseHtml(html), pageUrl)).toHaveLength(10);
  });

  it("翻页按钮没有 href，通用分页探测拿不到下一页", () => {
    expect(detectNextPageUrl(parseHtml(html), pageUrl)).toBeNull();
  });
});

describe("detectJieqiArticleNo", () => {
  it("从 onclick 里取出书号", () => {
    expect(detectJieqiArticleNo(html, pageUrl)).toBe("99");
  });

  /**
   * 判据不能依赖页面出现 /ajaxService —— 那个地址写在外部 wap.js 里，
   * 页面上根本没有。早先要求页面提到它，真实的 95dxs 页面一次都没命中过。
   */
  it("页面不提 ajaxService 也能认出来", () => {
    expect(/ajaxService/i.test(html)).toBe(false);
    expect(detectJieqiArticleNo(html, pageUrl)).toBe("99");
  });

  it("只有分页容器、书号不在 onclick 里时从地址取", () => {
    const noCall = `<html><body><table id="allchapter_2"><tr><td>第1/168页</td></tr></table></body></html>`;
    expect(detectJieqiArticleNo(noCall, pageUrl)).toBe("99");
  });

  it("getchapterList 形态同样认得", () => {
    const alt = `<html><body><a onclick="getchapterList(1234,2)">下页</a></body></html>`;
    expect(detectJieqiArticleNo(alt, "https://x.example/info/0/1234.html")).toBe("1234");
  });

  it("不是这套模板时返回 null", () => {
    const plain = `<html><body><div class="listmain"><dl><dd><a href="/c/1.html">第一章</a></dd></dl></div></body></html>`;
    expect(detectJieqiArticleNo(plain, "https://other.example/book/1/")).toBeNull();
  });

  /**
   * 单参数的同名函数不算 —— 接口要「书号 + 页码」两个参数，
   * 只有一个参数的是别的东西，认错会白发一次请求。
   */
  it("单参数调用不误判", () => {
    const one = `<html><body><a onclick="allchapter(99)">展开</a></body></html>`;
    expect(detectJieqiArticleNo(one, "https://x.example/other/99.html")).toBeNull();
  });
});

describe("buildJieqiTocUrl", () => {
  it("按书号与页码拼接口地址", () => {
    const url = new URL(buildJieqiTocUrl(pageUrl, "99", 0));
    expect(url.origin).toBe("https://m.95dxs.com");
    expect(url.pathname).toBe("/ajaxService");
    expect(url.searchParams.get("action")).toBe("chapterlist");
    expect(url.searchParams.get("articleno")).toBe("99");
    expect(url.searchParams.get("index")).toBe("0");
    // sort=1 是正序：倒序会让整本书的阅读顺序反过来
    expect(url.searchParams.get("sort")).toBe("1");
  });

  it("size 放大到千级，1683 章两次请求取完", () => {
    const size = Number(new URL(buildJieqiTocUrl(pageUrl, "99", 0)).searchParams.get("size"));
    expect(size).toBeGreaterThanOrEqual(1000);
    // 1000 章约 400KB，要留在 guardedFetch 的 2MB 上限内
    expect(size).toBeLessThanOrEqual(2000);
  });

  it("按页码递增 index", () => {
    expect(new URL(buildJieqiTocUrl(pageUrl, "99", 3)).searchParams.get("index")).toBe("3");
  });
});

describe("parseJieqiPage", () => {
  it("取出章节名与绝对地址，并带回总页数", () => {
    const parsed = parseJieqiPage(page0, pageUrl);
    expect(parsed?.pages).toBe(2);
    expect(parsed?.chapters[0]).toEqual({
      title: "第一章 陨落的天才",
      externalKey: "https://m.95dxs.com/reader/0/99/3673687.html",
    });
  });

  it("不是 JSON 或没有 items 时返回 null", () => {
    expect(parseJieqiPage("<html>403</html>", pageUrl)).toBeNull();
    expect(parseJieqiPage(JSON.stringify({ code: 1 }), pageUrl)).toBeNull();
  });

  it("缺名字或缺地址的条目跳过，不产出点开就报错的假章节", () => {
    const body = JSON.stringify({
      pages: 1,
      items: [
        { chaptername: "第一章", url: "/reader/0/99/1.html" },
        { chaptername: "", url: "/reader/0/99/2.html" },
        { chaptername: "第三章", url: "" },
        null,
      ],
    });
    expect(parseJieqiPage(body, pageUrl)?.chapters).toHaveLength(1);
  });

  it("pages 字段异常时按 1 页算", () => {
    const body = JSON.stringify({ pages: "坏", items: [{ chaptername: "第一章", url: "/c/1.html" }] });
    expect(parseJieqiPage(body, pageUrl)?.pages).toBe(1);
  });
});

describe("fetchJieqiToc", () => {
  it("按 pages 翻完所有页并拼成完整目录", async () => {
    const requested: string[] = [];
    const bodies = [page0, page1];
    const chapters = await fetchJieqiToc(html, pageUrl, async (url) => {
      requested.push(url);
      return bodies[requested.length - 1] ?? "{}";
    });

    // 夹具每页各留了几条（真实是 1000 + 683）
    expect(chapters).toHaveLength(5);
    expect(chapters[0]?.title).toBe("第一章 陨落的天才");
    expect(chapters.at(-1)?.title).toBe("第九百七十二章 天山台");

    // pages=2，所以正好两次请求，index 依次递增
    expect(requested).toHaveLength(2);
    expect(new URL(requested[0]!).searchParams.get("index")).toBe("0");
    expect(new URL(requested[1]!).searchParams.get("index")).toBe("1");
  });

  it("不是杰奇模板时不发任何请求", async () => {
    let calls = 0;
    const chapters = await fetchJieqiToc("<html><body>无关页面</body></html>", pageUrl, async () => {
      calls += 1;
      return page0;
    });
    expect(chapters).toEqual([]);
    expect(calls).toBe(0);
  });

  it("接口打不通时返回空数组，交回上层走探测", async () => {
    const chapters = await fetchJieqiToc(html, pageUrl, async () => {
      throw new Error("503");
    });
    expect(chapters).toEqual([]);
  });

  it("第二页失败时保留第一页已取到的章节", async () => {
    let calls = 0;
    const chapters = await fetchJieqiToc(html, pageUrl, async () => {
      calls += 1;
      if (calls === 1) return page0;
      throw new Error("超时");
    });
    expect(chapters).toHaveLength(3);
  });

  it("地址重复的条目只留一条", async () => {
    const dupe = JSON.stringify({
      pages: 1,
      items: [
        { chaptername: "第一章", url: "/reader/0/99/1.html" },
        { chaptername: "第一章（重复入口）", url: "/reader/0/99/1.html" },
      ],
    });
    const chapters = await fetchJieqiToc(html, pageUrl, async () => dupe);
    expect(chapters).toHaveLength(1);
  });

  /**
   * pages 字段异常（大得离谱）时必须有界：没有上限会一直翻下去，
   * 把源站打爆，也会撞 Workers 的子请求上限。
   */
  it("pages 异常时翻页次数有界", async () => {
    let calls = 0;
    await fetchJieqiToc(html, pageUrl, async () => {
      calls += 1;
      return JSON.stringify({
        pages: 99999,
        items: [{ chaptername: `第${calls}章`, url: `/reader/0/99/${calls}.html` }],
      });
    });
    expect(calls).toBeLessThanOrEqual(20);
  });
});
