import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { TooltipProvider } from "~/components/ui/tooltip";
import { pageMeta, siteName } from "~/lib/page-title";
import type { Route } from "./+types/root";
import "./app.css";

/*
  兜底标题。子路由自己导出 meta 时会覆盖这一份，只有两种情况会用到它：
  路由没写 meta，或者 loader 抛错走了 ErrorBoundary（那时 loaderData 是空的）。
  没有它浏览器会拿 URL 当标题，标签页上就是一串 /sources/xxx/chapter?key=…
*/
export function meta(_: Route.MetaArgs) {
  return pageMeta(siteName);
}

/*
  首屏之前定好配色，避免闪一下白再变深色。

  两个维度各自独立存：
   - yuedu-theme  明暗（light / dark），没存就跟系统
   - yuedu-skin   哪套配色（amber / ink / moss / plum），没存就 amber

  取值都做了白名单校验 —— localStorage 是用户可改的，脏值直接落到
  data-theme 上会得到一个没有任何颜色变量的页面。
*/
const themeInitScript = `
try {
  var skins = ["amber", "ink", "moss", "plum"];
  var skin = localStorage.getItem("yuedu-skin");
  document.documentElement.dataset.theme = skins.indexOf(skin) >= 0 ? skin : "amber";

  var stored = localStorage.getItem("yuedu-theme");
  var dark = stored === "dark" || stored === "light"
    ? stored === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", dark);
} catch (_) {}
`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {/* 移动端地址栏配色，跟默认主题的底色一致 */}
        <meta name="theme-color" content="#fdf8f3" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#1a1512" media="(prefers-color-scheme: dark)" />
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
