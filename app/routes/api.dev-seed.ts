import { and, eq } from "drizzle-orm";
import {
  authors,
  books,
  bookTags,
  categories,
  chapterVersions,
  chapters,
  permissions,
  recommendationItems,
  recommendationSlots,
  rolePermissions,
  roles,
  siteSettings,
  tags,
  userRoles,
  users,
  volumes,
} from "drizzle/schema";
import type { Route } from "./+types/api.dev-seed";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import {
  seedBooks,
  seedCategories,
  seedPermissions,
  seedRolePermissions,
  seedRoles,
  seedTags,
} from "~/server/seed-data";
import { putChapterContent } from "~/server/storage/chapter-content";
import { chapterVersionKey } from "~/server/storage/keys";

function isLocalUrl(url: string) {
  return url.includes("localhost") || url.includes("127.0.0.1") || url.includes("::1");
}

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  if (!isLocalUrl(env.BETTER_AUTH_URL)) {
    return Response.json({ error: "seed is only available in local development" }, { status: 403 });
  }

  const db = createDb(env.DB_APP);
  const marker = await db
    .select()
    .from(siteSettings)
    .where(eq(siteSettings.key, "seed.completed"))
    .get();
  if (marker) {
    return Response.json({ ok: true, seeded: false, message: "already seeded" });
  }

  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const categoryIds: Record<string, string> = {};
  const tagIds: Record<string, string> = {};

  for (const category of seedCategories) {
    const inserted = await db
      .insert(categories)
      .values({ id: crypto.randomUUID(), name: category.name, slug: category.slug })
      .onConflictDoNothing()
      .returning({ id: categories.id, slug: categories.slug })
      .get();
    if (inserted) {
      categoryIds[inserted.slug] = inserted.id;
    } else {
      const existing = await db
        .select()
        .from(categories)
        .where(eq(categories.slug, category.slug))
        .get();
      if (existing) categoryIds[existing.slug] = existing.id;
    }
  }

  for (const tagName of seedTags) {
    const inserted = await db
      .insert(tags)
      .values({
        id: crypto.randomUUID(),
        name: tagName,
        normalized: tagName.toLocaleLowerCase("zh-CN"),
      })
      .onConflictDoNothing()
      .returning({ id: tags.id, name: tags.name })
      .get();
    if (inserted) {
      tagIds[inserted.name] = inserted.id;
    } else {
      const existing = await db.select().from(tags).where(eq(tags.name, tagName)).get();
      if (existing) tagIds[existing.name] = existing.id;
    }
  }

  const roleIds: Record<string, string> = {};
  for (const role of seedRoles) {
    const inserted = await db
      .insert(roles)
      .values({
        id: crypto.randomUUID(),
        code: role.code,
        name: role.name,
        description: role.description,
      })
      .onConflictDoNothing()
      .returning({ id: roles.id, code: roles.code })
      .get();
    if (inserted) {
      roleIds[inserted.code] = inserted.id;
    } else {
      const existing = await db.select().from(roles).where(eq(roles.code, role.code)).get();
      if (existing) roleIds[existing.code] = existing.id;
    }
  }

  const permissionIds: Record<string, string> = {};
  for (const permission of seedPermissions) {
    const inserted = await db
      .insert(permissions)
      .values({ id: crypto.randomUUID(), code: permission.code, name: permission.name })
      .onConflictDoNothing()
      .returning({ id: permissions.id, code: permissions.code })
      .get();
    if (inserted) {
      permissionIds[inserted.code] = inserted.id;
    } else {
      const existing = await db
        .select()
        .from(permissions)
        .where(eq(permissions.code, permission.code))
        .get();
      if (existing) permissionIds[existing.code] = existing.id;
    }
  }

  for (const [roleCode, codes] of Object.entries(seedRolePermissions)) {
    const roleId = roleIds[roleCode];
    if (!roleId) continue;
    for (const code of codes) {
      const permissionId = permissionIds[code];
      if (!permissionId) continue;
      await db.insert(rolePermissions).values({ roleId, permissionId }).onConflictDoNothing();
    }
  }

  let readerUserId: string;
  let authorUserId: string;
  try {
    const reader = await auth.api.signUpEmail({
      body: { email: "reader@yuedu.test", password: "reader123", name: "青柠读者" },
      headers: request.headers,
    });
    readerUserId = reader.user.id;
  } catch {
    const session = await auth.api.getSession({ headers: request.headers });
    readerUserId = session?.user.id ?? "";
  }

  try {
    const author = await auth.api.signUpEmail({
      body: { email: "author@yuedu.test", password: "author123", name: "老渡鸦" },
      headers: request.headers,
    });
    authorUserId = author.user.id;
  } catch {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "author@yuedu.test"))
      .get();
    authorUserId = existing?.id ?? "";
  }

  if (authorUserId) {
    const authorRoleId = roleIds.author;
    if (authorRoleId) {
      await db
        .insert(userRoles)
        .values({ userId: authorUserId, roleId: authorRoleId, reason: "seed" })
        .onConflictDoNothing();
    }
  }

  const authorRow = await db
    .insert(authors)
    .values({
      id: crypto.randomUUID(),
      userId: authorUserId || readerUserId,
      penName: "老渡鸦",
      bio: "白天修飞船，晚上写故事。代表作《星海拾荒者》。",
    })
    .returning()
    .get();

  let seededBooks = 0;
  let seededChapters = 0;
  for (const seedBook of seedBooks) {
    const categoryId = categoryIds[seedBook.categorySlug];
    const bookId = crypto.randomUUID();
    const now = new Date();
    await db.insert(books).values({
      id: bookId,
      authorId: authorRow.id,
      categoryId,
      title: seedBook.title,
      slug: seedBook.slug,
      description: seedBook.description,
      status: "published",
      serialStatus: "ongoing",
      wordCount: 0,
      publishedAt: now,
    });

    for (const tagName of seedBook.tagNames) {
      const tagId = tagIds[tagName];
      if (tagId) {
        await db.insert(bookTags).values({ bookId, tagId }).onConflictDoNothing();
      }
    }

    const volumeId = crypto.randomUUID();
    await db.insert(volumes).values({ id: volumeId, bookId, title: "正文", sortOrder: 0 });

    let totalWords = 0;
    for (const [i, chapter] of seedBook.chapters.entries()) {
      const chapterId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const paragraphs = chapter.paragraphs.map((text, index) => ({ id: `p${index + 1}`, text }));
      const wordCount = chapter.paragraphs.reduce((sum, p) => sum + p.length, 0);
      const contentText = JSON.stringify({
        version: 1,
        bookId,
        chapterId,
        title: chapter.title,
        paragraphs,
        contentHash: "",
        wordCount,
      });
      const contentHash = await sha256Hex(contentText);
      const doc = {
        version: 1,
        bookId,
        chapterId,
        title: chapter.title,
        paragraphs,
        contentHash,
        wordCount,
      };
      const key = chapterVersionKey(bookId, chapterId, versionId);
      await putChapterContent(env.R2_CONTENT, key, doc);

      await db.insert(chapters).values({
        id: chapterId,
        bookId,
        volumeId,
        title: chapter.title,
        sortOrder: i + 1,
        status: "published",
        wordCount,
        currentVersionId: versionId,
        publishedAt: new Date(now.getTime() + (i + 1) * 60000),
      });
      await db.insert(chapterVersions).values({
        id: versionId,
        chapterId,
        version: 1,
        r2Key: key,
        contentHash,
        title: chapter.title,
        wordCount,
        isPublished: true,
        createdBy: authorRow.userId,
      });

      totalWords += wordCount;
      if (i === seedBook.chapters.length - 1) {
        await db
          .update(books)
          .set({
            latestChapterId: chapterId,
            latestChapterTitle: chapter.title,
            latestChapterAt: new Date(now.getTime() + (i + 1) * 60000),
          })
          .where(eq(books.id, bookId));
      }
      seededChapters++;
    }

    await db.update(books).set({ wordCount: totalWords }).where(eq(books.id, bookId));
    seededBooks++;
  }

  const slotId = crypto.randomUUID();
  await db.insert(recommendationSlots).values({
    id: slotId,
    code: "home-editor",
    name: "首页编辑推荐",
    sortOrder: 0,
  });
  const allBooks = await db
    .select({ id: books.id })
    .from(books)
    .where(and(eq(books.status, "published")))
    .limit(5);
  for (const [i, book] of allBooks.entries()) {
    await db
      .insert(recommendationItems)
      .values({ id: crypto.randomUUID(), slotId, bookId: book.id, sortOrder: i });
  }

  await db.insert(siteSettings).values({
    id: crypto.randomUUID(),
    key: "seed.completed",
    value: { version: 1, at: new Date().toISOString() },
  });

  return Response.json({
    ok: true,
    seeded: true,
    stats: {
      books: seededBooks,
      chapters: seededChapters,
      categories: seedCategories.length,
      tags: seedTags.length,
    },
  });
}
