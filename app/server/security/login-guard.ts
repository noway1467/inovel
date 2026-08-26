import { eq } from "drizzle-orm";
import { loginAttempts } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export const maxLoginFailures = 5;
export const ipCooldownSeconds = 15 * 60;

export function getClientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "127.0.0.1"
  );
}

export interface LoginGuardState {
  blocked: boolean;
  remainingSeconds: number;
  failedCount: number;
}

export async function getLoginGuardState(db: AppDb, ip: string): Promise<LoginGuardState> {
  const row = await db.select().from(loginAttempts).where(eq(loginAttempts.identifier, ip)).get();
  if (!row) return { blocked: false, remainingSeconds: 0, failedCount: 0 };

  if (row.blockedUntil && row.blockedUntil.getTime() > Date.now()) {
    return {
      blocked: true,
      remainingSeconds: Math.max(1, Math.ceil((row.blockedUntil.getTime() - Date.now()) / 1000)),
      failedCount: row.failedCount,
    };
  }
  return { blocked: false, remainingSeconds: 0, failedCount: row.failedCount };
}

export async function recordLoginFailure(db: AppDb, ip: string) {
  const existing = await db.select().from(loginAttempts).where(eq(loginAttempts.identifier, ip)).get();
  const now = new Date();
  const nextCount = (existing?.failedCount ?? 0) + 1;
  const blockedUntil =
    nextCount >= maxLoginFailures ? new Date(now.getTime() + ipCooldownSeconds * 1000) : null;

  if (existing) {
    await db
      .update(loginAttempts)
      .set({
        failedCount: nextCount,
        blockedUntil,
        lastFailedAt: now,
        updatedAt: now,
      })
      .where(eq(loginAttempts.id, existing.id));
  } else {
    await db.insert(loginAttempts).values({
      id: crypto.randomUUID(),
      identifier: ip,
      failedCount: nextCount,
      blockedUntil,
      lastFailedAt: now,
    });
  }
  return { failedCount: nextCount, blockedUntil };
}

export async function clearLoginFailures(db: AppDb, ip: string) {
  await db.delete(loginAttempts).where(eq(loginAttempts.identifier, ip));
}

