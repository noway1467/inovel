import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  const origin = process.env.E2E_BASE_URL ?? "http://localhost:5173";
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { Origin: origin },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function visibleWorkbench(page: import("@playwright/test").Page) {
  return page.locator('button[aria-label="工作台"]:visible');
}

test("普通读者看不到工作台，也无法打开发布表单", async ({ page }) => {
  test.setTimeout(60_000);
  await login(page, "reader@yuedu.test", "reader123");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(visibleWorkbench(page)).toHaveCount(0);

  await page.goto("/creator/upload", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("需要作者权限", { exact: true })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
});

test("作者可从顶栏集中进入作品管理和发布", async ({ page }) => {
  await login(page, "author@yuedu.test", "author123");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const trigger = visibleWorkbench(page);
  await expect(trigger).toBeVisible();
  await trigger.click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /作品管理/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /发布作品/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /审核中心/ })).toHaveCount(0);

  await menu.getByRole("menuitem", { name: /发布作品/ }).click();
  await expect(page).toHaveURL(/\/creator\/upload$/);
  await expect(page.locator("#skip-review")).toBeVisible();
});

test("管理员可从顶栏集中进入审核与后台管理", async ({ page }) => {
  await login(page, "admin@yuedu.test", "admin123");
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const trigger = visibleWorkbench(page);
  await expect(trigger).toBeVisible();
  await trigger.click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "审核中心" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "管理首页" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "用户管理" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "内容运营" })).toBeVisible();

  await menu.getByRole("menuitem", { name: "审核中心" }).click();
  await expect(page).toHaveURL(/\/admin\/moderation$/);
  await expect(page.getByRole("heading", { name: "审核工作台" })).toBeVisible();
});
