import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 仓库里的 wrangler.jsonc 是脱敏模板（域名/资源 ID 留空）。
 * 真实配置放在 gitignore 的 wrangler.local.jsonc，存在时优先使用。
 */
export function resolveWranglerConfig(): string {
  const local = join(root, "wrangler.local.jsonc");
  return existsSync(local) ? local : join(root, "wrangler.jsonc");
}
