import { and, eq } from "drizzle-orm";
import { shelfItems } from "drizzle/schema";
import type { AppDb } from "~/server/db";

/** 判断某本书是否已在用户书架（命中 shelf_items_user_book_unique，单行查询）。 */
export async function isBookInShelf(db: AppDb, userId: string, bookId: string) {
  const row = await db
    .select({ id: shelfItems.id })
    .from(shelfItems)
    .where(and(eq(shelfItems.userId, userId), eq(shelfItems.bookId, bookId)))
    .get();
  return Boolean(row);
}
