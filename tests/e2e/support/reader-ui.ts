import { expect, type Page } from "@playwright/test";

/**
 * 点击正文中心把上下栏亮出来。
 *
 * 上下栏进页面 3.5s 后自动收起，且收起用的是 translate-y-full——元素仍在 DOM 里、
 * 仍可点击，所以直接点会"点到屏幕外的按钮"，测不出真实交互。
 * 这里显式走一遍新交互（点中心切换），并断言状态，避免用例依赖时序。
 */
export async function revealReaderChrome(page: Page) {
  const surface = page.locator(".reader-surface");
  await expect(surface).toBeVisible();

  if ((await surface.getAttribute("data-ui-visible")) === "true") return;

  // 中心 40% 区域才切换上下栏，两侧是翻页区
  await page.locator("main").click({ position: await centerOfMain(page) });
  await expect(surface).toHaveAttribute("data-ui-visible", "true");
}

/** 收起上下栏（若当前是显示态）。 */
export async function hideReaderChrome(page: Page) {
  const surface = page.locator(".reader-surface");
  if ((await surface.getAttribute("data-ui-visible")) !== "true") return;
  await page.locator("main").click({ position: await centerOfMain(page) });
  await expect(surface).toHaveAttribute("data-ui-visible", "false");
}

async function centerOfMain(page: Page) {
  const box = await page.locator("main").boundingBox();
  if (!box) throw new Error("找不到阅读区");
  return { x: box.width / 2, y: box.height / 2 };
}
