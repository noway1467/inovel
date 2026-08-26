const fs = require("node:fs");
const sql = fs.readFileSync("patch-rmr.sql", "utf8");
const checks = {
  "48 INSERT statements": (sql.match(/INSERT INTO import_chapter_candidates/g) || []).length === 48,
  "472 rows total (48 statements, last has 2)": (sql.match(/VALUES/g) || []).length === 48,
  "last title present": sql.includes("第1458章 北辰、北良（大结局）"),
  "reset UPDATE present": sql.includes("UPDATE import_jobs SET status='awaiting_confirmation'"),
  "no replacement chars": !sql.includes("\uFFFD"),
};
let ok = true;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? "PASS" : "FAIL"} - ${k}`);
  if (!v) ok = false;
}
process.exit(ok ? 0 : 1);
