import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { rulesAdapter } from "~/server/sources/adapters/rules";
import { convertLegadoSource } from "~/server/sources/legado";
import { createSource } from "~/server/sources/service";

/**
 * 含 JS 的书源能不能装进来、能不能读。
 *
 * 取材于两个真实被拒的源（源仓库 7557 / 7554），它们代表了合集里
 * 「因 JS 被剔除」的两大类，页面结构按实测的形状复刻：
 *
 *  7557 型：正文规则整段是 JS，但内层主路径就是一条 CSS
 *           （`@js:var c=java.getString('.mrx-cot@p@html');…换源重试…`）
 *  7554 型：目录规则整段是 JS（正则拼 HTML + base64 解地址），
 *           正文规则是 CSS 头 + JS 尾，且目录页地址藏在 data-cata 里、
 *           章节地址是 base64、DOM 顺序被打乱
 */

let db: AppDb;
let raw: DatabaseSync;
let responses: Map<string, string>;

function ctxWith(config: Record<string, unknown>, endpoint: string) {
  return { db, endpoint, config, countRequest: () => {} };
}

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);
  raw
    .prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)")
    .run("u1", "运营", "op@example.org");

  responses = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
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

// ---------------------------------------------------------------- 7557 型

const jsWrappedContentSource = {
  bookSourceName: "JS 包裹正文的源",
  bookSourceUrl: "https://m87.example.com",
  ruleToc: { chapterList: ".rxs-zj a", chapterName: "text", chapterUrl: "href" },
  ruleContent: {
    content:
      "@js:var c=java.getString('.mrx-cot@p@html');if(c&&String(c).length>50){result=c;}" +
      "else{var l=java.getStringList('.pt-card a@href');result=c;}result",
  },
};

describe("正文规则整段是 JS，但内层是一条 CSS（7557 型）", () => {
  it("导入时抢救出内层规则，不再被剔除", () => {
    const converted = convertLegadoSource(jsWrappedContentSource);
    expect(converted.config.contentRule).toBe(".mrx-cot@p@html");
    expect(converted.config.tocMode).toBe("rules");
    expect(converted.warnings.join()).toMatch(/内层 CSS/);
  });

  it("装进来后目录与正文都能真的读出来", async () => {
    const converted = convertLegadoSource(jsWrappedContentSource);
    const bookUrl = "https://m87.example.com/novel/1/";
    responses.set(
      bookUrl,
      `<html><body><div class="rxs-zj">
        <a href="/novel/1/1.html">第一章 开端</a>
        <a href="/novel/1/2.html">第二章 承接</a>
      </div></body></html>`
    );
    responses.set(
      "https://m87.example.com/novel/1/1.html",
      `<html><body><div class="mrx-cot"><p>头一段正文。</p><p>第二段正文。</p></div></body></html>`
    );

    const ctx = ctxWith(
      converted.config as unknown as Record<string, unknown>,
      converted.endpoint
    );
    const chapters = await rulesAdapter.listChapters(ctx, { externalId: bookUrl });
    expect(chapters.map((c) => c.title)).toEqual(["第一章 开端", "第二章 承接"]);

    const content = await rulesAdapter.fetchChapter(ctx, {
      externalKey: chapters[0]!.externalKey,
    });
    expect(content.paragraphs).toEqual(["头一段正文。", "第二段正文。"]);
  });
});

// ---------------------------------------------------------------- 7554 型

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

const jsTocSource = {
  bookSourceName: "目录整段是 JS 的聚合源",
  bookSourceUrl: "https://agg.example.com",
  ruleToc: {
    // `+` 前缀 + 整段 JS：此前会被当成选择器，导入"成功"但目录永远为空
    chapterList: "+@js:(function(){var r=/<li[^>]*>[\\s\\S]*?<\\/li>/gi;return []})()",
    chapterName: "@js:(function(){return ''})()",
    chapterUrl: "@js:(function(){return java.base64Decode('x')})()",
  },
  ruleBookInfo: {
    tocUrl: "@js:(function(){var m=String(result).match(/data-cata=\"([^\"]+)\"/);return m?m[1]:''})()",
  },
  ruleContent: {
    content:
      "class.RBGsectionThree-content@html@js:(function(){return String(result).replace(/<[^>]+>/g,'')})()",
  },
};

/** 混淆目录页：href 是诱饵、真地址 base64 在 data-*、DOM 顺序打乱 */
function obfuscatedTocPage(bookPath: string, count: number) {
  const rows = Array.from({ length: count }, (_, i) => {
    const realOrder = count - 1 - i; // DOM 序与真顺序相反
    const path = `${bookPath}${200000 + realOrder}.html`;
    return (
      `<li class="chapter" data-id="${i}" data-z8f="${realOrder}">` +
      `<a href="${bookPath}" class="g" data-name="${realOrder + 1} 真章节名${realOrder + 1}" ` +
      `data-loc="${b64(path)}">章节 ${String(i + 1).padStart(2, "0")}</a></li>`
    );
  });
  return `<html><body><ul class="toc">${rows.join("")}</ul></body></html>`;
}

describe("目录规则整段是 JS 的聚合源（7554 型）", () => {
  it("导入时转为探测模式，不再被剔除；正文砍掉 JS 尾巴", () => {
    const converted = convertLegadoSource(jsTocSource);
    expect(converted.config.tocMode).toBe("detect");
    expect(converted.config.tocList).toBeNull();
    expect(converted.config.contentRule).toBe("class.RBGsectionThree-content@html");
    expect(converted.warnings.join()).toMatch(/目录规则不可用/);
  });

  it("探测模式的源能落库：目录三件套为空是合法状态", async () => {
    const converted = convertLegadoSource(jsTocSource);
    const created = await createSource(db, {
      name: converted.name,
      kind: "rules",
      endpoint: converted.endpoint,
      config: converted.config as unknown as Record<string, unknown>,
      actorId: "u1",
    });
    expect(created.id).toBeTruthy();
  });

  it("详情页 → 目录页 → 混淆目录：整条链路取到真章节地址", async () => {
    const converted = convertLegadoSource(jsTocSource);
    const bookUrl = "https://agg.example.com/book/373036/";
    const tocUrl = "https://mirror.example.com/book/8899/catalog/";
    const bookPath = "/book/8899/";

    // 详情页上没有章节列表，只有 data-cata 指向镜像站目录页（带 ?u= 包装）
    responses.set(
      bookUrl,
      `<html><body><ul><li class="site">
        <a href="/redirect/1/373036/?u=${encodeURIComponent("https://mirror.example.com/book/8899/")}">书名</a>
        来自 <a href="/redirect/1/373036/" data-cata="/redirect/1/373036/?u=${encodeURIComponent(tocUrl)}">镜像站</a>
      </li></ul></body></html>`
    );
    responses.set(tocUrl, obfuscatedTocPage(bookPath, 10));

    const ctx = ctxWith(
      converted.config as unknown as Record<string, unknown>,
      converted.endpoint
    );
    const chapters = await rulesAdapter.listChapters(ctx, { externalId: bookUrl });

    expect(chapters).toHaveLength(10);
    // href 是诱饵（全部指向书籍首页），结果里不能出现它
    for (const chapter of chapters) {
      expect(chapter.externalKey).not.toBe(`https://mirror.example.com${bookPath}`);
      expect(chapter.externalKey).toMatch(/\/book\/8899\/\d+\.html$/);
    }
    // 按真顺序排，而不是 DOM 顺序；名字取 data-*，不取按 DOM 写死的可见文字
    expect(chapters[0]!.title).toBe("1 真章节名1");
    expect(chapters[9]!.title).toBe("10 真章节名10");
    expect(chapters[0]!.externalKey).toContain("200000.html");
  }, 20_000);

  it("正文按砍掉 JS 尾巴的 CSS 规则取出，零宽反爬字符被清掉", async () => {
    const converted = convertLegadoSource(jsTocSource);
    const chapterUrl = "https://mirror.example.com/book/8899/200000.html";
    responses.set(
      chapterUrl,
      `<html><body><div class="RBGsectionThree-content">` +
        `<p>头一段&zwnj;正&zwj;文&lrm;。</p><p>第二段正文。</p></div></body></html>`
    );

    const ctx = ctxWith(
      converted.config as unknown as Record<string, unknown>,
      converted.endpoint
    );
    const content = await rulesAdapter.fetchChapter(ctx, { externalKey: chapterUrl });
    expect(content.paragraphs).toEqual(["头一段正文。", "第二段正文。"]);
  });

  it("探测也一无所获时报错说清是探测失败，而非「规则未命中」", async () => {
    const converted = convertLegadoSource(jsTocSource);
    const bookUrl = "https://agg.example.com/book/empty/";
    responses.set(bookUrl, `<html><body><p>这本书还没有章节</p></body></html>`);

    const ctx = ctxWith(
      converted.config as unknown as Record<string, unknown>,
      converted.endpoint
    );
    await expect(rulesAdapter.listChapters(ctx, { externalId: bookUrl })).rejects.toThrow(
      /探测/
    );
  });
});

// ------------------------------------------------------- 库里的老行（无迁移）

describe("库里已有的老行（规则里还带着 @js: 尾巴）", () => {
  it("读取时再降级一次，不需要数据迁移", async () => {
    const chapterUrl = "https://legacy.example.com/c/1.html";
    responses.set(
      chapterUrl,
      `<html><body><div class="content"><p>老行也能读。</p></div></body></html>`
    );

    // 模拟支持降级之前入库的配置：正文规则带 JS 尾巴
    const ctx = ctxWith(
      {
        tocList: "class.listmain@tag.dd",
        tocName: "tag.a@text",
        tocUrl: "tag.a@href",
        contentRule: "class.content@html@js:(function(){return result})()",
      },
      "https://legacy.example.com"
    );
    const content = await rulesAdapter.fetchChapter(ctx, { externalKey: chapterUrl });
    expect(content.paragraphs).toEqual(["老行也能读。"]);
  });

  it("老行的目录规则整段是 JS 时，读取时自动转探测", async () => {
    const bookUrl = "https://legacy.example.com/book/1/";
    responses.set(
      bookUrl,
      `<html><body><div class="listmain"><dl>` +
        Array.from(
          { length: 8 },
          (_, i) => `<dd><a href="/c/${i + 1}.html">第${i + 1}章 标题</a></dd>`
        ).join("") +
        `</dl></div></body></html>`
    );

    const ctx = ctxWith(
      {
        tocList: "+@js:(function(){return []})()",
        tocName: "@js:(function(){return ''})()",
        tocUrl: "@js:(function(){return ''})()",
        contentRule: "class.content@html",
      },
      "https://legacy.example.com"
    );
    const chapters = await rulesAdapter.listChapters(ctx, { externalId: bookUrl });
    expect(chapters).toHaveLength(8);
    expect(chapters[0]!.title).toBe("第1章 标题");
  });
});
