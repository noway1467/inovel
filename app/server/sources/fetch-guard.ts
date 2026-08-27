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
  /** Retry-After 头原值，429/503 重试时按它退避 */
  retryAfter?: string | null;
  /**
   * 响应里的 cookie（只取 name=value 部分）。
   *
   * 过浏览器验证时必须带回去：实测只带 challenge token 不带 cookie 会被
   * 302 回挑战页 —— 服务端靠 session 认这次挑战。
   */
  setCookie?: string | null;
}

/**
 * 受控抓取：超时、体积上限、UA 标识齐备。
 * allowlist 已由调用方通过 checkSourceUrl 校验过一次；这里再校验一次
 * 是为了拦住重定向到未授权域名的情况。
 */
/**
 * 值得重试的状态码。
 *
 * 503/502/504 是源站临时故障或限流，429 是明确限流 —— 这几种过一两秒再打
 * 往往就成了。403/404 不重试：那是封禁或地址不存在，重试只是白等还更招封。
 */
const retriableStatuses = new Set([429, 500, 502, 503, 504]);
/** 最多重试几次。总耗时要留在 fetchTimeoutMs 的预算内，2 次是上限。 */
const maxRetries = 2;
/** 首次退避毫秒数，之后翻倍（400 → 800） */
const retryBackoffMs = 400;

/**
 * 带退避重试的抓取。
 *
 * 为什么需要：在线读书时源站偶发 503 会直接让用户看到"抓取失败"，
 * 而这类错误大多是瞬时的 —— 我们并发打同一个域名时尤其容易触发。
 * 重试一两次能把大部分 503 消化掉，用户完全感知不到。
 *
 * Retry-After 头如果有就听它的（但封顶 2 秒，免得被源站要求等 60 秒
 * 把整个请求拖超时）。
 */
/**
 * 「正在验证浏览器」挑战页。
 *
 * 有一类站（ixdzs8 等）对章节页先回一个极小的页面：正文位置只有
 * 「请稍等，正在进行安全验证…」，真地址靠一段 JS 跳到 `?challenge=<token>`。
 * 我们不跑 JS，于是把这几行提示当成正文抓走 —— 表现就是"章节全是垃圾内容"，
 * 而且不报错，看不出问题在哪。
 *
 * 但这个挑战不需要 JS 引擎：token 明写在 HTML 里，取出来带 cookie 重请求
 * 一次即可。纯字符串与 HTTP 操作。
 */
const challengeTokenPattern = /(?:let|var|const)\s+token\s*=\s*["']([A-Za-z0-9+/=_-]{16,512})["']/;
/** 挑战页都很小，用体积先做粗筛，避免对每个正常页面都跑正则 */
const maxChallengeBytes = 4096;

function extractChallengeToken(result: GuardedFetchResult): string | null {
  if (result.body.length > maxChallengeBytes) return null;
  // 必须同时具备"验证提示"和"跳 challenge 的脚本"，避免误判正常短页
  if (!/challenge/i.test(result.body)) return null;
  if (!/验证|verify|請稍等|请稍等/i.test(result.body)) return null;
  return challengeTokenPattern.exec(result.body)?.[1] ?? null;
}

export async function guardedFetch(
  db: AppDb,
  raw: string,
  init?: { headers?: Record<string, string> }
): Promise<{ ok: true; result: GuardedFetchResult } | FetchRejection | { ok: false; code: "FETCH_FAILED"; message: string }> {
  let last = await guardedFetchOnce(db, raw, init);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // 只有拿到了响应且状态码值得重试才重试；被闸拦下的（域名、SSRF）不重试
    if (!last.ok || !retriableStatuses.has(last.result.status)) break;

    const retryAfter = Number(last.result.retryAfter ?? "");
    const wait = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 2_000)
      : retryBackoffMs * 2 ** attempt;
    await delay(wait);
    last = await guardedFetchOnce(db, raw, init);
  }

  /**
   * 过浏览器验证：拿到 token 后带上首次响应的 cookie 重请求一次。
   *
   * cookie 是必需的 —— 实测只带 token 不带 cookie 会被 302 回挑战页，
   * 服务端要靠 session 认这次挑战。只尝试一次：真过不去就该如实失败，
   * 反复重试只是白等。
   */
  if (last.ok) {
    const token = extractChallengeToken(last.result);
    if (token) {
      const target = new URL(raw);
      target.searchParams.set("challenge", token);
      const retried = await guardedFetchOnce(db, target.toString(), {
        headers: {
          ...init?.headers,
          ...(last.result.setCookie ? { Cookie: last.result.setCookie } : {}),
        },
      });
      // 换来的内容不再是挑战页才采用，否则保留原结果让上层照常报错
      if (retried.ok && !extractChallengeToken(retried.result)) return retried;
    }
  }

  return last;
}

async function guardedFetchOnce(
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
    const contentType = response.headers.get("content-type") ?? "";
    return {
      ok: true,
      result: {
        status: response.status,
        body: decodeBody(merged, contentType),
        contentType,
        truncated,
        retryAfter: response.headers.get("retry-after"),
        setCookie: pickCookiePairs(response.headers.get("set-cookie")),
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

/**
 * 别名归一：gbk / gb2312 都用 gb18030 解。
 *
 * gb18030 是两者的超集，用它解码 gbk/gb2312 内容不会出错，还能顺带兜住
 * 那些声明 gb2312 实际混入 gbk 生僻字的页面（中文小说站很常见）。
 */
const charsetAliases = new Map([
  ["gbk", "gb18030"],
  ["gb2312", "gb18030"],
  ["gb-2312", "gb18030"],
  ["x-gbk", "gb18030"],
  ["gb18030", "gb18030"],
  ["big5", "big5"],
  ["big5-hkscs", "big5"],
  ["shift_jis", "shift_jis"],
  ["sjis", "shift_jis"],
  ["euc-jp", "euc-jp"],
  ["euc-kr", "euc-kr"],
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
]);

function normalizeCharset(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return charsetAliases.get(raw.trim().toLowerCase().replace(/^["']|["']$/g, "")) ?? null;
}

/**
 * 嗅探响应编码。
 *
 * 为什么必须做：老一批中文小说站大量是 gbk，而我们原先写死 utf-8 解码，
 * 整页会解成乱码（`�����Ķ�`）。表现很误导 —— 规则、分页都对，
 * 选择器却一个也匹配不上，看起来像"规则失效"，实际是编码错了。
 * 老版扁平格式的书源尤其集中在这批站上，光支持格式而不解编码等于没修。
 *
 * 顺序：先信 Content-Type 头，再看 HTML 里的 meta，最后按 utf-8。
 * meta 那步先用 ascii 粗解前 2KB —— charset 声明本身一定是 ASCII，
 * 所以哪怕正文是 gbk，也能可靠地把声明读出来。
 */
export function detectCharset(bytes: Uint8Array, contentType: string): string {
  const fromHeader = normalizeCharset(/charset=([^;]+)/i.exec(contentType)?.[1]);
  if (fromHeader) return fromHeader;

  const head = new TextDecoder("ascii", { fatal: false }).decode(bytes.subarray(0, 2048));
  const fromMeta =
    normalizeCharset(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]) ??
    normalizeCharset(/content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head)?.[1]);
  if (fromMeta) return fromMeta;

  return "utf-8";
}

/**
 * 从 Set-Cookie 里取出 `name=value` 拼成 Cookie 头的值。
 *
 * 只要键值，丢掉 Path/Expires/HttpOnly 那些属性 —— 那些是给浏览器存储用的，
 * 回传时只需要键值对。多条 cookie 用 `; ` 连接。
 */
export function pickCookiePairs(setCookie: string | null): string | null {
  if (!setCookie) return null;
  /**
   * 按逗号切要小心：Expires 里的日期本身含逗号（`Wed, 21 Oct 2025`）。
   * 只在「逗号后面紧跟 name=」处切，日期里的逗号后面是空格加星期，不会误切。
   */
  const parts = setCookie.split(/,\s*(?=[^;=\s]+=)/);
  const pairs = parts
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("=") && !/^(expires|path|domain|max-age|samesite)=/i.test(pair));
  return pairs.length > 0 ? pairs.join("; ") : null;
}

/** 按嗅探到的编码解码；Workers 不认某个编码时退回 utf-8，不让整次抓取失败 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = detectCharset(bytes, contentType);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
