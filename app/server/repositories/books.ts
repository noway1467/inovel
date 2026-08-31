import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { authors, bookTags, books, categories, chapters, tags, volumes } from "drizzle/schema";
import type { AppDb } from "~/server/db";

export interface BookListRow {
  id: string;
  title: string;
  slug: string;
  coverKey: string | null;
  status: string;
  serialStatus: string;
  wordCount: number;
  latestChapterTitle: string | null;
  updatedAt: Date | null;
  authorName: string;
  categoryName: string | null;
  tags: string[];
}

export async function listPublishedBooks(db: AppDb, limit = 24): Promise<BookListRow[]> {
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      slug: books.slug,
      coverKey: books.coverKey,
      status: books.status,
      serialStatus: books.serialStatus,
      wordCount: books.wordCount,
      latestChapterTitle: books.latestChapterTitle,
      updatedAt: books.updatedAt,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
      categoryName: categories.name,
    })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .leftJoin(categories, eq(books.categoryId, categories.id))
    .where(and(eq(books.status, "published"), isNull(books.deletedAt)))
    .orderBy(desc(books.updatedAt))
    .limit(limit);

  return withTags(db, rows);
}

/** 未归类作品（category_id 为空），对应分类页的"未分类"入口。 */
export async function listUncategorizedBooks(db: AppDb, limit = 50): Promise<BookListRow[]> {
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      slug: books.slug,
      coverKey: books.coverKey,
      status: books.status,
      serialStatus: books.serialStatus,
      wordCount: books.wordCount,
      latestChapterTitle: books.latestChapterTitle,
      updatedAt: books.updatedAt,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
      categoryName: sql<string | null>`null`,
    })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .where(and(isNull(books.categoryId), eq(books.status, "published"), isNull(books.deletedAt)))
    .orderBy(desc(books.updatedAt))
    .limit(limit);

  return withTags(db, rows);
}

export async function listPublishedBooksByCategorySlug(
  db: AppDb,
  categorySlug: string,
  limit = 50
): Promise<BookListRow[]> {
  const rows = await db
    .select({
      id: books.id,
      title: books.title,
      slug: books.slug,
      coverKey: books.coverKey,
      status: books.status,
      serialStatus: books.serialStatus,
      wordCount: books.wordCount,
      latestChapterTitle: books.latestChapterTitle,
      updatedAt: books.updatedAt,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
      categoryName: categories.name,
    })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .innerJoin(categories, eq(books.categoryId, categories.id))
    .where(
      and(
        eq(categories.slug, categorySlug),
        eq(categories.enabled, true),
        eq(books.status, "published"),
        isNull(books.deletedAt)
      )
    )
    .orderBy(desc(books.updatedAt))
    .limit(limit);

  return withTags(db, rows);
}

export async function searchBooks(db: AppDb, query: string, limit = 30): Promise<BookListRow[]> {
  const q = `%${query.trim()}%`;
  const rows = await db
    .selectDistinct({
      id: books.id,
      title: books.title,
      slug: books.slug,
      coverKey: books.coverKey,
      status: books.status,
      serialStatus: books.serialStatus,
      wordCount: books.wordCount,
      latestChapterTitle: books.latestChapterTitle,
      updatedAt: books.updatedAt,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
      categoryName: categories.name,
    })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .leftJoin(categories, eq(books.categoryId, categories.id))
    .leftJoin(bookTags, eq(bookTags.bookId, books.id))
    .leftJoin(tags, eq(bookTags.tagId, tags.id))
    .where(
      and(
        eq(books.status, "published"),
        isNull(books.deletedAt),
        or(like(books.title, q), like(authors.penName, q), like(tags.name, q))
      )
    )
    .orderBy(desc(books.updatedAt))
    .limit(limit);

  return withTags(db, rows);
}

export async function getBook(db: AppDb, bookId: string) {
  const map = await getBooksByIds(db, [bookId]);
  return map.get(bookId) ?? null;
}

/**
 * 批量取书籍详情（含标签），替代逐本 getBook 的 N+1 查询：
 * 无论多少本书都只发 2 条 SQL。ID 按 90 个一片分块，避开 D1 单语句约 100 个绑定参数的上限。
 */
export async function getBooksByIds(db: AppDb, bookIds: string[]) {
  const unique = [...new Set(bookIds)];
  const result = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof fetchBookRows>>[number]> & { tags: string[] }
  >();
  if (unique.length === 0) return result;

  const chunkSize = 90;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const [rows, tagRows] = await Promise.all([
      fetchBookRows(db, chunk),
      db
        .select({ bookId: bookTags.bookId, name: tags.name })
        .from(bookTags)
        .innerJoin(tags, eq(bookTags.tagId, tags.id))
        .where(inArray(bookTags.bookId, chunk)),
    ]);
    const tagsByBook = new Map<string, string[]>();
    for (const tagRow of tagRows) {
      const list = tagsByBook.get(tagRow.bookId) ?? [];
      list.push(tagRow.name);
      tagsByBook.set(tagRow.bookId, list);
    }
    for (const row of rows) {
      result.set(row.id, { ...row, tags: tagsByBook.get(row.id) ?? [] });
    }
  }
  return result;
}

function fetchBookRows(db: AppDb, bookIds: string[]) {
  return db
    .select({
      id: books.id,
      title: books.title,
      slug: books.slug,
      coverKey: books.coverKey,
      description: books.description,
      status: books.status,
      serialStatus: books.serialStatus,
      wordCount: books.wordCount,
      latestChapterId: books.latestChapterId,
      latestChapterTitle: books.latestChapterTitle,
      latestChapterAt: books.latestChapterAt,
      publishedAt: books.publishedAt,
      updatedAt: books.updatedAt,
      authorId: authors.id,
      authorName: sql<string>`coalesce(${books.authorName}, ${authors.penName})`,
      authorBio: authors.bio,
      categoryId: categories.id,
      categoryName: categories.name,
    })
    .from(books)
    .innerJoin(authors, eq(books.authorId, authors.id))
    .leftJoin(categories, eq(books.categoryId, categories.id))
    .where(and(inArray(books.id, bookIds), isNull(books.deletedAt)));
}

/**
 * 按章节的全局 sortOrder 走一遍，卷号一变就切一段。
 *
 * 原来是"按卷分组、组内再筛章节"，于是目录顺序由卷的 sortOrder 决定，作者在
 * 作品管理里改章节顺序后目录不跟着动；没有卷的章节（volumeId 为 null）
 * 更是直接从目录里消失。改成跟着章节走：目录永远等于章节顺序，卷名只是
 * 中间的分隔标题。同一卷被拆到两段时各自成段（`id` 带段序号保证 key 唯一），
 * 这正确反映了"这卷的章节不连续"这件事。
 */
function groupChaptersIntoSegments<T extends { volumeId: string | null }>(
  chapterRows: T[],
  volumeTitles: Map<string, string>
) {
  const segments: { id: string; volumeId: string | null; title: string; chapters: T[] }[] = [];
  for (const chapter of chapterRows) {
    const last = segments[segments.length - 1];
    if (last && last.volumeId === chapter.volumeId) {
      last.chapters.push(chapter);
      continue;
    }
    segments.push({
      id: `${chapter.volumeId ?? "unsorted"}#${segments.length}`,
      volumeId: chapter.volumeId,
      title: (chapter.volumeId ? volumeTitles.get(chapter.volumeId) : null) ?? "正文",
      chapters: [chapter],
    });
  }
  return segments;
}

/**
 * 作品详情页目录。
 *
 * includeUnpublished 默认 false：阅读页会拒绝未发布章节，详情页若照旧展示
 * 就成了必死的 404 入口。作者预览自己的草稿、审核员看待审内容时传 true。
 */
export async function listBookChapters(db: AppDb, bookId: string, includeUnpublished = false) {
  const volumeRows = await db
    .select({
      id: volumes.id,
      title: volumes.title,
      sortOrder: volumes.sortOrder,
    })
    .from(volumes)
    .where(eq(volumes.bookId, bookId))
    .orderBy(ascOrder(volumes.sortOrder));

  const chapterRows = await db
    .select({
      id: chapters.id,
      volumeId: chapters.volumeId,
      title: chapters.title,
      sortOrder: chapters.sortOrder,
      status: chapters.status,
      wordCount: chapters.wordCount,
      publishedAt: chapters.publishedAt,
    })
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, bookId),
        isNull(chapters.deletedAt),
        ...(includeUnpublished ? [] : [eq(chapters.status, "published")])
      )
    )
    .orderBy(ascOrder(chapters.sortOrder));

  const volumeTitles = new Map(volumeRows.map((volume) => [volume.id, volume.title]));
  return groupChaptersIntoSegments(chapterRows, volumeTitles).map((segment) => ({
    id: segment.id,
    title: segment.title,
    sortOrder: segment.chapters[0]?.sortOrder ?? 0,
    chapters: segment.chapters,
  }));
}

export async function getChapterMeta(db: AppDb, chapterId: string) {
  return db
    .select({
      id: chapters.id,
      bookId: chapters.bookId,
      volumeId: chapters.volumeId,
      title: chapters.title,
      sortOrder: chapters.sortOrder,
      status: chapters.status,
      wordCount: chapters.wordCount,
      currentVersionId: chapters.currentVersionId,
      publishedAt: chapters.publishedAt,
      bookTitle: books.title,
      bookSlug: books.slug,
      bookAuthorId: books.authorId,
    })
    .from(chapters)
    .innerJoin(books, eq(chapters.bookId, books.id))
    .where(eq(chapters.id, chapterId))
    .get();
}

/**
 * 只取阅读页翻页需要的最小信息：上一章/下一章 + 当前序号 + 总章数。
 *
 * 取代阅读页原先的 listBookChapters()：万字长篇有 2000+ 章，整表拉回后
 * 序列化到客户端约 250KB，且每翻一页都要重复一次。这里三条查询全部命中
 * chapters_book_id_sort_idx，返回体只有几十字节。
 */
export async function getChapterNavigation(
  db: AppDb,
  bookId: string,
  sortOrder: number,
  includeUnpublished = false
): Promise<{
  prev: { id: string; title: string } | null;
  next: { id: string; title: string } | null;
  currentIndex: number;
  totalChapters: number;
}> {
  const readable = and(
    eq(chapters.bookId, bookId),
    isNull(chapters.deletedAt),
    ...(includeUnpublished ? [] : [eq(chapters.status, "published")])
  );

  const [counts, prev, next] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)`,
        before: sql<number>`sum(case when ${chapters.sortOrder} < ${sortOrder} then 1 else 0 end)`,
      })
      .from(chapters)
      .where(readable)
      .get(),
    db
      .select({ id: chapters.id, title: chapters.title })
      .from(chapters)
      .where(and(readable, lt(chapters.sortOrder, sortOrder)))
      .orderBy(desc(chapters.sortOrder))
      .limit(1)
      .get(),
    db
      .select({ id: chapters.id, title: chapters.title })
      .from(chapters)
      .where(and(readable, gt(chapters.sortOrder, sortOrder)))
      .orderBy(ascOrder(chapters.sortOrder))
      .limit(1)
      .get(),
  ]);

  return {
    prev: prev ?? null,
    next: next ?? null,
    currentIndex: Number(counts?.before ?? 0),
    totalChapters: Number(counts?.total ?? 0),
  };
}

/** 按全书序号取章节 ID，供阅读页底部进度条跳章使用（无需把整份目录送到前端）。 */
export async function getChapterIdByIndex(
  db: AppDb,
  bookId: string,
  index: number,
  includeUnpublished = false
) {
  if (index < 0) return null;
  const row = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, bookId),
        isNull(chapters.deletedAt),
        ...(includeUnpublished ? [] : [eq(chapters.status, "published")])
      )
    )
    .orderBy(ascOrder(chapters.sortOrder))
    .limit(1)
    .offset(index)
    .get();
  return row?.id ?? null;
}

/**
 * 阅读页目录抽屉用的精简目录：只取 id + title，省掉 wordCount/status/publishedAt
 * 等抽屉里用不到的字段。配合按需加载，长篇目录不再进入阅读页首屏负载。
 */
export async function listBookTocMinimal(
  db: AppDb,
  bookId: string,
  includeUnpublished = false
) {
  const [volumeRows, chapterRows] = await Promise.all([
    db
      .select({ id: volumes.id, title: volumes.title })
      .from(volumes)
      .where(eq(volumes.bookId, bookId))
      .orderBy(ascOrder(volumes.sortOrder)),
    db
      .select({ id: chapters.id, volumeId: chapters.volumeId, title: chapters.title })
      .from(chapters)
      .where(
        and(
          eq(chapters.bookId, bookId),
          isNull(chapters.deletedAt),
          ...(includeUnpublished ? [] : [eq(chapters.status, "published")])
        )
      )
      .orderBy(ascOrder(chapters.sortOrder)),
  ]);

  const volumeTitles = new Map(volumeRows.map((volume) => [volume.id, volume.title]));
  return groupChaptersIntoSegments(chapterRows, volumeTitles).map((segment) => ({
    id: segment.id,
    title: segment.title,
    chapters: segment.chapters.map((chapter) => ({ id: chapter.id, title: chapter.title })),
  }));
}

async function withTags(db: AppDb, rows: Omit<BookListRow, "tags">[]): Promise<BookListRow[]> {
  if (rows.length === 0) return [];
  const bookIds = rows.map((row) => row.id);
  const tagRows = await db
    .select({ bookId: bookTags.bookId, name: tags.name })
    .from(bookTags)
    .innerJoin(tags, eq(bookTags.tagId, tags.id))
    .where(inArray(bookTags.bookId, bookIds));
  const byBook = new Map<string, string[]>();
  for (const row of tagRows) {
    const list = byBook.get(row.bookId) ?? [];
    list.push(row.name);
    byBook.set(row.bookId, list);
  }
  return rows.map((row) => ({ ...row, tags: byBook.get(row.id) ?? [] }));
}

// Drizzle 未导出 sqlite 的 lt/gt/asc 时的小包装，保持查询意图清晰
import { asc, gt, lt } from "drizzle-orm";
const ascOrder = asc;
