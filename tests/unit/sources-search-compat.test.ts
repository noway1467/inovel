import { afterEach, describe, expect, it, vi } from "vitest";
import iconv from "iconv-lite";
import type { AppDb } from "~/server/db";
import {
  convertLegadoSource,
  parseLegadoJson,
  currentConverterVersion,
} from "~/server/sources/legado";
import { rulesAdapter } from "~/server/sources/adapters/rules";
import { detectListFormat } from "~/server/sources/import-url";
import {
  evalRuleNodes,
  evalRuleOne,
  htmlDoc,
  jsonDoc,
  canParseRule,
} from "~/server/sources/rule-expr";
import { parseHtml } from "~/server/sources/html";
import { toLegadoSource } from "~/server/sources/export";

const endpoint = "https://search.example.org/";
const baseSource = {
  bookSourceName: "搜索兼容测试",
  bookSourceUrl: endpoint,
  searchUrl: "/search?q={{key}}",
  ruleSearch: { bookList: ".book", name: "a@text", bookUrl: "a@href" },
  ruleToc: { chapterList: "li", chapterName: "a@text", chapterUrl: "a@href" },
  ruleContent: { content: "#content@text" },
};
const db = {
  select: () => ({
    from: () => ({
      where: () => ({ get: async () => undefined, all: async () => [] }),
      all: async () => [],
    }),
  }),
} as unknown as AppDb;

afterEach(() => vi.unstubAllGlobals());

describe("搜索规则格式", () => {
  it("搜索封面、简介和请求选项导出后能重新导入", () => {
    const source = convertLegadoSource({
      ...baseSource,
      searchUrl: "/s,{method:'POST',body:{q:'{{key}}'}}",
      ruleSearch: { ...baseSource.ruleSearch, coverUrl: "img@src", intro: ".intro@text" },
    });
    const exported = toLegadoSource({
      name: source.name,
      endpoint,
      kind: "rules",
      config: source.config,
    });
    const roundTrip = convertLegadoSource(exported);
    expect(roundTrip.config.searchUrl).toBe(source.config.searchUrl);
    expect(roundTrip.config.searchCover).toBe("img@src");
    expect(roundTrip.config.searchIntro).toBe(".intro@text");
  });
  it("接受 BOM、JSON5 清单及序列化规则分组", () => {
    const text = `\uFEFF[{bookSourceName:'测试',bookSourceUrl:'${endpoint}',searchUrl:'/s?q={{key}}',ruleSearch:'{"bookList":".book","name":"a@text","bookUrl":"a@href"}',}]`;
    expect(detectListFormat(text)).toBe("bookSource");
    const { converted, failed } = parseLegadoJson(text);
    expect(failed).toEqual([]);
    expect(converted[0]?.config).toMatchObject({
      searchList: ".book",
      searchName: "a@text",
      converterVersion: currentConverterVersion,
    });
  });

  it("相对 JSONPath、大小写前缀与回退规则可在列表节点内继续取值", () => {
    const doc = jsonDoc({
      data: { books: [{ name: "修仙", author: { name: "作者" }, href: "/b/1" }] },
    });
    const nodes = evalRuleNodes(doc, "@Json: data.books");
    expect(nodes).toHaveLength(1);
    expect(evalRuleOne(nodes[0]!, "missing||name")).toBe("修仙");
    expect(evalRuleOne(nodes[0]!, "author.name")).toBe("作者");
    expect(evalRuleOne(nodes[0]!, "@JSON:href")).toBe("/b/1");
    expect(evalRuleOne(htmlDoc(parseHtml('<a href="/b">书名</a>')), "@CSS:a@href")).toBe("/b");
    expect(canParseRule("$.data[?(@.name)]")).toBe(false);
  });
});

describe("转换 → 受控抓取 → 搜索结果", () => {
  it("POST JSON 搜索发送正确请求，保留封面、简介与模板书籍地址", async () => {
    const source = convertLegadoSource({
      ...baseSource,
      searchUrl: "/api/search,{method:'POST',body:{keyword:'{{key}}',offset:'{{(page-1)*20}}'}}",
      header: { "Content-Type": "application/json", Referer: endpoint },
      ruleSearch: {
        bookList: "@json: data.books",
        name: "name",
        author: "author",
        bookUrl: "/books/{{$.id}}",
        coverUrl: "cover",
        intro: "intro",
      },
    });
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ keyword: '修仙"录', offset: "0" });
      return new Response(
        JSON.stringify({
          data: {
            books: [
              { id: 7, name: '修仙"录', author: "作者", cover: "/covers/7.jpg", intro: "简介" },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const books = await rulesAdapter.search!(
      {
        db,
        endpoint,
        config: source.config as unknown as Record<string, unknown>,
        countRequest: () => {},
      },
      '修仙"录'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}api/search`);
    expect(books).toEqual([
      {
        externalId: `${endpoint}books/7`,
        title: '修仙"录',
        author: "作者",
        coverUrl: `${endpoint}covers/7.jpg`,
        description: "简介",
      },
    ]);
  });

  it("GBK 表单请求与未声明编码的 GBK 响应都能工作", async () => {
    const source = convertLegadoSource({
      ...baseSource,
      searchUrl: "/s,{method:'POST',charset:'gbk',body:'q={{key}}'}",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        expect(init?.body).toBe("q=%D0%DE%CF%C9");
        return new Response(
          Uint8Array.from(
            iconv.encode('<div class="book"><a href="/books/1">修仙</a></div>', "gbk")
          ),
          { headers: { "content-type": "text/html" } }
        );
      })
    );
    const books = await rulesAdapter.search!(
      {
        db,
        endpoint,
        config: source.config as unknown as Record<string, unknown>,
        countRequest: () => {},
      },
      "修仙"
    );
    expect(books[0]?.title).toBe("修仙");
  });

  it("扁平源默认链接字段，按重定向最终地址补全并去重", async () => {
    const source = convertLegadoSource({
      bookSourceName: "扁平",
      bookSourceUrl: endpoint,
      ruleSearchUrl: "/s?q=searchKey",
      ruleSearchList: "a.book",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const response = new Response(
          '<a class="book" href="../7">修仙</a><a class="book" href="../7">重复</a><a class="book" href="javascript:void(0)">坏链接</a>'
        );
        Object.defineProperty(response, "url", { value: `${endpoint}nested/search/results` });
        return response;
      })
    );
    const books = await rulesAdapter.search!(
      {
        db,
        endpoint,
        config: source.config as unknown as Record<string, unknown>,
        countRequest: () => {},
      },
      "修仙"
    );
    expect(books).toEqual([{ externalId: `${endpoint}nested/7`, title: "修仙", author: null }]);
  });
});
