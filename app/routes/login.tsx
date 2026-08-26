import { useState } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import { Link, redirect, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/login";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getRegistrationEnabled } from "~/server/settings/registration";
import { translateAuthError } from "~/lib/auth-errors";
import { safeRedirectTarget } from "~/lib/redirect";
import {
  clearLocalLoginFailures,
  maxLoginFailures,
  recordLocalLoginFailure,
  remainingBlockSeconds,
  saveLoginGuard,
} from "~/lib/login-guard";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  // 已登录直接在服务端跳走，避免在渲染期调用 navigate()（React 会警告，
  // 且会先闪一下登录表单）
  if (session?.user) {
    const url = new URL(request.url);
    return redirect(safeRedirectTarget(url.searchParams.get("redirect")));
  }
  const db = createDb(env.DB_APP);
  return {
    registrationEnabled: await getRegistrationEnabled(db),
    // 模板里留空时视为未配置，跳过人机验证
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
  };
}

export default function LoginPage({ loaderData }: Route.ComponentProps) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [blockedSeconds, setBlockedSeconds] = useState(() => remainingBlockSeconds());
  const [turnstileToken, setTurnstileToken] = useState("");
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const redirectTo = safeRedirectTarget(params.get("redirect"));

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const localBlocked = remainingBlockSeconds();
    if (localBlocked > 0) {
      setBlockedSeconds(localBlocked);
      setError(`登录尝试次数过多，请 ${Math.ceil(localBlocked / 60)} 分钟后再试`);
      return;
    }
    if (loaderData.turnstileSiteKey && !turnstileToken) {
      setError("请先完成人机验证");
      return;
    }
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          turnstileToken: loaderData.turnstileSiteKey ? turnstileToken : undefined,
        }),
      });
      const data = (await response.json()) as { message?: string; retryAfterSeconds?: number };
      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = Number(data.retryAfterSeconds) || 60;

          saveLoginGuard({
            failedCount: maxLoginFailures,
            blockedUntil: Date.now() + retryAfter * 1000,
          });
          setBlockedSeconds(retryAfter);
        } else {
          const result = recordLocalLoginFailure();
          if (result.blockedUntil > Date.now())
            setBlockedSeconds(Math.ceil((result.blockedUntil - Date.now()) / 1000));
        }
        setError(translateAuthError(data?.message, "登录失败，请检查邮箱和密码。"));
        return;
      }
      clearLocalLoginFailures();
      navigate(redirectTo, { replace: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <div className="rounded-lg border border-border bg-surface p-6">
        <h1 className="text-xl font-semibold">登录悦读</h1>
        <p className="mt-1 text-sm text-muted-foreground">登录后同步书架、进度和书签。</p>
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              placeholder="至少 8 位"
            />
          </div>
          {error && (
            <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
          )}
          <Button type="submit" className="w-full" disabled={submitting}>
            {blockedSeconds > 0
              ? `已冷却 ${Math.ceil(blockedSeconds / 60)} 分钟`
              : submitting
                ? "登录中…"
                : "登录"}
          </Button>
          {loaderData.turnstileSiteKey && (
            <Turnstile
              siteKey={loaderData.turnstileSiteKey}
              options={{ language: "zh-CN" }}
              onSuccess={setTurnstileToken}
              onError={() => setTurnstileToken("")}
              onExpire={() => setTurnstileToken("")}
            />
          )}
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          还没有账号？{" "}
          {loaderData.registrationEnabled ? (
            <Link
              to={`/register?redirect=${encodeURIComponent(redirectTo)}`}
              className="text-primary hover:underline"
            >
              注册
            </Link>
          ) : (
            "注册暂未开放"
          )}
        </p>
      </div>
    </div>
  );
}
