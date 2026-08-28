import { eq, sql } from "drizzle-orm";
import { sourceRepos, sourceRepoStatus } from "drizzle/schema";
import type { AppDb } from "~/server/db";
import { batchImportSources } from "~/server/sources/batch-import";

/**
 * 书源订阅（清单地址）的增删与重拉。
 *
 * 定位：开源阅读里的"书源订阅"。用户加一个清单地址，之后清单作者修了规则、
 * 加了站点，这边按间隔重拉一次就跟上了。原先只有一次性的批量导入 ——
 * 导完即断联，清单更新得手工再粘一遍，而书源失效是常态。
 *
 * 真正的导入逻辑全部复用 batchImportSources：同地址复用、按 converterVersion
 * 升级、格式自动判别都在那边，这里只负责"记住地址 + 到期再跑一次 + 记账"。
 */

/** 重拉间隔下限。清单是别人的服务器，别一小时一次去刷。 */
const minIntervalMinutes = 360;
const maxIntervalMinutes = 20160;
/** 连续失败退避的等待上限：7 天。 */
const maxBackoffMinutes = 7 * 24 * 60;

export interface AddRepoInput {
  url: string;
  name?: string | null;
  syncIntervalMinutes?: number | null;
  actorId: string;
}

export interface RepoSyncOutcome {
  repoId: string;
  name: string;
  created: number;
  updated: number;
  sourceCount: number;
  status: "ok" | "failed";
  message: string;
}

function clampInterval(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1440;
  return Math.min(maxIntervalMinutes, Math.max(minIntervalMinutes, Math.round(value)));
}

/**
 * 从地址猜个展示名。
 *
 * 清单 JSON 本身没有"清单名"这个字段（书源数组里每项才有名字），
 * 所以拿域名 + 路径末段凑一个，用户可以自己改。
 */
function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
    const stem = tail.replace(/\.(json|txt)$/i, "");
    return (stem ? `${parsed.hostname} / ${stem}` : parsed.hostname).slice(0, 100);
  } catch {
    return url.slice(0, 100);
  }
}

/**
 * 剥掉分享链接的壳，取出真正的 http(s) 清单地址。
 *
 * 阅读一类的 App 分享出来的是 `legado://import/bookSource?src=<真地址>`，
 * 也有 `yuedu://`、`shuyuan://` 等变体，src 可能再套一层 URL 编码。
 * 存壳有两个问题：唯一索引形同虚设（同一份清单两种壳=两行），
 * 而且 parseSourceUrl 只放行 http/https，到期重拉会直接失败。
 *
 * 认不出壳就原样返回 —— 交给 parseSourceUrl 去判，错误信息在那边更准。
 */
export function unwrapShareUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  // 壳里的真地址一般挂在 src / url 查询参数上
  const fromQuery = /[?&](?:src|url)=([^&]+)/i.exec(trimmed)?.[1];
  if (fromQuery) {
    try {
      const decoded = decodeURIComponent(fromQuery);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      // 编码坏了就当认不出，往下走
    }
  }

  // 没有查询参数的形态：legado://import/bookSource/https://…
  const embedded = /https?:\/\/[^\s"'<>]+/i.exec(trimmed)?.[0];
  return embedded ?? trimmed;
}

/** 添加订阅并立即拉一次 —— 加完就该看到源，不必等 Cron。 */
export async function addRepo(db: AppDb, input: AddRepoInput): Promise<RepoSyncOutcome> {
  const raw = input.url.trim();
  if (!raw) throw new Error("需要清单地址");

  const url = unwrapShareUrl(raw);

  const existing = await db.select().from(sourceRepos).where(eq(sourceRepos.url, url)).get();
  const repoId = existing?.id ?? crypto.randomUUID();

  if (!existing) {
    await db.insert(sourceRepos).values({
      id: repoId,
      name: (input.name?.trim() || nameFromUrl(url)).slice(0, 100),
      url,
      status: sourceRepoStatus.active,
      syncIntervalMinutes: clampInterval(input.syncIntervalMinutes),
      createdBy: input.actorId,
    });
  } else if (input.name?.trim()) {
    await db
      .update(sourceRepos)
      .set({ name: input.name.trim().slice(0, 100), updatedAt: new Date() })
      .where(eq(sourceRepos.id, repoId));
  }

  return await syncRepo(db, repoId, input.actorId);
}

export async function listRepos(db: AppDb) {
  return await db.select().from(sourceRepos).orderBy(sourceRepos.createdAt).all();
}

export async function removeRepo(db: AppDb, repoId: string): Promise<void> {
  /*
    只删订阅关系，不删它带来的源。

    源可能已经被订阅了书、攒了阅读进度；因为退订一份清单就连带删掉，
    损失和用户预期完全不符。清单没了只是不再自动更新。
  */
  await db.delete(sourceRepos).where(eq(sourceRepos.id, repoId));
}

export async function setRepoStatus(
  db: AppDb,
  repoId: string,
  status: "active" | "paused"
): Promise<void> {
  await db
    .update(sourceRepos)
    .set({ status, updatedAt: new Date() })
    .where(eq(sourceRepos.id, repoId));
}

/** 重拉一份清单：新源建起来，已有源按新规则升级。 */
export async function syncRepo(
  db: AppDb,
  repoId: string,
  actorId: string
): Promise<RepoSyncOutcome> {
  const repo = await db.select().from(sourceRepos).where(eq(sourceRepos.id, repoId)).get();
  if (!repo) throw new Error("订阅不存在");

  try {
    const result = await batchImportSources(db, { url: repo.url, actorId });
    const created = result.created.length;
    const updated = result.reused.length;
    const sourceCount = created + updated;
    const message =
      `新增 ${created} 个源，已有 ${updated} 个` +
      (result.droppedCount > 0 ? `，跳过 ${result.droppedCount} 个不可用` : "");

    await db
      .update(sourceRepos)
      .set({
        lastSyncAt: new Date(),
        lastSyncStatus: "ok",
        lastSyncMessage: message,
        consecutiveFailures: 0,
        lastCreatedCount: created,
        lastUpdatedCount: updated,
        sourceCount,
        updatedAt: new Date(),
      })
      .where(eq(sourceRepos.id, repoId));

    return { repoId, name: repo.name, created, updated, sourceCount, status: "ok", message };
  } catch (error) {
    const message = error instanceof Error ? error.message : "拉取失败";
    await db
      .update(sourceRepos)
      .set({
        lastSyncAt: new Date(),
        lastSyncStatus: "failed",
        lastSyncMessage: message.slice(0, 500),
        // 用 SQL 自增，避免读改写之间被别的同步覆盖
        consecutiveFailures: sql`${sourceRepos.consecutiveFailures} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(sourceRepos.id, repoId));

    return {
      repoId,
      name: repo.name,
      created: 0,
      updated: 0,
      sourceCount: repo.sourceCount,
      status: "failed",
      message,
    };
  }
}

/** 到期判断本身不碰数据库，单独拆出来好测。 */
export interface RepoDueFields {
  syncIntervalMinutes: number;
  lastSyncAt: Date | null;
  consecutiveFailures: number;
}

export function isRepoDue(repo: RepoDueFields, now: Date): boolean {
  if (!repo.lastSyncAt) return true;
  const backoff = 2 ** Math.min(repo.consecutiveFailures, 4);
  // 上限落在等待时长上，不是倍数上：1 天的间隔连失败 4 次会推到 16 天，太久了
  const waitMinutes = Math.min(repo.syncIntervalMinutes * backoff, maxBackoffMinutes);
  return repo.lastSyncAt.getTime() + waitMinutes * 60_000 <= now.getTime();
}

/**
 * 挑出到期的订阅，供 Cron 调度。
 *
 * 连续失败的往后退（指数退避，上限 7 天）：清单地址失效是常态，
 * 每天照原间隔去撞一个 404 只是白烧配额。
 */
export async function findDueRepos(db: AppDb, now = new Date()) {
  const rows = await db
    .select()
    .from(sourceRepos)
    .where(eq(sourceRepos.status, sourceRepoStatus.active))
    .all();

  return rows.filter((row) => isRepoDue(row, now));
}
