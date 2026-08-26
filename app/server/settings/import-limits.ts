import { eq } from "drizzle-orm";
import { siteSettings } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export const importLimitSettingKey = "imports.max_upload_mb";
export const defaultMaxUploadMb = 300;
export const maxUploadMbRange = { min: 1, max: 4096 } as const;

// Worker 内存有限，不同格式解析的内存放大倍数差异很大：TXT 是纯文本，
// EPUB/MOBI 需要解压整本，PDF 还要走 PDF.js 全文提取。
export const formatMaxUploadMb: Record<string, number> = {
  txt: 50,
  epub: 50,
  mobi: 50,
  pdf: 50,
} as const;

export async function getMaxUploadMb(db: AppDb): Promise<number> {
  const row = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, importLimitSettingKey))
    .get();
  if (!row) return defaultMaxUploadMb;
  const value = row.value as unknown;
  if (typeof value === "object" && value !== null && "maxUploadMb" in value) {
    const mb = Math.round((value as { maxUploadMb?: unknown }).maxUploadMb as number);
    if (Number.isFinite(mb) && mb >= maxUploadMbRange.min && mb <= maxUploadMbRange.max) {
      return mb;
    }
  }
  return defaultMaxUploadMb;
}

export async function getMaxUploadMbForFormat(db: AppDb, ext: string): Promise<number> {
  const globalLimit = await getMaxUploadMb(db);
  const formatLimit = formatMaxUploadMb[ext.toLowerCase()] ?? globalLimit;
  return Math.min(globalLimit, formatLimit);
}

export async function setMaxUploadMb(db: AppDb, mb: number): Promise<number> {
  const normalized = Math.round(mb);
  if (!Number.isFinite(normalized)) throw new Error("上传大小上限必须是数字");
  if (normalized < maxUploadMbRange.min || normalized > maxUploadMbRange.max) {
    throw new Error(`上传大小上限需要在 ${maxUploadMbRange.min}-${maxUploadMbRange.max}MB 之间`);
  }
  const existing = await db
    .select({ id: siteSettings.id })
    .from(siteSettings)
    .where(eq(siteSettings.key, importLimitSettingKey))
    .get();
  const value = { maxUploadMb: normalized };
  if (existing) {
    await db.update(siteSettings).set({ value, updatedAt: new Date() }).where(eq(siteSettings.id, existing.id));
  } else {
    await db.insert(siteSettings).values({
      id: crypto.randomUUID(),
      key: importLimitSettingKey,
      value,
      description: "单本小说上传大小上限（MB），默认 300",
    });
  }
  return normalized;
}
