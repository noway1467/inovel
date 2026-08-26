import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { detectListFormat, fetchSourceList } from "~/server/sources/import-url";

let db: AppDb;
let raw: DatabaseSync;

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

/** 造一个带 body 流的响应 */
function jsonResponse(body: string, init?: { status?: number; url?: string }) {
  const response = new Response(body, {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
  if (init?.url) Object.defineProperty(response, "url", { value: init.url });
  return response;
}

describe("fetchSourceList", () => {
  it("拉回清单并记录最终落点与字节数", async () => {
    const body = JSON.stringify([{ bookSourceName: "甲", bookSourceUrl: "https://a.example.org" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(body, { url: "https://cdn.example.net/x.json" })))
    );

    const result = await fetchSourceList(db, "https://list.example.org/1.json");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.text).toBe(body);
    // 书源站普遍 302 到 CDN，落点要能看到
    expect(result.result.finalUrl).toBe("https://cdn.example.net/x.json");
    expect(result.result.bytes).toBeGreaterThan(0);
  });

  it("拦住内网与回环地址，且不发请求", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);

    for (const url of [
      "http://localhost/x.json",
      "http://127.0.0.1/x.json",
      "http://192.168.1.5/x.json",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.9/x.json",
    ]) {
      const result = await fetchSourceList(db, url);
      expect(result.ok, url).toBe(false);
      if (result.ok) continue;
      expect(result.message, url).toMatch(/内网|回环/);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("重定向落到内网时拒绝（防 SSRF 绕过）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse("[]", { url: "http://169.254.169.254/latest/meta-data" }))
      )
    );
    const result = await fetchSourceList(db, "https://list.example.org/1.json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/重定向落点被拒/);
  });

  it("非法协议被拒", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const result = await fetchSourceList(db, "file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("HTTP 错误码与空内容都给出可读原因", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse("[]", { status: 503 }))));
    const bad = await fetchSourceList(db, "https://list.example.org/1.json");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/HTTP 503/);

    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse("   "))));
    const empty = await fetchSourceList(db, "https://list.example.org/1.json");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toMatch(/为空/);
  });

  it("超时给出明确原因", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
      )
    );
    const result = await fetchSourceList(db, "https://slow.example.org/1.json", { timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/超时/);
  });

  it("超过体积上限时中止并报错", async () => {
    // 造一个持续吐数据的流，触发 16MB 上限
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            if (sent > 24) {
              controller.close();
              return;
            }
            controller.enqueue(chunk);
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      })
    );
    const result = await fetchSourceList(db, "https://huge.example.org/1.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/上限/);
  });
});

describe("detectListFormat", () => {
  it("按字段判别书源与订阅源", () => {
    expect(detectListFormat(JSON.stringify([{ bookSourceUrl: "https://a.org" }]))).toBe("bookSource");
    expect(detectListFormat(JSON.stringify([{ bookSourceName: "甲" }]))).toBe("bookSource");
    // 订阅源用的是另一套字段名
    expect(detectListFormat(JSON.stringify([{ sourceUrl: "https://a.org", sourceName: "乙" }]))).toBe(
      "rssSource"
    );
  });

  it("单个对象与数组都能判别", () => {
    expect(detectListFormat(JSON.stringify({ bookSourceUrl: "https://a.org" }))).toBe("bookSource");
  });

  it("非 JSON 或字段不认识时返回 unknown", () => {
    expect(detectListFormat("{ 坏")).toBe("unknown");
    expect(detectListFormat(JSON.stringify([{ foo: 1 }]))).toBe("unknown");
    expect(detectListFormat("[]")).toBe("unknown");
  });
});
