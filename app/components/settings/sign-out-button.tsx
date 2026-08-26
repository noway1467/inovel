import { useState } from "react";
import { Loader2, LogOut } from "lucide-react";
import { Button } from "~/components/ui/button";

/**
 * 退出登录。用 fetch 而不是原生 form 提交：
 * better-auth 端点吃 JSON，表单的 urlencoded 编码会被拒。
 */
export function SignOutButton() {
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await fetch("/api/auth/sign-out", { method: "POST" });
          window.location.assign("/login");
        } catch {
          setPending(false);
        }
      }}
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
      退出登录
    </Button>
  );
}
