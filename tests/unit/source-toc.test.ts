import { describe, expect, it } from "vitest";
import { buildSourceTocMap } from "../../app/server/imports/source-toc";

describe("source-toc", () => {
  it("把树形目录映射为卷名和章节名，叶子标题优先于父卷标题", () => {
    const map = buildSourceTocMap(
      [
        {
          label: "第一卷 起航",
          href: "book:chapter-1",
          children: [
            { label: "第一章 海风", href: "book:chapter-1" },
            { label: "第二章 星光", href: "book:chapter-2" },
          ],
        },
        {
          label: "第二卷 归途",
          href: "book:chapter-3",
          children: [{ label: "第三章 回港", href: "book:chapter-3" }],
        },
      ],
      (href) => href.replace("book:", "")
    );

    expect(map.get("chapter-1")).toEqual({ title: "第一章 海风", volumeTitle: "第一卷 起航", selector: "" });
    expect(map.get("chapter-2")).toEqual({ title: "第二章 星光", volumeTitle: "第一卷 起航", selector: "" });
    expect(map.get("chapter-3")).toEqual({ title: "第三章 回港", volumeTitle: "第二卷 归途", selector: "" });
  });
});
