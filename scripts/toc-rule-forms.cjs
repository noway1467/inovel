// 统计可导入源里 tocList/tocName/tocUrl 的具体形态，找出哪些我支持不了。
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const script = `
import { readFileSync } from "node:fs";
import { parseLegadoJson } from "./app/server/sources/legado.ts";
import { canParseRule, parseRule } from "./app/server/sources/rule-expr.ts";

const text = readFileSync("_bs.json", "utf8");
const r = parseLegadoJson(text);

const forms = {};
const unsupported = [];
const bump = (k) => { forms[k] = (forms[k] || 0) + 1; };

for (const item of r.converted) {
  const rules = {
    tocList: item.config.tocList,
    tocName: item.config.tocName,
    tocUrl: item.config.tocUrl,
    content: item.config.contentRule,
  };
  for (const [field, rule] of Object.entries(rules)) {
    if (typeof rule !== "string") continue;
    if (/^text\\./.test(rule) || rule.includes("@text.")) bump("含 text.关键字 文本筛选");
    if (rule.includes("||")) bump("含 || 备选");
    if (/![-\\d]/.test(rule)) bump("含 !n 排除");
    if (rule.startsWith("$")) bump("JSONPath");
    if (/:contains|:has|:not/.test(rule)) bump("含 :contains/:has/:not 伪类");
    if (/\\bchildren\\b/.test(rule)) bump("含 children");
    if (!canParseRule(rule)) {
      let reason = "";
      try { parseRule(rule); } catch (e) { reason = e.message; }
      unsupported.push({ field, rule: rule.slice(0, 90), reason });
    }
  }
}

// 目录分页与正文分页
let nextToc = 0, nextContent = 0;
const raw = JSON.parse(text);
const names = new Set(r.converted.map((c) => c.name));
for (const s of raw) {
  if (!names.has(s.bookSourceName)) continue;
  if (s.ruleToc?.nextTocUrl) nextToc += 1;
  if (s.ruleContent?.nextContentUrl) nextContent += 1;
}

const seen = new Set();
const uniqUnsupported = unsupported.filter((u) => !seen.has(u.rule) && seen.add(u.rule));

console.log(JSON.stringify({
  convertible: r.converted.length,
  forms,
  withNextTocUrl: nextToc,
  withNextContentUrl: nextContent,
  unsupportedCount: unsupported.length,
  unsupportedUnique: uniqUnsupported.length,
  samples: uniqUnsupported.slice(0, 12),
}, null, 1));
`;

fs.writeFileSync("_forms.mts", script);
try {
  const out = execFileSync("npx", ["tsx", "_forms.mts"], {
    encoding: "utf8",
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  console.log(out.slice(out.indexOf("{")));
} finally {
  fs.rmSync("_forms.mts", { force: true });
}
