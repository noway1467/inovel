# 悦读小说平台执行 Brief

> 交接材料：`PRODUCT_PLAN.md`、`TECH_ARCHITECTURE.md`、`UI_DEMO_SPEC.md`、原始 `ui.md`。  
> 用途：交给产品、设计、Cloudflare 全栈开发和测试团队直接拆解执行。

## 1. 原需求诊断

原始 `ui.md` 已覆盖首页、账号、后台、上传和书架的线框方向，但仍有五个结构性缺口：

1. 没有阅读器，而阅读器是小说平台的核心体验。
2. 缺少搜索结果、作品详情、目录，发现到阅读链路不完整。
3. “发布”和“审核”关系不清，缺少内容生命周期。
4. 没有进度锚点、版本、权限、错误恢复和异步任务规格。
5. 没有 Mobile 独立交互，不能只把 Desktop 缩小。

本次规划已补全业务、双端 UI、Cloudflare 架构、具体技术栈、数据与验收。后续不得回退到“逐页临时补字段”的方式。

## 2. 总执行提示词

```text
你是一支由产品、UX/UI、Cloudflare 全栈工程师和测试工程师组成的团队。

目标：依据 PRODUCT_PLAN.md、TECH_ARCHITECTURE.md、UI_DEMO_SPEC.md，建设“悦读小说平台”的 Desktop、Tablet、Mobile Web。平台包含读者前台、内置阅读器、作者工作台和管理后台。

固定技术基线：
- React Router v8 Framework Mode + TypeScript strict
- Vite + Cloudflare Vite Plugin
- Tailwind CSS v4 + shadcn/ui + Radix UI + Lucide
- React Hook Form + Zod
- Drizzle ORM + Cloudflare D1
- Cloudflare R2 存章节版本、封面和上传文件
- Cloudflare Queues 处理导入、索引、通知和统计
- Better Auth + D1/Drizzle，编码前先完成 Worker 兼容性 PoC
- Vitest + @cloudflare/vitest-pool-workers + Playwright

硬性约束：
1. 阅读器必须支持滚动、左右覆盖、无动画；P1 支持仿真翻页。支持明亮、柔和、羊皮纸、墨灰、OLED 主题，以及字体、字号、行距、段距、边距、对齐、缩进。
2. 阅读进度不得存逻辑页码作为主定位，必须使用 chapterId、paragraphAnchor、charOffset，并处理重排与跨设备冲突。
3. Desktop 与 Mobile 共享业务能力，但导航、筛选、弹层、编辑器、后台表格和阅读器交互需分别实现。
4. 章节正文和上传原文件存 R2；D1 只存元数据、状态、索引和用户资产。大对象全程流式处理，不在 Worker 内存完整缓冲。
5. Queues 为至少一次投递，消费者必须通过 eventId、条件更新和唯一业务键实现幂等。
6. 作者发布必须经过审核状态机；正文版本不可覆盖，草稿与发布版本分离。
7. 所有页面覆盖 loading、empty、error、offline、no-permission、长文本和角色差异。
8. 编码前读取项目 AGENTS.md、现有结构、依赖、组件和测试脚本；不做无关重构。

执行顺序：
1. 确认范围、状态机、权限、字段字典和 Cloudflare 资源。
2. 完成 Better Auth+D1、Drizzle migration、R2 流式访问、Queue 幂等的技术 PoC。
3. 完成 Desktop/Mobile 设计与 API 契约。
4. 按垂直链路实现：发现并阅读、书架同步、作者投稿、审核发布。
5. 执行单元、Worker 集成、真实浏览器 E2E、性能、安全和无障碍验证。
6. 报告部署、迁移、监控、回滚、测试结果与已知风险。

依赖版本规则：以 TECH_ARCHITECTURE.md 的稳定主版本为基线，PoC 通过后锁定精确版本和 compatibility_date；CI 和生产不得使用漂移的 latest。

禁止：
- 用静态假数据页面冒充完整功能。
- 把正文大字段直接长期存入 D1。
- 假设 Queue 只投递一次。
- 只跑 lint 就声称上传、阅读、同步或审核正常。
- 在 Mobile 上硬压 Desktop 侧栏和表格。
- 自动识别 TXT 后未经作者预览就导入发布。
```

## 3. 分角色交付

### 产品经理

输出 PRD、流程、RBAC、字段字典、状态机、错误码、事件、MVP 边界、验收矩阵和范围变更记录。优先保证阅读连续性、内容安全和用户资产不丢失。

### UX/UI

基于 `UI_DEMO_SPEC.md` 输出设计 Token、组件库、1440px/390px 页面、阅读器 320px/768px/横屏与主题稿，以及四条可点击主流程。必须用真实中文长文本验证。

### Cloudflare 全栈开发

先完成运行时 PoC，再按 `TECH_ARCHITECTURE.md` 的模块边界实现。所有 D1 查询、R2 Key、权限和队列处理位于 server/service 层；React 组件不直接拼 SQL 或对象路径。

### 测试

建立风险驱动矩阵，覆盖断网、重复 Queue、进度冲突、超长章节、错误编码 TXT、权限越界、章节下架、软键盘遮挡、横竖屏和动画降级。功能测试包含真实浏览器操作。

### 运维与内容运营

运维负责 Cloudflare 环境、资源、WAF、限流、日志、告警、迁移、备份和回滚；运营负责分类标签、审核规范、推荐口径、公告、举报和申诉流程。

## 4. 工作分解 WBS

| Epic | 关键内容 | 前置 | 完成证据 |
|---|---|---|---|
| E1 工程与资源 | Worker、D1、R2、Queues、CI/CD、环境 | 技术基线 | Preview/Staging 部署 |
| E2 身份权限 | Better Auth PoC、会话、RBAC、设备 | E1 | 越权与审计测试 |
| E3 内容目录 | 作品、作者、分类标签、详情、搜索 | E1 | 搜索到详情流程 |
| E4 阅读器 | 正文流、主题、排版、翻页、锚点 | E3 | 双端阅读恢复 E2E |
| E5 用户资产 | 书架、历史、书签、偏好、同步 | E2/E4 | 跨端冲突测试 |
| E6 作者创作 | 建书、TXT 导入、编辑、版本 | E2/E3 | 上传到提交审核 |
| E7 审核运营 | 审核、举报、发布、推荐、通知 | E6 | 退回再提交闭环 |
| E8 上线质量 | 性能、安全、无障碍、监控、回滚 | 全部 | 灰度演练报告 |

## 5. 任务卡模板

每张开发任务必须包含：

- 用户故事和业务价值。
- 范围内与范围外。
- 角色和权限。
- Desktop/Mobile 差异。
- 正常、加载、空、错误、离线、无权限状态。
- D1 表、R2 对象、Queue 消息或 API 依赖。
- 幂等、并发、缓存和审计要求。
- 可执行验收步骤与测试证据。
- 监控、部署与回滚影响。

缺少这些字段的任务不得进入开发，省得后期靠会议猜需求。

## 6. 里程碑门禁

### Gate A：可开发

- 权限、字段、状态机、双端设计和 API 契约确认。
- Cloudflare PoC 验证 Auth、D1 migration、R2 stream、Queue 幂等。
- 长文本、错误 TXT、空/错/离线状态有设计。

### Gate B：可联调

- 前端不依赖不可追踪的临时假数据。
- 阅读锚点、章节版本和审核状态不再结构性变化。
- 核心 API 有权限、错误码和测试数据。

### Gate C：可灰度

- 四条核心 E2E 通过。
- Worker 限制、D1 查询、R2 访问、Queue 积压可监控。
- 安全、性能、无障碍、兼容、备份和回滚达标。

### Gate D：可上线

- 灰度无高严重度数据丢失、越权、重复发布或阅读阻断。
- 导入失败、章节加载、进度冲突和审核积压处于可接受范围。
- 已知限制有负责人和排期。

## 7. 最终报告模板

```text
版本 / 日期：

一、完成范围
二、未完成与范围变化
三、关键技术与产品决策
四、Cloudflare 资源与 D1 migration
五、Desktop/Mobile 验证
六、单元 / 集成 / E2E / 性能 / 安全 / 无障碍结果
七、部署、监控与回滚
八、已知风险、负责人和后续版本
```
