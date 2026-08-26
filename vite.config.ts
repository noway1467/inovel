import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { resolveWranglerConfig } from "./scripts/wrangler-config";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" }, configPath: resolveWranglerConfig() }),
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
