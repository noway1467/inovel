import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { rulesAdapter } from "~/server/sources/adapters/rules";
import { fallbackChaptersFromText } from "~/server/sources/toc-fallback";

/**
 * 目录/正文分页，以及目录规则失效时的兜底切章。
 *
 * 真实合集里约半数源需要分页（目录 65 个、正文 43 个），
 * 只取首页会导致"源站 3 页只看到 1 页"和每章正文被截断。
 */

let db: AppDb;
let raw: DatabaseSync;
let responses: Map<string, string>;
let requestLog: string[];

function ctxWith(config: Record<string, unknown>, endpoint = "https://novels.example.org") {
  return { db, endpoint, config, countRequest: () => {} };
}

const baseConfig = {
  tocList: "class.listmain@tag.dd",
  tocName: "tag.a@text",
  tocUrl: "tag.a@href",
  contentRule: "id.content@html",
};

function tocPage(entries: { title: string; href: string }[], extra = "") {
  const items = entries.map((e) => `<dd><a href="${e.href}">${e.title}</a></dd>`).join("");
  return `<html><body><div class="listmain"><dl>${items}</dl></div>${extra}</body></html>`;
}

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);

  responses = new Map();
  requestLog = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestLog.push(url);
      const body = responses.get(url);
      if (body === undefined) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "text/html" } })
      );
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

describe("目录分页", () => {
  it("跟随 text.下一页 把三页目录全部取回", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/book/1_2">下一页</a>`)
    );
    responses.set(
      "https://novels.example.org/book/1_2",
      tocPage([{ title: "第2章", href: "/c/2" }], `<a href="/book/1_3">下一页</a>`)
    );
    // 末页没有下一页链接
    responses.set(
      "https://novels.example.org/book/1_3",
      tocPage([{ title: "第3章", href: "/c/3" }])
    );

    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, nextTocUrl: "text.下一页@href" }),
      { externalId: "https://novels.example.org/book/1" }
    );

    expect(chapters.map((c) => c.title)).toEqual(["第1章", "第2章", "第3章"]);
  });

  it("没有分页规则时只取首页", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/book/1_2">下一页</a>`)
    );
    const chapters = await rulesAdapter.listChapters(ctxWith(baseConfig), {
      externalId: "https://novels.example.org/book/1",
    });
    expect(chapters).toHaveLength(1);
    expect(requestLog).toHaveLength(1);
  });

  it("option@value 形态的分页：取下拉里还没访问过的页", async () => {
    const options = `<select>
      <option value="/book/1">第1页</option>
      <option value="/book/1_2">第2页</option>
    </select>`;
    responses.set("https://novels.example.org/book/1", tocPage([{ title: "第1章", href: "/c/1" }], options));
    responses.set("https://novels.example.org/book/1_2", tocPage([{ title: "第2章", href: "/c/2" }], options));

    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, nextTocUrl: "option@value" }),
      { externalId: "https://novels.example.org/book/1" }
    );
    expect(chapters.map((c) => c.title)).toEqual(["第1章", "第2章"]);
  });

  it("分页规则自指时不会死循环", async () => {
    // 下一页指向自己
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/book/1">下一页</a>`)
    );
    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, nextTocUrl: "text.下一页@href" }),
      { externalId: "https://novels.example.org/book/1" }
    );
    expect(chapters).toHaveLength(1);
    expect(requestLog).toHaveLength(1);
  });

  it("跨页重复的章节按地址去重", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      tocPage([{ title: "第1章", href: "/c/1" }], `<a href="/book/1_2">下一页</a>`)
    );
    // 第二页重复了第 1 章（"最新章节"块常见）
    responses.set(
      "https://novels.example.org/book/1_2",
      tocPage([
        { title: "第1章", href: "/c/1" },
        { title: "第2章", href: "/c/2" },
      ])
    );

    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, nextTocUrl: "text.下一页@href" }),
      { externalId: "https://novels.example.org/book/1" }
    );
    expect(chapters).toHaveLength(2);
  });
});

describe("正文分页", () => {
  const content = (text: string, next = "") =>
    `<html><body><div id="content"><p>${text}</p></div>${next}</body></html>`;

  it("跟随 nextContentUrl 把分页正文拼完整", async () => {
    responses.set(
      "https://novels.example.org/c/1",
      content("第一页正文", `<a href="/c/1_2">下一页</a>`)
    );
    responses.set(
      "https://novels.example.org/c/1_2",
      content("第二页正文", `<a href="/c/1_3">下一页</a>`)
    );
    responses.set("https://novels.example.org/c/1_3", content("第三页正文"));

    const result = await rulesAdapter.fetchChapter(
      ctxWith({ ...baseConfig, nextContentUrl: "text.下一页@href" }),
      { externalKey: "https://novels.example.org/c/1" }
    );

    expect(result.paragraphs).toEqual(["第一页正文", "第二页正文", "第三页正文"]);
  });

  it("没有分页规则时只取首页，正文不拼接", async () => {
    responses.set(
      "https://novels.example.org/c/1",
      content("只要这一页", `<a href="/c/1_2">下一页</a>`)
    );
    const result = await rulesAdapter.fetchChapter(ctxWith(baseConfig), {
      externalKey: "https://novels.example.org/c/1",
    });
    expect(result.paragraphs).toEqual(["只要这一页"]);
  });

  it("中间页抓不到时保留已取到的部分，不整章失败", async () => {
    responses.set(
      "https://novels.example.org/c/1",
      content("第一页正文", `<a href="/c/missing">下一页</a>`)
    );
    // /c/missing 不在 responses 里 → 404，loadDoc 抛错
    await expect(
      rulesAdapter.fetchChapter(ctxWith({ ...baseConfig, nextContentUrl: "text.下一页@href" }), {
        externalKey: "https://novels.example.org/c/1",
      })
    ).rejects.toThrow();
  });
});

describe("目录规则失效时兜底切章", () => {
  it("规则选不中时，用标题识别从页面正文切出章节", async () => {
    // tocList 完全不匹配，但正文里有可识别的章节标题
    const body = [
      "第一章 启程",
      "他背起行囱走出村口，山路蜿蜒向北。".repeat(20),
      "第二章 抵达",
      "城门在暮色里合上，他终于赶到了。".repeat(20),
      "第三章 归途",
      "归途比来时更长，风雪没有停过。".repeat(20),
    ].join("\n");
    responses.set(
      "https://novels.example.org/book/1",
      `<html><body><div id="content">${body
        .split("\n")
        .map((line) => `<p>${line}</p>`)
        .join("")}</div></body></html>`
    );

    const chapters = await rulesAdapter.listChapters(
      ctxWith({ ...baseConfig, tocList: "class.does-not-exist@tag.li" }),
      { externalId: "https://novels.example.org/book/1" }
    );

    expect(chapters.length).toBeGreaterThanOrEqual(3);
    expect(chapters[0]?.title).toContain("第一章");
    // 兜底章节自带正文，不需要再回源
    expect(chapters[0]?.inlineParagraphs?.length).toBeGreaterThan(0);
  });

  it("正文太短时不硬切，仍然报错并说明原因", async () => {
    responses.set(
      "https://novels.example.org/book/1",
      `<html><body><div id="content"><p>太短</p></div></body></html>`
    );
    await expect(
      rulesAdapter.listChapters(ctxWith({ ...baseConfig, tocList: "class.nope@tag.li" }), {
        externalId: "https://novels.example.org/book/1",
      })
    ).rejects.toThrow(/不足以切分/);
  });
});

describe("fallbackChaptersFromText", () => {
  it("认得出标题时按标题切", () => {
    const text = [
      "第一章 开端",
      "内容甲".repeat(200),
      "第二章 转折",
      "内容乙".repeat(200),
    ].join("\n");
    const result = fallbackChaptersFromText(text);
    expect(result?.strategy).toBe("title");
    expect(result?.chapters).toHaveLength(2);
    expect(result?.chapters[0]?.title).toContain("第一章");
  });

  it("认不出标题时按字数切", () => {
    // 一整段没有任何标题结构的长文本
    const text = "连绵不断的叙述文字，没有任何章节标题。".repeat(600);
    const result = fallbackChaptersFromText(text, { charsPerChapter: 2_000 });
    expect(result?.strategy).toBe("chars");
    expect(result?.chapters.length).toBeGreaterThan(1);
  });

  it("每个兜底章节都自带正文", () => {
    const text = "没有标题的长文本内容。".repeat(600);
    const result = fallbackChaptersFromText(text, { charsPerChapter: 2_000 });
    for (const chapter of result?.chapters ?? []) {
      expect(chapter.inlineParagraphs?.length).toBeGreaterThan(0);
    }
  });

  it("文本太短时返回 null，不产出无意义的单章", () => {
    expect(fallbackChaptersFromText("很短的一句话")).toBeNull();
    expect(fallbackChaptersFromText("   ")).toBeNull();
  });

  /**
   * 回归：网页常把整章塞进一个 <p>，到这里就是一个上万字的单行。
   * parseTxt 的按字数切分只在段落之间下刀，段落内部不切 ——
   * 这种形状下兜底会退化成"只有一章"，等于没兜住。
   */
  it("整章挤在一个段落里也能切开（单行超长文本）", () => {
    // 一整行、无换行、带句末标点
    const oneLine = "他往北走了很久，风雪始终没有停。".repeat(500);
    expect(oneLine.includes("\n")).toBe(false);

    const result = fallbackChaptersFromText(oneLine, { charsPerChapter: 2_000 });
    expect(result?.strategy).toBe("chars");
    expect(result?.chapters.length).toBeGreaterThan(1);
    // 切点应落在句末，不在半句中间
    for (const chapter of result?.chapters ?? []) {
      const text = (chapter.inlineParagraphs ?? []).join("");
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("完全没有标点的超长单行也能切开", () => {
    const noPunctuation = "无标点文字".repeat(2_000);
    const result = fallbackChaptersFromText(noPunctuation, { charsPerChapter: 2_000 });
    expect(result?.chapters.length).toBeGreaterThan(1);
  });

  it("兜底章节的 key 稳定，重复调用结果一致（增量去重靠它）", () => {
    const text = "稳定性测试用的长文本。".repeat(600);
    const first = fallbackChaptersFromText(text, { charsPerChapter: 2_000 });
    const second = fallbackChaptersFromText(text, { charsPerChapter: 2_000 });
    expect(first?.chapters.map((c) => c.externalKey)).toEqual(
      second?.chapters.map((c) => c.externalKey)
    );
  });
});
