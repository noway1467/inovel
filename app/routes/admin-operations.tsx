import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type { Route } from "./+types/admin-operations";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { EmptyState } from "~/components/state/empty-state";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { createAuth } from "~/server/auth";
import { getUserRoleCodes } from "~/server/security/rbac";
import { listPublishedBooks } from "~/server/repositories/books";
import { pageMeta, pageTitle } from "~/lib/page-title";

export function meta() {
  return pageMeta(pageTitle("运营配置"));
}

interface CategoryItem {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  enabled: boolean;
}

interface TagItem {
  id: string;
  name: string;
  enabled: boolean;
}

interface SlotItem {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  items: { id: string; slotId: string; bookId: string; bookTitle: string; enabled: boolean }[];
}

interface AnnouncementItem {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
  createdAt: string;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return { user: null, admin: false, books: [] };
  const db = createDb(env.DB_APP);
  const roles = await getUserRoleCodes(db, session.user.id);
  const admin = roles.some((role) => ["operator", "admin", "super_admin"].includes(role));
  const books = admin ? await listPublishedBooks(db, 100) : [];
  return { user: session.user, admin, books };
}

export default function AdminOperationsPage({ loaderData }: Route.ComponentProps) {
  const [tab, setTab] = useState("categories");
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [slots, setSlots] = useState<SlotItem[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [pickBook, setPickBook] = useState("");
  const [annTitle, setAnnTitle] = useState("");
  const [annBody, setAnnBody] = useState("");
  const [message, setMessage] = useState("");

  async function loadAll() {
    setLoading(true);
    try {
      const [c, t, r, a] = await Promise.all([
        fetch("/api/admin/operations/categories").then((res) => res.json()),
        fetch("/api/admin/operations/tags").then((res) => res.json()),
        fetch("/api/admin/operations/recommendations").then((res) => res.json()),
        fetch("/api/admin/operations/announcements").then((res) => res.json()),
      ]);
      setCategories((c as { categories?: CategoryItem[] }).categories ?? []);
      setTags((t as { tags?: TagItem[] }).tags ?? []);
      setSlots((r as { slots?: SlotItem[] }).slots ?? []);
      setAnnouncements((a as { announcements?: AnnouncementItem[] }).announcements ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (loaderData.admin) void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as { error?: string };
    if (!response.ok) {
      setMessage(data.error ?? "操作失败");
      return false;
    }
    setMessage("");
    await loadAll();
    return true;
  }

  if (!loaderData.user || !loaderData.admin) {
    return (
      <div className="mx-auto max-w-md">
        <EmptyState
          title="需要运营权限"
          action={
            <Button asChild>
              <Link to={loaderData.user ? "/admin" : "/login?redirect=/admin/operations"}>
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
      <div>
        <h1 className="text-xl font-semibold">运营配置</h1>
        <p className="mt-1 text-sm text-muted-foreground">分类、标签与首页推荐位。</p>
      </div>

      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      {loading && (
        <div className="flex justify-center py-8">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="categories">分类</TabsTrigger>
          <TabsTrigger value="tags">标签</TabsTrigger>
          <TabsTrigger value="recommendations">推荐位</TabsTrigger>
          <TabsTrigger value="announcements">公告</TabsTrigger>
          <TabsTrigger value="rankings">榜单</TabsTrigger>
        </TabsList>

        <TabsContent value="categories">
          <div className="mb-3 flex flex-wrap gap-2">
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="分类名" className="max-w-40" aria-label="分类名" />
            <Input value={newSlug} onChange={(event) => setNewSlug(event.target.value)} placeholder="slug" className="max-w-40" aria-label="分类 slug" />
            <Button
              onClick={() => {
                if (newName && newSlug) {
                  void post("/api/admin/operations/categories", { name: newName, slug: newSlug });
                  setNewName("");
                  setNewSlug("");
                }
              }}
            >
              <Plus className="size-4" />
              新增分类
            </Button>
          </div>
          <div className="space-y-2">
            {categories.map((category) => (
              <div key={category.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{category.name} <span className="text-xs text-muted-foreground">({category.slug})</span></p>
                </div>
                <Badge variant={category.enabled ? "success" : "outline"}>{category.enabled ? "启用" : "停用"}</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void post("/api/admin/operations/categories", { id: category.id, enabled: !category.enabled })}
                >
                  {category.enabled ? "停用" : "启用"}
                </Button>
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="tags">
          <div className="mb-3 flex gap-2">
            <Input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="标签名" className="max-w-56" aria-label="标签名" />
            <Button
              onClick={() => {
                if (newName) {
                  void post("/api/admin/operations/tags", { name: newName });
                  setNewName("");
                }
              }}
            >
              <Plus className="size-4" />
              新增标签
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                onClick={() => void post("/api/admin/operations/tags", { id: tag.id, enabled: !tag.enabled })}
                className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  tag.enabled ? "border-primary/30 bg-primary/5 text-foreground" : "border-border text-muted-foreground opacity-60"
                }`}
              >
                {tag.name}
              </button>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="recommendations">
          {slots.map((slot) => (
            <section key={slot.id} className="mb-4 rounded-lg border border-border bg-surface p-4">
              <h3 className="text-base font-semibold">{slot.name} <span className="text-xs text-muted-foreground">({slot.code})</span></h3>
              <div className="mt-3 space-y-2">
                {slot.items.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 rounded-md border border-border bg-background p-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{item.bookTitle}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`移除 ${item.bookTitle}`}
                      onClick={() => void post("/api/admin/operations/recommendations", { action: "remove", itemId: item.id })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
                {slot.items.length === 0 && <p className="text-sm text-muted-foreground">暂无推荐，添加一部作品。</p>}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Select value={pickBook} onValueChange={setPickBook}>
                  <SelectTrigger className="max-w-56" aria-label="选择作品">
                    <SelectValue placeholder="选择作品" />
                  </SelectTrigger>
                  <SelectContent>
                    {loaderData.books.map((book) => (
                      <SelectItem key={book.id} value={book.id}>
                        {book.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  onClick={() => {
                    if (pickBook) {
                      void post("/api/admin/operations/recommendations", { action: "add", slotId: slot.id, bookId: pickBook });
                      setPickBook("");
                    }
                  }}
                >
                  <Plus className="size-4" />
                  添加
                </Button>
              </div>
            </section>
          ))}
        </TabsContent>

        <TabsContent value="announcements">
          <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <Input value={annTitle} onChange={(event) => setAnnTitle(event.target.value)} placeholder="公告标题" aria-label="公告标题" />
            <Input value={annBody} onChange={(event) => setAnnBody(event.target.value)} placeholder="公告内容" aria-label="公告内容" />
            <Button
              onClick={() => {
                if (annTitle && annBody) {
                  void post("/api/admin/operations/announcements", { title: annTitle, body: annBody });
                  setAnnTitle("");
                  setAnnBody("");
                }
              }}
            >
              <Plus className="size-4" />
              发布公告
            </Button>
          </div>
          <div className="space-y-2">
            {announcements.map((announcement) => (
              <div key={announcement.id} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{announcement.title}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{announcement.body}</p>
                </div>
                <Badge variant={announcement.enabled ? "success" : "outline"}>
                  {announcement.enabled ? "展示中" : "已停用"}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void post("/api/admin/operations/announcements", { id: announcement.id, enabled: !announcement.enabled })}
                >
                  {announcement.enabled ? "停用" : "启用"}
                </Button>
              </div>
            ))}
            {announcements.length === 0 && <p className="text-sm text-muted-foreground">暂无公告。</p>}
          </div>
        </TabsContent>

        <TabsContent value="rankings">
          <p className="mb-3 text-sm text-muted-foreground">刷新后生成真实统计快照（发布作品按字数/更新时间排序），榜单页优先展示最近快照。</p>
          <div className="flex flex-wrap gap-2">
            {(["week", "month", "total"] as const).map((type) => (
              <Button
                key={type}
                variant="outline"
                onClick={() => void post("/api/admin/operations/rankings", { action: "refresh", type })}
              >
                <Loader2 className="size-4" />
                刷新{type === "week" ? "周榜" : type === "month" ? "月榜" : "总榜"}
              </Button>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
