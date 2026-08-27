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
  /** 同地址已存在，复用不重复建 */
  reused: { name: string; sourceId: string }[];
  /**
   * 用不了的源直接丢弃，只统计数量。
   * 逐条列出跳过原因对使用者没有价值 —— 那些源本来就不可能工作。
   */
  droppedCount: number;
  /** 转换成功但有降级的源（搜索需 JS、目录转探测等，正文仍可用） */
  warned: { name: string; warnings: string[] }[];
  totals: {
    usable: number;
    created: number;
    reused: number;
    dropped: number;
    /**
     * 降级细分。管理台此前把所有 warned 一律显示成"不支持搜索"，
     * 现在降级有多种（目录转探测也算），笼统一句话会误导运营方。
     */
    searchDisabled: number;
    tocDetected: number;
  };
}

/**
 * 一次把已有源的 endpoint → id 全取回来。
 *
 * 原先是循环里逐个 findByEndpoint，600 个源就是 600 次 D1 往返，
 * 加上建源的 600 次，单请求 1200 次往返 —— 这是导入偶发 Error 1102
 * （Worker 资源超限）的主要来源。一次查完在内存里比对，往返降到 1 次。
 */
async function loadEndpointIndex(db: AppDb): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: contentSources.id, endpoint: contentSources.endpoint })
    .from(contentSources)
    .all();
  return new Map(rows.map((row) => [row.endpoint, row.id]));
}

interface PendingSource {
  name: string;
  endpoint: string;
  kind: "feed" | "rules";
  config: Record<string, unknown> | null;
  /** 书源自带 weight，作为搜索排序的初始优先级 */
  weight: number;
  warnings: string[];
}

/** 从待建源的配置里读降级情况，用于给运营方分类统计 */
function degradeKind(item: PendingSource) {
  const config = item.config ?? {};
  return {
    searchDisabled: item.kind === "rules" && !config.searchUrl,
    tocDetected: config.tocMode === "detect",
  };
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
        weight: item.weight,
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
        // 订阅源格式没有 weight 字段
        weight: 0,
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
  const droppedAtConvert = rejected.length;

  const created: BatchImportResult["created"] = [];
  const reused: BatchImportResult["reused"] = [];
  const warned: BatchImportResult["warned"] = [];
  // 转换阶段就用不了的源，连同建源失败的一起计入丢弃
  let dropped = droppedAtConvert;

  let searchDisabled = 0;
  let tocDetected = 0;

  // 已有源的 endpoint 索引：一次查完，循环里只查内存
  const endpointIndex = await loadEndpointIndex(db);

  for (const item of pending) {
    if (item.warnings.length > 0) warned.push({ name: item.name, warnings: item.warnings });
    // 只统计真正进了库的：建不起来的源计入丢弃，不该再出现在降级提示里
    const countDegrade = () => {
      const kind = degradeKind(item);
      if (kind.searchDisabled) searchDisabled += 1;
      if (kind.tocDetected) tocDetected += 1;
    };
    try {
      // 同地址的源复用，反复导入同一清单不会堆出重复行与重复同步计划。
      // 查已有源的索引一次性载入（见 loadEndpointIndex），这里只查内存。
      const normalized = normalizeEndpoint(item.endpoint);
      const existingId = normalized ? endpointIndex.get(normalized) : undefined;
      if (existingId) {
        reused.push({ name: item.name, sourceId: existingId });
        countDegrade();
        continue;
      }
      const result = await createSource(db, {
        name: item.name,
        kind: item.kind,
        endpoint: item.endpoint,
        config: item.config,
        attribution: `来源：${item.name}`,
        syncIntervalMinutes: input.syncIntervalMinutes ?? 360,
        searchWeight: item.weight,
        actorId: input.actorId,
      });
      created.push({
        name: item.name,
        sourceId: result.id,
        kind: item.kind,
        status: result.status,
      });
      // 新建的也进索引：同一份清单里出现两条相同地址时，第二条才会走复用分支
      if (normalized) endpointIndex.set(normalized, result.id);
      countDegrade();
    } catch {
      // 建不起来的源直接丢，不打断整批
      dropped += 1;
    }
  }

  return {
    format,
    finalUrl,
    bytes,
    created,
    reused,
    droppedCount: dropped,
    warned,
    totals: {
      usable: created.length + reused.length,
      created: created.length,
      reused: reused.length,
      dropped,
      searchDisabled,
      tocDetected,
    },
  };
}
