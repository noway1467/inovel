import { eq } from "drizzle-orm";
import { siteSettings } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export const registrationSettingKey = "registration.enabled";

export async function getRegistrationEnabled(db: AppDb): Promise<boolean> {
  const row = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, registrationSettingKey))
    .get();
  if (!row) return false;
  const value = row.value as unknown;
  if (typeof value === "object" && value !== null && "enabled" in value) {
    return Boolean((value as { enabled?: boolean }).enabled);
  }
  return false;
}

export async function setRegistrationEnabled(db: AppDb, enabled: boolean) {
  const existing = await db
    .select({ id: siteSettings.id })
    .from(siteSettings)
    .where(eq(siteSettings.key, registrationSettingKey))
    .get();
  const value = { enabled };
  if (existing) {
    await db.update(siteSettings).set({ value, updatedAt: new Date() }).where(eq(siteSettings.id, existing.id));
  } else {
    await db.insert(siteSettings).values({
      id: crypto.randomUUID(),
      key: registrationSettingKey,
      value,
      description: "是否允许用户自助注册，默认关闭",
    });
  }
  return enabled;
}

