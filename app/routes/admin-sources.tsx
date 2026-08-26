import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { CloudDownload, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { Route } from "./+types/admin-sources";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getUserRoleCodes } from "~/server/security/rbac";

interface AdapterInfo {
  kind: string;
  label: string;
  supportsSearch: boolean;
}

interface SourceRow {
  id: string;
  name: string;
  kind: string;
  endpoint: string;
  status: string;
  attribution: string | null;
  syncIntervalMinutes: number;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  subscriptionCount: number;
}

interface DomainRow {
  id: string;
  host: string;
  authorizationNote: string;
  createdAt: string;
}

interface SubscriptionRow {
  id: string;
  sourceName: string;
  bookId: string;
  bookTitle: string;
  bookStatus: string;
  externalTitle: string | null;
  status: string;
  syncedChapterCount: number;
  pendingChapters: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

interface RunRow {
  id: string;
  sourceName: string;
  trigger: string;
  status: string;
  booksChecked: number;
  chaptersAdded: number;
  requestCount: number;
  message: string | null;
  startedAt: string;
}

interface RemoteBook {
  externalId: string;
  title: string;
  author?: string | null;
  description?: string | null;
  rights?: string | null;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, admin: false };
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  const admin = roles.some((role) => role === "admin" || role === "super_admin");
  return { user: session.user, admin };
}

const statusLabels: Record<string, string> = {
  enabled: "已启用",
  disabled: "已停用",
  blocked: "域名未授权",
};

export default function AdminSourcesPage({ loaderData }: Route.ComponentProps) {
  const [tab, setTab] = useState("sources");
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const isAdmin = Boolean(loaderData.user && loaderData.admin);

  const loadAll = useCallback(async () => {
    if (!isAdmin) return;
    const [main, domainRes, subRes, runRes] = (await Promise.all([
      fetch("/api/admin/sources/list").then((r) => r.json()),
      fetch("/api/admin/sources/domains").then((r) => r.json()),
      fetch("/api/admin/sources/subscriptions").then((r) => r.json()),
      fetch("/api/admin/sources/runs").then((r) => r.json()),
    ])) as [
      { sources?: SourceRow[]; adapters?: AdapterInfo[] },
      { domains?: DomainRow[] },
      { subscriptions?: SubscriptionRow[] },
      { runs?: RunRow[] },
    ];
    setSources(main.sources ?? []);
    setAdapters(main.adapters ?? []);
    setDomains(domainRes.domains ?? []);
    setSubscriptions(subRes.subscriptions ?? []);
    setRuns(runRes.runs ?? []);
  }, [isAdmin]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  async function call(path: string, init: RequestInit, okMessage: string) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(data.error ?? "操作失败");
        return null;
      }
      setMessage(okMessage);
      await loadAll();
      return data;
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="需要管理员权限"
          description="在线源管理仅限管理员访问。"
          action={
            <Button asChild>
              <Link to={loaderData.user ? "/" : "/login?redirect=/admin/sources"}>
                {loaderData.user ? "返回首页" : "去登录"}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold">在线源</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          导入源、订阅书籍、按间隔自动更新。抓取前必须先在「域名授权」登记你有权抓取的站点。
        </p>
      </header>

      <div className="rounded-lg border border-warning/40 bg-warning/5 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-4" />
          抓取前请确认授权
        </p>
        <p className="mt-1.5 text-muted-foreground">
          未在白名单内的域名一律拒绝访问，登记时需填写授权依据并记入审计日志。
          源同步来的章节默认落草稿，需你逐本确认后再发布。
        </p>
      </div>

      {message && (
        <p role="status" className="rounded-md bg-secondary px-3 py-2 text-sm">
          {message}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="sources">源（{sources.length}）</TabsTrigger>
          <TabsTrigger value="domains">域名授权（{domains.length}）</TabsTrigger>
          <TabsTrigger value="subscriptions">订阅（{subscriptions.length}）</TabsTrigger>
          <TabsTrigger value="runs">同步记录</TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="space-y-4">
          <SourceCreateForm adapters={adapters} busy={busy} onSubmit={(body) =>
            call("/api/admin/sources/create", { method: "POST", body: JSON.stringify(body) }, "源已登记")
          } />
          <LegadoImportForm busy={busy} onSubmit={(text) =>
            call("/api/admin/sources/import-legado", { method: "POST", body: JSON.stringify({ text }) }, "导入完成")
          } />
          <SourceList
            sources={sources}
            busy={busy}
            onProbe={(sourceId) =>
              call("/api/admin/sources/probe", { method: "POST", body: JSON.stringify({ sourceId }) }, "已测试连通性")
            }
            onToggle={(sourceId, status) =>
              call("/api/admin/sources/update", { method: "PATCH", body: JSON.stringify({ sourceId, status }) }, "状态已更新")
            }
            onSync={(sourceId) =>
              call("/api/admin/sources/sync", { method: "POST", body: JSON.stringify({ sourceId }) }, "已触发同步")
            }
            onDelete={(sourceId) =>
              call("/api/admin/sources/delete", { method: "DELETE", body: JSON.stringify({ sourceId }) }, "源已删除（已入库书籍保留）")
            }
            onSubscribe={(body) =>
              call("/api/admin/sources/subscribe", { method: "POST", body: JSON.stringify(body) }, "已订阅并拉取目录")
            }
          />
        </TabsContent>

        <TabsContent value="domains" className="space-y-4">
          <DomainForm busy={busy} onSubmit={(body) =>
            call("/api/admin/sources/domains", { method: "POST", body: JSON.stringify(body) }, "域名已授权")
          } />
          {domains.length === 0 ? (
            <EmptyState title="白名单为空" description="没有任何域名获授权，所有抓取都会被拒绝。" />
          ) : (
            <ul className="space-y-2">
              {domains.map((domain) => (
                <li key={domain.id} className="rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{domain.host}</p>
                      <p className="truncate text-xs text-muted-foreground">{domain.authorizationNote}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void call(
                          "/api/admin/sources/domains",
                          { method: "DELETE", body: JSON.stringify({ host: domain.host }) },
                          "已撤销授权，相关源已停抓"
                        )
                      }
                    >
                      <Trash2 className="size-4" />
                      撤销
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="subscriptions" className="space-y-3">
          {subscriptions.length === 0 ? (
            <EmptyState title="还没有订阅" description="在「源」里浏览或搜索，选中书籍后订阅。" />
          ) : (
            subscriptions.map((sub) => (
              <div key={sub.id} className="rounded-lg border border-border bg-surface p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/creator/books/${sub.bookId}`} className="font-medium hover:underline">
                    {sub.bookTitle}
                  </Link>
                  <Badge variant={sub.status === "active" ? "success" : "warning"}>
                    {sub.status === "active" ? "订阅中" : "已暂停"}
                  </Badge>
                  <Badge variant="secondary">{sub.sourceName}</Badge>
                  <span className="text-xs text-muted-foreground">
                    已同步 {sub.syncedChapterCount} 章
                    {sub.pendingChapters > 0 && ` · 待抓 ${sub.pendingChapters}`}
                  </span>
                </div>
                {sub.lastError && (
                  <p className="mt-1.5 text-xs text-danger">上次失败：{sub.lastError}</p>
                )}
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void call(
                        "/api/admin/sources/sync",
                        { method: "POST", body: JSON.stringify({ subscriptionId: sub.id }) },
                        "已同步"
                      )
                    }
                  >
                    <RefreshCw className="size-4" />
                    立即同步
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void call(
                        "/api/admin/sources/subscriptions",
                        {
                          method: "POST",
                          body: JSON.stringify({
                            subscriptionId: sub.id,
                            status: sub.status === "active" ? "paused" : "active",
                          }),
                        },
                        "订阅状态已更新"
                      )
                    }
                  >
                    {sub.status === "active" ? "暂停" : "恢复"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void call(
                        "/api/admin/sources/subscriptions",
                        { method: "DELETE", body: JSON.stringify({ subscriptionId: sub.id }) },
                        "已取消订阅（本地书籍保留）"
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                    取消订阅
                  </Button>
                </div>
              </div>
            ))
          )}
        </TabsContent>

        <TabsContent value="runs" className="space-y-2">
          {runs.length === 0 ? (
            <EmptyState title="还没有同步记录" description="手动同步或等 Cron 触发后这里会有记录。" />
          ) : (
            runs.map((run) => (
              <div key={run.id} className="rounded-lg border border-border bg-surface p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={run.status === "ok" ? "success" : run.status === "failed" ? "danger" : "secondary"}>
                    {run.status}
                  </Badge>
                  <span className="font-medium">{run.sourceName}</span>
                  <span className="text-xs text-muted-foreground">
                    {run.trigger === "cron" ? "自动" : "手动"} ·{" "}
                    {new Date(run.startedAt).toLocaleString("zh-CN")}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  检查 {run.booksChecked} 本 · 新增 {run.chaptersAdded} 章 · 请求 {run.requestCount} 次
                  {run.message && ` · ${run.message}`}
                </p>
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SourceCreateForm({
  adapters,
  busy,
  onSubmit,
}: {
  adapters: AdapterInfo[];
  busy: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [kind, setKind] = useState("opds");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [interval, setInterval] = useState("360");

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Plus className="size-4" />
        登记新源
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="src-kind">类型</Label>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger id="src-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {adapters.map((adapter) => (
                <SelectItem key={adapter.kind} value={adapter.kind}>
                  {adapter.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="src-name">名称</Label>
          <Input id="src-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="我的书库" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="src-endpoint">入口地址</Label>
          <Input
            id="src-endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://books.example.com/opds"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="src-interval">同步间隔（分钟）</Label>
          <Input
            id="src-interval"
            type="number"
            min={30}
            max={10080}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          />
        </div>
      </div>
      <Button
        className="mt-3"
        disabled={busy || !name.trim() || !endpoint.trim()}
        onClick={() =>
          void onSubmit({
            name,
            kind,
            endpoint,
            syncIntervalMinutes: Number(interval) || 360,
          })
        }
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        登记
      </Button>
    </section>
  );
}

function LegadoImportForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (text: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <CloudDownload className="size-4" />
        导入书源 JSON（兼容开源阅读格式）
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        粘贴单个或数组形式的书源 JSON。只支持 CSS 规则；用到 JS / JSONPath / XPath 的书源会被跳过并说明原因。
        导入后域名仍需单独授权才会开始抓取。
      </p>
      <Textarea
        className="mt-3 font-mono text-xs"
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='[{"bookSourceName":"...","bookSourceUrl":"https://...","ruleToc":{...},"ruleContent":{...}}]'
      />
      <Button className="mt-3" disabled={busy || !text.trim()} onClick={() => void onSubmit(text)}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        解析并导入
      </Button>
    </section>
  );
}

function DomainForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (body: { host: string; authorizationNote: string }) => Promise<unknown>;
}) {
  const [host, setHost] = useState("");
  const [note, setNote] = useState("");

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-base font-semibold">授权新域名</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        只登记你确实有权抓取的站点：自建服务、已获授权的源、公共领域库。授权依据会记入审计日志。
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="dom-host">域名</Label>
          <Input
            id="dom-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="books.example.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dom-note">授权依据</Label>
          <Input
            id="dom-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="我自建的 Calibre-Web 实例"
          />
        </div>
      </div>
      <Button
        className="mt-3"
        disabled={busy || !host.trim() || note.trim().length < 5}
        onClick={() => void onSubmit({ host, authorizationNote: note })}
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        确认授权
      </Button>
    </section>
  );
}

function SourceList({
  sources,
  busy,
  onProbe,
  onToggle,
  onSync,
  onDelete,
  onSubscribe,
}: {
  sources: SourceRow[];
  busy: boolean;
  onProbe: (sourceId: string) => Promise<unknown>;
  onToggle: (sourceId: string, status: "enabled" | "disabled") => Promise<unknown>;
  onSync: (sourceId: string) => Promise<unknown>;
  onDelete: (sourceId: string) => Promise<unknown>;
  onSubscribe: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [remote, setRemote] = useState<RemoteBook[]>([]);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [remoteError, setRemoteError] = useState("");

  async function browse(sourceId: string, q: string) {
    setLoadingRemote(true);
    setRemoteError("");
    setRemote([]);
    try {
      const params = new URLSearchParams({ sourceId });
      if (q.trim()) params.set("q", q.trim());
      const response = await fetch(`/api/admin/sources/browse?${params}`);
      const data = (await response.json()) as { books?: RemoteBook[]; error?: string };
      if (!response.ok) {
        setRemoteError(data.error ?? "浏览失败");
        return;
      }
      setRemote(data.books ?? []);
      if ((data.books ?? []).length === 0) {
        setRemoteError("没有结果。规则源通常不支持列目录，请用搜索或直接填详情页地址。");
      }
    } finally {
      setLoadingRemote(false);
    }
  }

  if (sources.length === 0) {
    return <EmptyState title="还没有源" description="用上面的表单登记一个，或导入书源 JSON。" />;
  }

  return (
    <div className="space-y-3">
      {sources.map((source) => (
        <div key={source.id} className="rounded-lg border border-border bg-surface p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{source.name}</span>
            <Badge
              variant={
                source.status === "enabled" ? "success" : source.status === "blocked" ? "danger" : "warning"
              }
            >
              {statusLabels[source.status] ?? source.status}
            </Badge>
            <Badge variant="secondary">{source.kind}</Badge>
            <span className="text-xs text-muted-foreground">
              {source.subscriptionCount} 个订阅 · 每 {source.syncIntervalMinutes} 分钟
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{source.endpoint}</p>
          {source.lastSyncMessage && (
            <p className="mt-1 text-xs text-muted-foreground">上次同步：{source.lastSyncMessage}</p>
          )}

          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onProbe(source.id)}>
              测试连通
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || source.status === "blocked"}
              onClick={() => void onSync(source.id)}
            >
              <RefreshCw className="size-4" />
              同步全部订阅
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || source.status === "blocked"}
              onClick={() => {
                const next = openId === source.id ? null : source.id;
                setOpenId(next);
                setRemote([]);
                setRemoteError("");
                if (next) void browse(source.id, "");
              }}
            >
              浏览并订阅
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || source.status === "blocked"}
              onClick={() => void onToggle(source.id, source.status === "enabled" ? "disabled" : "enabled")}
            >
              {source.status === "enabled" ? "停用" : "启用"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onDelete(source.id)}>
              <Trash2 className="size-4" />
              删除
            </Button>
          </div>

          {openId === source.id && (
            <div className="mt-3 rounded-md border border-border/70 bg-background/60 p-3">
              <div className="flex gap-2">
                <Input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  placeholder="搜索书名，或粘贴详情页地址"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={loadingRemote}
                  onClick={() => void browse(source.id, keyword)}
                >
                  {loadingRemote ? <Loader2 className="size-4 animate-spin" /> : "搜索"}
                </Button>
                {/* 规则源没有目录列表，允许直接按详情页地址订阅 */}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={loadingRemote || !keyword.startsWith("http")}
                  onClick={() =>
                    void onSubscribe({
                      sourceId: source.id,
                      externalId: keyword.trim(),
                      title: keyword.trim().slice(0, 60),
                    })
                  }
                >
                  按地址订阅
                </Button>
              </div>
              {remoteError && <p className="mt-2 text-xs text-danger">{remoteError}</p>}
              {remote.length > 0 && (
                <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">
                  {remote.map((book) => (
                    <li
                      key={book.externalId}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{book.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {book.author ?? "未知作者"}
                          {book.rights ? ` · ${book.rights}` : ""}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void onSubscribe({
                            sourceId: source.id,
                            externalId: book.externalId,
                            title: book.title,
                            author: book.author ?? null,
                            description: book.description ?? null,
                            rights: book.rights ?? null,
                          })
                        }
                      >
                        订阅
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
