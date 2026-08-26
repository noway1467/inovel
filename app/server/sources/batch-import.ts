import { eq } from "drizzle-orm";
import { contentSources } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { normalizeEndpoint } from "~/server/sources/fetch-guard";
import { detectListFormat, fetchSourceList, type ListFormat } from "~/server/sources/import-url";
import { parseLegadoJson } from "~/server/sources/legado";
import { parseRssSourceJson } from "~/server/sources/rss-source";
import { createSource } from "~/server/sources/service";

/**
 * 批量导入源清单。支持三种入口：
 *   - 清单地址（书源站的 json 地址，会跟 302 到 CDN）
 *   - 直接粘贴 JSON 文本
 * 两种格式（书源 / 订阅源）按字段自动判别，用各自的转换器。
 */

export interface BatchImportResult {
  format: ListFormat;
  /** 跟随重定向后的实际地址，便于排查 */
  finalUrl: string | null;
  bytes: number | null;
  created: { name: string; sourceId: string; kind: string; status: string }[];
  /** 同地址已存在，跳过新建 */
  reused: { name: string; sourceId: string }[];
  rejected: { name: string; reason: string }[];
  /** 转换成功但有降级的源 */
  warned: { name: string; warnings: string[] }[];
  totals: { parsed: number; created: number; reused: number; rejected: number };
}

async function findByEndpoint(db: AppDb, endpoint: string) {
  const normalized = normalizeEndpoint(endpoint);
  if (!normalized) return null;
  return db.select().from(contentSources).where(eq(contentSources.endpoint, normalized)).get();
}

interface PendingSource {
  name: string;
  endpoint: string;
  kind: "feed" | "rules";
  config: Record<string, unknown> | null;
  warnings: string[];
}

/** 两种格式各自转换后，收敛成同一种待建列表 */
function convertByFormat(
  text: string,
  format: ListFormat
): { pending: PendingSource[]; rejected: { name: string; reason: string }[] } {
  if (format === "bookSource") {
    const { converted, failed } = parseLegadoJson(text);
    return {
      pending: converted.map((item) => ({
        name: item.name,
        endpoint: item.endpoint,
        kind: "rules" as const,
        config: item.config as unknown as Record<string, unknown>,
        warnings: item.warnings,
      })),
      rejected: failed,
    };
  }
  if (format === "rssSource") {
    const { converted, failed } = parseRssSourceJson(text);
    return {
      pending: converted.map((item) => ({
        name: item.name,
        endpoint: item.endpoint,
        kind: item.kind,
        config: item.config as unknown as Record<string, unknown> | null,
        warnings: item.warnings,
      })),
      rejected: failed,
    };
  }
  throw new Error(
    "无法识别清单格式：书源需含 bookSourceUrl/bookSourceName，订阅源需含 sourceUrl/sourceName"
  );
}

export interface BatchImportInput {
  /** 清单地址，与 text 二选一 */
  url?: string | null;
  /** 直接粘贴的 JSON，与 url 二选一 */
  text?: string | null;
  syncIntervalMinutes?: number;
  actorId: string;
}

export async function batchImportSources(
  db: AppDb,
  input: BatchImportInput
): Promise<BatchImportResult> {
  let text = input.text?.trim() ?? "";
  let finalUrl: string | null = null;
  let bytes: number | null = null;

  if (!text) {
    if (!input.url?.trim()) throw new Error("需要提供清单地址（url）或 JSON 文本（text）");
    const fetched = await fetchSourceList(db, input.url.trim());
    if (!fetched.ok) throw new Error(fetched.message);
    text = fetched.result.text;
    finalUrl = fetched.result.finalUrl;
    bytes = fetched.result.bytes;
  }

  const format = detectListFormat(text);
  const { pending, rejected } = convertByFormat(text, format);

  const created: BatchImportResult["created"] = [];
  const reused: BatchImportResult["reused"] = [];
  const warned: BatchImportResult["warned"] = [];

  for (const item of pending) {
    if (item.warnings.length > 0) warned.push({ name: item.name, warnings: item.warnings });
    try {
      // 同地址的源复用，反复导入同一清单不会堆出重复行与重复同步计划
      const existing = await findByEndpoint(db, item.endpoint);
      if (existing) {
        reused.push({ name: item.name, sourceId: existing.id });
        continue;
      }
      const result = await createSource(db, {
        name: item.name,
        kind: item.kind,
        endpoint: item.endpoint,
        config: item.config,
        attribution: `来源：${item.name}`,
        syncIntervalMinutes: input.syncIntervalMinutes ?? 360,
        actorId: input.actorId,
      });
      created.push({
        name: item.name,
        sourceId: result.id,
        kind: item.kind,
        status: result.status,
      });
    } catch (error) {
      rejected.push({
        name: item.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    format,
    finalUrl,
    bytes,
    created,
    reused,
    rejected,
    warned,
    totals: {
      parsed: pending.length,
      created: created.length,
      reused: reused.length,
      rejected: rejected.length,
    },
  };
}
