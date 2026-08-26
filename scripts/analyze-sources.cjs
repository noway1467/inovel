// 统计真实书源里各种规则方言的出现频率，用来决定该补哪些语法。
const fs = require("fs");

const arr = JSON.parse(fs.readFileSync(process.argv[2] || "_bs.json", "utf8"));
const stats = {
  total: arr.length,
  jsInSearchUrl: 0,
  jsInRules: 0,
  orFallback: 0,
  bangIndex: 0,
  textSelector: 0,
  jsonPath: 0,
  xpath: 0,
  nextTocUrl: 0,
  nextContentUrl: 0,
  missingToc: 0,
  missingContent: 0,
};

const ruleFields = (s) => [
  s.ruleToc?.chapterList, s.ruleToc?.chapterName, s.ruleToc?.chapterUrl,
  s.ruleContent?.content,
  s.ruleSearch?.bookList, s.ruleSearch?.name, s.ruleSearch?.author, s.ruleSearch?.bookUrl,
].filter((v) => typeof v === "string");

for (const s of arr) {
  const su = typeof s.searchUrl === "string" ? s.searchUrl : "";
  if (su.includes("{{") && !/^\{\{\s*key\s*\}\}$/.test(su) && /java\.|source\.|cookie\.|=/.test(su)) {
    stats.jsInSearchUrl += 1;
  }
  const rules = ruleFields(s);
  const joined = rules.join("\n");
  if (/<js>|@js:/.test(joined)) stats.jsInRules += 1;
  if (rules.some((r) => r.includes("||"))) stats.orFallback += 1;
  if (/!\d/.test(joined)) stats.bangIndex += 1;
  if (/(^|@|\.)text\.[^@]/.test(joined)) stats.textSelector += 1;
  if (rules.some((r) => r.trim().startsWith("$."))) stats.jsonPath += 1;
  if (rules.some((r) => r.trim().startsWith("//"))) stats.xpath += 1;
  if (s.ruleToc?.nextTocUrl) stats.nextTocUrl += 1;
  if (s.ruleContent?.nextContentUrl) stats.nextContentUrl += 1;
  if (!s.ruleToc?.chapterList || !s.ruleToc?.chapterName || !s.ruleToc?.chapterUrl) stats.missingToc += 1;
  if (!s.ruleContent?.content) stats.missingContent += 1;
}

const pct = (n) => `${n} (${((n / stats.total) * 100).toFixed(1)}%)`;
console.log(`总数: ${stats.total}`);
console.log(`searchUrl 含 JS 模板: ${pct(stats.jsInSearchUrl)}`);
console.log(`规则含 <js>: ${pct(stats.jsInRules)}`);
console.log(`规则含 || 备选: ${pct(stats.orFallback)}`);
console.log(`规则含 !n 排除: ${pct(stats.bangIndex)}`);
console.log(`规则含 text.xx 文本选择: ${pct(stats.textSelector)}`);
console.log(`规则用 JSONPath: ${pct(stats.jsonPath)}`);
console.log(`规则用 XPath: ${pct(stats.xpath)}`);
console.log(`目录分页 nextTocUrl: ${pct(stats.nextTocUrl)}`);
console.log(`正文分页 nextContentUrl: ${pct(stats.nextContentUrl)}`);
console.log(`缺目录规则: ${pct(stats.missingToc)}`);
console.log(`缺正文规则: ${pct(stats.missingContent)}`);
