import { eq } from "drizzle-orm";
import { authors } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { hasAnyRole, roleCodes } from "~/server/security/rbac";

/**
 * 能否看到未发布章节：本人是该作品作者，或具备审核/管理角色。
 *
 * 读者只应看到已发布章节 —— 否则详情页会列出阅读页必然 404 的入口；
 * 但作者要能预览自己的草稿，审核员要能看待审内容，所以按访问者判定而非一刀切。
 */
export async function canPreviewUnpublished(
  db: AppDb,
  userId: string | null,
  bookAuthorId: string
): Promise<boolean> {
  if (!userId) return false;

  const [owned, privileged] = await Promise.all([
    db
      .select({ id: authors.id })
      .from(authors)
      .where(eq(authors.userId, userId))
      .get()
      .then((row) => Boolean(row) && row!.id === bookAuthorId),
    hasAnyRole(db, userId, [roleCodes.moderator, roleCodes.admin, roleCodes.superAdmin]),
  ]);

  return owned || privileged;
}
