import { existsSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// 仓库里的 wrangler.jsonc 是脱敏模板（域名/资源 ID 留空）。
// 真实配置放在 gitignore 的 wrangler.local.jsonc，存在时优先使用。
const wranglerConfigPath = existsSync("wrangler.local.jsonc")
  ? "wrangler.local.jsonc"
  : "wrangler.jsonc";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" }, configPath: wranglerConfigPath }),
    tailwindcss(),
    reactRouter(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    watch: {
      ignored: ["**/tests/**", "**/test-results/**", "**/playwright-report/**", "**/.wrangler/**"],
    },
  },
});
