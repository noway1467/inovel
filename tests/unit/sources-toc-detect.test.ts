import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import {
  detectChapterList,
  detectObfuscatedChapters,
  detectTocPageUrl,
} from "~/server/sources/toc-detect";

/**
 * 通用目录探测：不依赖书源规则，从页面结构认出章节列表。
 *
 * 这是规则失效时的兜底。上一版兜底是「把页面正文按字数切章」，
 * 但目录页上没有正文，切出来的是简介碎片，产出一堆点开就报错的假章节。
 * 探测真实目录得到的是带真实地址的章节，正文照常能回源。
 */

const base = "https://novels.example.org/book/1";

function chapterLinks(count: number, prefix = "第") {
  return Array.from(
    { length: count },
    (_, i) => `<dd><a href="/c/${i + 1}.html">${prefix}${i + 1}章 标题${i + 1}</a></dd>`
  ).join("");
}

describe("detectChapterList", () => {
  it("从典型目录页认出章节列表", () => {
    const html = `<html><body>
      <div class="nav"><a href="/">首页</a><a href="/rank">排行</a></div>
      <div class="listmain"><dl>${chapterLinks(12)}</dl></div>
    </body></html>`;

    const chapters = detectChapterList(parseHtml(html), base);
    expect(chapters).toHaveLength(12);
    expect(chapters[0]?.title).toContain("第1章");
    // 相对地址补全成绝对地址，正文才能回源
    expect(chapters[0]?.url).toBe("https://novels.example.org/c/1.html");
  });

  it("避开导航栏，选中真正的目录容器", () => {
    const html = `<html><body>
      <nav><a href="/p1">首页</a><a href="/p2">书架</a><a href="/p3">登录</a>
        <a href="/p4">注册</a><a href="/p5">搜索</a><a href="/p6">分类</a></nav>
      <ul id="chapters">${chapterLinks(20)}</ul>
    </body></html>`;

    const chapters = detectChapterList(parseHtml(html), base);
    expect(chapters).toHaveLength(20);
    // 导航项不该出现在结果里
    expect(chapters.some((c) => c.title === "首页")).toBe(false);
    expect(chapters.some((c) => c.title === "登录")).toBe(false);
  });

  it("链接太少时不误判", () => {
    const html = `<html><body>
      <div><a href="/c/1.html">第1章</a><a href="/c/2.html">第2章</a></div>
    </body></html>`;
    expect(detectChapterList(parseHtml(html), base)).toEqual([]);
  });

  it("纯导航页面返回空，不硬凑结果", () => {
    const html = `<html><body>
      <div><a href="/a1">首页</a><a href="/a2">书架</a><a href="/a3">登录</a>
        <a href="/a4">注册</a><a href="/a5">搜索</a><a href="/a6">分类</a>
        <a href="/a7">排行</a><a href="/a8">下载</a></div>
    </body></html>`;
    expect(detectChapterList(parseHtml(html), base)).toEqual([]);
  });

  it("识别序章/楔子/番外这类非数字标题", () => {
    const html = `<html><body><div class="list">
      <a href="/c/0.html">楔子</a>
      <a href="/c/1.html">序章 开端</a>
      ${chapterLinks(8)}
      <a href="/c/99.html">番外 后来</a>
    </div></body></html>`;

    const chapters = detectChapterList(parseHtml(html), base);
    const titles = chapters.map((c) => c.title);
    expect(titles).toContain("楔子");
    expect(titles).toContain("番外 后来");
  });

  it("识别「1、标题」这类编号形态", () => {
    const items = Array.from(
      { length: 10 },
      (_, i) => `<li><a href="/c/${i}.html">${i + 1}、章节标题${i + 1}</a></li>`
    ).join("");
    const chapters = detectChapterList(parseHtml(`<ul>${items}</ul>`), base);
    expect(chapters).toHaveLength(10);
  });

  it("识别英文 Chapter N", () => {
    const items = Array.from(
      { length: 8 },
      (_, i) => `<li><a href="/c/${i}.html">Chapter ${i + 1}</a></li>`
    ).join("");
    const chapters = detectChapterList(parseHtml(`<ul>${items}</ul>`), base);
    expect(chapters).toHaveLength(8);
  });

  it("按地址去重：目录页常有「最新章节」重复块", () => {
    const html = `<html><body>
      <div class="latest">
        <a href="/c/10.html">第10章 最新</a><a href="/c/9.html">第9章</a>
        <a href="/c/8.html">第8章</a><a href="/c/7.html">第7章</a>
        <a href="/c/6.html">第6章</a>
      </div>
      <div class="listmain">${chapterLinks(10)}
        <a href="/c/10.html">第10章 最新</a>
      </div>
    </body></html>`;

    const chapters = detectChapterList(parseHtml(html), base);
    const urls = chapters.map((c) => c.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("跳过锚点与 javascript 链接", () => {
    const html = `<html><body><div class="list">
      <a href="#top">回到顶部</a>
      <a href="javascript:void(0)">展开</a>
      ${chapterLinks(10)}
    </div></body></html>`;
    const chapters = detectChapterList(parseHtml(html), base);
    expect(chapters.every((c) => !c.url.includes("#top"))).toBe(true);
    expect(chapters.every((c) => !c.url.includes("javascript"))).toBe(true);
  });

  it("章节地址必须带数字，纯文字导航链接被排除", () => {
    const html = `<html><body><div class="list">
      ${chapterLinks(10)}
      <a href="/about">关于本站</a>
      <a href="/contact">联系我们</a>
    </div></body></html>`;
    const chapters = detectChapterList(parseHtml(html), base);
    expect(chapters.some((c) => c.url.includes("/about"))).toBe(false);
  });

  it("空页面与畸形 HTML 返回空数组，不抛错", () => {
    expect(detectChapterList(parseHtml(""), base)).toEqual([]);
    expect(detectChapterList(parseHtml("<div><a href=/c/1>未闭合"), base)).toEqual([]);
  });

  it("探测出的章节都有真实可访问地址（与切正文兜底的关键区别）", () => {
    const html = `<div class="listmain">${chapterLinks(10)}</div>`;
    const chapters = detectChapterList(parseHtml(html), base);
    for (const chapter of chapters) {
      expect(chapter.url).toMatch(/^https?:\/\//);
    }
  });
});

/**
 * 地址被混淆的目录。
 *
 * 有一类聚合站刻意不让爬：每个 <a href> 都指向书籍首页（诱饵），真地址
 * base64 编码后塞在随机命名的 data-* 里，章节名也在 data-* 里，DOM 顺序
 * 打乱、真顺序由另一个数字 data-* 给出。普通探测在这种页面上会因为所有
 * href 相同而去重成一章。
 */
describe("detectObfuscatedChapters", () => {
  const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

  /** 打乱 DOM 顺序，真顺序放在第二个数字 data-* 里 */
  function obfuscatedToc(count: number) {
    const rows = Array.from({ length: count }, (_, i) => {
      const path = `/book/9527/${100000 + i}.html`;
      return {
        domIndex: i,
        order: count - i, // 与 DOM 序相反，用来验证真的按 order 排
        html:
          `<li class="chapter-row" data-id="${i}" data-x9f2="${count - i}">` +
          `<a href="/book/9527/" class="g" data-t7b1="${i + 1} 备用名" ` +
          `data-u4ac="${b64(path)}">章节 ${String(i + 1).padStart(2, "0")}</a></li>`,
        path,
      };
    });
    return {
      html: `<html><body><ul class="toc">${rows.map((r) => r.html).join("")}</ul></body></html>`,
      rows,
    };
  }

  it("从 base64 的 data-* 里解出真实章节地址", () => {
    const { rows } = obfuscatedToc(10);
    const chapters = detectObfuscatedChapters(parseHtml(obfuscatedToc(10).html), base);
    expect(chapters).toHaveLength(10);
    // href 是诱饵（全指向书籍首页），结果里不能出现它
    for (const chapter of chapters) {
      expect(chapter.url).not.toBe("https://novels.example.org/book/9527/");
      expect(chapter.url).toMatch(/^https:\/\/novels\.example\.org\/book\/9527\/\d+\.html$/);
    }
    // 真顺序由数字 data-* 给出，与 DOM 顺序相反
    expect(chapters[0]?.url).toContain(rows[rows.length - 1]!.path);
  });

  /**
   * 章节名同样要取 data-*，不能用可见文字。
   *
   * 这类页面的可见文字按 DOM 顺序写死（「章节 01」「章节 02」…），而 DOM
   * 顺序是打乱的 —— 排在首位那条写着「章节 01」，真实序号却是最后一个。
   * 用可见文字，读者看到的编号会与阅读顺序互相矛盾。
   */
  it("章节名取 data-* 里的真名字，不用按 DOM 顺序写死的可见文字", () => {
    const chapters = detectObfuscatedChapters(parseHtml(obfuscatedToc(8).html), base);
    expect(chapters[0]?.title).toContain("备用名");
    expect(chapters[0]?.title).not.toMatch(/^章节 /);
  });

  it("没有可用 data-* 名字时退回节点文本", () => {
    const rows = Array.from(
      { length: 6 },
      (_, i) => `<li><a data-u="${b64(`/book/1/${i + 10}.html`)}">第${i + 1}章 标题</a></li>`
    ).join("");
    const chapters = detectObfuscatedChapters(parseHtml(`<ul>${rows}</ul>`), base);
    expect(chapters).toHaveLength(6);
    expect(chapters[0]?.title).toBe("第1章 标题");
  });

  it("普通目录页不会被误判（没有 base64 data-* 就不出结果）", () => {
    const html = `<div class="listmain"><dl>${chapterLinks(12)}</dl></div>`;
    expect(detectObfuscatedChapters(parseHtml(html), base)).toEqual([]);
  });

  it("行数太少不算目录，避免把零星装饰节点当章节", () => {
    const html = `<ul><li><a data-u="${b64("/book/1/2.html")}">仅一条</a></li></ul>`;
    expect(detectObfuscatedChapters(parseHtml(html), base)).toEqual([]);
  });

  it("解不开或解出来不像地址的 base64 不采纳", () => {
    // 合法 base64 但解出来是普通文字，不是路径
    const rows = Array.from(
      { length: 8 },
      () => `<li><a data-u="${b64("just some text here")}">x</a></li>`
    ).join("");
    expect(detectObfuscatedChapters(parseHtml(`<ul>${rows}</ul>`), base)).toEqual([]);
  });

  it("空页面与畸形 HTML 返回空数组，不抛错", () => {
    expect(detectObfuscatedChapters(parseHtml(""), base)).toEqual([]);
    expect(detectObfuscatedChapters(parseHtml("<li><a data-u=abc"), base)).toEqual([]);
  });
});

/**
 * 详情页 → 目录页那一跳。
 *
 * 需要它的场景：infoTocUrl 规则要 JS 求值而被降级丢掉。详情页上没有章节
 * 列表，不跳这一步探测器只会在详情页空转。聚合站还把目录地址放在
 * data-cata 这类属性里而不是 href。
 */
describe("detectTocPageUrl", () => {
  it("从 data-cata 属性里取目录地址，并解开 ?u= 包装", () => {
    const inner = "https://mirror.example.com/book/8899/catalog/";
    const html =
      `<html><body><li class="site">` +
      `<a href="/redirect/309/1/?u=${encodeURIComponent("https://mirror.example.com/book/8899/")}">书名</a>` +
      `<a href="/redirect/309/1/" data-cata="/redirect/309/1/?u=${encodeURIComponent(inner)}">来源站</a>` +
      `</li></body></html>`;
    expect(detectTocPageUrl(parseHtml(html), base)).toBe(inner);
  });

  it("退而认「目录」「查看更多」这类链接文字", () => {
    const html = `<html><body><a href="/book/1/list.html">查看更多</a></body></html>`;
    expect(detectTocPageUrl(parseHtml(html), base)).toBe(
      "https://novels.example.org/book/1/list.html"
    );
  });

  it("没有目录线索时返回 null，不乱猜", () => {
    const html = `<html><body><a href="/">首页</a><a href="/rank">排行</a></body></html>`;
    expect(detectTocPageUrl(parseHtml(html), base)).toBeNull();
  });

  it("指向自身的候选不采纳，避免原地打转", () => {
    const html = `<html><body><a href="${base}">目录</a></body></html>`;
    expect(detectTocPageUrl(parseHtml(html), base)).toBeNull();
  });
});

/**
 * 探测成本必须与「文字量 × 深度」成正比，不能与深度成平方。
 *
 * 起因是线上报 1102（Worker 超出 CPU 限额）：探测要给每个元素打分，而打分
 * 要知道该元素子树的文字长度和链接数。递归现算的话，深度 d 处的文字会被
 * 它的 d 个祖先各算一遍，还各做一次空白压缩。实测嵌套 8 层、1900 章的
 * 目录页要 3476ms，而 maxTocPages 是 30 —— 一本书冷启动就能烧掉几十秒 CPU。
 *
 * 预计算每个节点的统计之后同一页 273ms。这里的阈值取得很宽（只要没退回
 * 平方就必然通过），够挡住回退，又不会因为跑测试的机器忙而误报。
 */
describe("探测成本不随嵌套深度爆炸", () => {
  function nestedToc(chapters: number, depth: number) {
    const items = Array.from(
      { length: chapters },
      (_, i) =>
        `<li><span class="num">${i + 1}</span><a href="/read/9/p${i + 1}.html">第${
          i + 1
        }章 这是一个中等长度的章节标题</a></li>`
    ).join("");
    let inner = `<div class="listmain"><ul>${items}</ul></div>`;
    for (let d = 0; d < depth; d += 1) {
      inner = `<div class="wrap l${d}"><div class="inner"><section>${inner}</section></div></div>`;
    }
    return `<html><body><div class="nav"><a href="/">首页</a></div>${inner}</body></html>`;
  }

  it("嵌套 8 层、1900 章的目录页在 1.5 秒内探完且结果正确", () => {
    const doc = parseHtml(nestedToc(1900, 8));
    const started = Date.now();
    const chapters = detectChapterList(doc, "https://novels.example.org/read/9/");
    const elapsed = Date.now() - started;

    expect(chapters).toHaveLength(1900);
    expect(chapters[0]?.title).toContain("第1章");
    expect(chapters.at(-1)?.title).toContain("第1900章");
    expect(elapsed).toBeLessThan(1500);
  });

  it("加深嵌套不改变探测结果", () => {
    const shallow = detectChapterList(parseHtml(nestedToc(60, 1)), base);
    const deep = detectChapterList(parseHtml(nestedToc(60, 9)), base);
    expect(deep.map((item) => item.title)).toEqual(shallow.map((item) => item.title));
  });
});
