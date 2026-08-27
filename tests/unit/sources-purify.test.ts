import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parsePurifyRules,
  purifyParagraphs,
  purifyText,
  safeRules,
} from "~/server/sources/purify";

/**
 * 正文净化规则（书源的 replaceRegex）。
 *
 * 真实格式取自合集与 yckceo 清单，四种都存在。这些正则来自第三方书源、
 * 跑在 Workers 上，所以安全边界（限长限量、挡灾难性回溯）和解析同样重要 ——
 * 一条病态模式能烧穿 CPU 触发 1102。
 */

describe("parsePurifyRules", () => {
  it("认 `##正则` —— 匹配即删", () => {
    // 铅笔小说的真实写法
    expect(parsePurifyRules("##本章未完.*")).toEqual([{ pattern: "本章未完.*", replacement: "" }]);
  });

  it("认 `##正则##替换`", () => {
    expect(parsePurifyRules("##错别字##正确字")).toEqual([
      { pattern: "错别字", replacement: "正确字" },
    ]);
  });

  it("认 JSON 对象数组", () => {
    // 稷下书院的真实写法
    const raw = JSON.stringify([
      { pattern: "<div[^>]*class=\"gadBlock\".*?<\\/div>", replacement: "" },
      { pattern: "溫馨提示", replacement: "提示" },
    ]);
    expect(parsePurifyRules(raw)).toEqual([
      { pattern: '<div[^>]*class="gadBlock".*?<\\/div>', replacement: "" },
      { pattern: "溫馨提示", replacement: "提示" },
    ]);
  });

  it("认 JSON 字符串数组 —— 每条都是要删的", () => {
    // 笔趣阁的真实写法
    const raw = JSON.stringify(["笔趣阁.*?阅读", "bqquge\\.com"]);
    expect(parsePurifyRules(raw)).toEqual([
      { pattern: "笔趣阁.*?阅读", replacement: "" },
      { pattern: "bqquge\\.com", replacement: "" },
    ]);
  });

  it("砍掉 JS 尾，保留前面的正则", () => {
    // 明月中文的真实写法：正则后面挂了一段 JS
    const raw = '##记##的@js:result.replace(/插入书签/g,"")';
    expect(parsePurifyRules(raw)).toEqual([{ pattern: "记", replacement: "的" }]);
  });

  it("多行分别成规则", () => {
    expect(parsePurifyRules("##广告一\n##广告二")).toEqual([
      { pattern: "广告一", replacement: "" },
      { pattern: "广告二", replacement: "" },
    ]);
  });

  it("坏数据返回空数组", () => {
    expect(parsePurifyRules("[不是合法 JSON")).toEqual([]);
    expect(parsePurifyRules("")).toEqual([]);
    expect(parsePurifyRules(null)).toEqual([]);
    expect(parsePurifyRules(undefined)).toEqual([]);
    expect(parsePurifyRules(42)).toEqual([]);
  });

  it("条数封顶，防止一个源塞几百条", () => {
    const many = Array.from({ length: 100 }, (_, i) => `##广告${i}`).join("\n");
    expect(parsePurifyRules(many).length).toBeLessThanOrEqual(20);
  });
});

describe("safeRules 安全边界", () => {
  it("挡掉会灾难性回溯的形状", () => {
    // 这类模式配长文本能把 CPU 烧穿 —— 正是 1102 的成因之一
    expect(safeRules([{ pattern: "(a+)+$", replacement: "" }])).toHaveLength(0);
    expect(safeRules([{ pattern: "(x*)*y", replacement: "" }])).toHaveLength(0);
    expect(safeRules([{ pattern: "([a-z]+)+z", replacement: "" }])).toHaveLength(0);
  });

  it("挡掉超长模式", () => {
    expect(safeRules([{ pattern: "a".repeat(400), replacement: "" }])).toHaveLength(0);
  });

  it("挡掉编译不了的正则", () => {
    expect(safeRules([{ pattern: "([unclosed", replacement: "" }])).toHaveLength(0);
    expect(safeRules([{ pattern: "*invalid", replacement: "" }])).toHaveLength(0);
  });

  it("正常模式放行", () => {
    const rules = safeRules([
      { pattern: "本章未完.*", replacement: "" },
      { pattern: "第\\(\\d+/\\d+\\)页", replacement: "" },
    ]);
    expect(rules).toHaveLength(2);
  });
});

describe("purifyText", () => {
  it("删掉广告行", () => {
    const text = "正文第一句。\n一秒记住 www.example.com，更新最快！\n正文第二句。";
    expect(purifyText(text, "##一秒记住.*")).toBe("正文第一句。\n\n正文第二句。");
  });

  it("按替换文本改字（错别字场景）", () => {
    expect(purifyText("他说到做到", "##说到##说话")).toBe("他说话做到");
  });

  it("多条规则依次套用", () => {
    const raw = JSON.stringify(["广告A", "广告B"]);
    expect(purifyText("前广告A中广告B后", raw)).toBe("前中后");
  });

  it("没有规则时原样返回", () => {
    expect(purifyText("正文", null)).toBe("正文");
    expect(purifyText("正文", "")).toBe("正文");
  });

  it("一条坏规则不影响其它规则", () => {
    // 第一条编译不了，第二条应当照常生效
    const raw = JSON.stringify(["([unclosed", "广告"]);
    expect(purifyText("前广告后", raw)).toBe("前后");
  });

  it("超长正文不跑净化，避免被病态模式拖死", () => {
    const huge = "a".repeat(600_000);
    expect(purifyText(huge, "##a")).toBe(huge);
  });
});

describe("purifyParagraphs", () => {
  it("整段是广告时把这一段丢掉", () => {
    const paragraphs = ["正文一。", "本章未完，请点击下一页继续阅读", "正文二。"];
    expect(purifyParagraphs(paragraphs, "##本章未完.*")).toEqual(["正文一。", "正文二。"]);
  });

  it("段内局部命中只删那一部分", () => {
    expect(purifyParagraphs(["正文（一秒记住本站）继续"], "##（一秒记住本站）")).toEqual([
      "正文继续",
    ]);
  });

  it("没有规则时原样返回", () => {
    const paragraphs = ["一", "二"];
    expect(purifyParagraphs(paragraphs, null)).toEqual(paragraphs);
  });
});

describe("真实合集里的净化规则", () => {
  it("扁平清单里的规则都能解析且安全", () => {
    const sources = JSON.parse(
      readFileSync("tests/fixtures/legado-flat-sources.json", "utf8")
    ) as Record<string, unknown>[];

    let withRules = 0;
    let usable = 0;
    for (const source of sources) {
      const raw = source.ruleBookContentReplaceRegex;
      if (typeof raw !== "string" || !raw.trim()) continue;
      withRules++;
      const parsed = parsePurifyRules(raw);
      expect(parsed.length).toBeGreaterThan(0);
      if (safeRules(parsed).length > 0) usable++;
    }

    expect(withRules).toBeGreaterThanOrEqual(15);
    // 绝大多数应当是能安全执行的，被挡掉的只该是极少数
    expect(usable).toBeGreaterThanOrEqual(withRules - 2);
  });

  it("对真实规则跑一遍不抛错、不超时", () => {
    const sources = JSON.parse(
      readFileSync("tests/fixtures/legado-flat-sources.json", "utf8")
    ) as Record<string, unknown>[];
    const sample =
      "第一章 测试\n一秒记住 www.test.com\n本章未完，请点击下一页继续阅读\n正文内容若干。\n第(1/3)页";

    for (const source of sources) {
      const raw = source.ruleBookContentReplaceRegex;
      if (typeof raw !== "string") continue;
      expect(() => purifyText(sample, raw)).not.toThrow();
    }
  });
});
