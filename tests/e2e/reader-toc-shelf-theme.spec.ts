import { expect, test, type Page } from "@playwright/test";
import { revealReaderChrome } from "./support/reader-ui";

async function loginBrowser(page: Page) {
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "reader@yuedu.test", password: "reader123" },
    headers: { Origin: "http://localhost:5173" },
  });
  expect(response.ok()).toBeTruthy();
}

/** 打开一本书的阅读页，返回 bookId。 */
async function openReader(page: Page) {
  await page.goto("/");
  const bookHref = await page.locator('a[href^="/books/"]').first().getAttribute("href");
  const bookId = (bookHref ?? "").replace("/books/", "");
  await page.goto(bookHref ?? "/");
  await page.waitForLoadState("networkidle");
  const readHref = await page.locator('a[href^="/read/"]').first().getAttribute("href");
  await page.goto(readHref ?? "/");
  await page.waitForLoadState("networkidle");
  return bookId;
}

test.describe("阅读页目录定位", () => {
  test("打开目录时滚动到当前章节，而不是停在第一章", async ({ page }) => {
    await loginBrowser(page);
    const bookId = await openReader(page);

    // 挑一个靠后的章节，第一章看不出定位效果
    const tocResponse = await page.request.get(`/api/books/${bookId}/toc`);
    const { volumes } = (await tocResponse.json()) as {
      volumes: { chapters: { id: string; title: string }[] }[];
    };
    const allChapters = volumes.flatMap((volume) => volume.chapters);
    test.skip(allChapters.length < 4, "该作品章节太少，定位无从体现");

    const target = allChapters[allChapters.length - 1]!;
    await page.goto(`/read/${bookId}/${target.id}`);
    await page.waitForLoadState("networkidle");

    await revealReaderChrome(page);
    await page.locator('button[aria-label="目录"]').click();

    const current = page.getByRole("dialog").locator("a.text-primary").first();
    await expect(current).toBeVisible();
    await expect(current).toContainText(target.title);
    // 回归点：原来目录总停在顶部，当前章节在视口外
    await expect(current).toBeInViewport();
  });
});

test.describe("阅读页书架按钮", () => {
  test("顶栏按钮是加入/移出书架，文案随状态变化", async ({ page }) => {
    await loginBrowser(page);
    const bookId = await openReader(page);
    // 从"不在书架"开始
    await page.request.fetch(`/api/library/shelf?bookId=${bookId}`, { method: "DELETE" });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await revealReaderChrome(page);

    // 回归点：这个位置原来是「添加书签」，站内没有任何地方能看书签
    await expect(page.locator('button[aria-label="添加书签"]')).toHaveCount(0);

    const addButton = page.locator('button[aria-label="加入书架"]');
    await expect(addButton).toBeVisible();
    await addButton.click();
    await expect(page.getByText("已加入书架")).toBeVisible();

    const removeButton = page.locator('button[aria-label="移出书架"]');
    await expect(removeButton).toBeVisible();

    // 状态要能落库：刷新后仍是"移出书架"
    await page.reload();
    await page.waitForLoadState("networkidle");
    await revealReaderChrome(page);
    await expect(page.locator('button[aria-label="移出书架"]')).toBeVisible();

    await page.locator('button[aria-label="移出书架"]').click();
    await expect(page.getByText("已移出书架")).toBeVisible();
    await expect(page.locator('button[aria-label="加入书架"]')).toBeVisible();
  });

  test("书架状态与作品详情页一致", async ({ page }) => {
    await loginBrowser(page);
    const bookId = await openReader(page);
    await page.request.fetch(`/api/library/shelf?bookId=${bookId}`, { method: "DELETE" });
    await page.reload();
    await page.waitForLoadState("networkidle");
    await revealReaderChrome(page);
    await page.locator('button[aria-label="加入书架"]').click();
    await expect(page.getByText("已加入书架")).toBeVisible();

    await page.goto(`/books/${bookId}`);
    await page.waitForLoadState("networkidle");
    await expect(
      page.locator("button:visible", { hasText: /已在书架/ }).first()
    ).toBeVisible();
  });
});

test.describe("阅读器主题跟随系统", () => {
  test("深色系统偏好解析为墨水灰", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await loginBrowser(page);
    await page.addInitScript(() => {
      localStorage.setItem("yuedu-reader-settings", JSON.stringify({ theme: "system" }));
    });
    await openReader(page);

    // data-reader-theme 只认具体配色，system 不该漏到 DOM 上
    await expect(page.locator("html")).toHaveAttribute("data-reader-theme", "ink");
    await context.close();
  });

  test("浅色系统偏好解析为明亮纸张", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await loginBrowser(page);
    await page.addInitScript(() => {
      localStorage.setItem("yuedu-reader-settings", JSON.stringify({ theme: "system" }));
    });
    await openReader(page);

    await expect(page.locator("html")).toHaveAttribute("data-reader-theme", "paper");
    await context.close();
  });

  test("系统深浅色切换后立即生效，无需重进页面", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await loginBrowser(page);
    await page.addInitScript(() => {
      localStorage.setItem("yuedu-reader-settings", JSON.stringify({ theme: "system" }));
    });
    await openReader(page);
    await expect(page.locator("html")).toHaveAttribute("data-reader-theme", "paper");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-reader-theme", "ink");
    await context.close();
  });

  test("设置面板里能选到跟随系统，且显式主题不受系统影响", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await loginBrowser(page);
    await openReader(page);
    await revealReaderChrome(page);
    await page.locator('button[aria-label="阅读设置"]').click();

    const followSystem = page.getByRole("button", { name: "跟随系统" });
    await expect(followSystem).toBeVisible();
    await followSystem.click();
    await expect(page.locator("html")).toHaveAttribute("data-reader-theme", "ink");

    // 选了明亮纸张后，即便系统是深色也要保持纸张
    await page.getByRole("button", { name: "明亮纸张" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-reader-theme", "paper");
    await context.close();
  });
});
