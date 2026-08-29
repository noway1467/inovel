import { Link } from "react-router";
import { BookOpen, Mail } from "lucide-react";
import type { Route } from "./+types/settings";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { ProfileForm } from "~/components/settings/profile-form";
import { PasswordForm } from "~/components/settings/password-form";
import { SignOutButton } from "~/components/settings/sign-out-button";
import { SkinPicker } from "~/components/skin-picker";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getPreferences } from "~/server/services/reader";
import { pageMeta, pageTitle } from "~/lib/page-title";

export function meta() {
  return pageMeta(pageTitle("个人设置"));
}

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

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {/*
        账号那一行把身份和退出一起放完：退出登录原来单独占一张「登录状态」
        卡片排在页尾，而顶栏头像菜单里也有一个。
        这页上方原来还有一排 我的书架 / 阅读历史 / 账号设置 导航 ——
        前两项主导航与移动底栏都常显，第三项指向本页，整排都是重复的。
      */}
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
        {/* 窄屏上别被昵称/邮箱挤扁 */}
        <div className="shrink-0">
          <SignOutButton />
        </div>
      </section>

      <SkinPicker />

      <ProfileForm initialName={user.name} initialImage={user.image} />

      <PasswordForm />

      {/*
        这块只读，改不了任何东西 —— 名字里写清"在阅读器里改"，
        免得看着像个能点的设置区，点半天没反应。
      */}
      <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <BookOpen className="size-4" />
          正文排版（在阅读器里调）
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          打开任意一章，点右上角「阅读设置」调主题与排版，改完自动同步到云端。
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
    </div>
  );
}
