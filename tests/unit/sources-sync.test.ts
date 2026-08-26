import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { R2Bucket } from "@cloudflare/workers-types";
import { contentSources, sourceChapterLinks, sourceDomains, sourceSubscriptions } from "drizzle/schema";
import { eq } from "drizzle-orm";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createMemoryBucket, createSourceFixtures, makeRss } from "../helpers/sources-fixtures";
import { createSubscription, fetchPendingChapters, findDueSources, syncSubscriptionToc } from "~/server/sources/sync";
import { addDomain } from "~/server/sources/service";

/**
 * 端到端跑一遍订阅链路：域名授权 → 建源 → 订阅 → 拉目录 → 抓正文。
 * fetch 被替换成受控实现，但白名单、XML 解析、增量去重都是真代码。
 */

let db: AppDb;
let raw: DatabaseSync;
let bucket: R2Bucket;
let store: Map<string, string>;
let responses: Map<string, string>;
let requestLog: string[];

const sourceId = "src-1";
const userId = "user-1";

beforeEach(async () => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);

  const memory = createMemoryBucket();
  bucket = memory.bucket as unknown as R2Bucket;
  store = memory.store;

  responses = new Map();
  requestLog = [];

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      requestLog.push(url);
      const body = responses.get(url);
      if (body === undefined) {
        return Promise.resolve(
          new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
        );
      }
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/rss+xml" } })
      );
    })
  );

  raw.prepare("INSERT INTO user (id, name, email) VALUES (?, ?, ?)").run(userId, "运营", "op@test.local");
  await addDomain(db, {
    host: "feed.example.com",
    authorizationNote: "单测用的本地源，已确认授权",
    actorId: userId,
  });
  await db.insert(contentSources).values({
    id: sourceId,
    name: "测试连载",
    kind: "feed",
    endpoint: "https://feed.example.com/rss",
    status: "enabled",
    createdBy: userId,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

async function subscribe() {
  const result = await createSubscription(db, {
    sourceId,
    externalId: "https://feed.example.com/rss",
    title: "测试连载",
    actorId: userId,
  });
  return result.subscriptionId;
}

describe("域名白名单", () => {
  it("未授权的域名拒绝抓取，且不产生任何出站请求", async () => {
    await db.insert(contentSources).values({
      id: "src-blocked",
      name: "未授权源",
      kind: "feed",
      endpoint: "https://evil.example.org/rss",
      status: "enabled",
      createdBy: userId,
    });
    const sub = await createSubscription(db, {
      sourceId: "src-blocked",
      externalId: "https://evil.example.org/rss",
      title: "未授权",
      actorId: userId,
    });
    const outcome = await syncSubscriptionToc(db, undefined, sub.subscriptionId, "manual");
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toMatch(/未获授权确认/);
    expect(requestLog).toHaveLength(0);
  });

  it("授权依据太短时拒绝登记", async () => {
    await expect(
      addDomain(db, { host: "x.example.net", authorizationNote: "无", actorId: userId })
    ).rejects.toThrow(/授权依据/);
  });

  it("子域自动继承父域授权", async () => {
    responses.set(
      "https://cdn.feed.example.com/rss",
      makeRss([{ title: "第1章", link: "https://cdn.feed.example.com/c/1" }])
    );
    await db.insert(contentSources).values({
      id: "src-sub",
      name: "子域源",
      kind: "feed",
      endpoint: "https://cdn.feed.example.com/rss",
      status: "enabled",
      createdBy: userId,
    });
    const sub = await createSubscription(db, {
      sourceId: "src-sub",
      externalId: "https://cdn.feed.example.com/rss",
      title: "子域源",
      actorId: userId,
    });
    const outcome = await syncSubscriptionToc(db, undefined, sub.subscriptionId, "manual");
    expect(outcome.status).toBe("ok");
  });
});

describe("目录同步与增量去重", () => {
  it("首次同步登记全部章节为 pending", async () => {
    responses.set(
      "https://feed.example.com/rss",
      makeRss([
        { title: "第3章", link: "https://feed.example.com/c/3" },
        { title: "第2章", link: "https://feed.example.com/c/2" },
        { title: "第1章", link: "https://feed.example.com/c/1" },
      ])
    );
    const subscriptionId = await subscribe();
    const outcome = await syncSubscriptionToc(db, undefined, subscriptionId, "manual");

    expect(outcome.status).toBe("ok");
    expect(outcome.chaptersAdded).toBe(3);

    const links = await db
      .select()
      .from(sourceChapterLinks)
      .where(eq(sourceChapterLinks.subscriptionId, subscriptionId))
      .all();
    // feed 是新→旧，入库要反转成阅读顺序
    expect(links.sort((a, b) => a.sortOrder - b.sortOrder).map((l) => l.externalTitle)).toEqual([
      "第1章",
      "第2章",
      "第3章",
    ]);
    expect(links.every((l) => l.fetchStatus === "pending")).toBe(true);
  });

  it("目录未变时整本跳过", async () => {
    responses.set(
      "https://feed.example.com/rss",
      makeRss([{ title: "第1章", link: "https://feed.example.com/c/1" }])
    );
    const subscriptionId = await subscribe();
    await syncSubscriptionToc(db, undefined, subscriptionId, "manual");
    const second = await syncSubscriptionToc(db, undefined, subscriptionId, "manual");

    expect(second.status).toBe("skipped");
    expect(second.message).toBe("目录未变化");
    expect(second.chaptersAdded).toBe(0);
  });

  it("只登记新增章节，已有的不重复建", async () => {
    responses.set(
      "https://feed.example.com/rss",
      makeRss([{ title: "第1章", link: "https://feed.example.com/c/1" }])
    );
    const subscriptionId = await subscribe();
    await syncSubscriptionToc(db, undefined, subscriptionId, "manual");

    // 源端更新：多了第 2 章
    responses.set(
      "https://feed.example.com/rss",
      makeRss([
        { title: "第2章", link: "https://feed.example.com/c/2" },
        { title: "第1章", link: "https://feed.example.com/c/1" },
      ])
    );
    const outcome = await syncSubscriptionToc(db, undefined, subscriptionId, "manual");

    expect(outcome.chaptersAdded).toBe(1);
    const links = await db
      .select()
      .from(sourceChapterLinks)
      .where(eq(sourceChapterLinks.subscriptionId, subscriptionId))
      .all();
    expect(links).toHaveLength(2);
  });

  it("暂停的订阅不同步", async () => {
    responses.set(
      "https://feed.example.com/rss",
      makeRss([{ title: "第1章", link: "https://feed.example.com/c/1" }])
    );
    const subscriptionId = await subscribe();
    await db
      .update(sourceSubscriptions)
      .set({ status: "paused" })
      .where(eq(sourceSubscriptions.id, subscriptionId));

    const outcome = await syncSubscriptionToc(db, undefined, subscriptionId, "manual");
    expect(outcome.status).toBe("skipped");
    expect(outcome.message).toBe("订阅已暂停");
  });

  it("重复订阅同一本返回既有订阅，不建第二本书", async () => {
    responses.set("https://feed.example.com/rss", makeRss([]));
    const first = await subscribe();
    const again = await createSubscription(db, {
      sourceId,
      externalId: "https://feed.example.com/rss",
      title: "测试连载",
      actorId: userId,
    });
    expect(again.created).toBe(false);
    expect(again.subscriptionId).toBe(first);
  });
});

describe("正文抓取", () => {
  it("把 pending 章节写进 R2 与 chapters，并标记 fetched", async () => {
    responses.set(
      "https://feed.example.com/rss",
      makeRss([
        { title: "第2章", link: "https://feed.example.com/c/2", content: "<p>二段甲</p><p>二段乙</p>" },
        { title: "第1章", link: "https://feed.example.com/c/1", content: "<p>一段甲</p>" },
      ])
    );
    const subscriptionId = await subscribe();
    await syncSubscriptionToc(db, undefined, subscriptionId, "manual");

    const result = await fetchPendingChapters(db, bucket, subscriptionId);
    expect(result.fetched).toBe(2);
    expect(result.failed).toBe(0);

    const links = await db
      .select()
      .from(sourceChapterLinks)
      .where(eq(sourceChapterLinks.subscriptionId, subscriptionId))
      .all();
    expect(links.every((l) => l.fetchStatus === "fetched")).toBe(true);
    expect(links.every((l) => l.chapterId)).toBe(true);

    // R2 里应有两份正文，段落被正确切分
    expect(store.size).toBe(2);
    const docs = [...store.values()].map((raw) => JSON.parse(raw) as { paragraphs: { text: string }[] });
    const allParagraphs = docs.flatMap((doc) => doc.paragraphs.map((p) => p.text));
    expect(allParagraphs).toContain("一段甲");
    expect(allParagraphs).toContain("二段甲");
    expect(allParagraphs).toContain("二段乙");

    const chapterRows = raw.prepare("SELECT status, title FROM chapters ORDER BY sort_order").all() as {
      status: string;
      title: string;
    }[];
    // 源同步内容一律先落草稿，不直接公开
    expect(chapterRows.every((row) => row.status === "draft")).toBe(true);
    expect(chapterRows.map((row) => row.title)).toEqual(["第1章", "第2章"]);
  });

  it("已同步章节数写回订阅", async () => {
    responses.set(
      "https://feed.example.com/rss",
      makeRss([{ title: "第1章", link: "https://feed.example.com/c/1" }])
    );
    const subscriptionId = await subscribe();
    await syncSubscriptionToc(db, undefined, subscriptionId, "manual");
    await fetchPendingChapters(db, bucket, subscriptionId);

    const sub = await db
      .select()
      .from(sourceSubscriptions)
      .where(eq(sourceSubscriptions.id, subscriptionId))
      .get();
    expect(sub?.syncedChapterCount).toBe(1);
  });

  it("重复执行不会重复建章（队列重投安全）", async () => {
    responses.set(
      "https://feed.example.com/rss",
      makeRss([{ title: "第1章", link: "https://feed.example.com/c/1" }])
    );
    const subscriptionId = await subscribe();
    await syncSubscriptionToc(db, undefined, subscriptionId, "manual");
    await fetchPendingChapters(db, bucket, subscriptionId);
    // 人为退回 pending，模拟队列重投
    await db
      .update(sourceChapterLinks)
      .set({ fetchStatus: "pending" })
      .where(eq(sourceChapterLinks.subscriptionId, subscriptionId));
    await fetchPendingChapters(db, bucket, subscriptionId);

    const count = raw.prepare("SELECT COUNT(*) AS c FROM chapters").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("目录自带全文时不再逐章回源，省掉正文请求", async () => {
    responses.set(
      "https://feed.example.com/rss",
      makeRss([
        { title: "第2章", link: "https://feed.example.com/c/2", content: "<p>二</p>" },
        { title: "第1章", link: "https://feed.example.com/c/1", content: "<p>一</p>" },
      ])
    );
    const subscriptionId = await subscribe();
    await syncSubscriptionToc(db, undefined, subscriptionId, "manual");
    requestLog.length = 0;

    const result = await fetchPendingChapters(db, bucket, subscriptionId);
    expect(result.fetched).toBe(2);
    // 只应请求目录那一次，两个章节 URL 都不该被访问
    expect(requestLog).toEqual(["https://feed.example.com/rss"]);
    expect(requestLog).not.toContain("https://feed.example.com/c/1");
  });

  it("单章失败只标记该章，其余照常入库", async () => {
    // 空 description 的条目不带 inline 正文，会回源；其 URL 不在 responses 里 → 404
    responses.set(
      "https://feed.example.com/rss",
      makeRss([
        { title: "坏章", link: "https://feed.example.com/c/bad", content: "" },
        { title: "好章", link: "https://feed.example.com/c/ok", content: "<p>好章正文</p>" },
      ])
    );
    const subscriptionId = await subscribe();
    await syncSubscriptionToc(db, undefined, subscriptionId, "manual");

    const result = await fetchPendingChapters(db, bucket, subscriptionId);
    expect(result.fetched).toBe(1);
    expect(result.failed).toBe(1);

    const links = await db
      .select()
      .from(sourceChapterLinks)
      .where(eq(sourceChapterLinks.subscriptionId, subscriptionId))
      .all();
    const bad = links.find((l) => l.externalTitle === "坏章");
    const good = links.find((l) => l.externalTitle === "好章");
    expect(bad?.fetchStatus).toBe("failed");
    expect(bad?.fetchError).toBeTruthy();
    expect(good?.fetchStatus).toBe("fetched");
    // 好章正文照常落库
    expect(store.size).toBe(1);
  });
});

describe("findDueSources", () => {
  it("从未同步过的源立即到期", async () => {
    const due = await findDueSources(db);
    expect(due.map((row) => row.id)).toContain(sourceId);
  });

  it("未到间隔的源不返回，超过间隔的返回", async () => {
    const now = new Date("2026-08-26T12:00:00Z");
    await db
      .update(contentSources)
      .set({ lastSyncAt: new Date(now.getTime() - 60_000), syncIntervalMinutes: 360 })
      .where(eq(contentSources.id, sourceId));
    expect((await findDueSources(db, now)).map((r) => r.id)).not.toContain(sourceId);

    await db
      .update(contentSources)
      .set({ lastSyncAt: new Date(now.getTime() - 400 * 60_000) })
      .where(eq(contentSources.id, sourceId));
    expect((await findDueSources(db, now)).map((r) => r.id)).toContain(sourceId);
  });

  it("停用的源不参与调度", async () => {
    await db
      .update(contentSources)
      .set({ status: "disabled" })
      .where(eq(contentSources.id, sourceId));
    expect((await findDueSources(db)).map((r) => r.id)).not.toContain(sourceId);
  });
});

describe("撤销域名授权", () => {
  it("撤销后该域名下的源立即变为 blocked", async () => {
    const { removeDomain } = await import("~/server/sources/service");
    await removeDomain(db, "feed.example.com", userId);
    const source = await db.select().from(contentSources).where(eq(contentSources.id, sourceId)).get();
    expect(source?.status).toBe("blocked");
    const remaining = await db.select().from(sourceDomains).all();
    expect(remaining).toHaveLength(0);
  });
});
