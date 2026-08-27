import { describe, expect, it } from "vitest";
import { decodeBody, detectCharset } from "~/server/sources/fetch-guard";

/**
 * 响应编码嗅探。
 *
 * 老一批中文小说站大量是 gbk，而我们原先写死 utf-8 解码 —— 整页解成乱码
 * （`����ɭ` 这种）。表现很误导：选择器、分页都对，取出来的标题和正文却是
 * 乱码，看起来像"规则失效"。老版扁平格式的书源尤其集中在这批站上。
 *
 * 实测同人小说（trxs.cc）一个书页：按 utf-8 解出 3625 个替换字符，
 * 按 gb18030 解出 0 个，标题从 `����ɭ����˺��û` 变回 `特雷森五马撕我没`。
 */

/** 把汉字按 gb18030 编成字节。Node 没有内置编码器，用查表拼固定样本。 */
const gbkBytes = {
  // 「第1节」= B5 DA 31 BD DA
  第1节: new Uint8Array([0xb5, 0xda, 0x31, 0xbd, 0xda]),
  // 「小说」= D0 A1 CB B5
  小说: new Uint8Array([0xd0, 0xa1, 0xcb, 0xb5]),
};

function withHtml(body: Uint8Array, meta: string): Uint8Array {
  const head = new TextEncoder().encode(`<html><head>${meta}</head><body><p>`);
  const tail = new TextEncoder().encode("</p></body></html>");
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

describe("detectCharset", () => {
  it("Content-Type 头里的 charset 优先", () => {
    const bytes = withHtml(gbkBytes.小说, '<meta charset="utf-8">');
    expect(detectCharset(bytes, "text/html; charset=gbk")).toBe("gb18030");
  });

  it("gbk / gb2312 都归一到 gb18030（超集，能兜住混入的生僻字）", () => {
    const empty = new Uint8Array();
    expect(detectCharset(empty, "text/html; charset=gbk")).toBe("gb18030");
    expect(detectCharset(empty, "text/html; charset=GB2312")).toBe("gb18030");
    expect(detectCharset(empty, "text/html; charset=gb18030")).toBe("gb18030");
  });

  it("头里没写时看 meta charset 简写形式", () => {
    const bytes = withHtml(gbkBytes.小说, '<meta charset="gbk">');
    expect(detectCharset(bytes, "text/html")).toBe("gb18030");
  });

  it("也认 http-equiv 那种老写法", () => {
    // 真实站点（trxs.cc）用的就是这种
    const bytes = withHtml(
      gbkBytes.小说,
      '<meta http-equiv="Content-Type" content="text/html; charset=gb2312">'
    );
    expect(detectCharset(bytes, "")).toBe("gb18030");
  });

  it("都没有就按 utf-8", () => {
    const bytes = new TextEncoder().encode("<html><body>正文</body></html>");
    expect(detectCharset(bytes, "text/html")).toBe("utf-8");
    expect(detectCharset(bytes, "")).toBe("utf-8");
  });

  it("不认识的编码不乱猜，退回 utf-8", () => {
    expect(detectCharset(new Uint8Array(), "text/html; charset=x-mystery")).toBe("utf-8");
  });

  it("引号包着的 charset 也能剥出来", () => {
    expect(detectCharset(new Uint8Array(), 'text/html; charset="gbk"')).toBe("gb18030");
  });
});

describe("decodeBody", () => {
  it("gbk 页面解出正确汉字，没有替换字符", () => {
    const bytes = withHtml(gbkBytes.第1节, '<meta charset="gbk">');
    const text = decodeBody(bytes, "text/html");
    expect(text).toContain("第1节");
    expect(text).not.toContain("�");
  });

  it("同一份字节按 utf-8 解就是乱码（修复前的行为）", () => {
    const bytes = withHtml(gbkBytes.第1节, '<meta charset="gbk">');
    const wrong = decodeBody(bytes, "text/html; charset=utf-8");
    expect(wrong).not.toContain("第1节");
    expect(wrong).toContain("�");
  });

  it("utf-8 页面照旧", () => {
    const bytes = new TextEncoder().encode("<html><body>第1节 正文</body></html>");
    expect(decodeBody(bytes, "text/html; charset=utf-8")).toContain("第1节 正文");
    expect(decodeBody(bytes, "")).toContain("第1节 正文");
  });

  it("空响应不炸", () => {
    expect(decodeBody(new Uint8Array(), "text/html")).toBe("");
  });
});
