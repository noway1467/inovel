// 用真实转换器跑一遍合集，按原因分类统计，用来定阈值和排优先级。
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const script = `
import { readFileSync } from "node:fs";
import { parseLegadoJson } from "./app/server/sources/legado.ts";
const text = readFileSync("_bs.json", "utf8");
const raw = JSON.parse(text);
const r = parseLegadoJson(text);
const buckets = {};
for (const f of r.failed) {
  let key = "其他";
  if (/缺少目录规则/.test(f.reason)) key = "无目录规则(有声/发现页源)";
  else if (/缺少正文规则/.test(f.reason)) key = "无正文规则";
  else if (/无法翻译/.test(f.reason)) key = "规则需 JS 求值";
  else if (/bookSourceUrl|bookSourceName/.test(f.reason)) key = "缺名称或地址";
  buckets[key] = (buckets[key] || 0) + 1;
}
const withSearch = r.converted.filter((c) => c.config.searchUrl).length;
console.log(JSON.stringify({
  total: raw.length,
  converted: r.converted.length,
  failed: r.failed.length,
  buckets,
  convertedWithSearch: withSearch,
}, null, 2));
`;

fs.writeFileSync("_report.mts", script);
try {
  const out = execFileSync("npx", ["tsx", "_report.mts"], { encoding: "utf8", shell: true });
  const data = JSON.parse(out.slice(out.indexOf("{")));
  const pct = (n) => `${n} (${((n / data.total) * 100).toFixed(1)}%)`;
  console.log(`合集总数: ${data.total}`);
  console.log(`可导入订阅: ${pct(data.converted)}`);
  console.log(`  其中支持搜索: ${pct(data.convertedWithSearch)}`);
  console.log(`被拒: ${pct(data.failed)}`);
  for (const [key, n] of Object.entries(data.buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${pct(n)}`);
  }
} finally {
  fs.rmSync("_report.mts", { force: true });
}
