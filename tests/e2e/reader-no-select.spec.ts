import { expect, test, type Page } from "@playwright/test";

/**
 * 正文禁止选中。
 *
 * 起因：阅读器靠点击左右三分之一翻页，手机上带一点拖动就变成选字，
 * 弹出"复制"菜单挡住正文，翻页也失效 —— 翻一页误触一次。
 *
 * 只能用 e2e 验：这是 CSS 生效与否的问题，单元测试断言 className
 * 字符串等于同义反复，真正要确认的是浏览器算出来的 user-select。
 */

async function loginBrowser(page: Page) {
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "reader@yuedu.test", password: "reader123" },
    headers: { Origin: "http://localhost:5173" },
  });
  expect(response.ok()).toBeTruthy();
}

async function openReader(page: Page) {
  await page.goto("/");
  const bookHref = await page.locator('a[href^="/books/"]').first().getAttribute("href");
  await page.goto(bookHref ?? "/");
  await page.waitForLoadState("networkidle");
  const readHref = await page.locator('a[href^="/read/"]').first().getAttribute("href");
  await page.goto(readHref ?? "/");
  await page.waitForLoadState("networkidle");
}

test.describe("正文禁止选中", () => {
  test("正文容器算出来的 user-select 是 none", async ({ page }) => {
    await loginBrowser(page);
    await openReader(page);

    const body = page.locator(".reader-body").first();
    await expect(body).toBeVisible();

    const userSelect = await body.evaluate((el) => getComputedStyle(el).userSelect);
    expect(userSelect).toBe("none");
  });

  test("正文里的段落继承不可选，选区拿不到文字", async ({ page }) => {
    await loginBrowser(page);
    await openReader(page);

    const paragraph = page.locator(".reader-body p").first();
    await expect(paragraph).toBeVisible();
    expect(await paragraph.evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");

    // 真去拖一遍：按住段落头拖到尾，选区应当是空的
    const box = await paragraph.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 4, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width - 4, box!.y + box!.height / 2, { steps: 10 });
    await page.mouse.up();

    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected).toBe("");
  });

  test("只锁正文，页面其余部分照旧可选", async ({ page }) => {
    await loginBrowser(page);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // 首页正文之外的文字不该被这条规则影响
    const heading = page.locator("h1, h2").first();
    await expect(heading).toBeVisible();
    const userSelect = await heading.evaluate((el) => getComputedStyle(el).userSelect);
    expect(userSelect).not.toBe("none");
  });
});
