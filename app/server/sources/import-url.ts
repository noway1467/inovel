import { parseSourceUrl } from "~/server/sources/fetch-guard";
import type { AppDb } from "~/server/db";

/**
 * 拉取书源/订阅源清单文件。
 *
 * 不复用 guardedFetch 的原因：那条路是给"抓一章正文"设计的，上限 2MB；
 * 书源合集动辄上兆（实测某合集 1.87MB，600 条），且常 302 跳到 CDN，
 * 落点域名与输入域名不同。这里单独放宽体积，并对最终落点重新做一次
 * 内网校验（防 SSRF 经重定向绕过）。
 */

/** 清单文件体积上限。合集比单章大得多，但仍要有界。 */
export const maxSourceListBytes = 16 * 1024 * 1024;
export const importTimeoutMs = 30_000;

const userAgent = "yuedu-ibook/0.1 (+source list import)";

export interface FetchedSourceList {
  text: string;
  /** 跟随重定向后的最终地址，便于排查 CDN 落点 */
  finalUrl: string;
  bytes: number;
}

export type FetchListResult =
  | { ok: true; result: FetchedSourceList }
  | { ok: false; message: string };

export async function fetchSourceList(
  _db: AppDb,
  rawUrl: string,
  options?: { timeoutMs?: number }
): Promise<FetchListResult> {
  // 入口地址先过一遍：拦内网/回环/非法协议
  const parsed = parseSourceUrl(rawUrl);
  if (!parsed.ok) return { ok: false, message: parsed.message };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? importTimeoutMs);
  try {
    const response = await fetch(parsed.url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": userAgent, Accept: "application/json, text/plain, */*" },
    });

    // 重定向落点也要校验：书源站普遍 302 到 CDN，若落到内网就是 SSRF
    const finalUrl = response.url || parsed.url.toString();
    const finalCheck = parseSourceUrl(finalUrl);
    if (!finalCheck.ok) {
      return { ok: false, message: `重定向落点被拒：${finalCheck.message}` };
    }

    if (response.status >= 400) {
      return { ok: false, message: `清单地址返回 HTTP ${response.status}` };
    }

    const reader = response.body?.getReader();
    if (!reader) return { ok: false, message: "响应没有内容" };

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxSourceListBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          message: `清单超过 ${Math.round(maxSourceListBytes / 1024 / 1024)}MB 上限`,
        };
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(merged);
    if (!text.trim()) return { ok: false, message: "清单内容为空" };

    return { ok: true, result: { text, finalUrl, bytes: total } };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `拉取超时（${options?.timeoutMs ?? importTimeoutMs}ms）`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, message };
  } finally {
    clearTimeout(timer);
  }
}

/** 清单文件的种类。两种格式字段完全不同，需先判别。 */
export type ListFormat = "bookSource" | "rssSource" | "unknown";

export function detectListFormat(text: string): ListFormat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unknown";
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const first = list.find((item) => item && typeof item === "object") as
    | Record<string, unknown>
    | undefined;
  if (!first) return "unknown";

  if ("bookSourceUrl" in first || "bookSourceName" in first) return "bookSource";
  // 订阅源用 sourceUrl / sourceName，与书源完全不同的一套字段
  if ("sourceUrl" in first || "sourceName" in first) return "rssSource";
  return "unknown";
}
