import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { TooltipProvider } from "~/components/ui/tooltip";
import type { Route } from "./+types/root";
import "./app.css";

const themeInitScript = `
try {
  const stored = localStorage.getItem("yuedu-theme");
  const theme = stored === "dark" || stored === "light"
    ? stored
    : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.classList.toggle("dark", theme === "dark");
} catch (_) {}
`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#2563eb" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <TooltipProvider>{children}</TooltipProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "页面出错了";
  let details = "发生了意外错误，请稍后重试。";

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "页面不存在" : `${error.status} ${error.statusText}`;
    details = error.status === 404 ? "你访问的页面可能已被移动或删除。" : details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-3xl font-semibold">{message}</p>
      <p className="text-sm text-muted-foreground">{details}</p>
      <a href="/" className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
        返回首页
      </a>
    </main>
  );
}
