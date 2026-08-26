import { expect, test } from "@playwright/test";

const origin = "http://localhost:5173";

async function setRegistration(page: import("@playwright/test").Page, enabled: boolean) {
  const login = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "admin@yuedu.test", password: "admin123" },
    headers: { Origin: origin },
  });
  expect(login.ok()).toBeTruthy();
  const response = await page.request.post("/api/admin/site-settings", {
    data: { registrationEnabled: enabled },
    headers: { "Content-Type": "application/json" },
  });
  expect(response.ok()).toBeTruthy();
  await page.request.post("/api/auth/sign-out", { headers: { Origin: origin } });
  await page.context().clearCookies();
}

test("开放注册后，登录页「去注册」可跳转 /register", async ({ page }) => {
  await setRegistration(page, true);

  await page.goto("/login");
  const registerLink = page.getByRole("main").getByRole("link", { name: "注册", exact: true });
  await expect(registerLink).toBeVisible();
  await registerLink.click();

  await expect(page).toHaveURL(/\/register/);
  await expect(page.getByRole("heading", { name: "注册悦读" })).toBeVisible();
});

test("注册页内的「登录」链接可跳回登录页", async ({ page }) => {
  await setRegistration(page, true);

  await page.goto("/register");
  await page.getByRole("main").getByRole("link", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "登录悦读" })).toBeVisible();
});

test("未登录点击阅读链接，登录后回到干净的阅读地址（不带 .data）", async ({ page }) => {
  await setRegistration(page, false);

  // 客户端导航到受保护页面时，single fetch 请求的是 /read/....data，
  // 守卫若不还原路径，redirect 会带上 .data 后缀
  await page.goto("/read/some-book/some-chapter");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  const target = new URL(page.url()).searchParams.get("redirect") ?? "";
  expect(target).toBe("/read/some-book/some-chapter");
  expect(target).not.toContain(".data");
});

test("管理员切换开放注册后，顶栏注册入口即时出现，无需刷新", async ({ page }) => {
  await setRegistration(page, false);

  const login = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "admin@yuedu.test", password: "admin123" },
    headers: { Origin: origin },
  });
  expect(login.ok()).toBeTruthy();

  await page.goto("/admin");
  await page.waitForLoadState("networkidle");
  const toggle = page.getByRole("switch", { name: "开放注册" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(page.getByText("已保存，前端入口即时生效")).toBeVisible();

  // 切换后 app-layout 的 registrationEnabled 应已刷新（退出登录后顶栏才显示注册按钮）
  await page.request.post("/api/auth/sign-out", { headers: { Origin: origin } });
  await page.context().clearCookies();
  await page.goto("/login");
  await expect(page.getByRole("main").getByRole("link", { name: "注册", exact: true })).toBeVisible();
});
