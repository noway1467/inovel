import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./drizzle/schema/index.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: "file:./.wrangler/state/v3/d1/miniflare-D1DatabaseObject/ibook-app.sqlite",
  },
});

