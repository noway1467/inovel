import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Loader2, Search, Shield, UserX, UserCheck } from "lucide-react";
import type { Route } from "./+types/admin-users";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getUserRoleCodes } from "~/server/security/rbac";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  status: string;
  roleCodes: string[];
  createdAt: string;
}

const roleLabels: Record<string, string> = {
  reader: "读者",
  author: "作者",
  moderator: "审核员",
  operator: "运营",
  admin: "管理员",
  super_admin: "超级管理员",
};

const roleOptions = [
  { code: "author", label: "作者" },
  { code: "moderator", label: "审核员" },
  { code: "operator", label: "运营" },
  { code: "admin", label: "管理员" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, admin: false };
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  return {
    user: session.user,
    admin: roles.some((role) => role === "admin" || role === "super_admin"),
  };
}

export default function AdminUsersPage({ loaderData }: Route.ComponentProps) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState("");
  const [message, setMessage] = useState("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/users?q=${encodeURIComponent(query)}`);
      const data = (await response.json()) as { users?: AdminUser[] };
      setUsers(data.users ?? []);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => void loadUsers(), 300);
    return () => clearTimeout(timer);
  }, [loadUsers]);

  async function updateUser(userId: string, body: unknown, action: "roles" | "status") {
    setActingId(userId);
    setMessage("");
    try {
      const response = await fetch(`/api/admin/users/${userId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "操作失败");
        return;
      }
      await loadUsers();
    } finally {
      setActingId("");
    }
  }

  if (!loaderData.user || !loaderData.admin) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="需要管理员权限"
          action={
            <Button asChild>
              <Link to={loaderData.user ? "/admin" : "/login?redirect=/admin/users"}>
                {loaderData.user ? "返回管理后台" : "去登录"}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">用户与角色</h1>
          <p className="mt-1 text-sm text-muted-foreground">搜索用户、调整角色、启用或禁用账号。</p>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索昵称或邮箱"
          aria-label="搜索用户"
          className="pl-9"
        />
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : users.length === 0 ? (
        <EmptyState title="没有匹配的用户" />
      ) : (
        <div className="space-y-2">
          {users.map((user) => (
            <div key={user.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-medium">{user.name}</p>
                  <p className="line-clamp-1 text-xs text-muted-foreground">{user.email}</p>
                </div>
                <Badge variant={user.status === "disabled" ? "danger" : "success"}>
                  {user.status === "disabled" ? "已禁用" : "正常"}
                </Badge>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Shield className="size-4 text-muted-foreground" />
                {user.roleCodes.map((code) => (
                  <Badge key={code} variant="outline">
                    {roleLabels[code] ?? code}
                  </Badge>
                ))}
                {roleOptions.map((role) => {
                  const enabled = user.roleCodes.includes(role.code);
                  return (
                    <Button
                      key={role.code}
                      size="sm"
                      variant={enabled ? "default" : "outline"}
                      disabled={actingId === user.id}
                      onClick={() =>
                        void updateUser(
                          user.id,
                          {
                            roleCodes: enabled
                              ? user.roleCodes.filter((code) => code !== role.code)
                              : [...user.roleCodes, role.code],
                          },
                          "roles"
                        )
                      }
                    >
                      {role.label}
                    </Button>
                  );
                })}
                <div className="ml-auto">
                  <Button
                    size="sm"
                    variant={user.status === "disabled" ? "outline" : "danger"}
                    disabled={actingId === user.id || user.email === loaderData.user?.email}
                    onClick={() =>
                      void updateUser(
                        user.id,
                        { status: user.status === "disabled" ? "active" : "disabled" },
                        "status"
                      )
                    }
                  >
                    {user.status === "disabled" ? (
                      <UserCheck className="size-4" />
                    ) : (
                      <UserX className="size-4" />
                    )}
                    {user.status === "disabled" ? "启用" : "禁用"}
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
