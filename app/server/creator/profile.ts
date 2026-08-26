import { eq } from "drizzle-orm";
import { authors, users } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { hasRole } from "~/server/security/rbac";

export async function ensureAuthorProfile(db: AppDb, userId: string) {
  const existing = await db.select().from(authors).where(eq(authors.userId, userId)).get();
  if (existing) return existing;
  if (!(await hasRole(db, userId, "author"))) return null;
  const user = await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  const inserted = await db
    .insert(authors)
    .values({
      id: crypto.randomUUID(),
      userId,
      penName: user?.name?.trim() || "作者",
      status: "active",
    })
    .returning()
    .get();
  return inserted;
}
