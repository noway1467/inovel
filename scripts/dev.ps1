$ErrorActionPreference = "Stop"

# 本机存在 HTTP(S)_PROXY 时，必须放行 localhost，否则 Cloudflare 本地 dev
# 会把回环请求交给代理，导致 workerd 502。
$env:NO_PROXY = "localhost,127.0.0.1,::1"

& npm exec -- react-router dev
