import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import { detectExploreBooks } from "~/server/sources/explore-detect";
import { parseExploreCategories } from "~/server/sources/explore";

/**
 * 发现页书单探测。
 *
 * 这条路径不是备用品：实测 152 个有分类的源里 54 个压根没有 exploreList 规则
 * （蓝海搜书的 ruleExplore 就是个 `{}`），点开分类全靠它。此前这里复用的是
 * 目录探测，它按「第 N 章」模式打分，分类页上没有这种模式于是退化成
 * 「挑链接最多的容器」—— 而分类页上链接最多的通常是顶部标签云，
 * 结果点开一个标签看到的还是一排标签。
 */

const base = "https://books.example.org/fenlei/1/1/";

describe("detectExploreBooks", () => {
  it("标签云与书单同页时只认书单", () => {
    const html = `<html><body>
      <div class="tags">
        ${Array.from(
          { length: 12 },
          (_, i) => `<a href="/fenlei/${i + 1}/1/">分类${i + 1}</a>`
        ).join("")}
      </div>
      <ul class="list">
        <li><a href="/book/1001.html">剑来</a></li>
        <li><a href="/book/1002.html">诡秘之主</a></li>
        <li><a href="/book/1003.html">深空彼岸</a></li>
      </ul>
    </body></html>`;
    const books = detectExploreBooks(parseHtml(html), base);
    expect(books.map((b) => b.title)).toEqual(["剑来", "诡秘之主", "深空彼岸"]);
  });

  it("标签比书多也不会赢 —— 与本页同形的一律排除", () => {
    // 20 个标签 vs 2 本书：按数量取最大会选错，按形状才对
    const html = `<html><body>
      <div class="tags">
        ${Array.from(
          { length: 20 },
          (_, i) => `<a href="/fenlei/${i + 1}/1/">分类${i + 1}</a>`
        ).join("")}
      </div>
      <ul><li><a href="/book/1.html">书一</a></li><li><a href="/book/2.html">书二</a></li></ul>
    </body></html>`;
    const books = detectExploreBooks(parseHtml(html), base);
    expect(books.map((b) => b.title)).toEqual(["书一", "书二"]);
  });

  it("按源自己的分类地址排除 —— 标签形状与本页不同时也挡得住", () => {
    /**
     * 有的站分类页是 `/fenlei/1/1/`，而标签云指向 `/tag/xuanhuan/`，
     * 两者形状不同，光靠「与本页同形」挡不住。源自己的分类列表能挡。
     */
    const categories = parseExploreCategories(
      "玄幻:: /tag/xuanhuan/\n武侠:: /tag/wuxia/\n都市:: /tag/dushi/"
    );
    const html = `<html><body>
      <div class="tags">
        <a href="/tag/xuanhuan/">玄幻</a>
        <a href="/tag/wuxia/">武侠</a>
        <a href="/tag/dushi/">都市</a>
      </div>
      <ul>
        <li><a href="/book/1.html">书一</a></li>
        <li><a href="/book/2.html">书二</a></li>
        <li><a href="/book/3.html">书三</a></li>
      </ul>
    </body></html>`;
    const books = detectExploreBooks(parseHtml(html), base, categories);
    expect(books.map((b) => b.title)).toEqual(["书一", "书二", "书三"]);
  });

  it("封面链接与书名链接指向同一本时只算一本", () => {
    const html = `<html><body><ul>
      <li>
        <a href="/book/1.html"><img src="/cover/1.jpg" alt="书一封面"></a>
        <a href="/book/1.html">书一</a>
      </li>
      <li>
        <a href="/book/2.html"><img src="/cover/2.jpg" alt="书二封面"></a>
        <a href="/book/2.html">书二</a>
      </li>
      <li>
        <a href="/book/3.html"><img src="/cover/3.jpg" alt="书三封面"></a>
        <a href="/book/3.html">书三</a>
      </li>
    </ul></body></html>`;
    const books = detectExploreBooks(parseHtml(html), base);
    expect(books).toHaveLength(3);
    // 首次出现胜出：封面的 alt 文字
    expect(books.map((b) => b.url)).toEqual([
      "https://books.example.org/book/1.html",
      "https://books.example.org/book/2.html",
      "https://books.example.org/book/3.html",
    ]);
  });

  it("作者链接与书籍链接形状不同，只留书", () => {
    const html = `<html><body><ul>
      <li><a href="/book/1.html">书一</a> <a href="/author/12.html">作者甲</a></li>
      <li><a href="/book/2.html">书二</a> <a href="/author/13.html">作者乙</a></li>
      <li><a href="/book/3.html">书三</a> <a href="/author/14.html">作者丙</a></li>
      <li><a href="/book/4.html">书四</a> <a href="/author/15.html">作者丁</a></li>
    </ul></body></html>`;
    const books = detectExploreBooks(parseHtml(html), base);
    expect(books.map((b) => b.title)).toEqual(["书一", "书二", "书三", "书四"]);
  });

  it("分页器、导航、站外链接都不算书", () => {
    const html = `<html><body>
      <div class="nav"><a href="/">首页</a><a href="/rank/">排行</a><a href="/login">登录</a></div>
      <ul>
        <li><a href="/book/1.html">书一</a></li>
        <li><a href="/book/2.html">书二</a></li>
      </ul>
      <div class="pager">
        <a href="/fenlei/1/1/">1</a><a href="/fenlei/1/2/">2</a><a href="/fenlei/1/3/">></a>
      </div>
      <div class="links"><a href="https://other.example.net/x.html">友情链接站</a></div>
    </body></html>`;
    const books = detectExploreBooks(parseHtml(html), base);
    expect(books.map((b) => b.title)).toEqual(["书一", "书二"]);
  });

  it("下载包、图片链接不算书", () => {
    const html = `<html><body><ul>
      <li><a href="/book/1.html">书一</a><a href="/dl/1.zip">TXT下载</a></li>
      <li><a href="/book/2.html">书二</a><a href="/dl/2.zip">TXT下载</a></li>
      <li><a href="/book/3.html">书三</a><a href="/dl/3.apk">安卓版</a></li>
    </ul></body></html>`;
    const books = detectExploreBooks(parseHtml(html), base);
    expect(books.map((b) => b.title)).toEqual(["书一", "书二", "书三"]);
  });

  it("接口型地址按查询串区分形状", () => {
    const apiBase = "https://api.example.org/v1/search?action=tag&actionTag=9000722&page=1";
    const html = `<html><body><ul>
      <li><a href="/v1/detail?bid=1001">书一</a></li>
      <li><a href="/v1/detail?bid=1002">书二</a></li>
      <li><a href="/v1/search?action=tag&actionTag=9000724&page=1">东方玄幻</a></li>
      <li><a href="/v1/search?action=tag&actionTag=9000728&page=1">现代都市</a></li>
    </ul></body></html>`;
    const books = detectExploreBooks(parseHtml(html), apiBase);
    expect(books.map((b) => b.title)).toEqual(["书一", "书二"]);
  });

  it("整页只有标签时返回空，而不是把标签当书", () => {
    /**
     * 空手而归比给一堆假书好：界面上会显示「这个分类没取到书」，
     * 用户知道该换分类；返回标签的话点进去每一个都是 404。
     */
    const html = `<html><body><div class="tags">
      ${Array.from({ length: 20 }, (_, i) => `<a href="/fenlei/${i + 1}/1/">分类${i + 1}</a>`).join(
        ""
      )}
    </div></body></html>`;
    expect(detectExploreBooks(parseHtml(html), base)).toEqual([]);
  });

  it("坏地址不抛错", () => {
    const html = `<html><body><ul>
      <li><a href="javascript:void(0)">脚本链接</a></li>
      <li><a href="#top">锚点</a></li>
      <li><a href="mailto:a@b.c">邮件</a></li>
      <li><a href="/book/1.html">书一</a></li>
      <li><a href="/book/2.html">书二</a></li>
    </ul></body></html>`;
    expect(detectExploreBooks(parseHtml(html), base).map((b) => b.title)).toEqual([
      "书一",
      "书二",
    ]);
    expect(detectExploreBooks(parseHtml(html), "不是合法地址")).toEqual([]);
  });
});
