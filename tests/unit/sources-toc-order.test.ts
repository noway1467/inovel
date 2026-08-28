import { describe, expect, it } from "vitest";
import { parseHtml } from "~/server/sources/html";
import { detectChapterList } from "~/server/sources/toc-detect";

/**
 * 真实页面形态：详情页先渲染“最新 5 章”，再渲染“正文 1..N 章”。
 * DOM 顺序会变成 15,14,12,11,10,1,2...；用户需要的是源站章节序号顺序。
 */
function detailPage() {
  const latest = [15, 14, 12, 11, 10]
    .map(
      (n) =>
        `<a href="/reader/0/99/70285${n}.html" alt="第${n}章 最新版">第${n}章 最新版</a>`
    )
    .join("");
  const body = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return `<a href="/reader/0/99/36736${80 + i}.html" title="第${n}章 源站标题">第${n}章 源站标题</a>`;
  }).join("");
  return `<html><body><div><div>${latest}</div><div>${body}</div></div></body></html>`;
}

describe("目录探测排序与标题", () => {
  it("最新章节块不会打乱源站章节序号", () => {
    const found = detectChapterList(parseHtml(detailPage()), "https://site.example/info/0/99.html");
    expect(found).toHaveLength(15);
    expect(found.slice(0, 10).map((item) => item.title)).toEqual(
      Array.from({ length: 10 }, (_, i) => `第${i + 1}章 源站标题`)
    );
    expect(found.slice(10).map((item) => item.title)).toEqual([
      "第10章 最新版",
      "第11章 最新版",
      "第12章 最新版",
      "第14章 最新版",
      "第15章 最新版",
    ]);
  });

  it("可见文字缺失时保留 title 属性里的源站标题", () => {
    const html = `<html><body><ul>${Array.from(
      { length: 5 },
      (_, i) =>
        `<li><a href="/read/1/p${i + 1}.html" title="第${i + 1}章 属性标题"></a></li>`
    ).join("")}</ul></body></html>`;
    const found = detectChapterList(parseHtml(html), "https://site.example/read/1/");
    expect(found.map((item) => item.title)).toEqual([
      "第1章 属性标题",
      "第2章 属性标题",
      "第3章 属性标题",
      "第4章 属性标题",
      "第5章 属性标题",
    ]);
  });
});
