# 悦读小说平台

基于 Cloudflare Workers + D1 + R2 + Queues 的全栈在线小说平台，覆盖读者前台、内置阅读器、作者投稿与导入、基础管理与审核占位。

## 技术基线（已锁定版本）

- React Router 8.3.0 Framework Mode + Vite 8.2.1 + Cloudflare Vite Plugin 1.52.0
- TypeScript 6.0.3 strict、Tailwind CSS 4.3.3、shadcn 风格组件、Radix UI、Lucide
- Drizzle ORM 0.45.2 + D1、R2、Queues、Better Auth 1.6.27
- Vitest 4.1.10、Playwright 1.62.1

精确版本见 `package.json` 与 `package-lock.json`；`compatibility_date` 固定为 `2026-08-13`。

## 本地启动

```powershell
npm install
npm run dev
```

打开 http://localhost:5173 。

本机若配置了 `HTTP_PROXY / HTTPS_PROXY`，`scripts/dev.ps1` 会自动放行 `localhost,127.0.0.1,::1`，否则 Cloudflare 本地 workerd 的回环请求会被代理劫持并返回 502。

首次启动后应用数据库 migration：

```powershell
npx wrangler d1 migrations apply ibook-app --local
```

灌入演示数据（分类、角色、3 本书、12 个已发布章节、作者与读者账号）：

```powershell
Invoke-RestMethod -Method Post http://localhost:5173/api/dev/seed
```

本地 seed 会创建读者、作者、管理员三个演示账号，账号与密码见 `app/server/seed-data.ts`。
仅供本地开发使用，请勿在生产环境执行 seed。

## 生产部署

仓库中的 `wrangler.jsonc` 是**脱敏模板**，域名、D1 `database_id` 等留空。首次部署：

```powershell
Copy-Item wrangler.jsonc wrangler.local.jsonc
```

在 `wrangler.local.jsonc` 里填入自己的资源信息（该文件已 gitignore，构建与部署会自动优先使用它）：

- `routes` / `BETTER_AUTH_URL`：自定义域名
- `d1_databases[0].database_id`：`wrangler d1 create ibook-app` 返回的 ID
- `TURNSTILE_SITE_KEY`：Turnstile 站点密钥（公开值；留空则跳过人机验证）
- `ADMIN_EMAIL` / `ADMIN_NAME`：首个管理员账号

需要的云资源：D1 `ibook-app`、R2 `ibook-content`（及 `ibook-content-preview`）、Queues `ibook-ingest` / `ibook-jobs` / `ibook-jobs-dlq`。

密钥一律用 `wrangler secret put` 写入，禁止提交到仓库：

```powershell
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TURNSTILE_SECRET_KEY
```

换自定义域名：

```powershell
.\scripts\deploy.ps1 -Domain "reader.example.com"
```

脚本会更新 `BETTER_AUTH_URL`、重新构建并部署。部署前确认：

1. 在 Cloudflare Dashboard 为 Worker 绑定自定义域名路由；
2. Turnstile 站点密钥的允许域名列表包含该域名；
3. 生产管理员账号由 `ADMIN_EMAIL` 与 `ADMIN_PASSWORD` secret 引导，首次登录接口调用时自动创建并授予 `super_admin`、`admin` 角色。

生产登录强制 Turnstile 验证：未配置 `TURNSTILE_SECRET_KEY` 的环境（如本地开发）自动跳过，不影响测试。

## 管理员与环境变量

管理员账号由环境变量初始化，创建后自动授予 `super_admin` 与 `admin` 角色，幂等且只执行一次：

```text
ADMIN_EMAIL=你的管理员邮箱
ADMIN_PASSWORD=至少8位强密码
ADMIN_NAME=平台管理员
```

本地写入 `.dev.vars`；生产环境用 `wrangler secret put` 或 Secret 管理，禁止提交真实密码。

管理员创建后，密码改用站内「头像菜单 → 账号设置 → 修改密码」修改，引导逻辑不会覆盖已存在账号的密码。

## 注册开关

- 默认关闭注册，注册接口返回 `403 REGISTRATION_DISABLED`。
- 管理员登录后在 `/admin` 打开“开放注册”开关，前端注册入口即时联动。
- 设置存于 D1 `site_settings`（`registration.enabled`），变更写入 `audit_logs`。

## 登录防护

- 同一 IP 连续 5 次登录失败进入 15 分钟冷却，期间接口返回 `429 IP_BLOCKED`。
- 前端本地记录失败次数并在达到阈值后直接拦截提交，不再请求后端。
- 登录成功自动清零服务端与本地计数。

## 小说导入（TXT / EPUB / MOBI / PDF）

入口：`/creator/upload`。

- 支持单文件多选与整个文件夹批量导入。
- TXT 自动识别 UTF-8 / UTF-8 BOM / GB18030 编码。
- TXT 自动识别真实卷名与章节标题：`第 N 卷` 会成为数据库卷目录，后续章节归入对应卷；正文语句不会冒充章节标题。
- EPUB 优先读取文件自带 NCX/TOC，支持同一 XHTML 内按 `#fragment` 拆成多章；只有源目录缺失时才回退到 spine 与正文标题。
- MOBI 优先读取文件自带 TOC，并按解析到的正文定位映射章节；缺失目录时才回退到 HTML/正文标题。
- PDF 使用 `unpdf`（内置 serverless PDF.js），文本提取后按章节规则切分；扫描版会明确报错。
- 上传完成后由 Cloudflare Queues 异步解析，前端轮询任务状态；队列不可用时明确标记失败并允许重试，不退回请求内同步解析，避免把请求拖到 Worker 1102。
- 解析报告按章拆存 R2：候选列表与分片确认导入不再把整本正文拉进 Worker 内存。
- 解析预算：单本上限 5000 章，有目录时超大章节保留为单个原始章节并提示“建议拆分”，解析超过 40 秒预算会明确失败。
- 有目录时章节结构完全来自源文件，技术分片只用于批量写入；没有目录时可设置字数兜底拆章；同标题同正文的重复章节自动过滤。
- 解析完成后进入章节确认：候选目录按 40 章分页，可改名、忽略单章和查看告警；默认提交审核，也可开启“无需审核，直接发布”，直接写入 `published` 章节且不创建审核任务。正文不可变版本写入 R2，元数据写入 D1。
- 导入任务状态机：`uploaded -> parsing -> awaiting_confirmation -> completed / failed`；导入成功后任务变为 `completed`，从解析列表与待导入池一起移除，不再显示。
- 多文件在前端逐本排队上传与解析，`ibook-ingest` Queue 限制为单消费者；同一用户重复上传同名同大小文件时复用现有任务，解析消费端原子抢占，避免重复或并发解析消耗 CPU 触发 Worker 1102。
- 上传大小上限（按格式）：TXT 50MB、EPUB/MOBI 50MB、PDF 50MB；>50MB 走 R2 multipart 分片（每片 16MB）。

## 章节编辑器与审核闭环

- 作者作品管理：`/creator`（我的作品）展示全部作品，`/creator/books/:bookId` 可修改书名、简介、本书作者名（每本书独立，不影响其他书）、标签、分类，章节列表分页（500 章也可管理），章节可直达编辑器；作品卡片直接进入管理页。
- 章节编辑：草稿/被退回可编辑、可删除；已发布章节先“下架”再编辑，改完可重新提交审核；章节列表点击任意章节右侧正文会同步切换。
- 阅读器默认“覆盖”翻页；目录直接读取数据库真实卷章，默认正序，可切换倒序并折叠/展开卷。
- 功能逻辑与交接说明见 `docs/FEATURE_LOGIC.md`。
- 作者章节编辑器：`/creator/books/:bookId/chapters/:chapterId`，Tiptap 受限扩展（段落、加粗/斜体/下划线、对齐、自动排版、字数），保存生成新的不可变版本并更新 `currentVersionId`。
- 保存后可将章节提交审核，状态流转 `draft/rejected -> pending_review`，服务端创建审核任务。
- 审核工作台：`/admin/moderation` 按作品归集待审章节，支持整部作品“全部通过”与勾选批量通过；单章可查看正文、填写意见并“通过并发布”或“退回修改”（退回必填原因）。
- 通过后章节状态变为 `published`、版本标记为已发布并写入通知；未通过审核的章节公开接口始终返回 404。
- 作者无法绕过审核直接公开：公开内容接口强制校验 `published` 状态。

## 用户与角色管理

- 管理后台 `/admin/users`：按昵称/邮箱搜索用户，授予或撤销 `author / moderator / operator / admin` 角色，启用或禁用账号。
- 禁用账号后登录接口返回 `403 ACCOUNT_DISABLED`，重新启用即可恢复。
- 角色与状态变更写入 `audit_logs`，管理员不能禁用自己。

## 通知中心

- 通知中心 `/notifications`：展示审核结果等系统通知，支持单条已读与全部已读，Header 用户菜单显示未读角标。
- 审核通过/退回时自动为作者写入通知（`dedup_key` 防重复）。

## 阅读器

- 滚动 / 覆盖 / 无动画三种模式，覆盖模式支持键盘、左右点击区与横向手势。
- 明亮纸张、柔和阅读、羊皮纸、墨水灰、OLED 黑主题。
- 字号、行距、段距、正文宽度、对齐、段首缩进、字间距、字体即时生效并本地保存。
- 目录与导入源文件保持同一卷章结构，支持正序/倒序、卷折叠；书签与进度以 `chapterId + paragraphAnchor` 定位。
- Desktop/Mobile 均通过真实浏览器验证无横向溢出。

## 测试

```powershell
npm run typecheck
npx vitest run
npx playwright test
npm run build
```

当前结果：TypeScript strict 通过，目录解析、导入与阅读器链路测试通过；上传→解析→确认导入→直接提交审核→管理员通过→公开阅读等导入/审核闭环经 Desktop 与 Mobile 真实浏览器/API 验证，生产构建通过。

## 目录结构

```text
app/routes          React Router 页面与 API route
app/components      公共组件、书卡、阅读器、布局
app/server          鉴权、D1 仓储、导入解析、队列、安全、存储
drizzle/schema      D1 表定义
drizzle/migrations  Drizzle SQL migration（含 FTS5 与触发器）
workers/app.ts      Cloudflare Worker 入口
tests/unit          单元测试
tests/e2e           Playwright 烟测
```

## 已知限制与剩余风险

- 解析已迁移到队列异步执行（`IMPORT_PARSE` 由同一 Worker 的 queue consumer 消费，`job_dedup` 幂等）；本地没有队列 binding 时回退请求内同步解析，便于开发。
- 大文件上传第一阶段经 multipart 读入 Worker 内存后写 R2；生产大文件需切换为流式分片上传。
- 候选章节用 D1 `batch` 分批写入（每批 ≤50 条），确认导入按 12 章/片游标分片提交（`commit_cursor`），上千章的全本大书可正常导入，单请求 D1/子请求预算（约 1000）内安全。
- 阅读器覆盖/无动画分页当前按视口与排版估算逻辑页，仿真翻页、划线笔记、TTS 为 P1。
- 审核台已支持章节通过/退回；用户管理、分类标签、推荐位、公告等后台模块按 `PRODUCT_PLAN.md` 继续扩展。
