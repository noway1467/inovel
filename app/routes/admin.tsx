import { useState } from "react";
import { Link, useRevalidator } from "react-router";
import type { Route } from "./+types/admin";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getRegistrationEnabled } from "~/server/settings/registration";
import { getMaxUploadMb } from "~/server/settings/import-limits";
import { getUserRoleCodes } from "~/server/security/rbac";
import { pageMeta, pageTitle } from "~/lib/page-title";

export function meta() {
  return pageMeta(pageTitle("站点设置"));
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, admin: false, registrationEnabled: false, maxUploadMb: 300 };
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  const admin = roles.some((role) => role === "admin" || role === "super_admin");
  return {
    user: session.user,
    admin,
    registrationEnabled: admin ? await getRegistrationEnabled(db) : false,
    maxUploadMb: admin ? await getMaxUploadMb(db) : 300,
  };
}

export default function AdminPage({ loaderData }: Route.ComponentProps) {
  const revalidator = useRevalidator();
  const [registrationEnabled, setRegistrationEnabledState] = useState(loaderData.registrationEnabled);
  const [maxUploadMb, setMaxUploadMbState] = useState(loaderData.maxUploadMb);
  const [uploadMbInput, setUploadMbInput] = useState(String(loaderData.maxUploadMb));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [uploadMessage, setUploadMessage] = useState("");

  if (!loaderData.user || !loaderData.admin) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="需要管理员权限"
          description="该页面仅限管理员访问。"
          action={
            <Button asChild>
              <Link to={loaderData.user ? "/" : "/login?redirect=/admin"}>
                {loaderData.user ? "返回首页" : "去登录"}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  async function toggle(next: boolean) {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/site-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationEnabled: next }),
      });
      const data = (await response.json()) as { error?: string; registrationEnabled?: boolean };
      if (!response.ok) {
        setMessage(data.error ?? "保存失败");
        return;
      }
      setRegistrationEnabledState(Boolean(data.registrationEnabled));
      // 顶栏注册入口来自 app-layout 的 loader，不重新校验的话开关要刷新页面才生效
      void revalidator.revalidate();
      setMessage("已保存，前端入口即时生效");
    } finally {
      setSaving(false);
    }
  }

  async function saveUploadLimit() {
    const mb = Number(uploadMbInput);
    if (!Number.isFinite(mb) || mb < 1 || mb > 4096) {
      setUploadMessage("上传大小上限需要在 1-4096MB 之间");
      return;
    }
    setSaving(true);
    setUploadMessage("");
    try {
      const response = await fetch("/api/admin/site-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUploadMb: mb }),
      });
      const data = (await response.json()) as { error?: string; maxUploadMb?: number };
      if (!response.ok) {
        setUploadMessage(data.error ?? "保存失败");
        return;
      }
      setMaxUploadMbState(Number(data.maxUploadMb));
      setUploadMbInput(String(data.maxUploadMb));
      setUploadMessage("已保存，上传页与服务端即时生效");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/*
        这页原来叫「管理后台」，底下还挂着三张只有一个按钮的卡片
        （用户与角色 / 运营配置 / 内容审核），而顶栏「工作台」里同样有这三项 ——
        同一个页面两个入口、两套名字。链接卡片撤了，这页只留自己独有的
        两个真开关，名字也改成它实际管的东西。别的管理页都从工作台进。
      */}
      <div>
        <h1 className="text-xl font-semibold">站点设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          全站生效的开关。用户、审核、运营与在线源在顶栏「工作台」里。
        </p>
      </div>

      <section className="rounded-lg border border-border bg-surface p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">开放注册</h2>
            <p className="mt-1 text-sm text-muted-foreground">关闭后注册入口与接口同时禁用，默认关闭。</p>
          </div>
          <Switch
            checked={registrationEnabled}
            disabled={saving}
            onCheckedChange={(next) => void toggle(next)}
            aria-label="开放注册"
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Badge variant={registrationEnabled ? "success" : "warning"}>
            {registrationEnabled ? "开放" : "关闭"}
          </Badge>
          {message && <span className="text-sm text-muted-foreground">{message}</span>}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-base font-semibold">上传大小上限</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          单本小说上传上限（MB），TXT/EPUB/MOBI/PDF 统一生效，默认 300。
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={4096}
            value={uploadMbInput}
            onChange={(event) => setUploadMbInput(event.target.value)}
            className="w-32"
            aria-label="上传大小上限"
          />
          <span className="text-sm text-muted-foreground">MB</span>
          <Button onClick={saveUploadLimit} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </Button>
          <Badge variant="secondary">当前 {maxUploadMb}MB</Badge>
        </div>
        {uploadMessage && <p className="mt-3 text-sm text-muted-foreground">{uploadMessage}</p>}
      </section>
    </div>
  );
}
