param(
  [string]$Domain = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# 仓库里的 wrangler.jsonc 是脱敏模板，真实配置在 gitignore 的 wrangler.local.jsonc
$config = Join-Path $root "wrangler.local.jsonc"
if (-not (Test-Path $config)) {
  $config = Join-Path $root "wrangler.jsonc"
  Write-Warning "未找到 wrangler.local.jsonc，使用脱敏模板 wrangler.jsonc（域名与资源 ID 为空，部署会失败）。"
}

if ($Domain) {
  $domain = $Domain.Trim()
  if ($domain -notmatch "^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$") {
    throw "域名格式无效：$domain"
  }
  $content = [System.IO.File]::ReadAllText($config, [System.Text.Encoding]::UTF8)
  $updated = [System.Text.RegularExpressions.Regex]::Replace(
    $content,
    '"BETTER_AUTH_URL"\s*:\s*"https://[^"]+"',
    "`"BETTER_AUTH_URL`": `"https://$domain`""
  )
  if ($updated -eq $content) {
    throw "$config 中未找到 BETTER_AUTH_URL"
  }
  [System.IO.File]::WriteAllText($config, $updated, [System.Text.UTF8Encoding]::new($false))
  Write-Output "BETTER_AUTH_URL -> https://$domain"
}

Push-Location $root
try {
  npm run typecheck
  # build 会把解析后的配置写进 build/server/wrangler.json，deploy 直接用它，不要再传 --config
  npm run build
  npx wrangler deploy
} finally {
  Pop-Location
}

Write-Output "部署完成。若使用自定义域名，请确认："
Write-Output "1. Cloudflare Worker 已绑定该自定义域名路由"
Write-Output "2. Turnstile site key 的允许域名包含该域名"

