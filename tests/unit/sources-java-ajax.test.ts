import { describe, expect, it } from "vitest";
import { convertLegadoSource } from "~/server/sources/legado";
import { evalAjaxRule, isSupportedAjaxRule } from "~/server/sources/java-ajax";

const ajaxRule =
  "<js>java.ajax(baseUrl.replace('read-', '_getcontent.php?id=').replace('.html','&v=' + " +
  "result.match(/&v=(.*?)\"/)[1])).replaceAll('<style.*style>','')" +
  ".replaceAll('<([^<]*?)class(.*?)</(.*?)>','')</js>";

describe("受限 java.ajax 规则", () => {
  it(" Legado 源的常见 AJAX 正文规则可以导入", () => {
    const result = convertLegadoSource({
      bookSourceName: "疯情书库",
      bookSourceUrl: "https://www.aabook.cyou",
      header: JSON.stringify({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; WOW64)",
        Referer: "https://www.aabook.cyou/",
      }),
      searchUrl: "/search.php?searchword={{key}}",
      ruleSearch: {
        bookList: ".sousuojieguo li",
        name: "a.0@text",
        bookUrl: "a.0@href",
      },
      ruleToc: {
        chapterList: ".section_list li a",
        chapterName: "text",
        chapterUrl: "href",
      },
      ruleContent: { content: ajaxRule },
    });

    expect(result.config.contentRule).toBe(ajaxRule);
    expect(result.config.headers?.["user-agent"]).toContain("Mozilla/5.0");
    expect(result.config.headers?.referer).toBe("https://www.aabook.cyou/");
    expect(result.warnings.join("")).toContain("java.ajax");
  });

  it("能用 baseUrl 和章节页原文算出 AJAX 地址，并执行 Java 风格 replaceAll", async () => {
    const page = [
      "<html><head><style>.old{color:red}</style></head><body>",
      '<script>$.get("./_getcontent.php?id="+chapid+"&v=token-123",',
      "function(data){});</script>",
      "</body></html>",
    ].join("");
    const response = [
      "aabook_readfile",
      '<style>.hidden{opacity:0}</style>',
      "<p>第一段正文。</p>",
      "<q class='hidden'>marker</q>",
      "<p>第二段正文。</p>",
    ].join("");

    const body = await evalAjaxRule(ajaxRule, {
      baseUrl: "https://example.com/read-123.html",
      result: page,
      ajax: async (url) => {
        expect(url).toBe("https://example.com/_getcontent.php?id=123&v=token-123");
        return response;
      },
    });

    expect(body).not.toContain("<style>");
    expect(body).not.toContain("marker");
    expect(body).toContain("第一段正文");
  });

  it("不认识的变量和真实 JS 引擎仍然拒绝", () => {
    expect(isSupportedAjaxRule("<js>java.ajax(source.getKey())</js>")).toBe(false);
    expect(isSupportedAjaxRule(
      "<js>var x=baseUrl;java.ajax(x)</js>"
    )).toBe(false);
  });
});
