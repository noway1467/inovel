import { describe, expect, it } from "vitest";
import { innerHtml, parseHtml, queryAll, queryFirst } from "~/server/sources/html";
import { textOf } from "~/server/sources/xml";

describe("parseHtml 容错", () => {
  it("空元素不吞后续兄弟节点", () => {
    const root = parseHtml(`<div><img src="a.jpg"><span>后面</span></div>`);
    const div = queryFirst(root, "div")!;
    expect(div.children.filter((c) => c.name !== "#text").map((c) => c.name)).toEqual(["img", "span"]);
    expect(textOf(queryFirst(root, "span"))).toBe("后面");
  });

  it("li 隐式闭合，不会层层嵌套", () => {
    const root = parseHtml(`<ul><li>甲<li>乙<li>丙</ul>`);
    const items = queryAll(root, "ul li");
    expect(items).toHaveLength(3);
    expect(items.map((li) => textOf(li))).toEqual(["甲", "乙", "丙"]);
  });

  it("script 内的尖括号不被当标签", () => {
    const root = parseHtml(`<div><script>var a = 1 < 2; var s = "<div>";</script><p>正文</p></div>`);
    expect(queryAll(root, "div p")).toHaveLength(1);
    expect(textOf(queryFirst(root, "p"))).toBe("正文");
  });

  it("无引号属性与布尔属性都能解析", () => {
    const root = parseHtml(`<a href=/c/1 target=_blank download>链接</a>`);
    const a = queryFirst(root, "a")!;
    expect(a.attrs.href).toBe("/c/1");
    expect(a.attrs.target).toBe("_blank");
    expect(a.attrs.download).toBe("");
  });

  it("大小写混写的标签统一成小写", () => {
    const root = parseHtml(`<DIV><A HREF="/x">链</A></DIV>`);
    expect(queryFirst(root, "div a")?.attrs.href).toBe("/x");
  });

  it("未闭合标签不会丢内容", () => {
    const root = parseHtml(`<div><p>没闭合的段落<div>另一个</div>`);
    expect(textOf(root)).toContain("没闭合的段落");
    expect(textOf(root)).toContain("另一个");
  });
});

describe("queryAll CSS 子集", () => {
  const html = `
    <div id="list" class="box main">
      <ul class="chapters">
        <li class="item"><a href="/c/1">第一章</a></li>
        <li class="item hot"><a href="/c/2">第二章</a></li>
        <li class="item"><a href="/c/3">第三章</a></li>
      </ul>
      <ul class="other"><li><a href="/x">干扰</a></li></ul>
    </div>`;
  const root = parseHtml(html);

  it("按 id 与 class 选择", () => {
    expect(queryFirst(root, "#list")?.attrs.id).toBe("list");
    expect(queryAll(root, ".chapters")).toHaveLength(1);
  });

  it("多 class 需全部命中", () => {
    expect(queryAll(root, ".item.hot")).toHaveLength(1);
    expect(queryAll(root, ".box.main")).toHaveLength(1);
    expect(queryAll(root, ".box.missing")).toHaveLength(0);
  });

  it("后代与直接子组合子语义不同", () => {
    expect(queryAll(root, ".chapters a")).toHaveLength(3);
    expect(queryAll(root, ".chapters > a")).toHaveLength(0);
    expect(queryAll(root, ".chapters > li")).toHaveLength(3);
  });

  it("不带空格的 > 也能解析", () => {
    expect(queryAll(root, "ul.chapters>li")).toHaveLength(3);
  });

  it("属性选择器支持存在与各种匹配", () => {
    expect(queryAll(root, "a[href]")).toHaveLength(4);
    expect(queryAll(root, 'a[href="/c/2"]')).toHaveLength(1);
    expect(queryAll(root, 'a[href^="/c/"]')).toHaveLength(3);
    expect(queryAll(root, 'a[href$="/3"]')).toHaveLength(1);
    expect(queryAll(root, 'a[href*="c/"]')).toHaveLength(3);
  });

  it(":eq / :first / :last 定位", () => {
    expect(textOf(queryFirst(root, ".chapters li:eq(1) a"))).toBe("第二章");
    expect(textOf(queryFirst(root, ".chapters li:first a"))).toBe("第一章");
    expect(textOf(queryFirst(root, ".chapters li:last a"))).toBe("第三章");
    expect(textOf(queryFirst(root, ".chapters li:eq(-1) a"))).toBe("第三章");
  });

  it("逗号分组去重合并", () => {
    const nodes = queryAll(root, ".item.hot a, .chapters li:first a");
    expect(nodes).toHaveLength(2);
  });

  it("选不中时返回空数组而不是抛错", () => {
    expect(queryAll(root, ".nope .nothing")).toEqual([]);
    expect(queryFirst(root, "#missing")).toBeNull();
  });

  it("提取目录：标题与链接成对取出", () => {
    const links = queryAll(root, ".chapters li a");
    expect(links.map((a) => ({ title: textOf(a), href: a.attrs.href }))).toEqual([
      { title: "第一章", href: "/c/1" },
      { title: "第二章", href: "/c/2" },
      { title: "第三章", href: "/c/3" },
    ]);
  });
});

describe("分页与序号相关的选择器", () => {
  const html = `<div class="page">
    <a href="/p1">上一页</a><a href="/p2">下一页</a>
    <select>
      <option value="v0">第1页</option>
      <option value="v1">第2页</option>
      <option value="v2">第3页</option>
    </select>
    <ul id="cl"><p><a href="/x0">x0</a></p><p><a href="/x1">x1</a></p><p><a href="/x2">x2</a></p><p><a href="/x3">x3</a></p></ul>
  </div>`;
  const root = parseHtml(html);

  it(":contains 按文本定位（分页链接最常见形态）", () => {
    const next = queryFirst(root, "a:contains(下一页)");
    expect(next?.attrs.href).toBe("/p2");
    expect(queryFirst(root, "a:contains(上一页)")?.attrs.href).toBe("/p1");
  });

  it(":contains 选不中时返回空，不误命中", () => {
    expect(queryAll(root, "a:contains(没有这个词)")).toEqual([]);
  });

  it(":gt / :lt 裁剪命中集", () => {
    expect(queryAll(root, "#cl > p:gt(1)")).toHaveLength(2);
    expect(queryAll(root, "#cl > p:lt(2)")).toHaveLength(2);
  });

  it("[from:to] 区间，负数从后计", () => {
    const picked = queryAll(root, "#cl p[1:-2] a");
    expect(picked.map((a) => a.attrs.href)).toEqual(["/x1", "/x2"]);
  });

  it("+ 紧邻兄弟", () => {
    expect(queryFirst(root, "option[value=v0]+option")?.attrs.value).toBe("v1");
    expect(queryFirst(root, "option[value=v2]+option")).toBeNull();
  });
});

describe("innerHtml", () => {
  it("保留子元素结构与空元素形态", () => {
    const root = parseHtml(`<div><p>甲</p><br><span class="s">乙</span></div>`);
    const html = innerHtml(queryFirst(root, "div")!);
    expect(html).toBe(`<p>甲</p><br><span class="s">乙</span>`);
  });
});
