import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import { detectContentParagraphs } from "~/server/sources/content-detect";

/**
 * 通用正文探测：不依赖书源规则，从页面结构认出正文容器。
 *
 * 用在两处：
 *  - 正文规则是真 JS 的源（600 个真实书源里 35 个）。原先这类源整源被拒，
 *    尽管它们的搜索与目录规则完好。
 *  - 规则还在但选择器已失配（站点改版后很常见）。与其抛"正文规则未命中"，
 *    不如探一次给出真正文。
 */

/** 够长、带句读的句子 —— 判正文的关键特征 */
const line = (n: number) =>
  `这是第${n}段正文，长度足够并且带着中文标点，萧炎抬起头，望向远处的斗气大陆，心中若有所思。`;

function page(body: string) {
  return parseHtml(`<html><head><title>第一章</title></head><body>${body}</body></html>`);
}

describe("认出正文容器", () => {
  it("典型章节页：正文在 id=content 的 div 里", () => {
    const paragraphs = detectContentParagraphs(
      page(`
        <div class="header"><a href="/">首页</a><a href="/book/1/">目录</a></div>
        <div id="content">
          <p>${line(1)}</p>
          <p>${line(2)}</p>
          <p>${line(3)}</p>
        </div>
        <div class="footer">版权所有</div>
      `)
    );
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toBe(line(1));
  });

  it("<br> 分段的正文也能切出段落", () => {
    const paragraphs = detectContentParagraphs(
      page(`<div class="booktxt">${line(1)}<br/><br/>${line(2)}<br/><br/>${line(3)}</div>`)
    );
    expect(paragraphs).toHaveLength(3);
  });

  it("认不出正文时返回空数组，而不是给出碎片", () => {
    expect(detectContentParagraphs(page(`<div><a href="/">首页</a></div>`))).toEqual([]);
    // 只有简介长度的文字不算正文
    expect(detectContentParagraphs(page(`<div>本书简介，寥寥数语。</div>`))).toEqual([]);
    // 成句但只有一段：详情页的简介就是这个形态，不能当正文交出去
    expect(detectContentParagraphs(page(`<div class="intro">${line(1)}</div>`))).toEqual([]);
  });
});

describe("剔掉正文容器里的杂物", () => {
  it("上一章/目录/下一章链接条不进正文", () => {
    const paragraphs = detectContentParagraphs(
      page(`
        <div id="content">
          <div class="pager"><a href="/c/1.html">上一章</a><a href="/book/1/">目录</a><a href="/c/3.html">下一章</a></div>
          <p>${line(1)}</p>
          <p>${line(2)}</p>
          <p>${line(3)}</p>
        </div>
      `)
    );
    expect(paragraphs.join()).not.toContain("下一章");
    expect(paragraphs).toHaveLength(3);
  });

  it("script/style 内容不进正文", () => {
    const paragraphs = detectContentParagraphs(
      page(`
        <div id="content">
          <script>var chapterId = 123; function load(){ return "这是脚本里的字符串，不该出现在正文里。"; }</script>
          <style>.content { font-size: 18px; color: #333; }</style>
          <p>${line(1)}</p>
          <p>${line(2)}</p>
          <p>${line(3)}</p>
        </div>
      `)
    );
    expect(paragraphs.join()).not.toContain("chapterId");
    expect(paragraphs.join()).not.toContain("font-size");
    expect(paragraphs).toHaveLength(3);
  });

  it("广告位与推荐位不进正文", () => {
    const paragraphs = detectContentParagraphs(
      page(`
        <div id="content">
          <div class="ad-banner">本站推荐：点击这里下载客户端，海量小说免费畅读，速度更快更稳定。</div>
          <p>${line(1)}</p>
          <p>${line(2)}</p>
          <p>${line(3)}</p>
          <div class="recommend"><a href="/book/2/">相关推荐：斗破苍穹前传，同样精彩，不容错过。</a></div>
        </div>
      `)
    );
    expect(paragraphs.join()).not.toContain("下载客户端");
    expect(paragraphs.join()).not.toContain("相关推荐");
  });
});

describe("在正文与目录之间选对", () => {
  /**
   * 章节页侧栏常挂着本书目录。目录链接文字总量可能超过正文，
   * 靠链接密度把它排除 —— 否则整章正文会变成一串章节名。
   */
  it("侧栏目录不会被当成正文", () => {
    const toc = Array.from(
      { length: 40 },
      (_, i) => `<li><a href="/c/${i + 1}.html">第${i + 1}章 这一章的标题也挺长的，凑够字数</a></li>`
    ).join("");
    const paragraphs = detectContentParagraphs(
      page(`
        <div class="sidebar"><ul>${toc}</ul></div>
        <div id="content"><p>${line(1)}</p><p>${line(2)}</p><p>${line(3)}</p></div>
      `)
    );
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs.join()).not.toContain("第1章");
  });

  it("选更贴身的容器，不是把正文包住的外层 div", () => {
    const paragraphs = detectContentParagraphs(
      page(`
        <div class="wrapper">
          <div class="box">
            <div id="chaptercontent">
              <p>${line(1)}</p><p>${line(2)}</p><p>${line(3)}</p>
            </div>
          </div>
        </div>
      `)
    );
    // 外层容器文字总量相同，命名加权让内层胜出；段落数不该因层级而变
    expect(paragraphs).toHaveLength(3);
  });
});

describe("真实站点的形态", () => {
  it("正文里夹的少量站内链接不影响识别", () => {
    const paragraphs = detectContentParagraphs(
      page(`
        <div id="nr1">
          <p>${line(1)}</p>
          <p>${line(2)}（本章完）<a href="/c/3.html">点此继续</a></p>
          <p>${line(3)}</p>
        </div>
      `)
    );
    expect(paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(paragraphs[0]).toBe(line(1));
  });

  it("分页正文的单页也能探出来（一页只有两段）", () => {
    const paragraphs = detectContentParagraphs(
      page(`<div class="showtxt"><p>${line(1)}</p><p>${line(2)}</p></div>`)
    );
    expect(paragraphs).toHaveLength(2);
  });
});
