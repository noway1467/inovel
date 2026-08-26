import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { contentSources } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { batchImportSources } from "~/server/sources/batch-import";
import { listSourcesFiltered } from "~/server/sources/service";

/**
 * 用真实抓下来的清单文件跑完整导入路径：
 * fetch → 判别格式 → 转换 → 建源。
 *
 * fetch 被替换成读本地文件，但格式判别、转换、建源都是真代码。
 * 清单文件不入库（见 .gitignore），缺失时跳过。
 */

const bookListPath = "_bs.json";
const rssListPath = "_rss.json";

let db: AppDb;
let raw: DatabaseSync;

beforeEach(() => {
  const sqlite = createSqliteD1();
  raw = sqlite.raw;
  createSourceFixtures(raw);
  db = createDb(sqlite.d1);
  raw.prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)").run("u1", "运营", "op@example.org");
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

/** 模拟书源站的 302 → CDN 行为 */
function stubFetchWith(body: string, finalUrl: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      const response = new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(response, "url", { value: finalUrl });
      return Promise.resolve(response);
    })
  );
}

describe.skipIf(!existsSync(bookListPath))("真实书源合集：完整导入路径", () => {
  it("从清单地址导入，建出可用的源", async () => {
    const body = readFileSync(bookListPath, "utf8");
    stubFetchWith(body, "https://cdn.example.net/gh/repo/file.json");

    const result = await batchImportSources(db, {
      url: "https://list.example.org/shuyuans/json/id/1244.json",
      actorId: "u1",
    });

    expect(result.format).toBe("bookSource");
    // 实测基线：600 条里 209 条可导入
    expect(result.totals.created).toBeGreaterThan(150);
    expect(result.finalUrl).toBe("https://cdn.example.net/gh/repo/file.json");
    expect(result.bytes).toBeGreaterThan(1_000_000);

    // 建出来的源默认启用，可直接用于搜索
    const enabled = await listSourcesFiltered(db, { status: "enabled" });
    expect(enabled.length).toBe(result.totals.created);
  });

  it("跳过的源都带可读原因，不静默丢弃", async () => {
    const body = readFileSync(bookListPath, "utf8");
    stubFetchWith(body, "https://cdn.example.net/x.json");
    const result = await batchImportSources(db, { url: "https://list.example.org/x.json", actorId: "u1" });

    expect(result.rejected.length).toBeGreaterThan(0);
    for (const item of result.rejected) {
      expect(item.reason.length).toBeGreaterThan(0);
    }
    // 多数跳过应是"无目录规则"（有声源与发现页专用源）
    const noToc = result.rejected.filter((r) => /目录规则/.test(r.reason));
    expect(noToc.length).toBeGreaterThan(result.rejected.length / 2);
  });

  it("重复导入同一清单不堆重复源", async () => {
    const body = readFileSync(bookListPath, "utf8");
    stubFetchWith(body, "https://cdn.example.net/x.json");

    const first = await batchImportSources(db, { url: "https://list.example.org/x.json", actorId: "u1" });
    const second = await batchImportSources(db, { url: "https://list.example.org/x.json", actorId: "u1" });

    expect(second.totals.created).toBe(0);
    expect(second.totals.reused).toBe(first.totals.created);
    const rows = await db.select().from(contentSources).all();
    expect(rows).toHaveLength(first.totals.created);
  });

  it("保留搜索能力的源占多数，可用于跨源搜书", async () => {
    const body = readFileSync(bookListPath, "utf8");
    stubFetchWith(body, "https://cdn.example.net/x.json");
    await batchImportSources(db, { url: "https://list.example.org/x.json", actorId: "u1" });

    const rows = await db.select().from(contentSources).all();
    const withSearch = rows.filter((row) => {
      const config = row.config as { searchUrl?: string | null } | null;
      return Boolean(config?.searchUrl);
    });
    // 实测 209 个可导入里 174 个支持搜索
    expect(withSearch.length / rows.length).toBeGreaterThan(0.7);
  });
});

describe.skipIf(!existsSync(rssListPath))("真实订阅源：完整导入路径", () => {
  it("判别为订阅源并按 feed 接入", async () => {
    const body = readFileSync(rssListPath, "utf8");
    stubFetchWith(body, "https://cdn.example.net/rss.json");

    const result = await batchImportSources(db, {
      url: "https://list.example.org/rss/json/id/193.json",
      actorId: "u1",
    });

    expect(result.format).toBe("rssSource");
    expect(result.totals.created).toBeGreaterThan(0);
    expect(result.created[0]?.kind).toBe("feed");
    // 书签式订阅源应给出提示，让运营方知道要测连通性
    expect(result.warned.length).toBeGreaterThan(0);
  });
});
