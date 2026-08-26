/**
 * 把迁移直接应用到 vite dev server 用的那个本地 D1 文件。
 *
 * 起因：`wrangler d1 migrations apply --local` 写的是 wrangler CLI 自己的
 * D1 实例，而 @cloudflare/vite-plugin 的 dev server 用的是另一个文件。
 * 两者不通，导致 dev 站点上表还不存在（页面报 no such table）。
 *
 * 用法：node scripts/apply-migrations-to-dev-d1.cjs [migration.sql ...]
 * 不带参数时应用所有尚未记录在 d1_migrations 里的迁移。
 */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const d1Dir = path.join(".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject");
const migrationsDir = path.join("drizzle", "migrations");

/** dev server 的库以"有业务数据"为特征：挑 books 行数最多的那个 */
function findDevDatabase() {
  const files = fs
    .readdirSync(d1Dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => path.join(d1Dir, name));

  let best = null;
  for (const file of files) {
    try {
      const db = new DatabaseSync(file);
      const hasBooks = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='books'")
        .all();
      if (hasBooks.length === 0) {
        db.close();
        continue;
      }
      const { c } = db.prepare("SELECT COUNT(*) c FROM books").get();
      db.close();
      if (!best || c > best.count) best = { file, count: c };
    } catch {
      // 读不了的跳过
    }
  }
  return best;
}

const target = findDevDatabase();
if (!target) {
  console.error("找不到 dev server 的 D1 文件");
  process.exit(1);
}
console.log(`目标库: ${path.basename(target.file).slice(0, 12)}… (books=${target.count})`);

const db = new DatabaseSync(target.file);
const applied = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((r) => r.name));

const requested = process.argv.slice(2);
const all = fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort();
const todo = (requested.length > 0 ? requested : all).filter((name) => !applied.has(name));

if (todo.length === 0) {
  console.log("没有待应用的迁移");
  db.close();
  process.exit(0);
}

for (const name of todo) {
  const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
  /**
   * drizzle 用这个标记分隔语句。
   *
   * 不能在这里按"首行是不是注释"过滤整块 —— 迁移文件开头往往是几行说明
   * 注释紧跟第一条语句，那样会把 CREATE TABLE 一起丢掉（表现为后续的
   * CREATE INDEX 报 no such table）。注释在下面逐行剔除。
   */
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  try {
    for (const statement of statements) {
      const cleaned = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (!cleaned) continue;
      db.exec(cleaned);
    }
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, datetime('now'))").run(name);
    console.log(`✅ ${name}`);
  } catch (error) {
    console.error(`❌ ${name}: ${error.message}`);
    db.close();
    process.exit(1);
  }
}

db.close();
console.log("完成");
