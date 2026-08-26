// 把被跳过的源逐条拆开：到底是真的没有目录规则，还是我没找对字段。
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const script = `
import { readFileSync } from "node:fs";
import { parseLegadoJson } from "./app/server/sources/legado.ts";

const raw = JSON.parse(readFileSync("_bs.json", "utf8"));
const r = parseLegadoJson(text());
function text() { return readFileSync("_bs.json", "utf8"); }

const rejectedNames = new Set(r.failed.map((f) => f.name));
const rejected = raw.filter((s) => rejectedNames.has(s.bookSourceName));

const stat = {
  rejectedTotal: rejected.length,
  byType: {},
  hasRuleTocObject: 0,
  ruleTocEmptyObject: 0,
  noRuleTocKey: 0,
  chapterListEmptyString: 0,
  hasContentButNoToc: 0,
  hasTocButNoContent: 0,
  neither: 0,
  // 目录规则藏在别处的可能形态
  tocInRuleBookInfo: 0,
  ruleTocIsString: 0,
};

const samples = { noToc: [], audio: [], odd: [] };

for (const s of rejected) {
  const type = String(s.bookSourceType ?? 0);
  stat.byType[type] = (stat.byType[type] || 0) + 1;

  const rt = s.ruleToc;
  if (typeof rt === "string") stat.ruleTocIsString += 1;
  if (rt === undefined || rt === null) stat.noRuleTocKey += 1;
  else if (typeof rt === "object") {
    stat.hasRuleTocObject += 1;
    if (Object.keys(rt).length === 0) stat.ruleTocEmptyObject += 1;
    if (rt.chapterList === "") stat.chapterListEmptyString += 1;
  }

  const hasToc = Boolean(rt && typeof rt === "object" && rt.chapterList);
  const hasContent = Boolean(s.ruleContent && s.ruleContent.content);
  if (hasContent && !hasToc) stat.hasContentButNoToc += 1;
  if (hasToc && !hasContent) stat.hasTocButNoContent += 1;
  if (!hasToc && !hasContent) stat.neither += 1;

  if (s.ruleBookInfo && (s.ruleBookInfo.tocUrl || s.ruleBookInfo.chapterList)) {
    stat.tocInRuleBookInfo += 1;
  }

  if (!hasToc && samples.noToc.length < 4) {
    samples.noToc.push({
      name: s.bookSourceName,
      type: s.bookSourceType,
      group: s.bookSourceGroup,
      keys: Object.keys(s),
      ruleToc: rt,
      ruleContent: s.ruleContent,
      hasSearch: Boolean(s.searchUrl),
      hasExplore: Boolean(s.exploreUrl),
    });
  }
  if (type !== "0" && samples.audio.length < 3) {
    samples.audio.push({ name: s.bookSourceName, type: s.bookSourceType, ruleToc: rt });
  }
}

console.log(JSON.stringify({ stat, samples }, null, 1));
`;

fs.writeFileSync("_inspect.mts", script);
try {
  const out = execFileSync("npx", ["tsx", "_inspect.mts"], {
    encoding: "utf8",
    shell: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  console.log(out.slice(out.indexOf("{")));
} finally {
  fs.rmSync("_inspect.mts", { force: true });
}
