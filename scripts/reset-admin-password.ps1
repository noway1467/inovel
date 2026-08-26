param(
  [Parameter(Mandatory = $true)]
  [string]$Email
)

$ErrorActionPreference = "Stop"

Write-Output "重置管理员密码步骤："
Write-Output "1. 先设置新密码："
Write-Output "   echo '你的新密码' | npx wrangler secret put ADMIN_PASSWORD"
Write-Output "2. 删除远程旧管理员（级联清理会话与角色）："
npx wrangler d1 execute ibook-app --remote --command "DELETE FROM audit_logs WHERE actor_id = (SELECT id FROM user WHERE email='$Email'); DELETE FROM user WHERE email='$Email';"
Write-Output "3. 触发重建：访问一次登录接口即可自动重建（bootstrap 幂等）。"
Write-Output "   例如：curl -X POST https://<域名>/api/auth/sign-in/email -H 'Content-Type: application/json' -H 'Origin: https://<域名>' -d '{\"email\":\"$Email\"}'"
Write-Output "4. 用新密码登录管理后台。"
