import { describe, expect, it } from "vitest";
import { buildSearchRequest, supportsSearchRequest } from "~/server/sources/search-request";
import { parseRequestOptions } from "~/server/sources/url-options";

const endpoint = "https://search.example.org/";

describe("搜索请求描述与编码", () => {
  it("关键字、旧占位与页码算术，不重复编码关键词", () => {
    const request = buildSearchRequest(
      "/s?q={{encodeURIComponent(key)}}&start={{(page-1)*20}}&end={{page*20-1}}",
      "修仙 &+",
      endpoint,
      {},
      2
    );
    const url = new URL(request.url);
    expect(url.searchParams.get("q")).toBe("修仙 &+");
    expect(url.searchParams.get("start")).toBe("20");
    expect(url.searchParams.get("end")).toBe("39");
    expect(
      buildSearchRequest("/s?searchKeyword=searchKey&p=searchPage", "searchKey", endpoint).url
    ).toBe(`${endpoint}s?searchKeyword=searchKey&p=1`);
  });

  it("POST 表单关键字不能注入额外参数", () => {
    const request = buildSearchRequest(
      "/s,{method:'POST',body:'key={{key}}&page={{page}}',}",
      "修仙&admin=true+ #",
      endpoint
    );
    expect(request.url).toBe(`${endpoint}s`);
    expect(request.options.method).toBe("POST");
    const form = new URLSearchParams(request.options.body);
    expect([...form.keys()]).toEqual(["key", "page"]);
    expect(form.get("key")).toBe("修仙&admin=true+ #");
  });

  it.each([
    { body: { keyword: "{{key}}", page: "{{page}}" } },
    { body: '{"keyword":"{{key}}","page":{{page}}}' },
  ])("JSON 请求体保留原文并转义引号、反斜杠和换行：%j", ({ body }) => {
    const keyword = '书"名\\路径\n新行';
    const request = buildSearchRequest(
      `/s,${JSON.stringify({ method: "POST", body })}`,
      keyword,
      endpoint
    );
    expect(JSON.parse(request.options.body!).keyword).toBe(keyword);
    expect(Number(JSON.parse(request.options.body!).page)).toBe(1);
    expect(request.options.headers?.["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("请求头支持字符串对象并覆盖全局头，插值不做 URL 编码", () => {
    const options = {
      headers: JSON.stringify({
        Referer: "{{baseUrl}}",
        "X-Search": "{{key}}",
        "Content-Type": "application/json",
      }),
      method: "POST",
      body: { q: "{{key}}" },
    };
    const request = buildSearchRequest(`/s,${JSON.stringify(options)}`, "修仙", endpoint, {
      referer: "old",
      "content-type": "text/plain",
      "user-agent": "test-agent",
    });
    expect(request.options.headers).toMatchObject({
      referer: endpoint,
      "x-search": "修仙",
      "content-type": "application/json",
      "user-agent": "test-agent",
    });
  });

  it.each(["gbk", "gb2312", "gb18030"])("%s 编码同时用于 GET 与 POST 关键字", (charset) => {
    expect(buildSearchRequest(`/s?q={{key}},{charset:'${charset}'}`, "修仙", endpoint).url).toBe(
      `${endpoint}s?q=%D0%DE%CF%C9`
    );
    expect(
      buildSearchRequest(
        `/s,{method:'POST',charset:'${charset}',body:'q={{key}}'}`,
        "修仙",
        endpoint
      ).options.body
    ).toBe("q=%D0%DE%CF%C9");
  });

  it("静态 source.getKey 和明确编码的 java.encodeURI 不执行 Java", () => {
    expect(
      buildSearchRequest("{{source.getKey()}}s?q={{java.encodeURI(key,'GBK')}}", "修仙", endpoint)
        .url
    ).toBe(`${endpoint}s?q=%D0%DE%CF%C9`);
  });

  it("JSON5 选项支持单引号、未加引号的键和尾逗号", () => {
    expect(
      parseRequestOptions("{method:'POST',body:{q:'{{key}}'},headers:{'X-Test':'yes'},}")
    ).toMatchObject({ method: "POST", body: '{"q":"{{key}}"}', headers: { "X-Test": "yes" } });
  });

  it("首页与后续页地址分支只用于 URL，不改动 JSON 请求体", () => {
    const template = "/search<,/{{page}}>.html?q={{key}}";
    expect(buildSearchRequest(template, "书", endpoint).url).toContain("/search.html?");
    expect(buildSearchRequest(template, "书", endpoint, {}, 2).url).toContain("/search/2.html?");
  });

  it.each([
    "/s,{webView:true}",
    "/s,{js:'result'}",
    "/s,{method:'DELETE'}",
    "file:///secret",
    "/s?q={{key}},{charset:'unknown'}",
  ])("明确拒绝不能支持的请求选项：%s", (template) => {
    expect(supportsSearchRequest(template)).toBe(false);
  });

  it.each([
    "/s?q={{java.ajax('https://evil.test')}}",
    "/s?p={{page/0}}",
    "/s?p={{page.constructor}}",
    "/s?q={{key",
    "@js:while(true){}",
    "/s,{method:(()=> 'POST')()}",
  ])("不执行未知表达式或损坏的请求：%s", (template) => {
    expect(supportsSearchRequest(template)).toBe(false);
  });
});
