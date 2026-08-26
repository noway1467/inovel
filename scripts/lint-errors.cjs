// 只打印 eslint 的 error（severity 2），忽略 warning，便于定位必修项。
let raw = "";
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  const files = JSON.parse(raw);
  let total = 0;
  for (const file of files) {
    const errors = (file.messages || []).filter((m) => m.severity === 2);
    if (errors.length === 0) continue;
    const short = file.filePath.replace(process.cwd(), "").replace(/^[\\/]/, "");
    console.log(`--- ${short}`);
    for (const e of errors) {
      console.log(`  ${e.line}:${e.column}  ${e.ruleId}  ${e.message}`);
      total += 1;
    }
  }
  console.log(`TOTAL_ERRORS=${total}`);
});
