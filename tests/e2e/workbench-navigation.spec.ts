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
  await expect(menu.getByRole("menuitem", { name: /导入小说/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /内容审核/ })).toHaveCount(0);

  await menu.getByRole("menuitem", { name: /导入小说/ }).click();
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
  // 菜单项与落地页同名，一处一个名字
  await expect(menu.getByRole("menuitem", { name: /内容审核/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /用户与角色/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /运营配置/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /在线源/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /站点设置/ })).toBeVisible();

  await menu.getByRole("menuitem", { name: /内容审核/ }).click();
  await expect(page).toHaveURL(/\/admin\/moderation$/);
  await expect(page.getByRole("heading", { name: "内容审核" })).toBeVisible();
});

test("站点设置只留全站开关，管理入口不再各处重复一份", async ({ page }) => {
  await login(page, "admin@yuedu.test", "admin123");
  await page.goto("/admin");
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: "站点设置" })).toBeVisible();
  await expect(page.getByLabel("开放注册")).toBeVisible();
  await expect(page.getByLabel("上传大小上限")).toBeVisible();

  // 这三页原来在这儿各有一张只放一个按钮的卡片，与顶栏工作台重复
  for (const href of ["/admin/users", "/admin/operations", "/admin/moderation"]) {
    await expect(page.locator(`main a[href="${href}"]`)).toHaveCount(0);
  }
});
