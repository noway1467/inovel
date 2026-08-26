import type { Route } from "./+types/api.sources-search";
import { createAuth } from "~/server/auth";
import { cloudflareContext } from "~/server/context";
import { createDb } from "~/server/db";
import { aggregateSearch, maxSourcesPerSearch } from "~/server/sources/search";

/**
 * 分批的在线源搜索，供搜索页客户端反复调用。
 *
 * 每次只查一小批源（默认 8 个），返回 nextOffset 指向下一批。
 * 这是绕开 Workers 单请求资源上限的关键：250 个源放在一个请求里
 * 会直接 Error 1102。
 *
 * 需要登录：抓取会产生出站请求，不能让未登录访问触发。
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = createAuth(env.DB_APP, env.BETTER_AUTH_SECRET, env.BETTER_AUTH_URL);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const keyword = url.searchParams.get("q")?.trim() ?? "";
  if (!keyword) return Response.json({ error: "q required" }, { status: 400 });

  const offsetRaw = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

  const batchRaw = Number.parseInt(url.searchParams.get("batch") ?? "", 10);
  // 上限硬性封顶，不允许客户端要求一次查很多源
  const maxSources =
    Number.isFinite(batchRaw) && batchRaw > 0
      ? Math.min(batchRaw, maxSourcesPerSearch)
      : maxSourcesPerSearch;

  const db = createDb(env.DB_APP);
  try {
    const result = await aggregateSearch(db, keyword, {
      offset,
      maxSources,
      perSourceLimit: 5,
      timeoutMs: 8_000,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "搜索失败" },
      { status: 400 }
    );
  }
}
