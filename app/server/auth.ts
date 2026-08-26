import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { drizzle } from "drizzle-orm/d1";
import { accounts, sessions, users, verifications } from "drizzle/schema";
import type { D1Database } from "@cloudflare/workers-types";

export function createAuth(d1: D1Database, secret: string, baseURL: string) {
  const db = drizzle(d1);
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    secret,
    baseURL,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 300,
      },
    },
    user: {
      modelName: "user",
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

