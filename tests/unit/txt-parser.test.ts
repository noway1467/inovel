import { describe, expect, it } from "vitest";
import {
  decodeText,
  detectEncoding,
  parseTxt,
} from "../../app/server/imports/txt-parser";
import { parseBookFile } from "../../app/server/imports/parser";
import { maxChapterParagraphs } from "../../app/server/imports/chapter-rules";

describe("txt-parser", () => {
  it("检测 UTF-8 与 GB18030 编码", () => {
    const utf8 = new TextEncoder().encode("第一章 测试");
    expect(detectEncoding(utf8)).toBe("utf-8");

    const gbBytes = new Uint8Array([
      0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xb2, 0xe2, 0xca, 0xd4,
    ]);
    expect(detectEncoding(gbBytes)).toBe("gb18030");
    expect(decodeText(gbBytes, "gb18030")).toBe("第一章 测试");
  });

  it("按章节标题切分正文", () => {
    const text = [
      "第一章 夜雨",
      "雨声敲打着窗棂。",
      "他放下手中的书。",
      "",
      "第二章 晨光",
      "天亮了。",
    ].join("\n");

    const { chapters, report } = parseTxt(text);
    expect(chapters).toHaveLength(2);
    expect(chapters[0]?.title).toBe("第一章 夜雨");
    expect(chapters[0]?.paragraphs).toEqual(["雨声敲打着窗棂。", "他放下手中的书。"]);
    expect(chapters[1]?.title).toBe("第二章 晨光");
    expect(chapters[1]?.paragraphs).toEqual(["天亮了。"]);
    expect(report.warnings).toHaveLength(0);
  });

  it("保留源文件卷名并把章节归入对应目录", () => {
    const text = [
      "第一卷 起航",
      "第一章 海风",
      "正文一",
      "第二章 星光",
      "正文二",
      "第二卷 归途",
      "第三章 回港",
      "正文三",
    ].join("\n");
    const { chapters } = parseTxt(text);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第一章 海风", "第二章 星光", "第三章 回港"]);
    expect(chapters.map((chapter) => chapter.volumeTitle)).toEqual(["第一卷 起航", "第一卷 起航", "第二卷 归途"]);
  });

  it("默认不按字数制造虚拟目录", () => {
    const text = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 段普通正文内容。`).join("\n");
    const { chapters, report } = parseTxt(text);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBe("正文");
    expect(report.warnings.some((warning) => warning.includes("按字数拆分"))).toBe(false);
  });
  it("同标题同正文去重，同标题不同正文全部保留", () => {
    const duplicate = ["第一章 重逢", "正文一", "第一章 重逢", "正文一"].join("\n");
    const { chapters: filtered, report } = parseTxt(duplicate);
    expect(filtered.map((chapter) => chapter.title)).toEqual(["第一章 重逢"]);
    expect(report.warnings.some((warning) => warning.includes("重复"))).toBe(false);

    const distinct = ["第一章 重逢", "正文一", "第一章 重逢", "正文二"].join("\n");
    const { chapters: kept } = parseTxt(distinct);
    expect(kept.map((chapter) => chapter.title)).toEqual(["第一章 重逢", "第一章 重逢"]);
    expect(kept[0]?.paragraphs).toEqual(["正文一"]);
    expect(kept[1]?.paragraphs).toEqual(["正文二"]);
  });

  it("parseBookFile 全链路按正文去重", async () => {
    const text = ["第一章 重逢", "正文一", "第一章 重逢", "正文一"].join("\n");
    const parsed = await parseBookFile(new TextEncoder().encode(text), "book.txt");
    expect(parsed.chapters).toHaveLength(1);
  });

  it("标题前无标题内容归入正文首章", () => {
    const text = ["这是开篇引言。", "第一章 启程", "正文开始。"].join("\n");
    const { chapters } = parseTxt(text);
    expect(chapters[0]?.title).toBe("正文");
    expect(chapters[0]?.paragraphs).toContain("这是开篇引言。");
    expect(chapters[1]?.title).toBe("第一章 启程");
  });

  it("标题后紧跟的内容行计入章节字数", () => {
    const text = ["第一章 夜雨", "短句。", "正文二。"].join("\n");
    const { chapters } = parseTxt(text);
    expect(chapters[0]?.charCount).toBe(7);
  });

  it("没有任何实际正文的标题章节被过滤", () => {
    const text = ["第一章 空章", "", "第二章 真章", "正文内容。"].join("\n");
    const { chapters } = parseTxt(text);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第二章 真章"]);
  });

  it("单章超过上限时保留为单章且不丢内容", () => {
    const lines = ["第一章 超长章节"];
    for (let i = 0; i < maxChapterParagraphs + 10; i++) {
      lines.push(`第 ${i} 段正文内容`);
    }
    const { chapters, report } = parseTxt(lines.join("\n"));
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBe("第一章 超长章节");
    expect(chapters[0]?.paragraphs).toHaveLength(maxChapterParagraphs + 10);
    expect(report.warnings.some((warning) => warning.includes("续章"))).toBe(false);
    expect(chapters[0]?.warning).toContain("段落过多");
  });

  it("识别不到章节标题时按字数兜底拆分", () => {
    const text = Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 段正文内容，用于验证字数拆分规则。`).join("\n");
    const { chapters, report } = parseTxt(text, { charsPerChapter: 100 });
    expect(chapters.length).toBeGreaterThan(1);
    expect(chapters.every((chapter) => chapter.charCount <= 100)).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("已按字数拆分"))).toBe(true);
  });

  it("有章节标题时 charsPerChapter 不拆章", () => {
    const lines = ["第一章 夜雨"];
    for (let i = 0; i < 12; i++) {
      lines.push(`第 ${i + 1} 段正文内容，用于验证字数拆分规则。`);
    }
    const { chapters, report } = parseTxt(lines.join("\n"), { charsPerChapter: 10 });
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.title).toBe("第一章 夜雨");
    expect(report.warnings.some((warning) => warning.includes("已按字数拆分"))).toBe(false);
  });

  it("forceSplitByChars 时有章节标题也按字数拆分", () => {
    const lines = ["第一章 夜雨"];
    for (let i = 0; i < 12; i++) {
      lines.push(`第 ${i + 1} 段正文内容，用于验证字数拆分规则。`);
    }
    const { chapters, report } = parseTxt(lines.join("\n"), {
      charsPerChapter: 50,
      forceSplitByChars: true,
    });
    expect(chapters.length).toBeGreaterThan(1);
    expect(chapters[0]?.title).toBe("第一章 夜雨");
    expect(chapters[1]?.title).toContain("第一章 夜雨");
    expect(chapters.every((chapter) => chapter.charCount <= 50)).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("已按字数拆分"))).toBe(true);
  });

  it("parseBookFile 支持强制按字数重分章", async () => {
    const lines = ["第一章 超长章节"];
    for (let i = 0; i < 12; i++) {
      lines.push(`第 ${i + 1} 段正文内容，用于验证字数拆分规则。`);
    }
    const parsed = await parseBookFile(new TextEncoder().encode(lines.join("\n")), "book.txt", {
      charsPerChapter: 50,
      forceSplitByChars: true,
    });
    expect(parsed.chapters.length).toBeGreaterThan(1);
  });

  it("无章节标题时分隔线作为章节边界", () => {
    const text = ["---", "第一段内容", "第二段内容", "-----", "第三段内容"].join("\n");
    const { chapters } = parseTxt(text);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第 1 章", "第 2 章"]);
    expect(chapters[0]?.paragraphs).toEqual(["第一段内容", "第二段内容"]);
    expect(chapters[1]?.paragraphs).toEqual(["第三段内容"]);
  });

  it("有章节标题时分隔线只做内容分隔", () => {
    const text = ["第一章 山门", "正文一", "------------", "第二章 剑", "正文二"].join("\n");
    const { chapters } = parseTxt(text);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["第一章 山门", "第二章 剑"]);
    expect(chapters[0]?.paragraphs).toEqual(["正文一"]);
    expect(chapters[1]?.paragraphs).toEqual(["正文二"]);
  });
});
