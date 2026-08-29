import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildExploreUrl,
  categoryNeedsJs,
  findCategory,
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
    expect(parseExploreCategories(raw)).toMatchObject([
      { title: "玄幻奇幻", urlTemplate: "/nav/xh-qh-{{page}}.html", group: "" },
      { title: "科幻游戏", urlTemplate: "/nav/kh-yx-{{page}}.html", group: "" },
    ]);
  });

  it("认 `名称:: 地址` 换行格式", () => {
    // 全本同人的真实写法
    const raw = "火影:: /tag/{{page-1}}_huoying\n系统:: /tag/{{page-1}}_xitong";
    expect(parseExploreCategories(raw)).toMatchObject([
      { title: "火影", urlTemplate: "/tag/{{page-1}}_huoying", group: "" },
      { title: "系统", urlTemplate: "/tag/{{page-1}}_xitong", group: "" },
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

/**
 * 分组。这是「标签看起来重复」的根源：
 * 海棠书屋的「🌹排行🌹」和「🌹分类🌹」两组下挂着同样的 24 个名字，
 * 地址完全不同。丢掉小标题平铺出来，就是 48 个标签、每个名字出现两次。
 */
describe("分组小标题", () => {
  it("JSON 里 flexBasisPercent>=1 的行是小标题，给后面的分类当分组", () => {
    // 海棠书屋的真实结构
    const raw = JSON.stringify([
      { title: "🌹排行🌹", url: "", style: { layout_flexGrow: 1, layout_flexBasisPercent: 1 } },
      { title: "言情", url: "/top/yq-{{page}}.html", style: { layout_flexBasisPercent: 0.25 } },
      { title: "🌹分类🌹", url: "", style: { layout_flexGrow: 1, layout_flexBasisPercent: 1 } },
      { title: "言情", url: "/list/yq-{{page}}.html", style: { layout_flexBasisPercent: 0.25 } },
    ]);
    const parsed = parseExploreCategories(raw);
    expect(parsed).toMatchObject([
      { title: "言情", group: "🌹排行🌹", urlTemplate: "/top/yq-{{page}}.html" },
      { title: "言情", group: "🌹分类🌹", urlTemplate: "/list/yq-{{page}}.html" },
    ]);
    // 同名但分属两组，id 必须不同 —— 否则点第二个还是打开第一个
    expect(parsed[0]!.id).not.toBe(parsed[1]!.id);
  });

  it("`标题::` 后面为空也是小标题", () => {
    // 鬼故事集的真实写法：标题两侧填了大量空格，`::` 在但地址为空
    const raw = "        最新        ::\n恐怖:: /kb/{{page}}.html\n悬疑:: /xy/{{page}}.html";
    expect(parseExploreCategories(raw)).toMatchObject([
      { title: "恐怖", group: "最新" },
      { title: "悬疑", group: "最新" },
    ]);
  });

  it("小标题自身带地址时，它既是分组名也是一个分类", () => {
    // 700txt 的真实写法：`分类•全部` 既是小标题又指向 /fenlei/
    const raw = JSON.stringify([
      { title: "分类•全部", url: "/fenlei/{{page}}", style: { layout_flexBasisPercent: 1 } },
      { title: "玄幻", url: "/fenlei/1/{{page}}", style: { layout_flexBasisPercent: 0.25 } },
    ]);
    expect(parseExploreCategories(raw)).toMatchObject([
      { title: "分类•全部", group: "分类•全部", urlTemplate: "/fenlei/{{page}}" },
      { title: "玄幻", group: "分类•全部", urlTemplate: "/fenlei/1/{{page}}" },
    ]);
  });

  it("同组同名同址是真冗余，去掉重复的", () => {
    const raw = "玄幻:: /x/{{page}}\n玄幻:: /x/{{page}}";
    expect(parseExploreCategories(raw)).toHaveLength(1);
  });

  it("同名但地址不同的加序号，不能删 —— 那是两个真分类", () => {
    // 精武小说的真实写法：玄幻小说既在 /fenlei/1/ 又在 /fenlei/18/
    const raw = "玄幻小说:: /fenlei/1/{{page}}/\n玄幻小说:: /fenlei/18/{{page}}/";
    const parsed = parseExploreCategories(raw);
    expect(parsed.map((item) => item.title)).toEqual(["玄幻小说", "玄幻小说 2"]);
    expect(parsed[0]!.id).not.toBe(parsed[1]!.id);
  });

  it("id 只跟内容有关，与顺序无关 —— 书源更新后收藏的链接仍然指向同一个分类", () => {
    const first = parseExploreCategories("甲:: /a/{{page}}\n乙:: /b/{{page}}");
    // 源里新插了一个分类，乙的位置后移
    const second = parseExploreCategories("甲:: /a/{{page}}\n丙:: /c/{{page}}\n乙:: /b/{{page}}");
    const yiBefore = first.find((item) => item.title === "乙")!;
    const yiAfter = second.find((item) => item.title === "乙")!;
    expect(yiAfter.id).toBe(yiBefore.id);
  });
});

describe("findCategory", () => {
  const categories = parseExploreCategories("甲:: /a/{{page}}\n乙:: /b/{{page}}");

  it("按 id 找", () => {
    expect(findCategory(categories, categories[1]!.id)?.title).toBe("乙");
  });

  it("按标题找 —— 兼容改版前发出去的链接", () => {
    expect(findCategory(categories, "乙")?.title).toBe("乙");
  });

  it("没给引用时取第一个", () => {
    expect(findCategory(categories, null)?.title).toBe("甲");
  });

  it("找不到就返回 undefined，由调用方报错", () => {
    expect(findCategory(categories, "不存在的分类")).toBeUndefined();
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

  it("每个源内部 id 唯一，同组内不出现重名标签", () => {
    for (const source of sources) {
      const categories = usableCategories(source.ruleFindUrl);
      if (categories.length === 0) continue;

      const ids = new Set(categories.map((item) => item.id));
      expect(ids.size).toBe(categories.length);

      // 界面按 (分组, 标题) 显示，这一对重复用户就分不清点哪个
      const labels = categories.map((item) => `${item.group} ${item.title}`);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

/**
 * 编号必须在滤掉要 JS 的分类之后算。
 *
 * 否则界面上会出现「悬疑 2」却找不到「悬疑」—— 前一个被 JS 过滤挡掉了，
 * 用户只看到一个带 2 的孤零零标签。
 */
describe("usableCategories 与编号的配合", () => {
  it("被 JS 过滤掉的分类不占号", () => {
    const raw = [
      "悬疑:: /x/index{{page - 1 == 0 ? '': '_'+page}}.html", // 要 JS，滤掉
      "悬疑:: /x/{{page}}.html",
    ].join("\n");
    expect(usableCategories(raw)).toMatchObject([{ title: "悬疑" }]);
  });

  it("小标题的地址要 JS 时，它仍然给后面的分类当分组名", () => {
    // 小标题自身指向一个要 JS 的地址：它不该成为可点分类，但分组名要留下
    const raw = JSON.stringify([
      { title: "热榜", url: "@js:foo()", style: { layout_flexBasisPercent: 1 } },
      { title: "玄幻", url: "/x/{{page}}.html", style: { layout_flexBasisPercent: 0.25 } },
    ]);
    expect(usableCategories(raw)).toMatchObject([{ title: "玄幻", group: "热榜" }]);
  });
});
