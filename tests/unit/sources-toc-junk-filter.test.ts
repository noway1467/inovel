import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import { detectChapterList } from "~/server/sources/toc-detect";
import { pickCookiePairs } from "~/server/sources/fetch-guard";

/**
 * 目录探测的垃圾过滤。
 *
 * 真实来源：爱下电子书8（ixdzs8.com）《夜寰》详情页。这个源的目录规则要走
 * POST 接口取 JSON，被判不可翻译后退回页面结构探测 —— 而探测从详情页认出
 * 35 条「章节」，里面混着分类页、作者页、TXT 下载的 .zip、安卓 .apk、
 * iTunes 商店链接，真章节只有 9 条。用户点开全是垃圾内容，且不报错。
 *
 * 原有两道闸都太松：looksLikeChapterUrl 只要求「地址含数字」（/sort/1/、
 * 65688.zip、app_2.5.3.apk、id1358196637 全都含数字），noiseTitles 又是
 * 精确匹配（「立即阅读」「TXT下载」「iPhone」都不在表里）。黑名单补不完，
 * 所以改用结构化判据：真目录里的章节地址共享同一种形状。
 */

/** 复刻 ixdzs8 详情页的链接构成：9 条真章节 + 各类杂链 */
function ixdzsBookPage(): string {
  const chapters = [570, 569, 568, 567, 566, 565, 564, 563]
    .map((n, i) => `<li><a href="/read/65688/p${n}.html">第五百${65 - i}章 测试章节</a></li>`)
    .join("");
  return `<!DOCTYPE html><html><body>
    <nav>
      <a href="/sort/1/">分类</a>
      <a href="/sort/1/">玄幻奇幻</a>
      <a href="/author/%E5%AE%88%E7%9D%80%E7%8C%AB">守着猫睡觉的鱼</a>
    </nav>
    <div class="downbox">
      <a href="https://down7.ixdzs8.com/65688.zip">TXT下载</a>
      <a href="/ixdzs_app_2.5.3.apk">Android(ver:2.5.3)</a>
      <a href="https://itunes.apple.com/us/app/id1358196637">iPhone</a>
    </div>
    <div class="recommend">
      <a href="/read/302248/">本仙在此</a>
      <a href="/read/171226/">道吟</a>
      <a href="/read/22494/">鸣道</a>
      <a href="/read/500146/">鸿蒙霸体诀</a>
      <a href="/read/552366/">吞天混沌经</a>
      <a href="/read/569262/">家族修仙</a>
      <a href="/read/438178/">九天斩神诀</a>
      <a href="/read/645356/">九叔</a>
      <a href="/read/305385/">盖世神医</a>
      <a href="/read/555457/">混沌塔</a>
      <a href="/read/560076/">我都快成仙帝了</a>
    </div>
    <ul class="chapters">
      <li><a href="/read/65688/p1.html">立即阅读</a></li>
      ${chapters}
    </ul>
  </body></html>`;
}

const bookUrl = "https://ixdzs8.com/read/65688/";

describe("detectChapterList 垃圾过滤", () => {
  const found = detectChapterList(parseHtml(ixdzsBookPage()), bookUrl);

  it("只留下真章节，杂链全部剔除", () => {
    // 改动前这里是 35 条
    expect(found.length).toBeLessThanOrEqual(10);
    expect(found.length).toBeGreaterThanOrEqual(8);
    for (const item of found) {
      expect(item.url).toMatch(/\/read\/65688\/p\d+\.html$/);
    }
  });

  it("下载包与安装包不算章节", () => {
    const urls = found.map((item) => item.url).join(" ");
    expect(urls).not.toContain(".zip");
    expect(urls).not.toContain(".apk");
  });

  it("跨站链接不算章节", () => {
    expect(found.every((item) => item.url.startsWith("https://ixdzs8.com/"))).toBe(true);
  });

  it("分类页、作者页不算章节", () => {
    const urls = found.map((item) => item.url).join(" ");
    expect(urls).not.toContain("/sort/");
    expect(urls).not.toContain("/author/");
  });

  it("推荐书区块不算章节 —— 它比真章节还多，光比数量会选错", () => {
    // 推荐书 11 条 vs 真章节 9 条：必须靠「在当前书路径下」这个信号胜出
    const urls = found.map((item) => item.url);
    expect(urls.some((url) => url.includes("/read/302248/"))).toBe(false);
    expect(urls.some((url) => url.includes("/read/171226/"))).toBe(false);
  });

  it("少于 5 个链接的容器本来就不算目录（既有门槛，形状过滤不参与）", () => {
    const sparse = parseHtml(`<html><body><ul>
      <li><a href="/read/1/p1.html">第一章</a></li>
      <li><a href="/read/1/p2.html">第二章</a></li>
    </ul></body></html>`);
    expect(detectChapterList(sparse, "https://ixdzs8.com/read/1/")).toEqual([]);
  });

  it("刚够 5 章的目录不被形状过滤裁掉", () => {
    const five = parseHtml(
      `<html><body><ul>${Array.from(
        { length: 5 },
        (_, i) => `<li><a href="/read/1/p${i + 1}.html">第${i + 1}章</a></li>`
      ).join("")}</ul></body></html>`
    );
    expect(detectChapterList(five, "https://ixdzs8.com/read/1/").length).toBe(5);
  });

  it("规整的纯目录页不受影响", () => {
    const clean = parseHtml(
      `<html><body><ul>${Array.from(
        { length: 20 },
        (_, i) => `<li><a href="/read/9/p${i + 1}.html">第${i + 1}章</a></li>`
      ).join("")}</ul></body></html>`
    );
    expect(detectChapterList(clean, "https://ixdzs8.com/read/9/").length).toBe(20);
  });
});

/**
 * 浏览器验证挑战需要把 cookie 带回去 —— 只带 challenge token 不带 cookie
 * 会被 302 回挑战页，服务端靠 session 认这次挑战。
 */
describe("pickCookiePairs", () => {
  it("只取键值，丢掉属性", () => {
    expect(pickCookiePairs("PHPSESSID=abc123; Path=/; HttpOnly")).toBe("PHPSESSID=abc123");
  });

  it("多条 cookie 拼起来", () => {
    // ixdzs8 实际返回的形态
    const raw = "PHPSESSID=mfkmt9uu; path=/, record-65688=1; path=/; Max-Age=3600";
    expect(pickCookiePairs(raw)).toBe("PHPSESSID=mfkmt9uu; record-65688=1");
  });

  it("Expires 里的逗号不会被误切", () => {
    const raw = "a=1; Expires=Wed, 21 Oct 2025 07:28:00 GMT; Path=/, b=2; Path=/";
    expect(pickCookiePairs(raw)).toBe("a=1; b=2");
  });

  it("没有 cookie 时返回 null", () => {
    expect(pickCookiePairs(null)).toBeNull();
    expect(pickCookiePairs("")).toBeNull();
    expect(pickCookiePairs("Path=/; HttpOnly")).toBeNull();
  });
});
