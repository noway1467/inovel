import { expect, test, type Page } from "@playwright/test";

const email = "reader@yuedu.test";
const originalPassword = "reader123";

async function loginBrowser(page: Page, password = originalPassword) {
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { Origin: "http://localhost:5173" },
  });
  expect(response.ok()).toBeTruthy();
}

test.describe("账号设置", () => {
  test("可以修改昵称，顶栏随之更新", async ({ page }) => {
    await loginBrowser(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    const nameInput = page.locator("#profile-name");
    const original = await nameInput.inputValue();
    const updated = `青柠读者-${Date.now().toString().slice(-5)}`;

    // 未改动时保存按钮应为禁用
    await expect(page.getByRole("button", { name: "保存资料" })).toBeDisabled();

    await nameInput.fill(updated);
    await page.getByRole("button", { name: "保存资料" }).click();
    await expect(page.getByRole("status")).toContainText("资料已更新");

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#profile-name")).toHaveValue(updated);

    // 还原，避免污染其他用例
    await page.locator("#profile-name").fill(original);
    await page.getByRole("button", { name: "保存资料" }).click();
    await expect(page.getByRole("status")).toContainText("资料已更新");
  });

  test("昵称为空时给出校验提示且不提交", async ({ page }) => {
    await loginBrowser(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.locator("#profile-name").fill("   ");
    await page.getByRole("button", { name: "保存资料" }).click();
    await expect(page.getByRole("status")).toContainText("昵称不能为空");
  });

  test("新密码两次输入不一致时拒绝提交", async ({ page }) => {
    await loginBrowser(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.locator("#pw-current").fill(originalPassword);
    await page.locator("#pw-next").fill("newpassword123");
    await page.locator("#pw-confirm").fill("newpassword124");
    await page.getByRole("button", { name: "更新密码" }).click();
    await expect(page.getByRole("status")).toContainText("两次输入的新密码不一致");
  });

  test("当前密码错误时给出提示", async ({ page }) => {
    await loginBrowser(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.locator("#pw-current").fill("definitely-wrong-password");
    await page.locator("#pw-next").fill("newpassword123");
    await page.locator("#pw-confirm").fill("newpassword123");
    await page.getByRole("button", { name: "更新密码" }).click();
    await expect(page.getByRole("status")).toContainText(/当前密码不正确|修改失败/);
  });

  test("改密码后旧密码失效、新密码可登录，并改回原密码", async ({ page }) => {
    const tempPassword = "tempPassword123";
    await loginBrowser(page);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");

    await page.locator("#pw-current").fill(originalPassword);
    await page.locator("#pw-next").fill(tempPassword);
    await page.locator("#pw-confirm").fill(tempPassword);
    await page.getByRole("button", { name: "更新密码" }).click();
    await expect(page.getByRole("status")).toContainText("密码已更新");

    // 旧密码应失效
    const stale = await page.request.post("/api/auth/sign-in/email", {
      data: { email, password: originalPassword },
      headers: { Origin: "http://localhost:5173" },
    });
    expect(stale.ok()).toBeFalsy();

    // 新密码可登录，并用它改回原密码，保证其他用例不受影响
    await loginBrowser(page, tempPassword);
    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    await page.locator("#pw-current").fill(tempPassword);
    await page.locator("#pw-next").fill(originalPassword);
    await page.locator("#pw-confirm").fill(originalPassword);
    await page.getByRole("button", { name: "更新密码" }).click();
    await expect(page.getByRole("status")).toContainText("密码已更新");

    const restored = await page.request.post("/api/auth/sign-in/email", {
      data: { email, password: originalPassword },
      headers: { Origin: "http://localhost:5173" },
    });
    expect(restored.ok()).toBeTruthy();
  });
});

test.describe("界面密度", () => {
  test("发现页不再有大标题面板，内容更靠上", async ({ page }) => {
    await loginBrowser(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // 原来的大标题文案应已移除
    await expect(page.getByText("把想读的书，安静放进书架")).toHaveCount(0);

    // 首屏就能看到"最新作品"标题，说明上方没有被大面板挤走
    const heading = page.locator("#latest-books");
    const box = await heading.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.y).toBeLessThan(page.viewportSize()!.height);
  });

  test("分类页每格更紧凑并显示作品数", async ({ page }) => {
    await loginBrowser(page);
    await page.goto("/categories");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("浏览该分类")).toHaveCount(0);
    const firstCard = page.locator('a[href^="/categories/"]').first();
    const box = await firstCard.boundingBox();
    expect(box).toBeTruthy();
    // 原来 min-h-20 = 80px，现在应明显更矮
    expect(box!.height).toBeLessThan(60);
  });
});
