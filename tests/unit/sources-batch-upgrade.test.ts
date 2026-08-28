import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { contentSources } from "drizzle/schema";
import { createDb, type AppDb } from "~/server/db";
import { createSqliteD1 } from "../helpers/sqlite-d1";
import { createSourceFixtures } from "../helpers/sources-fixtures";
import { batchImportSources } from "~/server/sources/batch-import";

let db: AppDb;
let raw: ReturnType<typeof createSqliteD1>["raw"];
const userId = "user-1";

const freshSource = {
  bookSourceName: "目录升级源",
  bookSourceUrl: "https://upgrade.example.org",
  searchUrl: "/search?q={{key}}",
  ruleSearch: {
    bookList: ".result",
    name: "h3@text",
    author: ".author@text",
    bookUrl: "a@href",
  },
  ruleBookInfo: {
    tocUrl: '{{java.put("url",baseUrl); "/api/toc"}},{ "method": "POST", "body": "bid=1" }',
  },
  ruleToc: {
    chapterList: "$.data",
    chapterName: "$.title",
    chapterUrl: "@get:{url}p{{$.ordernum}}.html",
  },
  ruleContent: { content: "#content@html" },
};

describe("同地址书源配置升级", () => {
  beforeEach(async () => {
    const sqlite = createSqliteD1();
    raw = sqlite.raw;
    createSourceFixtures(raw);
    db = createDb(sqlite.d1);
    raw.prepare("INSERT INTO user (id, name, email) VALUES (?,?,?)").run(userId, "运营", "op@example.org");
  });

  it("重新导入新版清单时覆盖旧版转换结果，而不是继续复用残缺目录", async () => {
    await db.insert(contentSources).values({
      id: "old-source",
      name: "旧配置",
      kind: "rules",
      endpoint: "https://upgrade.example.org/",
      status: "enabled",
      config: {
        converterVersion: 0,
        infoTocUrl: null,
        tocMode: "detect",
        tocList: null,
        tocName: null,
        tocUrl: null,
        contentRule: "#content@html",
      },
      createdBy: userId,
    });

    const result = await batchImportSources(db, {
      text: JSON.stringify([freshSource]),
      actorId: userId,
    });
    expect(result.totals.created).toBe(0);
    expect(result.totals.reused).toBe(1);

    const rows = await db
      .select()
      .from(contentSources)
      .where(eq(contentSources.id, "old-source"))
      .all();
    expect(rows).toHaveLength(1);
    const config = rows[0]!.config as Record<string, unknown>;
    expect(config.converterVersion).toBe(4);
    expect(String(config.infoTocUrl)).toContain("/api/toc");
    expect(config.tocMode).toBe("rules");
    expect(rows[0]!.status).toBe("enabled");
  });
});
