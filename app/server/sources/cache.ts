import type { R2Bucket } from "@cloudflare/workers-types";

/**
 * 源抓取结果的 R2 缓存。
 *
 * 目录、正文、发现页书单共用一套 key 规则和版本号 —— 三条链路跑的是同一套
 * 解析代码，改一处逻辑三边的旧缓存都该作废，版本号分开管早晚会漏。
 */

/**
 * 抓取管线版本号。**改动抓取/解析逻辑时必须 +1。**
 *
 * 为什么需要它：正文缓存 7 天。修好分页跟随之后，早先存进去的截断正文
 * （只有第一页）会继续供 7 天 —— 部署完全正确，用户看到的还是旧内容，
 * 而且没有任何迹象说明问题出在缓存。上一轮就是这样，只能手动逐章删 R2。
 *
 * 版本号进 key，改一次逻辑就等于把旧缓存全部作废，旧对象自然失活
 * （R2 生命周期规则回收，不影响读取）。
 *
 * v2: 跟随正文/目录分页（数字分页器、`>` 符号、地址形状），滤掉翻页提示行
 * v3: 按响应编码解码（gbk/gb2312/big5），此前写死 utf-8，gbk 站缓存的是乱码
 * v4: 套用书源自带的净化规则（replaceRegex），旧缓存里是没净化的正文
 * v5: 过浏览器验证挑战 + 目录探测按地址形状剔除杂链，旧缓存里存的是验证页
 *     文字与一堆假章节
 * v6: 支持 POST 目录接口（源站「完整目录」按钮），旧缓存里只有详情页刮到的
 *     最新几章
 * v7: 目录探测按章节序号排序，并保留 title/alt 里的源站标题；
 *     旧缓存保存了“最新章节块”的倒序/缺序结果
 * v8: 剥掉目录开头的「最新章节」预告段（含详情页信息栏那一行），旧缓存里
 *     第 1 条是全书最后一章 —— 打开书直接剧透大结局
 * v9: 书源规则只刮到「最新章节」预告时改跳目录页重抓（此前规则一有结果就
 *     不再跳，整本书只剩最新几章）；发现页书单换成专用探测，不再拿目录探测
 *     去认书单（认回来的常是标签云）
 */
export const pipelineVersion = "v9";

/** 源地址不能直接当 R2 键（含协议与斜杠），用摘要 */
export async function keyHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** `source-cache/<版本>/<源>/<用途>/<摘要>.json` */
export function cacheKey(sourceId: string, scope: string, hash: string) {
  return `source-cache/${pipelineVersion}/${sourceId}/${scope}/${hash}.json`;
}

interface CachedEnvelope<T> {
  cachedAt: number;
  data: T;
}

export async function readCache<T>(
  bucket: R2Bucket,
  key: string,
  ttlMs: number
): Promise<T | null> {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    const parsed = JSON.parse(await object.text()) as CachedEnvelope<T>;
    if (Date.now() - parsed.cachedAt > ttlMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export async function writeCache<T>(bucket: R2Bucket, key: string, data: T): Promise<void> {
  const envelope: CachedEnvelope<T> = { cachedAt: Date.now(), data };
  await bucket.put(key, JSON.stringify(envelope), {
    httpMetadata: { contentType: "application/json" },
  });
}
