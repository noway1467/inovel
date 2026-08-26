import { expect, test } from "@playwright/test";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "novel-upload.txt"
);

async function login(
  request: import("@playwright/test").APIRequestContext,
  email: string,
  password: string
) {
  const response = await request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { Origin: "http://localhost:5173" },
  });
  expect(response.ok()).toBeTruthy();
  const data = (await response.json()) as { token?: string };
  return data.token as string;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Origin: "http://localhost:5173" };
}

/**
 * 通知页必须用浏览器 cookie 会话访问：布局 loader 不认 Bearer，带 token 直接 302。
 *
 * 数的是 DOM 节点而不是 HTML 文本：SSR 会把 loader 数据也序列化进页面，
 * 正则匹配原始 HTML 会把同一条通知算两次。
 * 书名带随机后缀确保唯一；聚合后应恰好 1 条，逐章模式下等于章节数。
 */
async function countBookNotifications(page: import("@playwright/test").Page, bookTitle: string) {
  await page.goto("/notifications");
  await page.waitForLoadState("networkidle");
  return page.locator("button", { hasText: bookTitle }).count();
}

test("整本一键通过只产生一条通知，而不是每章一条", async ({ page, request }) => {
  test.setTimeout(180_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");

  // 上传并提交审核。书名带随机后缀，便于在通知页里唯一定位
  const bookTitle = `通知聚合测试书N${Date.now().toString().slice(-6)}`;
  const fileBuffer = await readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: `notify-${Date.now()}.txt`, mimeType: "text/plain", buffer: fileBuffer },
      title: bookTitle,
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const jobId = ((await uploadResponse.json()) as { job?: { id?: string } }).job?.id as string;

  const deadline = Date.now() + 90_000;
  let candidates: { index: number }[] = [];
  while (Date.now() < deadline) {
    const poll = await request.get(`/api/creator/imports/${jobId}`, {
      headers: authHeaders(authorToken),
    });
    const data = (await poll.json()) as {
      job?: { status?: string; candidates?: { index: number }[] };
    };
    if (data.job?.status === "awaiting_confirmation") {
      candidates = data.job.candidates ?? [];
      break;
    }
    if (data.job?.status === "failed") throw new Error("导入失败");
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  expect(candidates.length).toBeGreaterThan(1);

  const confirmResponse = await request.post(`/api/creator/imports/${jobId}/confirm`, {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: {
      actions: candidates.map((candidate) => ({ index: candidate.index, action: "keep" })),
      submitForReview: true,
    },
  });
  expect(confirmResponse.ok()).toBeTruthy();
  const bookId = ((await confirmResponse.json()) as { bookId?: string }).bookId as string;

  // 等章节进入待审
  const reviewDeadline = Date.now() + 90_000;
  while (Date.now() < reviewDeadline) {
    const poll = await request.get(`/api/creator/imports/${jobId}`, {
      headers: authHeaders(authorToken),
    });
    const status = ((await poll.json()) as { job?: { status?: string } }).job?.status;
    if (status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  // 管理员按作品一键通过
  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const batchResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(batchResponse.ok()).toBeTruthy();
  const processed = ((await batchResponse.json()) as { processed?: number }).processed ?? 0;
  expect(processed).toBeGreaterThan(1);

  // 用作者身份建立浏览器 cookie 会话后再看通知页
  const browserLogin = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "author@yuedu.test", password: "author123" },
    headers: { Origin: "http://localhost:5173" },
  });
  expect(browserLogin.ok()).toBeTruthy();

  // 回归点：原来一章一条，这里会等于 processed（本次为多章）
  const notificationCount = await countBookNotifications(page, bookTitle);
  expect(notificationCount).toBe(1);

  // 文案应写明合计章数，而不是某一章的标题
  await expect(page.getByText(`${processed} 章已通过审核并发布`).first()).toBeVisible();
});
