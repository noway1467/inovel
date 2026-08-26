import type { Route } from "./+types/api.auth";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { users } from "drizzle/schema";
import { eq } from "drizzle-orm";
import { clearLoginFailures, getClientIp, getLoginGuardState, recordLoginFailure } from "~/server/security/login-guard";
import { ensureAdminUser } from "~/server/security/bootstrap-admin";
import { getRegistrationEnabled } from "~/server/settings/registration";

async function handle(request: Request, context: Route.LoaderArgs["context"]) {
  const { env } = context.get(cloudflareContext);
  const pathname = new URL(request.url).pathname;
  const isLogin = request.method === "POST" && pathname.endsWith("/sign-in/email");
  const isSignUp = request.method === "POST" && pathname.endsWith("/sign-up/email");
  const db = createDb(env.DB_APP);
  const ip = getClientIp(request);

  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
    await ensureAdminUser(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL, {
      email: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
      name: env.ADMIN_NAME,
    });
  }

  if (isSignUp && !(await getRegistrationEnabled(db))) {
    return Response.json(
      { code: "REGISTRATION_DISABLED", message: "注册已关闭，请联系管理员开通账号" },
      { status: 403 }
    );
  }

  if (isLogin) {
    const state = await getLoginGuardState(db, ip);
    if (state.blocked) {
      return Response.json(
        {
          code: "IP_BLOCKED",
          message: `登录尝试次数过多，请 ${Math.ceil(state.remainingSeconds / 60)} 分钟后再试`,
          retryAfterSeconds: state.remainingSeconds,
        },
        { status: 429, headers: { "Retry-After": String(state.remainingSeconds) } }
      );
    }
    const clone = request.clone();
    const body = (await clone.json().catch(() => null)) as {
      email?: string;
      turnstileToken?: string;
    } | null;
    if (body?.email) {
      const user = await db.select({ status: users.status }).from(users).where(eq(users.email, body.email.toLowerCase())).get();
      if (user?.status === "disabled") {
        return Response.json({ code: "ACCOUNT_DISABLED", message: "账号已被禁用，请联系管理员" }, { status: 403 });
      }
    }
    if (env.TURNSTILE_SECRET_KEY) {
      const token = body?.turnstileToken;
      if (!token) {
        return Response.json({ code: "TURNSTILE_REQUIRED", message: "请完成人机验证" }, { status: 400 });
      }
      const form = new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: ip,
      });
      const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: form,
      });
      const result = (await verify.json()) as { success?: boolean; hostname?: string };
      if (!result.success) {
        return Response.json({ code: "TURNSTILE_FAILED", message: "人机验证未通过，请重试" }, { status: 400 });
      }
      const expectedHost = new URL(env.BETTER_AUTH_URL).hostname;
      if (expectedHost && result.hostname && result.hostname !== expectedHost) {
        return Response.json({ code: "TURNSTILE_HOST_MISMATCH", message: "人机验证域名不匹配，请刷新后重试" }, { status: 400 });
      }
    }
  }

  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const response = await auth.handler(request);

  if (isLogin) {
    if (response.status >= 200 && response.status < 300) {
      await clearLoginFailures(db, ip);
    } else if (response.status === 400 || response.status === 401 || response.status === 403) {
      await recordLoginFailure(db, ip);
    }
  }
  return response;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  return handle(request, context);
}

export async function action({ request, context }: Route.ActionArgs) {
  return handle(request, context);
}
