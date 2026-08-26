import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { books, categories } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export interface CategoryNavItem {
  id: string;
  name: string;
  slug: string;
}

export async function listEnabledCategories(db: AppDb): Promise<CategoryNavItem[]> {
  const rows = await db
    .select({ id: categories.id, name: categories.name, slug: categories.slug })
    .from(categories)
    .where(eq(categories.enabled, true))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  return rows;
}

export interface CategoryWithCount extends CategoryNavItem {
  bookCount: number;
}

/**
 * 未归类作品数（category_id 为空）。
 *
 * 导入时不再默认塞进第一个分类，所以会出现这批书；
 * 分类页要给它们一个入口，否则作者看不到"我的书没分类"。
 */
export async function countUncategorizedBooks(db: AppDb): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(books)
    .where(and(isNull(books.categoryId), eq(books.status, "published"), isNull(books.deletedAt)))
    .get();
  return Number(row?.n ?? 0);
}

/**
 * 分类 + 已发布作品数，一条 SQL 出全部。
 * 分类页原来每格都写死一行"浏览该分类"，占了空间又没信息量；换成真实作品数。
 */
export async function listEnabledCategoriesWithCounts(db: AppDb): Promise<CategoryWithCount[]> {
  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      bookCount: sql<number>`count(${books.id})`,
    })
    .from(categories)
    .leftJoin(
      books,
      and(eq(books.categoryId, categories.id), eq(books.status, "published"), isNull(books.deletedAt))
    )
    .where(eq(categories.enabled, true))
    .groupBy(categories.id)
    .orderBy(asc(categories.sortOrder), asc(categories.name));
  return rows.map((row) => ({ ...row, bookCount: Number(row.bookCount ?? 0) }));
}

