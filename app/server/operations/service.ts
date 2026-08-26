import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import { announcements, auditLogs, books, categories, recommendationItems, recommendationSlots, tags } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  enabled: boolean;
}

export async function listCategories(db: AppDb): Promise<CategoryRow[]> {
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      sortOrder: categories.sortOrder,
      enabled: categories.enabled,
    })
    .from(categories)
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  return rows;
}

export async function createCategory(db: AppDb, actorId: string, input: { name: string; slug: string }) {
  const inserted = await db
    .insert(categories)
    .values({ id: crypto.randomUUID(), name: input.name.trim(), slug: input.slug.trim() })
    .returning()
    .get();
  await logOperation(db, actorId, "category.create", inserted.id, null, { name: inserted.name, slug: inserted.slug });
  return inserted;
}

export async function updateCategory(
  db: AppDb,
  actorId: string,
  categoryId: string,
  input: { name?: string; slug?: string; sortOrder?: number; enabled?: boolean }
) {
  const existing = await db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!existing) throw new Error("分类不存在");
  const next = {
    name: input.name?.trim() ?? existing.name,
    slug: input.slug?.trim() ?? existing.slug,
    sortOrder: input.sortOrder ?? existing.sortOrder,
    enabled: input.enabled ?? existing.enabled,
    updatedAt: new Date(),
  };
  await db.update(categories).set(next).where(eq(categories.id, categoryId));
  await logOperation(db, actorId, "category.update", categoryId, existing, next);
  return { ...existing, ...next };
}

export async function listTags(db: AppDb) {
  const rows = await db.select().from(tags).orderBy(asc(tags.name));
  return rows;
}

export async function createTag(db: AppDb, actorId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("标签名不能为空");
  const inserted = await db
    .insert(tags)
    .values({ id: crypto.randomUUID(), name: trimmed, normalized: trimmed.toLocaleLowerCase("zh-CN") })
    .returning()
    .get();
  await logOperation(db, actorId, "tag.create", inserted.id, null, { name: trimmed });
  return inserted;
}

export async function updateTag(db: AppDb, actorId: string, tagId: string, input: { enabled?: boolean }) {
  const existing = await db.select().from(tags).where(eq(tags.id, tagId)).get();
  if (!existing) throw new Error("标签不存在");
  const enabled = input.enabled ?? existing.enabled;
  await db.update(tags).set({ enabled }).where(eq(tags.id, tagId));
  await logOperation(db, actorId, "tag.update", tagId, { enabled: existing.enabled }, { enabled });
  return { ...existing, enabled };
}

export async function listRecommendationSlots(db: AppDb) {
  const rows = await db
    .select({
      id: recommendationSlots.id,
      code: recommendationSlots.code,
      name: recommendationSlots.name,
      enabled: recommendationSlots.enabled,
      sortOrder: recommendationSlots.sortOrder,
    })
    .from(recommendationSlots)
    .orderBy(asc(recommendationSlots.sortOrder));
  const slotIds = rows.map((row) => row.id);
  const items = slotIds.length
    ? await db
        .select({
          id: recommendationItems.id,
          slotId: recommendationItems.slotId,
          bookId: recommendationItems.bookId,
          sortOrder: recommendationItems.sortOrder,
          enabled: recommendationItems.enabled,
          bookTitle: books.title,
          bookAuthor: books.authorId,
        })
        .from(recommendationItems)
        .innerJoin(books, eq(recommendationItems.bookId, books.id))
        .where(inArray(recommendationItems.slotId, slotIds))
        .orderBy(asc(recommendationItems.sortOrder))
        .all()
    : [];
  return rows.map((slot) => ({
    ...slot,
    items: items.filter((item) => item.slotId === slot.id),
  }));
}

export async function addRecommendationItem(db: AppDb, actorId: string, slotId: string, bookId: string) {
  const slot = await db.select().from(recommendationSlots).where(eq(recommendationSlots.id, slotId)).get();
  if (!slot) throw new Error("推荐位不存在");
  const book = await db.select({ id: books.id }).from(books).where(eq(books.id, bookId)).get();
  if (!book) throw new Error("作品不存在");
  const maxOrder = await db
    .select({ order: recommendationItems.sortOrder })
    .from(recommendationItems)
    .where(eq(recommendationItems.slotId, slotId))
    .orderBy(desc(recommendationItems.sortOrder))
    .limit(1)
    .get();
  const inserted = await db
    .insert(recommendationItems)
    .values({
      id: crypto.randomUUID(),
      slotId,
      bookId,
      sortOrder: (maxOrder?.order ?? 0) + 1,
    })
    .returning()
    .get();
  await logOperation(db, actorId, "recommendation.add", inserted.id, null, { slotId, bookId });
  return inserted;
}

export async function removeRecommendationItem(db: AppDb, actorId: string, itemId: string) {
  const existing = await db.select().from(recommendationItems).where(eq(recommendationItems.id, itemId)).get();
  if (!existing) throw new Error("推荐项不存在");
  await db.delete(recommendationItems).where(eq(recommendationItems.id, itemId));
  await logOperation(db, actorId, "recommendation.remove", itemId, existing, null);
  return { ok: true };
}

export async function getActiveRecommendationBookIds(db: AppDb, slotCode: string, limit = 5): Promise<string[]> {
  const now = new Date();
  const rows = await db
    .select({ bookId: recommendationItems.bookId })
    .from(recommendationItems)
    .innerJoin(recommendationSlots, eq(recommendationItems.slotId, recommendationSlots.id))
    .where(
      and(
        eq(recommendationSlots.code, slotCode),
        eq(recommendationSlots.enabled, true),
        eq(recommendationItems.enabled, true),
        or(isNull(recommendationItems.startAt), lte(recommendationItems.startAt, now)),
        or(isNull(recommendationItems.endAt), gt(recommendationItems.endAt, now))
      )
    )
    .orderBy(asc(recommendationItems.sortOrder))
    .limit(limit);
  return rows.map((row) => row.bookId);
}

export async function listAnnouncements(db: AppDb) {
  return db.select().from(announcements).orderBy(desc(announcements.createdAt)).limit(50);
}

export async function createAnnouncement(db: AppDb, actorId: string, input: { title: string; body: string }) {
  const inserted = await db
    .insert(announcements)
    .values({ id: crypto.randomUUID(), title: input.title.trim(), body: input.body.trim() })
    .returning()
    .get();
  await logOperation(db, actorId, "announcement.create", inserted.id, null, { title: inserted.title });
  return inserted;
}

export async function updateAnnouncement(db: AppDb, actorId: string, id: string, input: { enabled?: boolean }) {
  const existing = await db.select().from(announcements).where(eq(announcements.id, id)).get();
  if (!existing) throw new Error("公告不存在");
  const enabled = input.enabled ?? existing.enabled;
  await db.update(announcements).set({ enabled, updatedAt: new Date() }).where(eq(announcements.id, id));
  await logOperation(db, actorId, "announcement.update", id, { enabled: existing.enabled }, { enabled });
  return { ...existing, enabled };
}

export async function getActiveAnnouncements(db: AppDb, limit = 5) {
  const now = new Date();
  return db
    .select({ id: announcements.id, title: announcements.title, body: announcements.body })
    .from(announcements)
    .where(
      and(
        eq(announcements.enabled, true),
        or(isNull(announcements.startAt), lte(announcements.startAt, now)),
        or(isNull(announcements.endAt), gt(announcements.endAt, now))
      )
    )
    .orderBy(desc(announcements.createdAt))
    .limit(limit);
}

async function logOperation(
  db: AppDb,
  actorId: string,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown
) {
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId,
    action,
    entityType: action.split(".")[0] ?? "operation",
    entityId,
    before: before as never,
    after: after as never,
    reason: "operations management",
  });
}
