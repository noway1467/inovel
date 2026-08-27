import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildExploreUrl,
  categoryNeedsJs,
  parseExploreCategories,
  usableCategories,
} from "~/server/sources/explore";

/**
 * 发现页分类解析。
 *
 * 真实来源：yckceo 清单 1213（50 源，47 个带 ruleFindUrl）。两种格式都存在，
 * 页码写法有三种，其中带三元表达式的那种真需 JS 引擎。
 */

describe("parseExploreCategories", () => {
  it("认 JSON 数组格式", () => {
    // 独步小说的真实写法
    const raw = JSON.stringify([
      { title: "玄幻奇幻", url: "/nav/xh-qh-{{page}}.html", style: { layout_flexGrow: 1 } },
      { title: "科幻游戏", url: "/nav/kh-yx-{{page}}.html" },
    ]);
    expect(parseExploreCategories(raw)).toEqual([
      { title: "玄幻奇幻", urlTemplate: "/nav/xh-qh-{{page}}.html" },
      { title: "科幻游戏", urlTemplate: "/nav/kh-yx-{{page}}.html" },
    ]);
  });

  it("认 `名称:: 地址` 换行格式", () => {
    // 全本同人的真实写法
    const raw = "火影:: /tag/{{page-1}}_huoying\n系统:: /tag/{{page-1}}_xitong";
    expect(parseExploreCategories(raw)).toEqual([
      { title: "火影", urlTemplate: "/tag/{{page-1}}_huoying" },
      { title: "系统", urlTemplate: "/tag/{{page-1}}_xitong" },
    ]);
  });

  it("坏数据返回空数组而不是抛错", () => {
    expect(parseExploreCategories("[不是合法 JSON")).toEqual([]);
    expect(parseExploreCategories("")).toEqual([]);
    expect(parseExploreCategories(null)).toEqual([]);
    expect(parseExploreCategories(undefined)).toEqual([]);
    expect(parseExploreCategories(123)).toEqual([]);
    // 没有 :: 分隔符的行直接丢掉
    expect(parseExploreCategories("只有一行没有分隔符")).toEqual([]);
  });

  it("标题或地址缺一个就丢掉", () => {
    expect(parseExploreCategories(JSON.stringify([{ title: "有名无址" }]))).toEqual([]);
    expect(parseExploreCategories(JSON.stringify([{ url: "/有址无名" }]))).toEqual([]);
    expect(parseExploreCategories(":: /空标题")).toEqual([]);
  });
});

describe("categoryNeedsJs", () => {
  it("纯 page 算术不需要 JS", () => {
    expect(categoryNeedsJs("/nav/x-{{page}}.html")).toBe(false);
    expect(categoryNeedsJs("/tag/{{page-1}}_huoying")).toBe(false);
    expect(categoryNeedsJs("/tag/{{page + 2}}")).toBe(false);
    expect(categoryNeedsJs("/纯地址不带占位")).toBe(false);
  });

  it("三元表达式、字符串拼接要真 JS 引擎", () => {
    // 全本同人小说网的真实写法
    expect(categoryNeedsJs("https://qbtr.cc/changgui/index{{page - 1 == 0 ? '': '_'+page}}.html")).toBe(
      true
    );
    expect(categoryNeedsJs("@js:var x=1")).toBe(true);
    expect(categoryNeedsJs("/x/<js>foo()</js>")).toBe(true);
    expect(categoryNeedsJs("/x/{{java.get('k')}}")).toBe(true);
  });
});

describe("buildExploreUrl", () => {
  it("替换 {{page}}", () => {
    expect(buildExploreUrl("/nav/xh-qh-{{page}}.html", 1)).toBe("/nav/xh-qh-1.html");
    expect(buildExploreUrl("/nav/xh-qh-{{page}}.html", 7)).toBe("/nav/xh-qh-7.html");
  });

  it("算 {{page-1}} / {{page+1}}", () => {
    expect(buildExploreUrl("/tag/{{page-1}}_huoying", 1)).toBe("/tag/0_huoying");
    expect(buildExploreUrl("/tag/{{page-1}}_huoying", 3)).toBe("/tag/2_huoying");
    expect(buildExploreUrl("/p/{{page+1}}", 1)).toBe("/p/2");
  });

  it("处理 <首页,后续页> 写法", () => {
    // 同人小说的真实写法：第 1 页就是 /hot/，之后才加 index_N.html
    const template = "/hot/<,index_{{page}}.html>";
    expect(buildExploreUrl(template, 1)).toBe("/hot/");
    expect(buildExploreUrl(template, 2)).toBe("/hot/index_2.html");

    const both = "/list/<first.html,page_{{page}}.html>";
    expect(buildExploreUrl(both, 1)).toBe("/list/first.html");
    expect(buildExploreUrl(both, 4)).toBe("/list/page_4.html");
  });

  it("认不出的占位原样留着，不乱算", () => {
    expect(buildExploreUrl("/x/{{unknown}}", 2)).toBe("/x/{{unknown}}");
  });

  it("默认第 1 页", () => {
    expect(buildExploreUrl("/nav/{{page}}.html")).toBe("/nav/1.html");
  });
});

describe("真实清单里的分类", () => {
  const sources = JSON.parse(
    readFileSync("tests/fixtures/legado-flat-sources.json", "utf8")
  ) as Record<string, unknown>[];

  it("大部分带发现页规则的源都能解出可用分类", () => {
    const withFind = sources.filter((s) => typeof s.ruleFindUrl === "string" && s.ruleFindUrl);
    expect(withFind.length).toBeGreaterThanOrEqual(40);

    const withUsable = withFind.filter((s) => usableCategories(s.ruleFindUrl).length > 0);
    // 少数是三元表达式那种，跳过是对的；大头必须能用
    expect(withUsable.length).toBeGreaterThanOrEqual(30);
  });

  it("解出来的分类地址都能套出第 2 页", () => {
    for (const source of sources) {
      for (const category of usableCategories(source.ruleFindUrl)) {
        const built = buildExploreUrl(category.urlTemplate, 2);
        // 套完不该再留 {{}} 占位
        expect(built).not.toMatch(/\{\{/);
      }
    }
  });
});
