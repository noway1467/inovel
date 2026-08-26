import { useState } from "react";
import { useRevalidator } from "react-router";
import { Loader2, UserRound } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { translateAuthError } from "~/lib/auth-errors";

/** 修改昵称/头像。走 better-auth 的 /api/auth/update-user。 */
export function ProfileForm({
  initialName,
  initialImage,
}: {
  initialName: string;
  initialImage: string | null;
}) {
  const revalidator = useRevalidator();
  const [name, setName] = useState(initialName);
  const [image, setImage] = useState(initialImage ?? "");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const dirty = name.trim() !== initialName || image.trim() !== (initialImage ?? "");

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus({ kind: "error", text: "昵称不能为空。" });
      return;
    }
    if (trimmed.length > 30) {
      setStatus({ kind: "error", text: "昵称不能超过 30 字。" });
      return;
    }
    setStatus(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/update-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, image: image.trim() || null }),
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        setStatus({
          kind: "error",
          text: translateAuthError(data.message, "保存失败，请稍后重试。"),
        });
        return;
      }
      setStatus({ kind: "ok", text: "资料已更新。" });
      // 顶栏头像/昵称来自 layout loader，需要重新校验才会刷新
      void revalidator.revalidate();
    } catch {
      setStatus({ kind: "error", text: "网络异常，请稍后重试。" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <UserRound className="size-4" />
        个人资料
      </h2>
      <form className="mt-4 space-y-4" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <Label htmlFor="profile-name">昵称</Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={30}
            autoComplete="nickname"
            placeholder="你的公开昵称"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-image">头像链接</Label>
          <Input
            id="profile-image"
            value={image}
            onChange={(event) => setImage(event.target.value)}
            type="url"
            placeholder="https://…（留空使用首字母头像）"
          />
        </div>
        {status && (
          <p
            role="status"
            className={`rounded-md px-3 py-2 text-sm ${
              status.kind === "ok" ? "bg-primary/10 text-primary" : "bg-danger/10 text-danger"
            }`}
          >
            {status.text}
          </p>
        )}
        <Button type="submit" disabled={submitting || !dirty}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? "保存中…" : "保存资料"}
        </Button>
      </form>
    </section>
  );
}
