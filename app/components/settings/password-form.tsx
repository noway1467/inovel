import { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { translateAuthError } from "~/lib/auth-errors";

const minPasswordLength = 8;

/** 修改密码。走 better-auth 的 /api/auth/change-password，需要提供当前密码。 */
export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (next.length < minPasswordLength) {
      setStatus({ kind: "error", text: `新密码至少 ${minPasswordLength} 位。` });
      return;
    }
    if (next !== confirm) {
      setStatus({ kind: "error", text: "两次输入的新密码不一致。" });
      return;
    }
    if (next === current) {
      setStatus({ kind: "error", text: "新密码不能与当前密码相同。" });
      return;
    }
    setStatus(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: current,
          newPassword: next,
          revokeOtherSessions: revokeOthers,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        setStatus({
          kind: "error",
          text: translateAuthError(
            data.message,
            response.status === 400 ? "当前密码不正确。" : "修改失败，请稍后重试。"
          ),
        });
        return;
      }
      setStatus({
        kind: "ok",
        text: revokeOthers ? "密码已更新，其他设备已退出登录。" : "密码已更新。",
      });
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch {
      setStatus({ kind: "error", text: "网络异常，请稍后重试。" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <KeyRound className="size-4" />
        修改密码
      </h2>
      <form className="mt-4 space-y-4" onSubmit={onSubmit}>
        <div className="space-y-1.5">
          <Label htmlFor="pw-current">当前密码</Label>
          <Input
            id="pw-current"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="pw-next">新密码</Label>
            <Input
              id="pw-next"
              type="password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
              minLength={minPasswordLength}
              autoComplete="new-password"
              placeholder={`至少 ${minPasswordLength} 位`}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-confirm">确认新密码</Label>
            <Input
              id="pw-confirm"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
              minLength={minPasswordLength}
              autoComplete="new-password"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={revokeOthers}
            onChange={(event) => setRevokeOthers(event.target.checked)}
            className="size-4 accent-primary"
          />
          同时退出其他设备的登录
        </label>
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
        <Button type="submit" disabled={submitting || !current || !next || !confirm}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? "提交中…" : "更新密码"}
        </Button>
      </form>
    </section>
  );
}
