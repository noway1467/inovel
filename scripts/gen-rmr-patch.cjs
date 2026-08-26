// 临时脚本：补齐《人魔之路》缺失候选章节，运行后删除
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");

const report = JSON.parse(fs.readFileSync("rm-report.json", "utf8"));
const JOB = "e79b8ad2-6bab-4c99-aa60-df25c1a953c6";
const esc = (s) => String(s).replace(/'/g, "''");

const statements = [];
const rows = [];
for (let idx = 987; idx < report.chapters.length; idx++) {
  const ch = report.chapters[idx];
  if (!ch) throw new Error(`missing index ${idx}`);
  rows.push(
    `('${randomUUID()}','${JOB}','${esc(ch.title)}',0,0,${ch.charCount},NULL,'keep',${idx},(cast((julianday('now') - 2440587.5)*86400000 as integer)))`
  );
}
for (let i = 0; i < rows.length; i += 10) {
  statements.push(
    `INSERT INTO import_chapter_candidates (id, job_id, title, start_line, end_line, char_count, warning, action, sort_order, created_at) VALUES ${rows.slice(i, i + 10).join(",")};`
  );
}
statements.push(
  `UPDATE import_jobs SET status='awaiting_confirmation', error_code=NULL, error_message=NULL WHERE id='${JOB}';`
);
fs.writeFileSync("patch-rmr.sql", statements.join("\n"), "utf8");
console.log(`chapters total: ${report.chapters.length}, missing: ${rows.length}, statements: ${statements.length}`);
