/**
 * React Router 的 single fetch 在客户端导航时请求的是 `/xxx.data`（并可能带上
 * `_routes` 等内部查询参数），而不是用户可见的 `/xxx`。
 *
 * 登录守卫如果直接拿 `url.pathname` 比对白名单或拼 redirect，会有两个后果：
 * 1. `/register.data` 不等于 `/register`，公开页被误判为需要登录，重定向回
 *    `/login`；紧接着 `/login.data` 同样被误判，形成 `?redirect=` 无限套娃，
 *    表现为点击「去注册」毫无反应。
 * 2. 登录后按 redirect 跳转会落到 `/read/x/y.data` 这类非页面地址。
 *
 * 因此守卫里一律用本模块还原成用户可见路径。
 */

const dataSuffix = ".data";

/** single fetch 内部参数，不应出现在用户可见地址里 */
const internalSearchParams = ["_routes"];

export interface VisiblePath {
  /** 去掉 `.data` 后的路径，例如 /register */
  pathname: string;
  /** 用户可见路径 + 过滤后的查询串，可直接放进 `?redirect=` */
  fullPath: string;
}

export function getVisiblePath(url: URL): VisiblePath {
  const pathname = url.pathname.endsWith(dataSuffix)
    ? url.pathname.slice(0, -dataSuffix.length) || "/"
    : url.pathname;

  const search = new URLSearchParams(url.search);
  for (const key of internalSearchParams) search.delete(key);
  const query = search.toString();

  return { pathname, fullPath: query ? `${pathname}?${query}` : pathname };
}

/** 生成指向登录页的重定向地址，redirect 参数始终是用户可见路径 */
export function loginRedirectTo(url: URL): string {
  const { fullPath } = getVisiblePath(url);
  return `/login?redirect=${encodeURIComponent(fullPath)}`;
}
