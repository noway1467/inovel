import { expect, test } from "@playwright/test";
import { revealReaderChrome } from "./support/reader-ui";

async function loginBrowser(page: import("@playwright/test").Page) {
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "reader@yuedu.test", password: "reader123" },
    headers: { Origin: "http://localhost:5173" },
  });
  expect(response.ok()).toBeTruthy();
}

test("首页渲染书籍与导航，无错误页", async ({ page }) => {
  await loginBrowser(page);
  await page.goto("/");
  await expect(page.locator("body")).not.toContainText("页面出错了");
  await expect(page.getByRole("heading", { name: "最新作品" })).toBeVisible();
  const bookLinks = page.locator('a[href^="/books/"]');
  expect(await bookLinks.count()).toBeGreaterThan(0);
});

test("读者账户菜单不暴露工作台，作品列表在桌面使用双列布局", async ({ page }) => {
  await loginBrowser(page);
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await expect(page.locator('button[aria-label="工作台"]:visible')).toHaveCount(0);

  const accountTrigger = page.locator('header button[aria-label="用户菜单"]:visible');
  await accountTrigger.click();
  await expect(accountTrigger).toHaveAttribute("aria-expanded", "true");
  const accountMenu = page.getByRole("menu");
  await expect(accountMenu).toBeVisible();
  await expect(accountMenu.getByText("阅读", { exact: true })).toBeVisible();
  await expect(accountMenu.getByText("账号", { exact: true })).toBeVisible();
  await expect(accountMenu.getByText("创作", { exact: true })).toHaveCount(0);
  await expect(accountMenu.getByRole("menuitem", { name: /导入小说/ })).toHaveCount(0);

  await page.keyboard.press("Escape");
  const latestGrid = page.locator('section[aria-labelledby="latest-books"] .grid').first();
  const columns = await latestGrid.evaluate(
    (element) => getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length
  );
  if ((page.viewportSize()?.width ?? 0) >= 768) expect(columns).toBeGreaterThanOrEqual(2);
  else expect(columns).toBe(1);
});
test("搜索可以找到种子作品", async ({ page }) => {
  await loginBrowser(page);
  await page.goto("/search?q=星海");
  await expect(page.getByText("星海拾荒者").first()).toBeVisible();
});

test("作品详情到阅读器主链路可用，无横向溢出", async ({ page }) => {
  await loginBrowser(page);
  const preferencesResponse = await page.request.post("/api/reader/preferences", {
    data: { paginationMode: "cover" },
    headers: { "Content-Type": "application/json" },
  });
  expect(preferencesResponse.ok()).toBeTruthy();
  await page.goto("/");
  const firstBook = page.locator('a[href^="/books/"]').first();
  await firstBook.click();
  await page.waitForLoadState("networkidle");
  const detailPage = page;

  const readLink = detailPage.locator('a[href^="/read/"]').first();
  await expect(readLink).toBeVisible();
  const readHref = await readLink.getAttribute("href");
  await detailPage.goto(readHref ?? "/");
  await detailPage.waitForLoadState("networkidle");

  const paragraphs = detailPage.locator('p[id^="p"]');
  expect(await paragraphs.count()).toBeGreaterThan(0);
  const readerViewport = detailPage.locator("main");
  await expect(detailPage.locator("[data-reader-pagination]")).toBeVisible();
  await expect(readerViewport).not.toHaveAttribute("data-reader-spread");
  const pageMetrics = await detailPage.locator("[data-reader-pagination]").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      columnWidth: Number.parseFloat(style.columnWidth),
      columnGap: Number.parseFloat(style.columnGap),
      viewportWidth: element.parentElement?.clientWidth ?? 0,
    };
  });
  expect(pageMetrics.columnWidth).toBeGreaterThanOrEqual(pageMetrics.viewportWidth);
  expect(pageMetrics.columnGap).toBe(0);
  const flipStyle = await detailPage.locator("[data-reader-pagination]").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      columnRuleWidth: style.columnRuleWidth,
      transitionDuration: style.transitionDuration,
    };
  });
  expect(flipStyle.columnRuleWidth).toBe("0px");
  expect(flipStyle.transitionDuration).toBe("0s");
  expect(
    await readerViewport.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)
  ).toBe(true);
  const overflow = await detailPage.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  );
  expect(overflow).toBe(false);

  // 上下栏已自动收起，先点中心亮出来再操作
  await revealReaderChrome(detailPage);
  // 有下一章时底部渲染的是预取 Link，没有下一章才是 disabled button
  const nextChapterControl = detailPage.locator("footer a, footer button").last();
  const isDisabledButton = await nextChapterControl.evaluate(
    (element) => element.tagName === "BUTTON" && (element as HTMLButtonElement).disabled
  );
  if (!isDisabledButton) {
    await nextChapterControl.click();
    await detailPage.waitForLoadState("networkidle");
    expect(await readerViewport.evaluate((element) => element.scrollTop)).toBe(0);
  }
});

test("未登录访问内容会跳转登录，内容接口返回 401", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  const response = await request.get("/api/books/not-found/chapters/not-found/content");
  expect(response.status()).toBe(401);
});
