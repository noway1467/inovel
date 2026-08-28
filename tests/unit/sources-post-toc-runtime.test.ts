import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDb } from "~/server/db";
import { convertLegadoSource } from "~/server/sources/legado";
import { rulesAdapter } from "~/server/sources/adapters/rules";

const source = {
  bookSourceName: "POST 目录源",
  bookSourceUrl: "https://post-toc.example.org",
  ruleBookInfo: {
    tocUrl:
      '{{java.put("url",baseUrl); "/api/toc"}},{ "method": "POST", "body": "bid={{baseUrl.match(/(\\d+).$/)[1]}}" }',
  },
  ruleToc: {
    chapterList: "$.data",
    chapterName: "$.title",
    chapterUrl: "@get:{url}p{{$.ordernum}}.html",
  },
  ruleContent: { content: "#content@html" },
};

describe("运行时保留 POST 目录模板", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("读取配置时不把地址模板降级成详情页探测", async () => {
    const converted = convertLegadoSource(source);
    expect(converted.config.tocMode).toBe("rules");
    expect(converted.config.infoTocUrl).toContain("/api/toc");

    const calls: { method?: string; url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: { method?: string; body?: string }) => {
        const url = input.toString();
        calls.push({ method: init?.method, url, body: init?.body });
        return new Response(
          JSON.stringify({
            data: [
              { ordernum: 1, title: "第1章" },
              { ordernum: 2, title: "第2章" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ get: async () => undefined, all: async () => [] }),
          all: async () => [],
        }),
      }),
    };
    const chapters = await rulesAdapter.listChapters(
      {
        db: db as unknown as AppDb,
        endpoint: converted.endpoint,
        config: converted.config as unknown as Record<string, unknown>,
        countRequest: () => {},
      },
      { externalId: "https://post-toc.example.org/read/38804/" }
    );

    expect(chapters.map((item) => item.title)).toEqual(["第1章", "第2章"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "POST",
      url: "https://post-toc.example.org/api/toc",
      body: "bid=38804",
    });
  });
});
