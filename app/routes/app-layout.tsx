import { Outlet, redirect } from "react-router";
import type { Route } from "./+types/app-layout";
import { AppHeader } from "~/components/layout/app-header";
import { MobileHeader } from "~/components/layout/mobile-header";
import { MobileNav } from "~/components/layout/mobile-nav";
import { cloudflareContext } from "~/server/context";
import { createAuth } from "~/server/auth";
import { createDb } from "~/server/db";
import { getRegistrationEnabled } from "~/server/settings/registration";
import { getUserRoleCodes } from "~/server/security/rbac";
import { notifications } from "drizzle/schema";
import { and, eq, isNull } from "drizzle-orm";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  const url = new URL(request.url);
  const isPublicPage = url.pathname === "/login" || url.pathname === "/register";
  if (!session?.user && !isPublicPage) {
    return redirect(`/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);
  }
  const db = createDb(env.DB_APP);
  const registrationEnabled = await getRegistrationEnabled(db);
  const roleCodes = session?.user ? await getUserRoleCodes(db, session.user.id) : [];
  const isAuthor = roleCodes.includes("author");
  const isAdmin = roleCodes.some((code) => code === "admin" || code === "super_admin");
  const unreadRows = session?.user
    ? await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.userId, session.user.id), isNull(notifications.readAt)))
        .all()
    : [];
  return {
    user: session?.user
      ? { name: session.user.name, email: session.user.email, image: session.user.image }
      : null,
    registrationEnabled,
    isAuthor,
    isAdmin,
    unreadCount: unreadRows.length,
  };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <div className="app-shell min-h-dvh bg-background">
      <AppHeader
        user={loaderData.user}
        registrationEnabled={loaderData.registrationEnabled}
        isAuthor={loaderData.isAuthor}
        isAdmin={loaderData.isAdmin}
        unreadCount={loaderData.unreadCount}
      />
      <MobileHeader
        user={loaderData.user}
        isAuthor={loaderData.isAuthor}
        isAdmin={loaderData.isAdmin}
        unreadCount={loaderData.unreadCount}
      />
      <main className="mx-auto w-full max-w-[1180px] px-3 pb-24 pt-4 sm:px-5 md:pb-10 md:pt-7">
        <Outlet />
      </main>
      <MobileNav />
    </div>
  );
}
