import { expect, test, type Page } from "@playwright/test";

async function openReader(page: Page, kind: "local" | "source", long = false) {
  // Vite 提供真实组件与样式；页面和 loader 为隔离夹具，不需要账号或种子数据。
  await page.route("**/__reader-navigation-test?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
        import RefreshRuntime from "/@id/__x00__virtual:react-router/hmr-runtime";
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$ = () => {};
        window.$RefreshSig$ = () => (type) => type;
        window.__vite_plugin_react_preamble_installed__ = true;
        await import("/tests/e2e/fixtures/reader-navigation.tsx");
      </script></body></html>`,
    })
  );
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/*.data*", (route) => route.fulfill({ status: 204 }));
  await page.route("**/build/stub-path-to-module.js", (route) => route.fulfill({ body: "" }));
  await page.goto(`/__reader-navigation-test?kind=${kind}${long ? "&long=1" : ""}`, {
    waitUntil: "domcontentloaded",
  });
  // 冷启动需先由 Vite 编译组件与 Tailwind；预取资源不属于本用例的就绪条件。
  await expect(page.locator("h1")).toHaveText("第1章", { timeout: 15_000 });
  await expect(page.locator("[data-reader-pagination]")).toBeVisible();
  // 等真实分页的首次测量完成，避免把首帧的 1/1 误当成章节末页。
  await expect
    .poll(() => page.locator("[data-reader-pagination]").evaluate((el) => el.clientWidth))
    .toBeGreaterThan(1);
}

async function expectFirstPage(page: Page) {
  await expect
    .poll(() =>
      page
        .locator("[data-reader-pagination]")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
    )
    .toBe(0);
}

for (const kind of ["local", "source"] as const) {
  test(`${kind}：慢网末页连续按键/点击只加载一次，完成后仍可翻页`, async ({ page }) => {
    await openReader(page, kind);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.evaluate(() => window.readerNavigationTest.requests)).toBe(1);
    // 连续输入后再断言请求数；旧实现会在这里反复取消前一份 loader。
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
    const main = page.locator("main");
    const box = (await main.boundingBox())!;
    await main.click({ position: { x: box.width * 0.88, y: box.height / 2 } });
    expect(await page.evaluate(() => window.readerNavigationTest.requests)).toBe(1);
    expect(await page.evaluate(() => window.readerNavigationTest.aborted)).toBe(0);
    await expect(page.getByRole("status")).toHaveText("正在加载章节…");
    await expect(page.locator(".reader-surface")).toHaveAttribute("aria-busy", "true");

    await page.evaluate(() => window.readerNavigationTest.release());
    await expect(page.locator("h1")).toHaveText("第2章");
    await expect(page.locator(".reader-surface")).toHaveAttribute("aria-busy", "false");
    await expectFirstPage(page);
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() =>
        page
          .locator("[data-reader-pagination]")
          .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
      )
      .toBeLessThan(0);
  });

  test(`${kind}：同帧重复点击下一章被合并，取消后可以重试`, async ({ page }) => {
    await openReader(page, kind);
    // 绕过 Playwright 自动等待 aria-disabled，模拟同一事件循环中的重复输入。
    await page
      .locator("footer a")
      .filter({ hasText: "下一章" })
      .evaluate((el) => {
        for (let i = 0; i < 8; i += 1) (el as HTMLAnchorElement).click();
      });
    await expect.poll(() => page.evaluate(() => window.readerNavigationTest.requests)).toBe(1);
    expect(await page.evaluate(() => window.readerNavigationTest.aborted)).toBe(0);
    await page.evaluate(() => window.readerNavigationTest.back());
    await expect(page.locator(".reader-surface")).toHaveAttribute("aria-busy", "false");
    expect(await page.evaluate(() => window.readerNavigationTest.aborted)).toBe(1);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => page.evaluate(() => window.readerNavigationTest.requests)).toBe(2);
    await page.evaluate(() => window.readerNavigationTest.release());
    await expect(page.locator("h1")).toHaveText("第2章");
  });

  test(`${kind}：加载失败后返回重试，不会留下导航锁`, async ({ page }) => {
    await openReader(page, kind);
    await page.evaluate(() => {
      window.readerNavigationTest.fail = true;
      window.readerNavigationTest.release();
    });
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByText(kind === "source" ? "这一章打不开" : "章节加载失败", { exact: true })
    ).toBeVisible();
    await page.evaluate(() => {
      window.readerNavigationTest.fail = false;
      window.readerNavigationTest.back();
    });
    await expect(page.locator("h1")).toHaveText("第1章");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("h1")).toHaveText("第2章");
  });
}

test("覆盖翻页动画未结束时换章，不会把旧页码写入新章", async ({ page }) => {
  await openReader(page, "local", true);
  await page.evaluate(() => window.readerNavigationTest.release());
  await page
    .locator("footer a")
    .filter({ hasText: "下一章" })
    .evaluate((el) => {
      // 同一事件循环触发，保证跳章发生在 90ms 的覆盖动画计时器之前。
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      (el as HTMLAnchorElement).click();
    });
  await expect(page.locator("h1")).toHaveText("第2章");
  await page.waitForTimeout(150);
  await expectFirstPage(page);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      page
        .locator("[data-reader-pagination]")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
    )
    .toBeLessThan(0);
});
