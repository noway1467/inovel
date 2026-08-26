import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  CloudDownload,
  Loader2,
  Plus,
  RefreshCw,
  Search as SearchIcon,
  ShieldCheck,
  Trash2,
} from "lucide-react";
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
  verifyStatus: string;
  verifyMessage: string | null;
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
  blocked: "被域名限定挡下",
};

export default function AdminSourcesPage({ loaderData }: Route.ComponentProps) {
  const [tab, setTab] = useState("sources");
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [restrictionEnabled, setRestrictionEnabled] = useState(false);
  const [verifyOverview, setVerifyOverview] = useState<VerifyOverview | null>(null);
  const [quickResult, setQuickResult] = useState<QuickImportResult | null>(null);
  const [batchResult, setBatchResult] = useState<BatchImportResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<SourceFilter>({ q: "", kind: "", status: "", verifyStatus: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const isAdmin = Boolean(loaderData.user && loaderData.admin);

  const loadAll = useCallback(async () => {
    if (!isAdmin) return;
    const params = new URLSearchParams();
    if (filter.q.trim()) params.set("q", filter.q.trim());
    if (filter.kind) params.set("kind", filter.kind);
    if (filter.status) params.set("status", filter.status);
    if (filter.verifyStatus) params.set("verifyStatus", filter.verifyStatus);
    const listUrl = `/api/admin/sources/list${params.toString() ? `?${params}` : ""}`;

    const [main, domainRes, subRes, runRes] = (await Promise.all([
      fetch(listUrl).then((r) => r.json()),
      fetch("/api/admin/sources/domains").then((r) => r.json()),
      fetch("/api/admin/sources/subscriptions").then((r) => r.json()),
      fetch("/api/admin/sources/runs").then((r) => r.json()),
    ])) as [
      { sources?: SourceRow[]; adapters?: AdapterInfo[]; verifyOverview?: VerifyOverview },
      { domains?: DomainRow[]; restrictionEnabled?: boolean },
      { subscriptions?: SubscriptionRow[] },
      { runs?: RunRow[] },
    ];
    setSources(main.sources ?? []);
    setAdapters(main.adapters ?? []);
    setVerifyOverview(main.verifyOverview ?? null);
    setDomains(domainRes.domains ?? []);
    setRestrictionEnabled(Boolean(domainRes.restrictionEnabled));
    setSubscriptions(subRes.subscriptions ?? []);
    setRuns(runRes.runs ?? []);
  }, [isAdmin, filter]);

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

      <p className="rounded-lg border border-border bg-surface/60 p-3 text-xs text-muted-foreground">
        源导入后立即可用。同步来的章节先落草稿，你确认后再发布。
        出站请求有体积（2MB）、超时（15s）与频率（1s 间隔）上限，内网与回环地址一律拒绝。
      </p>

      {message && (
        <p role="status" className="rounded-md bg-secondary px-3 py-2 text-sm">
          {message}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="sources">源（{sources.length}）</TabsTrigger>
          <TabsTrigger value="search">跨源搜书</TabsTrigger>
          <TabsTrigger value="quick">导入并订阅</TabsTrigger>
          <TabsTrigger value="subscriptions">订阅（{subscriptions.length}）</TabsTrigger>
          <TabsTrigger value="runs">同步记录</TabsTrigger>
          <TabsTrigger value="domains">域名限定</TabsTrigger>
        </TabsList>

        <TabsContent value="search">
          <AggregateSearchPanel
            busy={busy}
            onSubscribe={(body) =>
              call("/api/admin/sources/subscribe", { method: "POST", body: JSON.stringify(body) }, "已订阅并拉取目录")
            }
          />
        </TabsContent>

        <TabsContent value="quick" className="space-y-4">
          <QuickImportForm
            sources={sources}
            busy={busy}
            result={quickResult}
            onSubmit={async (body) => {
              const data = (await call(
                "/api/admin/sources/quick-import",
                { method: "POST", body: JSON.stringify(body) },
                "导入订阅完成"
              )) as QuickImportResult | null;
              setQuickResult(data);
            }}
          />
        </TabsContent>

        <TabsContent value="sources" className="space-y-4">
          <VerifyPanel overview={verifyOverview} busy={busy} onDone={loadAll} />
          <UrlImportForm
            busy={busy}
            result={batchResult}
            onSubmit={async (body) => {
              const data = (await call(
                "/api/admin/sources/batch-import",
                { method: "POST", body: JSON.stringify(body) },
                "批量导入完成"
              )) as BatchImportResult | null;
              setBatchResult(data);
            }}
          />
          <SourceCreateForm adapters={adapters} busy={busy} onSubmit={(body) =>
            call("/api/admin/sources/create", { method: "POST", body: JSON.stringify(body) }, "源已登记")
          } />
          <SourceFilterBar
            filter={filter}
            adapters={adapters}
            onChange={(next) => setFilter(next)}
          />
          <BulkBar
            sources={sources}
            selected={selected}
            busy={busy}
            onToggleAll={(checked) =>
              setSelected(checked ? sources.map((source) => source.id) : [])
            }
            onAction={async (action) => {
              await call(
                "/api/admin/sources/bulk",
                { method: "POST", body: JSON.stringify({ sourceIds: selected, action }) },
                `批量${action === "delete" ? "删除" : action === "enable" ? "启用" : "停用"}完成`
              );
              setSelected([]);
            }}
          />
          <SourceList
            sources={sources}
            selected={selected}
            onToggleSelect={(sourceId) =>
              setSelected((prev) =>
                prev.includes(sourceId)
                  ? prev.filter((id) => id !== sourceId)
                  : [...prev, sourceId]
              )
            }
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
          <section className="rounded-lg border border-border bg-surface p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold">域名限定</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  可选功能，默认关闭。关闭时任何合法地址都能抓；打开后只允许下面列出的域名，
                  用于把抓取范围收窄到指定站点。
                </p>
              </div>
              <Button
                variant={restrictionEnabled ? "default" : "secondary"}
                size="sm"
                disabled={busy}
                onClick={() =>
                  void call(
                    "/api/admin/sources/domain-restriction",
                    { method: "POST", body: JSON.stringify({ enabled: !restrictionEnabled }) },
                    restrictionEnabled ? "已关闭域名限定，被挡下的源已恢复" : "已开启域名限定"
                  )
                }
              >
                {restrictionEnabled ? "已开启" : "已关闭"}
              </Button>
            </div>
          </section>
          <DomainForm busy={busy} onSubmit={(body) =>
            call("/api/admin/sources/domains", { method: "POST", body: JSON.stringify(body) }, "域名已添加")
          } />
          {domains.length === 0 ? (
            <EmptyState
              title="列表为空"
              description={
                restrictionEnabled
                  ? "已开启域名限定但列表为空，所有抓取都会被拒绝。"
                  : "域名限定已关闭，这个列表当前不生效。"
              }
            />
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
  // 规则源必须带规则，只能靠导入书源 JSON 产生，不在手工登记的选项里
  const manualKinds = adapters.filter((adapter) => adapter.kind !== "rules");
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
              {manualKinds.map((adapter) => (
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
      <h2 className="text-base font-semibold">添加域名</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        命中时其子域一并放行。备注可留空，只是给你自己看的标签。
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
          <Label htmlFor="dom-note">备注（可选）</Label>
          <Input
            id="dom-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="自建 Calibre-Web"
          />
        </div>
      </div>
      <Button
        className="mt-3"
        disabled={busy || !host.trim()}
        onClick={() => void onSubmit({ host, authorizationNote: note })}
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        添加
      </Button>
    </section>
  );
}

interface SourceFilter {
  q: string;
  kind: string;
  status: string;
  verifyStatus: string;
}

interface VerifyOverview {
  ok: number;
  failed: number;
  untested: number;
}

interface VerifyOutcome {
  sourceId: string;
  sourceName: string;
  status: "ok" | "failed";
  searchHits: number;
  tocChapters: number;
  message: string;
}

interface VerifyBatchResponse {
  outcomes: VerifyOutcome[];
  totals: { checked: number; ok: number; failed: number; remaining: number };
  error?: string;
}

/**
 * 源可用性验证。
 *
 * 一份合集里多数源规则早已失效，只测连通性分辨不出来 —— 必须实际跑一遍
 * 「搜索 → 取目录」。跑完可一键清掉坏源，剩下的都是实测能搜能读的。
 */
function VerifyPanel({
  overview,
  busy,
  onDone,
}: {
  overview: VerifyOverview | null;
  busy: boolean;
  onDone: () => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const [keyword, setKeyword] = useState("第一");
  const [outcomes, setOutcomes] = useState<VerifyOutcome[]>([]);
  const [progress, setProgress] = useState({ checked: 0, ok: 0, failed: 0, remaining: 0 });
  const [error, setError] = useState("");
  const stopRef = useRef(false);

  /** 连续跑到没有未测源为止；每批只验几个，避开单请求资源上限 */
  async function runAll() {
    setRunning(true);
    setError("");
    setOutcomes([]);
    setProgress({ checked: 0, ok: 0, failed: 0, remaining: 0 });
    stopRef.current = false;

    try {
      for (let round = 0; round < 200; round += 1) {
        if (stopRef.current) break;
        const response = await fetch("/api/admin/sources/verify-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyword }),
        });
        const data = (await response.json()) as VerifyBatchResponse;
        if (!response.ok) {
          setError(data.error ?? "验证失败");
          break;
        }
        setOutcomes((prev) => [...data.outcomes, ...prev].slice(0, 80));
        setProgress((prev) => ({
          checked: prev.checked + data.totals.checked,
          ok: prev.ok + data.totals.ok,
          failed: prev.failed + data.totals.failed,
          remaining: data.totals.remaining,
        }));
        // 没有待验证的源了
        if (data.totals.checked === 0 || data.totals.remaining === 0) break;
      }
      await onDone();
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <ShieldCheck className="size-4" />
        筛选可用源
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        用一个常见关键字实际跑「搜索 → 取目录」，两步都成才算可用。
        只测连通性分辨不出规则是否已失效，必须实跑。
      </p>

      {overview && (
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          <Badge variant="success">可用 {overview.ok}</Badge>
          <Badge variant="danger">不可用 {overview.failed}</Badge>
          <Badge variant="secondary">未测 {overview.untested}</Badge>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="w-40 space-y-1.5">
          <Label htmlFor="vf-kw">验证关键字</Label>
          <Input id="vf-kw" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
        </div>
        <Button disabled={running || busy} onClick={() => void runAll()}>
          {running && <Loader2 className="size-4 animate-spin" />}
          {running ? "验证中…" : "开始验证"}
        </Button>
        {running && (
          <Button variant="secondary" onClick={() => (stopRef.current = true)}>
            停止
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={running || busy || !overview?.failed}
          onClick={async () => {
            const response = await fetch("/api/admin/sources/purge-failed", { method: "POST" });
            const data = (await response.json()) as { deleted?: number; error?: string };
            if (!response.ok) {
              setError(data.error ?? "清理失败");
              return;
            }
            setError("");
            await onDone();
          }}
        >
          <Trash2 className="size-4" />
          删除不可用的（{overview?.failed ?? 0}）
        </Button>
      </div>

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      {progress.checked > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          本次已验 {progress.checked} 个：可用 {progress.ok}，不可用 {progress.failed}
          {progress.remaining > 0 && ` · 剩余未测 ${progress.remaining}`}
        </p>
      )}

      {outcomes.length > 0 && (
        <ul className="mt-2 max-h-64 space-y-0.5 overflow-y-auto text-xs">
          {outcomes.map((outcome, i) => (
            <li
              key={`${outcome.sourceId}-${i}`}
              className={outcome.status === "ok" ? "text-foreground" : "text-muted-foreground"}
            >
              {outcome.status === "ok" ? "✓" : "✗"} {outcome.sourceName}：{outcome.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface BatchImportResult {
  format: string;
  finalUrl: string | null;
  bytes: number | null;
  created: { name: string; kind: string; status: string }[];
  reused: { name: string }[];
  droppedCount: number;
  warned: { name: string; warnings: string[] }[];
  totals: { usable: number; created: number; reused: number; dropped: number };
}

/** 从清单地址或粘贴的 JSON 批量导入；书源与订阅源自动判别 */
function UrlImportForm({
  busy,
  result,
  onSubmit,
}: {
  busy: boolean;
  result: BatchImportResult | null;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [mode, setMode] = useState<"url" | "text">("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");

  const canSubmit = mode === "url" ? url.trim().length > 0 : text.trim().length > 0;

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <CloudDownload className="size-4" />
        批量导入源
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        直接填清单地址即可，会自动跟随跳转（书源站通常 302 到 CDN）。
        书源与订阅源按字段自动判别，同地址的源复用不重复建。
      </p>

      <div className="mt-3 flex gap-2">
        <Button size="sm" variant={mode === "url" ? "default" : "secondary"} onClick={() => setMode("url")}>
          清单地址
        </Button>
        <Button size="sm" variant={mode === "text" ? "default" : "secondary"} onClick={() => setMode("text")}>
          粘贴 JSON
        </Button>
      </div>

      {mode === "url" ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="bi-url">清单地址</Label>
          <Input
            id="bi-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/shuyuans/json/id/1244.json"
          />
        </div>
      ) : (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="bi-text">清单 JSON</Label>
          <Textarea
            id="bi-text"
            className="font-mono text-xs"
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      )}

      <Button
        className="mt-3"
        disabled={busy || !canSubmit}
        onClick={() => void onSubmit(mode === "url" ? { url } : { text })}
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        导入
      </Button>

      {result && (
        <div className="mt-4 space-y-1.5 border-t border-border pt-3 text-sm">
          <p className="font-medium">
            已启用 {result.totals.usable} 个源
            {result.totals.reused > 0 && `（其中 ${result.totals.reused} 个此前已有）`}
          </p>
          <p className="text-xs text-muted-foreground">
            {result.format === "bookSource" ? "书源" : result.format === "rssSource" ? "订阅源" : result.format}
            {result.bytes !== null && ` · ${(result.bytes / 1024).toFixed(0)} KB`}
            {/* 用不了的源已丢弃：这些源本就不可能工作，逐条列原因没有价值 */}
            {result.totals.dropped > 0 && ` · 已自动剔除 ${result.totals.dropped} 个不可用的`}
          </p>
          {result.warned.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {result.warned.length} 个源不支持搜索（其目录与正文仍可用）
            </p>
          )}
          {result.totals.usable > 0 && (
            <p className="text-xs text-muted-foreground">
              现在可以直接在站内搜索框里搜书了。
            </p>
          )}
        </div>
      )}
    </section>
  );
}

interface GroupedBook {
  title: string;
  author: string | null;
  description: string | null;
  options: { sourceId: string; sourceName: string; externalId: string }[];
}

interface AggregateResult {
  keyword: string;
  books: GroupedBook[];
  outcomes: { sourceId: string; sourceName: string; status: string; hits: number; message?: string }[];
  totals: { sourcesQueried: number; sourcesOk: number; hits: number; books: number };
}

/** 跨源搜书：一次问所有启用的源，同名书合并 */
function AggregateSearchPanel({
  busy,
  onSubscribe,
}: {
  busy: boolean;
  onSubscribe: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [keyword, setKeyword] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<AggregateResult | null>(null);
  const [error, setError] = useState("");
  const [showOutcomes, setShowOutcomes] = useState(false);

  async function search() {
    if (!keyword.trim()) return;
    setSearching(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch("/api/admin/sources/aggregate-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword }),
      });
      const data = (await response.json()) as AggregateResult & { error?: string };
      if (!response.ok) {
        setError(data.error ?? "搜索失败");
        return;
      }
      setResult(data);
    } finally {
      setSearching(false);
    }
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-border bg-surface p-4">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <SearchIcon className="size-4" />
          跨源搜书
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          同时查询所有已启用且支持搜索的源，同名同作者的结果合并成一条，
          多源命中的排在前面。单个源超时或失败不影响其他源。
        </p>
        <div className="mt-3 flex gap-2">
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
            placeholder="输入书名或作者"
          />
          <Button disabled={searching || !keyword.trim()} onClick={() => void search()}>
            {searching ? <Loader2 className="size-4 animate-spin" /> : "搜索"}
          </Button>
        </div>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </div>

      {result && (
        <>
          <div className="rounded-lg border border-border bg-surface/60 p-3 text-xs text-muted-foreground">
            查询 {result.totals.sourcesQueried} 个源，{result.totals.sourcesOk} 个返回结果 ·
            共 {result.totals.hits} 条命中，合并为 {result.totals.books} 本
            <Button size="sm" variant="ghost" onClick={() => setShowOutcomes((v) => !v)}>
              {showOutcomes ? "收起各源状态" : "查看各源状态"}
            </Button>
            {showOutcomes && (
              <ul className="mt-1.5 max-h-48 space-y-0.5 overflow-y-auto">
                {result.outcomes.map((outcome) => (
                  <li key={outcome.sourceId}>
                    {outcome.status === "ok" ? "✓" : "✗"} {outcome.sourceName}（{outcome.status}
                    {outcome.hits > 0 && `，${outcome.hits} 条`}
                    {outcome.message && `：${outcome.message}`}）
                  </li>
                ))}
              </ul>
            )}
          </div>

          {result.books.length === 0 ? (
            <EmptyState title="没有结果" description="换个关键字，或确认已启用支持搜索的源。" />
          ) : (
            <ul className="space-y-2">
              {result.books.map((book, i) => (
                <li key={`${book.title}-${i}`} className="rounded-lg border border-border bg-surface p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{book.title}</span>
                    {book.author && (
                      <span className="text-xs text-muted-foreground">{book.author}</span>
                    )}
                    <Badge variant="secondary">{book.options.length} 个源</Badge>
                  </div>
                  {book.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {book.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {book.options.map((option) => (
                      <Button
                        key={`${option.sourceId}-${option.externalId}`}
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void onSubscribe({
                            sourceId: option.sourceId,
                            externalId: option.externalId,
                            title: book.title,
                            author: book.author,
                            description: book.description,
                          })
                        }
                      >
                        从「{option.sourceName}」订阅
                      </Button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** 源筛选。导入一份合集就是几百个，没筛选没法管 */
function SourceFilterBar({
  filter,
  adapters,
  onChange,
}: {
  filter: SourceFilter;
  adapters: AdapterInfo[];
  onChange: (next: SourceFilter) => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="min-w-48 flex-1 space-y-1.5">
        <Label htmlFor="flt-q">按名称或地址搜索</Label>
        <Input
          id="flt-q"
          value={filter.q}
          onChange={(e) => onChange({ ...filter, q: e.target.value })}
          placeholder="源名称或域名"
        />
      </div>
      <div className="w-40 space-y-1.5">
        <Label htmlFor="flt-kind">类型</Label>
        <Select
          value={filter.kind || "all"}
          onValueChange={(value) => onChange({ ...filter, kind: value === "all" ? "" : value })}
        >
          <SelectTrigger id="flt-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            {adapters.map((adapter) => (
              <SelectItem key={adapter.kind} value={adapter.kind}>
                {adapter.kind}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="w-40 space-y-1.5">
        <Label htmlFor="flt-status">状态</Label>
        <Select
          value={filter.status || "all"}
          onValueChange={(value) => onChange({ ...filter, status: value === "all" ? "" : value })}
        >
          <SelectTrigger id="flt-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="enabled">已启用</SelectItem>
            <SelectItem value="disabled">已停用</SelectItem>
            <SelectItem value="blocked">被限定挡下</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="w-40 space-y-1.5">
        <Label htmlFor="flt-verify">可用性</Label>
        <Select
          value={filter.verifyStatus || "all"}
          onValueChange={(value) =>
            onChange({ ...filter, verifyStatus: value === "all" ? "" : value })
          }
        >
          <SelectTrigger id="flt-verify">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="ok">实测可用</SelectItem>
            <SelectItem value="failed">实测不可用</SelectItem>
            <SelectItem value="untested">未验证</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/** 批量操作条 */
function BulkBar({
  sources,
  selected,
  busy,
  onToggleAll,
  onAction,
}: {
  sources: SourceRow[];
  selected: string[];
  busy: boolean;
  onToggleAll: (checked: boolean) => void;
  onAction: (action: "enable" | "disable" | "delete") => Promise<void>;
}) {
  const allChecked = sources.length > 0 && selected.length === sources.length;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-primary"
          checked={allChecked}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
        全选（当前 {sources.length} 个）
      </label>
      <span className="text-sm text-muted-foreground">已选 {selected.length}</span>
      <div className="ml-auto flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || selected.length === 0}
          onClick={() => void onAction("enable")}
        >
          批量启用
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || selected.length === 0}
          onClick={() => void onAction("disable")}
        >
          批量停用
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || selected.length === 0}
          onClick={() => void onAction("delete")}
        >
          <Trash2 className="size-4" />
          批量删除
        </Button>
      </div>
    </div>
  );
}

interface QuickImportResult {
  sources: {
    sourceId: string;
    sourceName: string;
    status: string;
    warnings: string[];
    subscribed: {
      subscriptionId: string;
      title: string;
      chaptersAdded: number;
      syncStatus: string;
      syncMessage: string;
    }[];
    failed: { target: string; reason: string }[];
  }[];
  rejected: { name: string; reason: string }[];
  totals: { sources: number; subscriptions: number; chaptersAdded: number };
}

/** 一步完成：书源 JSON（或已有源）+ 书籍地址/关键字 → 已订阅并开始同步 */
function QuickImportForm({
  sources,
  busy,
  result,
  onSubmit,
}: {
  sources: SourceRow[];
  busy: boolean;
  result: QuickImportResult | null;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [mode, setMode] = useState<"json" | "existing">("json");
  const [sourceJson, setSourceJson] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [bookUrls, setBookUrls] = useState("");
  const [keywords, setKeywords] = useState("");
  const [maxPerKeyword, setMaxPerKeyword] = useState("1");

  const canSubmit = mode === "json" ? sourceJson.trim().length > 0 : sourceId.length > 0;

  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <CloudDownload className="size-4" />
        导入并订阅
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        一次调用完成：登记源 → 解析书籍 → 建立订阅 → 拉目录 → 正文入队。
        书籍地址与关键字可以都填，也可都留空（有目录的源会自动取目录前几本）。
      </p>

      <div className="mt-3 flex gap-2">
        <Button size="sm" variant={mode === "json" ? "default" : "secondary"} onClick={() => setMode("json")}>
          粘贴书源 JSON
        </Button>
        <Button
          size="sm"
          variant={mode === "existing" ? "default" : "secondary"}
          onClick={() => setMode("existing")}
        >
          用已有源
        </Button>
      </div>

      {mode === "json" ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="qi-json">书源 JSON</Label>
          <Textarea
            id="qi-json"
            className="font-mono text-xs"
            rows={6}
            value={sourceJson}
            onChange={(e) => setSourceJson(e.target.value)}
            placeholder='[{"bookSourceName":"...","bookSourceUrl":"https://...","ruleToc":{...},"ruleContent":{...}}]'
          />
        </div>
      ) : (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor="qi-source">选择源</Label>
          <Select value={sourceId} onValueChange={setSourceId}>
            <SelectTrigger id="qi-source">
              <SelectValue placeholder="选择一个已登记的源" />
            </SelectTrigger>
            <SelectContent>
              {sources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.name}（{source.kind}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="qi-urls">书籍详情页地址（每行一个）</Label>
          <Textarea
            id="qi-urls"
            className="font-mono text-xs"
            rows={3}
            value={bookUrls}
            onChange={(e) => setBookUrls(e.target.value)}
            placeholder={"https://example.com/book/123\nhttps://example.com/book/456"}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="qi-keywords">搜索关键字（每行一个）</Label>
          <Textarea
            id="qi-keywords"
            rows={3}
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder={"修仙\n星海"}
          />
        </div>
      </div>

      <div className="mt-3 w-40 space-y-1.5">
        <Label htmlFor="qi-max">每个关键字取几本</Label>
        <Input
          id="qi-max"
          type="number"
          min={1}
          max={20}
          value={maxPerKeyword}
          onChange={(e) => setMaxPerKeyword(e.target.value)}
        />
      </div>

      <Button
        className="mt-3"
        disabled={busy || !canSubmit}
        onClick={() =>
          void onSubmit({
            ...(mode === "json" ? { sourceJson } : { sourceId }),
            bookUrls: bookUrls.split("\n").map((s) => s.trim()).filter(Boolean),
            keywords: keywords.split("\n").map((s) => s.trim()).filter(Boolean),
            maxPerKeyword: Number(maxPerKeyword) || 1,
          })
        }
      >
        {busy && <Loader2 className="size-4 animate-spin" />}
        导入并订阅
      </Button>

      {result && (
        <div className="mt-4 space-y-2 border-t border-border pt-3 text-sm">
          <p className="font-medium">
            {result.totals.sources} 个源 · {result.totals.subscriptions} 个订阅 ·{" "}
            {result.totals.chaptersAdded} 章新增
          </p>
          {result.sources.map((source) => (
            <div key={source.sourceId} className="rounded-md border border-border/60 p-2.5">
              <p className="flex items-center gap-2 text-sm font-medium">
                {source.sourceName}
                <Badge variant={source.status === "enabled" ? "success" : "warning"}>
                  {statusLabels[source.status] ?? source.status}
                </Badge>
              </p>
              {source.warnings.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  降级提示：{source.warnings.join("；")}
                </p>
              )}
              {source.subscribed.map((sub) => (
                <p key={sub.subscriptionId} className="mt-1 text-xs">
                  ✓ {sub.title} — 新增 {sub.chaptersAdded} 章（{sub.syncMessage}）
                </p>
              ))}
              {source.failed.map((fail, i) => (
                <p key={`${fail.target}-${i}`} className="mt-1 text-xs text-danger">
                  ✗ {fail.target}：{fail.reason}
                </p>
              ))}
            </div>
          ))}
          {result.rejected.map((item, i) => (
            <p key={`${item.name}-${i}`} className="text-xs text-danger">
              ✗ {item.name}：{item.reason}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

function SourceList({
  sources,
  selected,
  onToggleSelect,
  busy,
  onProbe,
  onToggle,
  onSync,
  onDelete,
  onSubscribe,
}: {
  sources: SourceRow[];
  selected: string[];
  onToggleSelect: (sourceId: string) => void;
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
            <input
              type="checkbox"
              aria-label={`选择 ${source.name}`}
              className="size-4 accent-primary"
              checked={selected.includes(source.id)}
              onChange={() => onToggleSelect(source.id)}
            />
            <span className="font-medium">{source.name}</span>
            <Badge
              variant={
                source.status === "enabled" ? "success" : source.status === "blocked" ? "danger" : "warning"
              }
            >
              {statusLabels[source.status] ?? source.status}
            </Badge>
            <Badge variant="secondary">{source.kind}</Badge>
            {/* 实测结果比连通性更能说明这个源到底能不能用 */}
            {source.verifyStatus === "ok" && <Badge variant="success">实测可用</Badge>}
            {source.verifyStatus === "failed" && <Badge variant="danger">实测不可用</Badge>}
            <span className="text-xs text-muted-foreground">
              {source.subscriptionCount} 个订阅 · 每 {source.syncIntervalMinutes} 分钟
            </span>
          </div>
          {source.verifyMessage && (
            <p className="mt-1 truncate text-xs text-muted-foreground">
              验证：{source.verifyMessage}
            </p>
          )}
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
            {/* blocked 时也必须可点：否则源被挡下后没有任何自救途径 */}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
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
