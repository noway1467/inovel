import { drizzle } from "drizzle-orm/d1";
import * as schema from "drizzle/schema";
import type { D1Database } from "@cloudflare/workers-types";

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type AppDb = ReturnType<typeof createDb>;

