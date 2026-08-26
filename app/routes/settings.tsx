import { Link } from "react-router";
import { BookOpen, Clock, Library, Mail, Settings } from "lucide-react";
import type { Route } from "./+types/settings";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { ProfileForm } from "~/components/settings/profile-form";
import { PasswordForm } from "~/components/settings/password-form";
import { SignOutButton } from "~/components/settings/sign-out-button";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getPreferences } from "~/server/services/reader";

const themeLabels: Record<string, string> = {
  paper: "明亮纸张",
  soft: "柔和阅读",
  parchment: "羊皮纸",
  ink: "墨水灰",
  oled: "OLED 黑",
};

const paginationLabels: Record<string, string> = {
  scroll: "上下滚动",
  cover: "左右覆盖",
  none: "左右无动画",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, preferences: null };
  const db = createDb(env.DB_APP);
  const preferences = await getPreferences(db, session.user.id);
  return {
    user: {
      name: session.user.name,
      email: session.user.email,
      image: session.user.image ?? null,
      emailVerified: session.user.emailVerified,
    },
    preferences,
  };
}

export default function SettingsPage({ loaderData }: Route.ComponentProps) {
  if (!loaderData.user) {
    return (
      <div className="mx-auto max-w-md rounded-lg border border-border bg-surface p-8 text-center">
        <p className="text-base font-medium">请先登录</p>
        <p className="mt-1 text-sm text-muted-foreground">登录后管理个人资料和阅读偏好。</p>
        <Button className="mt-4" asChild>
          <Link to="/login?redirect=/settings">去登录</Link>
        </Button>
      </div>
    );
  }

  const { user, preferences } = loaderData;
  const entries = [
    { icon: Library, label: "我的书架", to: "/library" },
    { icon: Clock, label: "阅读历史", to: "/history" },
    { icon: Settings, label: "账号设置", to: "/settings", active: true },
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <section className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4">
        <Avatar className="size-12">
          {user.image && <AvatarImage src={user.image} alt={user.name} />}
          <AvatarFallback className="text-base">{user.name.slice(0, 1)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{user.name}</h1>
          <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
            <Mail className="size-3.5 shrink-0" />
            {user.email}
          </p>
        </div>
      </section>

      <nav className="flex gap-1 rounded-lg border border-border bg-surface p-1.5">
        {entries.map((entry) => (
          <Link
            key={entry.label}
            to={entry.to}
            className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              entry.active ? "bg-muted font-medium" : "hover:bg-muted"
            }`}
          >
            <entry.icon className="size-4" />
            {entry.label}
          </Link>
        ))}
      </nav>

      <ProfileForm initialName={user.name} initialImage={user.image} />

      <PasswordForm />

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <BookOpen className="size-4" />
          阅读偏好
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          在阅读器内调整主题和排版，会自动保存并同步到云端。
        </p>
        <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">默认主题</dt>
            <dd className="font-medium sm:mt-0.5">
              {themeLabels[preferences?.theme ?? "paper"] ?? preferences?.theme ?? "明亮纸张"}
            </dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">字号</dt>
            <dd className="font-medium sm:mt-0.5">{preferences?.fontSize ?? 18}px</dd>
          </div>
          <div className="flex justify-between gap-2 sm:block">
            <dt className="text-muted-foreground">翻页模式</dt>
            <dd className="font-medium sm:mt-0.5">
              {paginationLabels[preferences?.paginationMode ?? "scroll"] ??
                preferences?.paginationMode ??
                "上下滚动"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-base font-semibold">登录状态</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          退出后需要重新登录才能查看书架与阅读进度。
        </p>
        <div className="mt-3">
          <SignOutButton />
        </div>
      </section>
    </div>
  );
}
