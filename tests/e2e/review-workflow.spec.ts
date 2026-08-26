import { expect, test } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { revealReaderChrome } from "./support/reader-ui";

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
  expect(data.token).toBeTruthy();
  return data.token as string;
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Origin: "http://localhost:5173" };
}

async function loginBrowser(
  page: import("@playwright/test").Page,
  email = "reader@yuedu.test",
  password = "reader123"
) {
  const origin = process.env.E2E_BASE_URL ?? "http://localhost:5173";
  const response = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { Origin: origin },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function setPaginationMode(page: import("@playwright/test").Page, mode: "cover" | "scroll") {
  const response = await page.request.post("/api/reader/preferences", {
    data: { paginationMode: mode },
    headers: { "Content-Type": "application/json" },
  });
  expect(response.ok()).toBeTruthy();
}

async function waitForParsedJob(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  jobId: string
) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await request.get(`/api/creator/imports/${jobId}`, {
      headers: authHeaders(token),
    });
    expect(response.ok()).toBeTruthy();
    const data = (await response.json()) as {
      job?: { status?: string; candidates?: { index: number }[]; warnings?: string[] };
    };
    if (data.job?.status === "awaiting_confirmation") return data.job;
    if (data.job?.status === "failed") throw new Error(`导入解析失败: ${JSON.stringify(data.job)}`);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  throw new Error("等待导入解析超时");
}

async function confirmAndWaitJob(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  jobId: string,
  options: {
    actions?: { index: number; action: string }[];
    publishMode?: string;
    submitForReview?: boolean;
  } = {}
) {
  const confirmResponse = await request.post(`/api/creator/imports/${jobId}/confirm`, {
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    data: {
      actions: options.actions ?? [],
      publishMode: options.publishMode,
      submitForReview: options.submitForReview,
    },
  });
  expect(confirmResponse.ok()).toBeTruthy();
  const confirmData = (await confirmResponse.json()) as { bookId?: string; done?: boolean };
  if (confirmData.done) {
    return { bookId: confirmData.bookId as string, imported: 0 };
  }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await request.get(`/api/creator/imports/${jobId}`, {
      headers: authHeaders(token),
    });
    expect(response.ok()).toBeTruthy();
    const data = (await response.json()) as {
      job?: {
        status?: string;
        bookId?: string;
        commitCursor?: number | null;
        errorMessage?: string | null;
      };
    };
    if (data.job?.status === "completed") {
      return { bookId: data.job.bookId as string, imported: data.job.commitCursor ?? 0 };
    }
    if (data.job?.status === "failed") {
      throw new Error(`导入失败: ${data.job.errorMessage ?? "未知错误"}`);
    }
  }
  throw new Error("等待导入完成超时");
}

async function createDraftBook(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  fileName: string,
  title: string
) {
  const fileBuffer = await (await import("node:fs/promises")).readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(token),
    multipart: {
      file: { name: fileName, mimeType: "text/plain", buffer: fileBuffer },
      title,
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, token, jobId);
  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, token, jobId, { actions });
  const detailHtml = await (
    await request.get(`/books/${bookId}`, { headers: authHeaders(token) })
  ).text();
  const match = detailHtml.match(new RegExp(`/read/${bookId}/([a-f0-9-]+)`));
  expect(match).toBeTruthy();
  return { bookId, chapterId: (match as RegExpMatchArray)[1] as string };
}

test("上传→编辑→提交审核→管理员通过→章节公开阅读", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const fileBuffer = await (await import("node:fs/promises")).readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: "review-book.txt", mimeType: "text/plain", buffer: fileBuffer },
      title: "审核闭环测试书",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as {
    job?: { id?: string; status?: string; candidates?: { index: number }[] };
  };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);

  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, authorToken, jobId, { actions });

  // 从详情页 HTML 提取第一个章节 id
  const detailHtml = await (
    await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  const match = detailHtml.match(new RegExp(`/read/${bookId}/([a-f0-9-]+)`));
  expect(match).toBeTruthy();
  const chapterId = (match as RegExpMatchArray)[1] as string;

  // 编辑保存（生成新不可变版本）
  const saveResponse = await request.post(`/api/creator/chapters/${chapterId}/save`, {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: {
      title: "第一章 山门（修订版）",
      paragraphs: [
        "云雾山的清晨总是被鸟鸣叫醒。",
        "这是审核闭环验证的修订正文。",
        "姜野沿着青石台阶向上走。",
      ],
    },
  });
  expect(saveResponse.ok()).toBeTruthy();
  const saveData = (await saveResponse.json()) as {
    chapter?: { title?: string; version?: number };
  };
  expect(saveData.chapter?.title).toBe("第一章 山门（修订版）");

  // 提交审核
  const submitResponse = await request.post(`/api/creator/chapters/${chapterId}/submit`, {
    headers: authHeaders(authorToken),
  });
  expect(submitResponse.ok()).toBeTruthy();

  // 审核前公开接口不可读
  const before = await request.get(`/api/books/${bookId}/chapters/${chapterId}/content`, {
    headers: authHeaders(authorToken),
  });
  expect(before.status()).toBe(404);

  // 管理员通过
  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const tasksResponse = await request.get(
    `/api/moderation/tasks?bookId=${encodeURIComponent(bookId)}`,
    {
      headers: authHeaders(adminToken),
    }
  );
  expect(tasksResponse.ok()).toBeTruthy();
  const tasksData = (await tasksResponse.json()) as {
    tasks?: { id: string; bookId: string; chapterId: string }[];
  };
  const task = (tasksData.tasks ?? []).find((item) => item.bookId === bookId);
  expect(task).toBeTruthy();

  const decideResponse = await request.post(`/api/moderation/tasks/${task?.id}/decision`, {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { decision: "approve" },
  });
  if (!decideResponse.ok()) {
    console.log(`decide failed: ${decideResponse.status()} ${await decideResponse.text()}`);
  }
  expect(decideResponse.ok()).toBeTruthy();

  // 审核通过后公开阅读
  const after = await request.get(`/api/books/${bookId}/chapters/${chapterId}/content`, {
    headers: authHeaders(adminToken),
  });
  expect(after.ok()).toBeTruthy();
  const contentData = (await after.json()) as {
    chapter?: { title?: string; paragraphs?: { text: string }[] };
  };
  expect(contentData.chapter?.title).toBe("第一章 山门（修订版）");
  expect(contentData.chapter?.paragraphs?.some((p) => p.text.includes("修订正文"))).toBe(true);
});

test("导入确认可直接提交审核并出现在管理员队列", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const fileBuffer = await (await import("node:fs/promises")).readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: "direct-review.txt", mimeType: "text/plain", buffer: fileBuffer },
      title: "直接提审测试书",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);

  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, authorToken, jobId, {
    actions,
    submitForReview: true,
  });
  expect(bookId).toBeTruthy();

  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const tasksResponse = await request.get(
    `/api/moderation/tasks?bookId=${encodeURIComponent(bookId)}`,
    {
      headers: authHeaders(adminToken),
    }
  );
  expect(tasksResponse.ok()).toBeTruthy();
  const tasksData = (await tasksResponse.json()) as {
    tasks?: { bookId: string; chapterId: string }[];
  };
  const tasks = tasksData.tasks ?? [];
  expect(tasks.some((task) => task.bookId === bookId)).toBe(true);
});

test("无需审核开关可直接发布且不创建审核任务", async ({ request }) => {
  test.setTimeout(120_000);
  const authorToken = await login(request, "author@yuedu.test", "author123");
  const stamp = Date.now();
  const upload = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      title: `无需审核测试书-${stamp}`,
      splitChars: "0",
      file: {
        name: `skip-review-${stamp}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from("第一章 直接发布\n这是无需审核直接发布的正文。", "utf8"),
      },
    },
  });
  expect(upload.ok()).toBeTruthy();
  const uploadJob = (await upload.json()).job as { id: string };
  await waitForParsedJob(request, authorToken, uploadJob.id);
  const { bookId } = await confirmAndWaitJob(request, authorToken, uploadJob.id, {
    actions: [],
    publishMode: "publish",
  });

  const detailHtml = await (
    await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  const chapterId = detailHtml.match(new RegExp(`/read/${bookId}/([a-f0-9-]+)`))?.[1];
  expect(chapterId).toBeTruthy();
  const content = await request.get(`/api/books/${bookId}/chapters/${chapterId}/content`, {
    headers: authHeaders(authorToken),
  });
  expect(content.ok()).toBeTruthy();

  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const tasks = await request.get(`/api/moderation/tasks?bookId=${encodeURIComponent(bookId)}`, {
    headers: authHeaders(adminToken),
  });
  expect(tasks.ok()).toBeTruthy();
  expect(((await tasks.json()) as { tasks?: unknown[] }).tasks ?? []).toHaveLength(0);
});
test("批量通过审核后章节公开阅读", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const fileBuffer = await (await import("node:fs/promises")).readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: "batch-review.txt", mimeType: "text/plain", buffer: fileBuffer },
      title: "批量审核测试书",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);
  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, authorToken, jobId, {
    actions,
    submitForReview: true,
  });

  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const batchResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(batchResponse.ok()).toBeTruthy();
  const batchData = (await batchResponse.json()) as { processed?: number };
  expect(batchData.processed).toBeGreaterThan(0);

  const detailHtml = await (
    await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  const match = detailHtml.match(new RegExp(`/read/${bookId}/([a-f0-9-]+)`));
  expect(match).toBeTruthy();
  const chapterId = (match as RegExpMatchArray)[1] as string;
  const after = await request.get(`/api/books/${bookId}/chapters/${chapterId}/content`, {
    headers: authHeaders(authorToken),
  });
  expect(after.ok()).toBeTruthy();
});

test("阅读器目录默认正序，排序按钮无背景和边框", async ({ page, request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const fileBuffer = await (await import("node:fs/promises")).readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: "toc-book.txt", mimeType: "text/plain", buffer: fileBuffer },
      title: "目录正序测试书",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);
  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, authorToken, jobId, {
    actions,
    submitForReview: true,
  });

  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const batchResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(batchResponse.ok()).toBeTruthy();

  const detailHtml = await (
    await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  const match = detailHtml.match(new RegExp(`/read/${bookId}/([a-f0-9-]+)`));
  expect(match).toBeTruthy();
  const chapterId = (match as RegExpMatchArray)[1] as string;

  await loginBrowser(page);
  await page.goto(`/read/${bookId}/${chapterId}`);
  await page.waitForLoadState("networkidle");
  // 不再靠 waitForTimeout 蹭自动收起前的窗口：显式点中心亮出上下栏
  await revealReaderChrome(page);
  await page.getByRole("button", { name: "目录" }).click();
  const orderButton = page.getByRole("button", { name: "切换为倒序" });
  const closeButton = page.getByRole("button", { name: "关闭" });
  await expect(orderButton).toBeVisible();
  await expect(closeButton).toBeVisible();
  const [orderBox, closeBox] = await Promise.all([
    orderButton.boundingBox(),
    closeButton.boundingBox(),
  ]);
  expect(orderBox).toBeTruthy();
  expect(closeBox).toBeTruthy();
  expect((orderBox?.x ?? 0) + (orderBox?.width ?? 0)).toBeLessThanOrEqual(closeBox?.x ?? 0);
  // 限定在目录抽屉内取链接：底部“下一章”也是 /read/ 链接，会抢到 first()
  const tocLink = page.getByRole("dialog").locator(`a[href^="/read/${bookId}/"]`).first();
  await expect(tocLink).toContainText("第一章 山门");
  const orderStyle = await orderButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { backgroundColor: style.backgroundColor, borderWidth: style.borderWidth };
  });
  expect(orderStyle.borderWidth).toBe("0px");
  expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(orderStyle.backgroundColor);
  await orderButton.click();
  await expect(tocLink).toContainText("第三章 风起");
});

test("1100 章大书按作品一键通过", async ({ request }) => {
  test.setTimeout(300_000);

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yuedu-e2e-batch-"));
  const uniqueName = `batch-1100-${Date.now()}.txt`;
  const bigPath = path.join(tmpDir, uniqueName);
  const lines: string[] = [];
  for (let c = 1; c <= 1100; c++) {
    lines.push(
      `第${c}章 章节标题${c}`,
      `这是第${c}章的正文第一段，用于验证大书一键通过。`,
      `正文第二段。`,
      ""
    );
  }
  await writeFile(bigPath, lines.join("\n"), "utf8");

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const fileBuffer = await (await import("node:fs/promises")).readFile(bigPath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: uniqueName, mimeType: "text/plain", buffer: fileBuffer },
      title: "一键通过大书测试",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);
  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));

  const { bookId, imported } = await confirmAndWaitJob(request, authorToken, jobId, {
    actions,
    submitForReview: true,
  });
  // 任务完成时服务端会把 commitCursor 清空（imports/service.ts 落库那步），
  // 所以拿不到入库总数；真正的入库量由下面 batch-decision 的 processed=1100 验证。
  expect(imported).toBeGreaterThanOrEqual(0);

  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const batchResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(batchResponse.ok()).toBeTruthy();
  const batchData = (await batchResponse.json()) as { processed?: number; error?: string };
  expect(batchData.processed).toBe(1100);

  const detailHtml = await (
    await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  const match = detailHtml.match(new RegExp(`/read/${bookId}/([a-f0-9-]+)`));
  expect(match).toBeTruthy();
  const chapterId = (match as RegExpMatchArray)[1] as string;
  const after = await request.get(`/api/books/${bookId}/chapters/${chapterId}/content`, {
    headers: authHeaders(authorToken),
  });
  expect(after.ok()).toBeTruthy();
});

test("作者可编辑作品书名与简介", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const fileBuffer = await (await import("node:fs/promises")).readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: "edit-book.txt", mimeType: "text/plain", buffer: fileBuffer },
      title: "待改名作品",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);
  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, authorToken, jobId, { actions });

  const updateResponse = await request.put(`/api/creator/books/${bookId}`, {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: { title: "改名后的作品", description: "这是修改后的简介。" },
  });
  expect(updateResponse.ok()).toBeTruthy();

  const detailHtml = await (
    await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  expect(detailHtml).toContain("改名后的作品");
  expect(detailHtml).toContain("这是修改后的简介。");
});

test("按字数兜底拆分整本单章文件", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const text = Array.from(
    { length: 1000 },
    (_, index) => `这是第 ${index + 1} 段用于验证字数拆分规则的正文内容。`
  ).join("\n");
  const buffer = Buffer.from(text, "utf8");
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: "split-by-chars.txt", mimeType: "text/plain", buffer },
      title: "按字数拆分测试书",
      splitChars: "5000",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as {
    job?: { id?: string; status?: string; candidates?: unknown[]; warnings?: string[] };
  };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);
  expect((parsedJob.candidates ?? []).length).toBeGreaterThan(3);
  expect(parsedJob.warnings?.some((warning) => warning.includes("已按字数拆分"))).toBe(true);
});

test("作品页全部提交审核后进入管理员队列", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const fileBuffer = await (await import("node:fs/promises")).readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: "submit-all.txt", mimeType: "text/plain", buffer: fileBuffer },
      title: "批量提审测试书",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);
  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, authorToken, jobId, { actions });

  const submitAllResponse = await request.post(`/api/creator/books/${bookId}/submit-all`, {
    headers: authHeaders(authorToken),
  });
  expect(submitAllResponse.ok()).toBeTruthy();
  const submitData = (await submitAllResponse.json()) as { submitted?: number };
  expect(submitData.submitted).toBeGreaterThan(0);

  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const tasksResponse = await request.get(
    `/api/moderation/tasks?bookId=${encodeURIComponent(bookId)}`,
    {
      headers: authHeaders(adminToken),
    }
  );
  const tasksData = (await tasksResponse.json()) as { tasks?: { bookId: string }[] };
  expect((tasksData.tasks ?? []).filter((task) => task.bookId === bookId).length).toBeGreaterThan(
    0
  );
});

test("1100 章大书草稿可一次性提交审核", async ({ request }) => {
  test.setTimeout(300_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yuedu-e2e-submit-all-"));
  const uniqueName = `submit-all-1100-${Date.now()}.txt`;
  const bigPath = path.join(tmpDir, uniqueName);
  const lines: string[] = [];
  for (let chapterIndex = 1; chapterIndex <= 1100; chapterIndex++) {
    lines.push(
      `第${chapterIndex}章 章节标题${chapterIndex}`,
      `这是第${chapterIndex}章的正文第一段，用于验证大书草稿全部提交。`,
      `正文第二段。`,
      ""
    );
  }
  await writeFile(bigPath, lines.join("\n"), "utf8");

  const fileBuffer = await readFile(bigPath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: uniqueName, mimeType: "text/plain", buffer: fileBuffer },
      title: "大书全部提交测试",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);
  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, authorToken, jobId, {
    actions,
    publishMode: "draft",
  });

  const submitAllResponse = await request.post(`/api/creator/books/${bookId}/submit-all`, {
    headers: authHeaders(authorToken),
  });
  expect(submitAllResponse.ok()).toBeTruthy();
  const submitAllData = (await submitAllResponse.json()) as { submitted?: number; error?: string };
  expect(submitAllData.error).toBeUndefined();
  expect(submitAllData.submitted).toBe(1100);
});

test("编辑页只改书名后全部提交会先保存作品信息且不重复提交章节", async ({ page, request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const fileBuffer = await readFile(fixturePath);
  const uploadResponse = await request.post("/api/creator/imports", {
    headers: authHeaders(authorToken),
    multipart: {
      file: { name: "edit-book-submit-all.txt", mimeType: "text/plain", buffer: fileBuffer },
      title: "只改书名测试书",
    },
  });
  expect(uploadResponse.ok()).toBeTruthy();
  const uploadData = (await uploadResponse.json()) as { job?: { id?: string } };
  const jobId = uploadData.job?.id as string;
  const parsedJob = await waitForParsedJob(request, authorToken, jobId);
  const actions = (parsedJob.candidates ?? []).map((candidate) => ({
    index: candidate.index,
    action: "keep",
  }));
  const { bookId } = await confirmAndWaitJob(request, authorToken, jobId, {
    actions,
    publishMode: "publish",
  });

  await loginBrowser(page, "author@yuedu.test", "author123");
  await page.goto(`/creator/books/${bookId}`);
  const titleInput = page.locator("#book-title");
  await expect(titleInput).toHaveValue("只改书名测试书");
  const newTitle = `只改书名测试书-${Date.now()}`;
  await titleInput.click();
  await titleInput.press("Control+A");
  await titleInput.pressSequentially(newTitle);
  await expect(titleInput).toHaveValue(newTitle);
  await page.getByRole("button", { name: "全部提交审核" }).click();
  await expect(page.getByText("没有需要提交审核的章节，作品信息已保存")).toBeVisible();

  const settingsResponse = await request.get(`/api/creator/books/${bookId}`, {
    headers: authHeaders(authorToken),
  });
  expect(settingsResponse.ok()).toBeTruthy();
  const settingsData = (await settingsResponse.json()) as { book?: { title?: string } };
  expect(settingsData.book?.title).toBe(newTitle);
});

test("作者可删除作品", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const { bookId, chapterId } = await createDraftBook(
    request,
    authorToken,
    "delete-book.txt",
    "待删除测试书"
  );

  const progressResponse = await request.post("/api/reader/progress", {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: {
      bookId,
      chapterId,
      paragraphAnchor: "p1",
      charOffset: 0,
      chapterProgress: 20,
      bookProgress: 20,
      updatedAt: new Date().toISOString(),
    },
  });
  expect(progressResponse.ok()).toBeTruthy();
  const bookmarkResponse = await request.post("/api/reader/bookmarks", {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: { bookId, chapterId, paragraphAnchor: "p1", charOffset: 0, excerpt: "删除前留下的书签" },
  });
  expect(bookmarkResponse.ok()).toBeTruthy();

  const deleteResponse = await request.delete(`/api/creator/books/${bookId}`, {
    headers: authHeaders(authorToken),
  });
  expect(deleteResponse.ok()).toBeTruthy();

  const detail = await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken) });
  expect(detail.status()).toBe(404);
});

test("已发布章节可直接编辑并删除", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const { bookId, chapterId } = await createDraftBook(
    request,
    authorToken,
    "edit-published.txt",
    "已发布编辑测试书"
  );

  const submitResponse = await request.post(`/api/creator/chapters/${chapterId}/submit`, {
    headers: authHeaders(authorToken),
  });
  expect(submitResponse.ok()).toBeTruthy();

  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const batchResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(batchResponse.ok()).toBeTruthy();

  // 同一 request 上下文的 cookie 已被管理员登录覆盖，需重新以作者身份登录
  const authorToken2 = await login(request, "author@yuedu.test", "author123");
  const saveResponse = await request.post(`/api/creator/chapters/${chapterId}/save`, {
    headers: { ...authHeaders(authorToken2), "Content-Type": "application/json" },
    data: { title: "发布后直接修改", paragraphs: ["发布后直接修改的正文。"] },
  });
  expect(saveResponse.ok()).toBeTruthy();

  const contentResponse = await request.get(`/api/books/${bookId}/chapters/${chapterId}/content`, {
    headers: authHeaders(authorToken2),
  });
  expect(contentResponse.ok()).toBeTruthy();
  const contentData = (await contentResponse.json()) as {
    chapter?: { paragraphs?: { text: string }[] };
  };
  expect(contentData.chapter?.paragraphs?.some((p) => p.text.includes("发布后直接修改"))).toBe(
    true
  );

  const progressResponse = await request.post("/api/reader/progress", {
    headers: { ...authHeaders(authorToken2), "Content-Type": "application/json" },
    data: {
      bookId,
      chapterId,
      paragraphAnchor: "p1",
      charOffset: 0,
      chapterProgress: 30,
      bookProgress: 30,
      updatedAt: new Date().toISOString(),
    },
  });
  expect(progressResponse.ok()).toBeTruthy();
  const bookmarkResponse = await request.post("/api/reader/bookmarks", {
    headers: { ...authHeaders(authorToken2), "Content-Type": "application/json" },
    data: { bookId, chapterId, paragraphAnchor: "p1", charOffset: 0, excerpt: "删除关联阅读数据" },
  });
  expect(bookmarkResponse.ok()).toBeTruthy();

  const deleteResponse = await request.delete(`/api/creator/chapters/${chapterId}`, {
    headers: authHeaders(authorToken2),
  });
  expect(deleteResponse.ok()).toBeTruthy();
  const progressAfterDelete = await request.get(`/api/reader/progress?bookId=${bookId}`, {
    headers: authHeaders(authorToken2),
  });
  expect(progressAfterDelete.ok()).toBeTruthy();
  const progressData = (await progressAfterDelete.json()) as {
    progress?: { chapterId?: string | null };
  };
  expect(progressData.progress?.chapterId).toBeNull();
  const afterDelete = await request.get(`/api/books/${bookId}/chapters/${chapterId}/content`, {
    headers: authHeaders(authorToken2),
  });
  expect(afterDelete.status()).toBe(404);
});

test("已发布作品会出现在所属分类页", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const { bookId } = await createDraftBook(
    request,
    authorToken,
    "category-book.txt",
    "分类筛选测试书"
  );
  const submitResponse = await request.post(`/api/creator/books/${bookId}/submit-all`, {
    headers: authHeaders(authorToken),
  });
  expect(submitResponse.ok()).toBeTruthy();
  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const approveResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(approveResponse.ok()).toBeTruthy();

  const authorToken2 = await login(request, "author@yuedu.test", "author123");
  const settingsResponse = await request.get(`/api/creator/books/${bookId}`, {
    headers: authHeaders(authorToken2),
  });
  expect(settingsResponse.ok()).toBeTruthy();
  const settings = (await settingsResponse.json()) as {
    categories?: { id: string; slug: string }[];
  };
  const category = settings.categories?.[0];
  expect(category).toBeTruthy();
  const updateResponse = await request.put(`/api/creator/books/${bookId}`, {
    headers: { ...authHeaders(authorToken2), "Content-Type": "application/json" },
    data: { title: "分类筛选测试书", categoryId: category?.id },
  });
  expect(updateResponse.ok()).toBeTruthy();

  const categoryPage = await (
    await request.get(`/categories/${category?.slug}`, { headers: authHeaders(authorToken2) })
  ).text();
  expect(categoryPage).toContain("分类筛选测试书");
});

test("切换下一章会从正文顶部开始阅读", async ({ page, request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const { bookId, chapterId } = await createDraftBook(
    request,
    authorToken,
    "reader-next-chapter.txt",
    "下一章阅读位置测试书"
  );
  const saveResponse = await request.post(`/api/creator/chapters/${chapterId}/save`, {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: {
      title: "第一章 长正文",
      paragraphs: Array.from(
        { length: 80 },
        (_, index) => `第 ${index + 1} 段，用于验证切换章节后滚动位置重置。`
      ),
    },
  });
  expect(saveResponse.ok()).toBeTruthy();
  const submitResponse = await request.post(`/api/creator/books/${bookId}/submit-all`, {
    headers: authHeaders(authorToken),
  });
  expect(submitResponse.ok()).toBeTruthy();
  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const approveResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(approveResponse.ok()).toBeTruthy();

  await page.addInitScript(() => {
    localStorage.setItem("yuedu-reader-settings", JSON.stringify({ paginationMode: "scroll" }));
  });
  await page.setViewportSize({ width: 390, height: 600 });
  await loginBrowser(page);
  await setPaginationMode(page, "scroll");
  await page.goto(`/read/${bookId}/${chapterId}`);
  const readerViewport = page.locator("main");
  await expect
    .poll(() => readerViewport.evaluate((element) => getComputedStyle(element).overflowY))
    .toBe("auto");
  await expect
    .poll(() => readerViewport.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await readerViewport.evaluate((element) => element.scrollTo({ top: 240 }));
  await expect
    .poll(() => readerViewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);

  // 上下栏已自动收起，先点中心亮出来再操作
  await revealReaderChrome(page);
  // 有下一章时底部是预取 Link，无下一章才是 disabled button
  await page.locator("footer a, footer button").last().click();
  await expect.poll(() => page.url()).not.toContain(`/${chapterId}`);
  await expect.poll(() => readerViewport.evaluate((element) => element.scrollTop)).toBe(0);
});

test("桌面覆盖模式每屏只显示一页且可翻页", async ({ page, request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const { bookId, chapterId } = await createDraftBook(
    request,
    authorToken,
    "reader-single-page.txt",
    "单页翻阅测试书"
  );
  const saveResponse = await request.post(`/api/creator/chapters/${chapterId}/save`, {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: {
      title: "第一章 单页正文",
      paragraphs: Array.from(
        { length: 120 },
        (_, index) => `第 ${index + 1} 段，用于验证单页连续排版与翻页。`
      ),
    },
  });
  expect(saveResponse.ok()).toBeTruthy();
  const submitResponse = await request.post(`/api/creator/books/${bookId}/submit-all`, {
    headers: authHeaders(authorToken),
  });
  expect(submitResponse.ok()).toBeTruthy();
  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const approveResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(approveResponse.ok()).toBeTruthy();

  await page.addInitScript(() => {
    localStorage.setItem("yuedu-reader-settings", JSON.stringify({ paginationMode: "cover" }));
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginBrowser(page);
  await setPaginationMode(page, "cover");
  await page.goto(`/read/${bookId}/${chapterId}`);
  const readerViewport = page.locator("main");
  await expect(readerViewport).not.toHaveAttribute("data-reader-spread");
  const indicator = page.locator(".reader-page-indicator");
  await expect.poll(() => indicator.textContent()).toMatch(/第 1 \/ (?:[3-9]|[1-9]\d+) 页/);
  const firstLabel = await indicator.textContent();

  await readerViewport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: rect.left + rect.width * 0.75,
        clientY: rect.top + rect.height * 0.75,
      })
    );
  });
  await expect.poll(() => indicator.textContent()).not.toBe(firstLabel);

  await readerViewport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: rect.left + rect.width * 0.25,
        clientY: rect.top + rect.height * 0.75,
      })
    );
  });
  await expect.poll(() => indicator.textContent()).toBe(firstLabel);

  const pageCountMatch = (await indicator.textContent())?.match(/\/ (\d+) 页/);
  const pageCount = pageCountMatch ? Number(pageCountMatch[1]) : 1;
  const lastLabel = `第 ${pageCount} / ${pageCount} 页`;
  for (let step = 0; step < pageCount; step++) {
    if ((await indicator.textContent()) === lastLabel) break;
    const before = await indicator.textContent();
    await readerViewport.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          clientX: rect.left + rect.width * 0.75,
          clientY: rect.top + rect.height * 0.75,
        })
      );
    });
    await expect.poll(() => indicator.textContent()).not.toBe(before);
  }
  await expect.poll(() => indicator.textContent()).toBe(lastLabel);
  await readerViewport.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: rect.left + rect.width * 0.75,
        clientY: rect.top + rect.height * 0.75,
      })
    );
  });
  await expect.poll(() => page.url()).not.toContain(`/${chapterId}`);
});

test("作品下架后从首页隐藏但详情仍可访问", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const { bookId, chapterId } = await createDraftBook(
    request,
    authorToken,
    "hide-book.txt",
    "下架展示测试书"
  );

  const submitResponse = await request.post(`/api/creator/chapters/${chapterId}/submit`, {
    headers: authHeaders(authorToken),
  });
  expect(submitResponse.ok()).toBeTruthy();
  const adminToken = await login(request, "admin@yuedu.test", "admin123");
  const batchResponse = await request.post("/api/moderation/tasks/batch-decision", {
    headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
    data: { bookId, decision: "approve" },
  });
  expect(batchResponse.ok()).toBeTruthy();

  const authorToken2 = await login(request, "author@yuedu.test", "author123");
  const toggleResponse = await request.post(`/api/creator/books/${bookId}/toggle-publication`, {
    headers: authHeaders(authorToken2),
  });
  expect(toggleResponse.ok()).toBeTruthy();

  const home = await (await request.get("/", { headers: authHeaders(authorToken2) })).text();
  expect(home).not.toContain("下架展示测试书");
  const detail = await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken2) });
  expect(detail.ok()).toBeTruthy();
});

test("每本书可设置独立作者名", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const book1 = await createDraftBook(request, authorToken, "author-1.txt", "作者独立测试一");
  const book2 = await createDraftBook(request, authorToken, "author-2.txt", "作者独立测试二");

  const update1 = await request.put(`/api/creator/books/${book1.bookId}`, {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: { title: "作者独立测试一", authorName: "甲作者" },
  });
  expect(update1.ok()).toBeTruthy();
  const update2 = await request.put(`/api/creator/books/${book2.bookId}`, {
    headers: { ...authHeaders(authorToken), "Content-Type": "application/json" },
    data: { title: "作者独立测试二", authorName: "乙作者" },
  });
  expect(update2.ok()).toBeTruthy();

  const detail1 = await (
    await request.get(`/books/${book1.bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  const detail2 = await (
    await request.get(`/books/${book2.bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  expect(detail1).toContain("甲作者");
  expect(detail1).not.toContain("乙作者");
  expect(detail2).toContain("乙作者");
  expect(detail2).not.toContain("甲作者");
});

test("作者可删除草稿章节", async ({ request }) => {
  test.setTimeout(120_000);

  const authorToken = await login(request, "author@yuedu.test", "author123");
  const { bookId, chapterId } = await createDraftBook(
    request,
    authorToken,
    "delete-chapter.txt",
    "删除章节测试书"
  );

  const deleteResponse = await request.delete(`/api/creator/chapters/${chapterId}`, {
    headers: authHeaders(authorToken),
  });
  expect(deleteResponse.ok()).toBeTruthy();

  const detail = await (
    await request.get(`/books/${bookId}`, { headers: authHeaders(authorToken) })
  ).text();
  expect(detail).not.toContain("第一章 山门");
});
