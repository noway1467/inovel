import { describe, expect, it } from "vitest";
import { parseEpub } from "../../app/server/imports/epub-parser";
import { makeTocEpub } from "../helpers/make-toc-epub";

describe("epub-parser", () => {
  it("优先使用 EPUB 自带 TOC，按 fragment 拆章并保留卷结构", async () => {
    const parsed = await parseEpub(makeTocEpub());
    expect(parsed.chapters.map((chapter) => chapter.title)).toEqual([
      "第一章 海风",
      "第二章 星光",
      "第三章 回港",
    ]);
    expect(parsed.chapters.map((chapter) => chapter.volumeTitle)).toEqual([
      "第一卷 起航",
      "第一卷 起航",
      "第二卷 归途",
    ]);
    expect(parsed.chapters[0]?.paragraphs).toContain("第一章正文。");
    expect(parsed.chapters[1]?.paragraphs).toContain("第二章正文。");
  });
});
