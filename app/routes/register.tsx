import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/register";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getRegistrationEnabled } from "~/server/settings/registration";
import { translateAuthError } from "~/lib/auth-errors";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  const db = createDb(env.DB_APP);
  return { loggedIn: Boolean(session), registrationEnabled: await getRegistrationEnabled(db) };
}

export default function RegisterPage({ loaderData }: Route.ComponentProps) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const redirect = params.get("redirect") || "/";

  if (loaderData.loggedIn) {
    navigate(redirect, { replace: true });
  }

  if (!loaderData.registrationEnabled) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
        <div className="rounded-lg border border-border bg-surface p-6 text-center">
          <h1 className="text-xl font-semibold">注册已关闭</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            当前平台暂不开放自助注册，请联系管理员开通账号。
          </p>
          <Link to="/login" className="mt-4 inline-block text-sm text-primary hover:underline">
            返回登录
          </Link>
        </div>
      </div>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      const data = (await response.json()) as { message?: string };
      if (!response.ok) {
        setError(translateAuthError(data?.message, "注册失败，请稍后重试。"));
        return;
      }
      navigate(redirect, { replace: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-sm flex-col justify-center">
      <div className="rounded-lg border border-border bg-surface p-6">
        <h1 className="text-xl font-semibold">注册悦读</h1>
        <p className="mt-1 text-sm text-muted-foreground">一个账号即可管理书架、进度与创作。</p>
        <form className="mt-5 space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="name">昵称</Label>
            <Input id="name" name="name" required autoComplete="nickname" placeholder="你的公开昵称" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">邮箱</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">密码</Label>
            <Input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" placeholder="至少 8 位" />
          </div>
          {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "注册中…" : "注册"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          已有账号？{" "}
          <Link to={`/login?redirect=${encodeURIComponent(redirect)}`} className="text-primary hover:underline">
            登录
          </Link>
        </p>
      </div>
    </div>
  );
}
