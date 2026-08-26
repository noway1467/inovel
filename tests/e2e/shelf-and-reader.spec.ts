import { expect, test, type Page } from "@playwright/test";
import { revealReaderChrome } from "./support/reader-ui";

async function loginBrowser(page: Page) {
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "reader@yuedu.test", password: "reader123" },
    headers: { Origin: "http://localhost:5173" },
  });
  expect(response.ok()).toBeTruthy();
}

async function openFirstBook(page: Page) {
  await page.goto("/");
  const firstBook = page.locator('a[href^="/books/"]').first();
  const href = await firstBook.getAttribute("href");
  await page.goto(href ?? "/");
  await page.waitForLoadState("networkidle");
  return href ?? "";
}

/** 桌面/移动两套布局各有一个书架按钮，取当前可见的那个。 */
function shelfButton(page: Page) {
  return page.locator('button:visible', { hasText: /加入书架|已在书架/ }).first();
}

test.describe("书架状态", () => {
  test.beforeEach(async ({ page }) => {
    await loginBrowser(page);
    const bookHref = await openFirstBook(page);
    // 从干净状态开始：先确保这本书不在书架。
    // 前置清理失败不应判定用例失败，dev server 冷编译时这一枪可能很慢
    const bookId = bookHref.replace("/books/", "");
    try {
      await page.request.fetch(`/api/library/shelf?bookId=${bookId}`, {
        method: "DELETE",
        timeout: 15_000,
      });
    } catch {
      // 忽略：用例内会显式断言初始状态
    }
  });

  test("加入书架后刷新仍显示已在书架", async ({ page }) => {
    await page.reload();
    await page.waitForLoadState("networkidle");
    const button = shelfButton(page);
    await expect(button).toHaveText(/加入书架/);

    await button.click();
    await expect(button).toHaveText(/已在书架/);

    // 回归点：状态此前只存在组件 state 里，刷新后必然退回“加入书架”
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(shelfButton(page)).toHaveText(/已在书架/);
  });

  test("再次点击可移出书架，状态随之改变", async ({ page }) => {
    await page.reload();
    await page.waitForLoadState("networkidle");
    const button = shelfButton(page);
    await button.click();
    await expect(button).toHaveText(/已在书架/);

    // 回归点：此前无论什么状态都发 POST，点“已在书架”文案不变
    await button.click();
    await expect(button).toHaveText(/加入书架/);

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(shelfButton(page)).toHaveText(/加入书架/);
  });

  test("书架页与详情页状态一致", async ({ page }) => {
    await page.reload();
    await page.waitForLoadState("networkidle");
    const bookTitle = await page.locator("h1").first().innerText();
    await shelfButton(page).click();
    await expect(shelfButton(page)).toHaveText(/已在书架/);

    await page.goto("/library");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(bookTitle, { exact: false }).first()).toBeVisible();
  });
});

test.describe("阅读页上下栏", () => {
  async function openReader(page: Page) {
    await loginBrowser(page);
    await page.request.post("/api/reader/preferences", {
      data: { paginationMode: "cover" },
      headers: { "Content-Type": "application/json" },
    });
    await openFirstBook(page);
    const readHref = await page.locator('a[href^="/read/"]').first().getAttribute("href");
    await page.goto(readHref ?? "/");
    await page.waitForLoadState("networkidle");
    // 等进场那次自动收起结束，从"隐藏"这个确定状态开始测
    await expect(page.locator(".reader-surface")).toHaveAttribute(
      "data-ui-visible",
      "false",
      { timeout: 8000 }
    );
    return page.locator("main");
  }

  test("鼠标移入正文不再自动显示上下栏", async ({ page }) => {
    const main = await openReader(page);
    const box = (await main.boundingBox())!;

    // 回归点：原来 onMouseMove 一触发就亮，桌面端等于常显
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 40);
    await page.waitForTimeout(300);
    await expect(page.locator(".reader-surface")).toHaveAttribute("data-ui-visible", "false");
  });

  test("点击中心显示，再点收起", async ({ page }) => {
    const main = await openReader(page);
    const surface = page.locator(".reader-surface");
    const box = (await main.boundingBox())!;
    const center = { x: box.width / 2, y: box.height / 2 };

    await main.click({ position: center });
    await expect(surface).toHaveAttribute("data-ui-visible", "true");
    await expect(page.locator('button[aria-label="目录"]')).toBeInViewport();

    await main.click({ position: center });
    await expect(surface).toHaveAttribute("data-ui-visible", "false");
  });

  test("点击两侧不显示上下栏", async ({ page }) => {
    const main = await openReader(page);
    const surface = page.locator(".reader-surface");
    const box = (await main.boundingBox())!;

    // 两侧是翻页区：不管本章有几页（单页章节点右侧会直接跳下一章），
    // 都不该把上下栏亮出来 —— 这是本用例要锁的行为
    for (const ratio of [0.88, 0.12, 0.95, 0.05]) {
      await main.click({ position: { x: box.width * ratio, y: box.height / 2 } });
      await expect(surface).toHaveAttribute("data-ui-visible", "false");
    }
  });

  test("点击右侧被当作翻页消费，而不是切换上下栏", async ({ page }) => {
    const main = await openReader(page);
    const surface = page.locator(".reader-surface");
    const indicator = page.locator(".reader-page-indicator");

    const pageBefore = await indicator.innerText();
    const urlBefore = page.url();
    const box = (await main.boundingBox())!;
    await main.click({ position: { x: box.width * 0.88, y: box.height / 2 } });

    // 种子章节长度不定：可能翻到下一页，也可能因为只有一页而直接跳下一章。
    // 两者都说明这一下被翻页逻辑吃掉了；关键是上下栏始终没露出来。
    await expect
      .poll(async () => (await indicator.innerText()) !== pageBefore || page.url() !== urlBefore)
      .toBe(true);
    await expect(surface).toHaveAttribute("data-ui-visible", "false");
  });
});

test.describe("阅读页翻页", () => {
  test("目录按需加载，不随翻页重复传输", async ({ page }) => {
    await loginBrowser(page);
    await page.request.post("/api/reader/preferences", {
      data: { paginationMode: "cover" },
      headers: { "Content-Type": "application/json" },
    });
    await openFirstBook(page);
    const readHref = await page.locator('a[href^="/read/"]').first().getAttribute("href");
    await page.goto(readHref ?? "/");
    await page.waitForLoadState("networkidle");

    // 目录接口在打开抽屉前不应被请求
    const tocRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/toc")) tocRequests.push(request.url());
    });
    await page.waitForTimeout(300);
    expect(tocRequests.filter((url) => !url.includes("index="))).toHaveLength(0);

    await revealReaderChrome(page);
    await page.locator('button[aria-label="目录"]').click();
    await expect(page.getByRole("heading", { name: "目录" })).toBeVisible();
    await expect(page.locator('a[href^="/read/"]').first()).toBeVisible();
    expect(tocRequests.filter((url) => !url.includes("index=")).length).toBeGreaterThan(0);
  });

  test("翻到章末进入下一章，阅读位置回到页首", async ({ page }) => {
    await loginBrowser(page);
    await openFirstBook(page);
    const readHref = await page.locator('a[href^="/read/"]').first().getAttribute("href");
    await page.goto(readHref ?? "/");
    await page.waitForLoadState("networkidle");

    await revealReaderChrome(page);
    const nextControl = page.locator("footer a, footer button").last();
    const disabled = await nextControl.evaluate(
      (element) => element.tagName === "BUTTON" && (element as HTMLButtonElement).disabled
    );
    test.skip(disabled, "该作品只有一章");

    await nextControl.click();
    await page.waitForLoadState("networkidle");
    await expect(page.locator('p[id^="p"]').first()).toBeVisible();
    expect(await page.locator("main").evaluate((element) => element.scrollTop)).toBe(0);
  });
});
