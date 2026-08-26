import { expect, test } from "@playwright/test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "novel-upload.txt"
);

async function loginAuthor(page: import("@playwright/test").Page) {
  const origin = process.env.E2E_BASE_URL ?? "http://localhost:5173";
  const login = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "author@yuedu.test", password: "author123" },
    headers: { Origin: origin },
  });
  expect(login.ok()).toBeTruthy();
}

async function waitForParsedJob(page: import("@playwright/test").Page, jobId: string) {
  for (let attempt = 0; attempt < 180; attempt++) {
    await page.waitForTimeout(400);
    const response = await page.request.get(`/api/creator/imports/${jobId}`);
    expect(response.ok()).toBeTruthy();
    const job = (await response.json()).job as { status: string };
    if (job.status === "awaiting_confirmation" || job.status === "failed") return job;
  }
  throw new Error("import parse timed out");
}

test("creator upload page exposes the no-review switch", async ({ page }) => {
  test.setTimeout(90_000);
  await loginAuthor(page);
  await page.goto("/creator/upload");
  await expect(page.locator("#skip-review")).toBeVisible();
  await expect(page.locator("#skip-review")).not.toBeChecked();
  await page.locator("#skip-review").check();
  await expect(page.locator("#skip-review")).toBeChecked();
});

test("creator can save custom metadata and publish drafts directly", async ({ page }) => {
  test.setTimeout(180_000);
  await loginAuthor(page);

  const stamp = Date.now();
  const upload = await page.request.post("/api/creator/imports", {
    multipart: {
      title: `Direct publish ${stamp}`,
      splitChars: "0",
      file: {
        name: `direct-publish-${stamp}.txt`,
        mimeType: "text/plain",
        buffer: await readFile(fixturePath),
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const initialJob = (await upload.json()).job as { id: string; bookId: string };
  const parsedJob = await waitForParsedJob(page, initialJob.id);
  expect(parsedJob.status).toBe("awaiting_confirmation");

  const confirm = await page.request.post(`/api/creator/imports/${initialJob.id}/confirm`, {
    data: { actions: [], publishMode: "draft" },
  });
  expect(confirm.ok()).toBeTruthy();
  for (let attempt = 0; attempt < 120; attempt++) {
    await page.waitForTimeout(1000);
    const jobResponse = await page.request.get(`/api/creator/imports/${initialJob.id}`);
    expect(jobResponse.ok()).toBeTruthy();
    const job = (await jobResponse.json()).job as { status: string };
    if (job.status === "completed") break;
    if (job.status === "failed") throw new Error("导入失败");
    if (attempt === 119) throw new Error("等待导入完成超时");
  }

  const categoryName = `C${stamp}`;
  const metadata = await page.request.put(`/api/creator/books/${initialJob.bookId}`, {
    data: {
      title: `Updated direct publish ${stamp}`,
      description: "metadata update test",
      categoryId: null,
      categoryName,
      tags: ["custom-tag", "direct-publish"],
      serialStatus: "ongoing",
    },
  });
  expect(metadata.ok(), await metadata.text()).toBeTruthy();

  const saved = await page.request.get(`/api/creator/books/${initialJob.bookId}`);
  expect(saved.ok()).toBeTruthy();
  const savedData = (await saved.json()) as {
    book: { categoryId: string | null };
    categories: { id: string; name: string }[];
    tags: string[];
  };
  expect(
    savedData.categories.find((category) => category.id === savedData.book.categoryId)?.name
  ).toBe(categoryName);
  expect(savedData.tags).toEqual(expect.arrayContaining(["custom-tag", "direct-publish"]));

  const publish = await page.request.post(`/api/creator/books/${initialJob.bookId}/publish-all`);
  expect(publish.ok(), await publish.text()).toBeTruthy();
  expect((await publish.json()).status).toBe("published");

  const cleanup = await page.request.delete(`/api/creator/books/${initialJob.bookId}`);
  expect(cleanup.ok()).toBeTruthy();
});

test("creator can drag in a txt, rename the book and re-split by 5000 chars on confirm", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await loginAuthor(page);
  await page.goto("/creator/upload");

  const stamp = Date.now();
  const fileName = `drag-${stamp}.txt`;
  const makeDataTransfer = () =>
    page.evaluateHandle((name) => {
      const lines = ["第一章 长章"];
      for (let i = 0; i < 4000; i++) {
        lines.push(`第${i}段正文内容，用于验证按五千字重新划分章节规则。`);
      }
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([lines.join("\n")], name, { type: "text/plain" }));
      return dataTransfer;
    }, fileName);
  const dropZone = page.locator("[data-dropzone]");
  const enterTransfer = await makeDataTransfer();
  await dropZone.dispatchEvent("dragenter", { dataTransfer: enterTransfer });
  await page.waitForTimeout(300);
  const overTransfer = await makeDataTransfer();
  await dropZone.dispatchEvent("dragover", { dataTransfer: overTransfer });
  await page.waitForTimeout(300);
  const dropTransfer = await makeDataTransfer();
  await dropZone.dispatchEvent("drop", { dataTransfer: dropTransfer });

  await expect(page.getByText(fileName)).toBeVisible();
  const [uploadResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/creator/imports") &&
        !response.url().includes("chunked") &&
        response.request().method() === "POST"
    ),
    page.getByRole("button", { name: /加入导入队列/ }).click(),
  ]);
  expect(uploadResponse.ok()).toBeTruthy();
  const initialJob = (await uploadResponse.json()).job as { id: string; bookId: string };
  const parsedJob = await waitForParsedJob(page, initialJob.id);
  expect(parsedJob.status).toBe("awaiting_confirmation");

  await page.reload();
  await expect(page.getByText("章节确认")).toBeVisible();
  const expandButton = page
    .getByRole("button", { name: new RegExp(fileName) })
    .first();
  await expandButton.click();
  await page.getByRole("button", { name: "确认导入" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const newTitle = `Drag renamed ${stamp}`;
  await dialog.getByLabel("书名").fill(newTitle);
  await dialog.getByLabel("按 5000 字重新划分章节").check();
  await dialog.getByRole("button", { name: "确认导入" }).click();

  for (let attempt = 0; attempt < 240; attempt++) {
    await page.waitForTimeout(1000);
    const jobResponse = await page.request.get(`/api/creator/imports/${initialJob.id}`);
    expect(jobResponse.ok()).toBeTruthy();
    const job = (await jobResponse.json()).job as { status: string };
    if (job.status === "completed") break;
    if (job.status === "failed") throw new Error("确认导入失败");
    if (attempt === 239) throw new Error("等待确认导入完成超时");
  }

  const bookResponse = await page.request.get(`/api/creator/books/${initialJob.bookId}`);
  expect(bookResponse.ok()).toBeTruthy();
  const bookData = (await bookResponse.json()) as { book: { title: string } };
  expect(bookData.book.title).toBe(newTitle);
});
