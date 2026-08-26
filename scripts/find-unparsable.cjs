// 找出真实合集里含 || 或 !n 但本引擎解析不了的规则，用来定位语法缺口。
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const script = `
import { readFileSync } from "node:fs";
import { needsJsEvaluation } from "./app/server/sources/legado.ts";
import { canParseRule, parseRule } from "./app/server/sources/rule-expr.ts";

const raw = JSON.parse(readFileSync("_bs.json", "utf8"));
const bad = [];
for (const s of raw) {
  const rules = [
    s.ruleToc?.chapterList, s.ruleToc?.chapterName, s.ruleToc?.chapterUrl,
    s.ruleContent?.content,
    s.ruleSearch?.bookList, s.ruleSearch?.name, s.ruleSearch?.bookUrl,
  ];
  for (const rule of rules) {
    if (typeof rule !== "string") continue;
    if (needsJsEvaluation(rule)) continue;
    if (!(rule.includes("||") || /![-\\d]/.test(rule))) continue;
    if (canParseRule(rule)) continue;
    let reason = "";
    try { parseRule(rule); } catch (e) { reason = e.message; }
    bad.push({ rule, reason });
  }
}
const seen = new Set();
const uniq = bad.filter((b) => !seen.has(b.rule) && seen.add(b.rule));
console.log(JSON.stringify({ count: bad.length, unique: uniq.length, samples: uniq.slice(0, 15) }, null, 2));
`;

fs.writeFileSync("_find.mts", script);
try {
  const out = execFileSync("npx", ["tsx", "_find.mts"], { encoding: "utf8", shell: true });
  console.log(out.slice(out.indexOf("{")));
} finally {
  fs.rmSync("_find.mts", { force: true });
}
