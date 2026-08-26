$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$sqlFile = Join-Path $root "drizzle\seeds\operations.sql"

Write-Output "Check remote operations data..."
$count = npx wrangler d1 execute ibook-app --remote --command "SELECT COUNT(*) AS n FROM categories;" --json | ConvertFrom-Json
$existing = $count[0].results[0].n
if ($existing -gt 0) {
  Write-Output "Categories already exist ($existing), skip."
  exit 0
}

Write-Output "Inserting categories, tags and recommendation slot..."
npx wrangler d1 execute ibook-app --remote --file $sqlFile
Write-Output "Done."
