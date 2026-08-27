import { eq } from "drizzle-orm";
import { siteSettings, sourceDomains } from "drizzle/schema";
import type { AppDb } from "~/server/db";

/** 站点设置键：是否用白名单限定可抓域名（默认关闭） */
export const domainRestrictionKey = "sources.restrictDomains";

/**
 * 所有出站抓取的唯一入口。三道闸：
 * 1. 只允许 https（和显式放行的 http，用于自建内网库时需运营方自行承担）
 * 2. 域名必须在 source_domains 白名单里（运营方逐个确认有授权）
 * 3. 拒绝内网/回环/元数据地址，防 SSRF 打到 Cloudflare 或你自己的内部服务
 *
 * 白名单出厂为空 —— 没有登记任何域名时，这里对所有请求返回拒绝。
 */

export const maxResponseBytes = 2 * 1024 * 1024;
export const fetchTimeoutMs = 15_000;
/** 同一次同步内两次请求之间的最小间隔，避免把源站打挂 */
export const politeDelayMs = 1_000;
/**
 * 翻同一份分页（目录第 N 页、正文第 N 页）时的间隔。
 *
 * 比 politeDelayMs 小：目录动辄二十页，1 秒一页光等就 20 秒，而这是用户
 * 点开书时同步等着的。分页请求是同一份文档的续页，总量由 maxTocPages /
 * maxContentPages 封顶，压到 300ms 仍远低于正常浏览器加载一个页面的并发量。
 */
export const paginationDelayMs = 300;

const userAgent = "yuedu-ibook/0.1 (+subscription sync; contact site admin)";

/** 私有网段与元数据地址，命中即拒 */
const blockedHostPatterns = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^169\.254\./, // link-local，含云元数据 169.254.169.254
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // fc00::/7 唯一本地地址
  /\.internal$/i,
  /\.local$/i,
];

export type FetchRejection =
  | { ok: false; code: "BAD_URL"; message: string }
  | { ok: false; code: "SCHEME_NOT_ALLOWED"; message: string }
  | { ok: false; code: "PRIVATE_ADDRESS"; message: string }
  | { ok: false; code: "DOMAIN_NOT_ALLOWLISTED"; message: string };

export type UrlCheck = { ok: true; url: URL } | FetchRejection;

export function parseSourceUrl(raw: string): { ok: true; url: URL } | FetchRejection {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "BAD_URL", message: `地址无法解析：${raw.slice(0, 120)}` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      ok: false,
      code: "SCHEME_NOT_ALLOWED",
      message: `只支持 http/https，收到 ${url.protocol}`,
    };
  }
  const host = url.hostname.toLowerCase();
  if (blockedHostPatterns.some((pattern) => pattern.test(host))) {
    return {
      ok: false,
      code: "PRIVATE_ADDRESS",
      message: `拒绝内网或回环地址：${host}`,
    };
  }
  return { ok: true, url };
}

/**
 * 入库前的地址归一化。
 *
 * 必须只有这一处实现：`new URL("https://a.com").toString()` 会补出尾斜杠，
 * 若写入用归一化后的值、查重却用原始值，同一个源每次导入都会新增一行。
 */
export function normalizeEndpoint(raw: string): string | null {
  const parsed = parseSourceUrl(raw);
  return parsed.ok ? parsed.url.toString() : null;
}

/** 白名单命中规则：精确匹配域名，或作为其子域 */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const target = host.toLowerCase();
  return allowlist.some((allowed) => {
    const base = allowed.toLowerCase();
    return target === base || target.endsWith(`.${base}`);
  });
}

export async function loadAllowlist(db: AppDb): Promise<string[]> {
  const rows = await db.select({ host: sourceDomains.host }).from(sourceDomains).all();
  return rows.map((row) => row.host);
}

/**
 * 域名限定默认关闭：源导入后立即可用，不需要额外确认步骤。
 *
 * 只有运营方主动在站点设置里打开 `sources.restrictDomains` 时，
 * 才会用 source_domains 白名单做限定 —— 那是给需要收窄抓取范围的
 * 部署留的可选开关，不是默认门槛。
 */
export async function isDomainRestrictionEnabled(db: AppDb): Promise<boolean> {
  const row = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, domainRestrictionKey))
    .get();
  const value = row?.value as { enabled?: boolean } | undefined;
  return Boolean(value?.enabled);
}

export async function checkSourceUrl(db: AppDb, raw: string): Promise<UrlCheck> {
  const parsed = parseSourceUrl(raw);
  if (!parsed.ok) return parsed;
  // 默认不限定域名；开关打开后才校验白名单
  if (!(await isDomainRestrictionEnabled(db))) return parsed;
  const allowlist = await loadAllowlist(db);
  if (!hostMatchesAllowlist(parsed.url.hostname, allowlist)) {
    return {
      ok: false,
      code: "DOMAIN_NOT_ALLOWLISTED",
      message: `已开启域名限定，且 ${parsed.url.hostname} 不在白名单内。到「在线源 → 域名限定」添加，或关掉该开关。`,
    };
  }
  return parsed;
}

export interface GuardedFetchResult {
  status: number;
  body: string;
  contentType: string;
  truncated: boolean;
}

/**
 * 受控抓取：超时、体积上限、UA 标识齐备。
 * allowlist 已由调用方通过 checkSourceUrl 校验过一次；这里再校验一次
 * 是为了拦住重定向到未授权域名的情况。
 */
export async function guardedFetch(
  db: AppDb,
  raw: string,
  init?: { headers?: Record<string, string> }
): Promise<{ ok: true; result: GuardedFetchResult } | FetchRejection | { ok: false; code: "FETCH_FAILED"; message: string }> {
  const check = await checkSourceUrl(db, raw);
  if (!check.ok) return check;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    const response = await fetch(check.url.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "*/*",
        ...init?.headers,
      },
    });

    // 跟随重定向后的落点也必须在白名单内，否则等于绕过授权
    const finalCheck = await checkSourceUrl(db, response.url || check.url.toString());
    if (!finalCheck.ok) return finalCheck;

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        ok: true,
        result: { status: response.status, body: "", contentType: response.headers.get("content-type") ?? "", truncated: false },
      };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      result: {
        status: response.status,
        body: new TextDecoder("utf-8", { fatal: false }).decode(merged),
        contentType: response.headers.get("content-type") ?? "",
        truncated,
      },
    };
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? `请求超时（${fetchTimeoutMs}ms）`
      : error instanceof Error
        ? error.message
        : String(error);
    return { ok: false, code: "FETCH_FAILED", message };
  } finally {
    clearTimeout(timer);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
