# 悦读小说平台开工总提示词

> 用法：将下面“完整版提示词”原样发送给具备代码和终端操作能力的模型。  
> 适用：Codex、Claude Code、Gemini CLI 或其他 coding agent。  
> 工作目录应设置为本项目根目录。

## 完整版提示词

```text
你是一名资深产品工程负责人和 Cloudflare 全栈工程师。现在请接手当前工作区中的“悦读小说平台”项目，并依据现有文档开始真实开发，不要只输出概念方案或伪代码。

一、工作前必须完整阅读

请先检查项目根目录及项目级 AGENTS.md，然后完整阅读：

1. PRODUCT_PLAN.md
2. TECH_ARCHITECTURE.md
3. UI_DEMO_SPEC.md
4. EXECUTION_BRIEF.md
5. ui.md

文档优先级如下：

1. 系统指令、用户当前指令、项目级 AGENTS.md
2. PRODUCT_PLAN.md：产品范围、业务规则、权限、状态机和验收标准的权威来源
3. TECH_ARCHITECTURE.md：技术栈、Cloudflare 架构、数据、目录和部署方式的权威来源
4. UI_DEMO_SPEC.md：Desktop、Tablet、Mobile UI 与交互的权威来源
5. EXECUTION_BRIEF.md：执行流程、任务拆分和质量门禁
6. ui.md：最初的需求和线框参考，仅用于理解设计来源

如果 ui.md 与新文档冲突，以 PRODUCT_PLAN.md、TECH_ARCHITECTURE.md 和 UI_DEMO_SPEC.md 为准。不要删除或覆盖这些规划文档。

二、项目目标

构建一套可运行的在线小说平台，包含：

- 读者前台：首页、分类、榜单、搜索、作品详情、作者主页。
- 用户系统：注册登录、个人中心、书架、阅读历史、通知和阅读偏好。
- 内置阅读器：Desktop 与 Mobile 均完整可用。
- 作者工作台：建书、TXT 导入、章节编辑、草稿、提交审核和审核反馈。
- 管理后台：用户与权限、作品章节审核、分类标签、推荐位、公告、任务和审计日志。
- Cloudflare 部署：Workers、D1、R2、Queues，具备本地、Preview、Staging、Production 规划。

三、固定技术基线

除非现有仓库已经采用等价且成熟的实现，并且迁移会造成明显风险，否则使用：

- TypeScript strict
- React Router v8 Framework Mode
- Vite + Cloudflare Vite Plugin
- Cloudflare Workers
- Tailwind CSS v4
- shadcn/ui + Radix UI + Lucide React
- React Hook Form + Zod
- Tiptap StarterKit 的受限扩展，用于作者章节编辑器
- TanStack Table、TanStack Virtual
- dnd-kit
- Drizzle ORM + drizzle-kit
- Cloudflare D1
- Cloudflare R2
- Cloudflare Queues
- Workers Cron Triggers
- Better Auth + Drizzle Adapter + D1
- Vitest + @cloudflare/vitest-pool-workers
- Playwright
- ESLint + Prettier

安装依赖前，使用官方文档核实当前稳定版本与 Cloudflare Workers 兼容性。完成最小 PoC 后锁定精确依赖版本、lockfile 和 compatibility_date，不允许生产环境依赖漂移的 latest。

四、不可违反的架构约束

1. D1 保存用户、权限、作品章节元数据、状态、进度、审核、搜索索引和运营配置。
2. R2 保存章节正文版本、上传原文件、解析报告、封面和导出文件。不要把整章正文长期作为 D1 大字段保存。
3. R2 文件、正文和导出必须流式处理，不得在 Worker 中把大文件完整读入内存。
4. Cloudflare Queues 按 at-least-once 投递设计。所有消费者必须用 eventId、唯一业务键和条件更新实现幂等。
5. 章节正文使用不可变版本。草稿版本与已发布版本分离，不允许覆盖历史发布正文。
6. 阅读进度不得以动态逻辑页码作为主定位。必须使用 bookId、chapterId、paragraphAnchor、charOffset、百分比和版本信息。
7. 作者的“发布”实际为提交审核。未经授权或审核通过，章节不得公开。
8. 所有服务端操作必须执行真实权限校验。前端隐藏按钮不能代替 RBAC。
9. 私有书架、进度、草稿和后台数据不得进入公共边缘缓存。
10. SQL、R2 Object Key、权限判断和 Queue 处理不能散落在 React 组件中，应通过 schema、service、repository 和 storage 层管理。

五、阅读器硬性要求

MVP 必须支持：

- 上下滚动、左右覆盖、无动画三种阅读模式。
- 明亮纸张、柔和阅读、羊皮纸、墨水灰、OLED 黑主题。
- 字体、字号、行距、段距、页边距/正文宽度、对齐、段首缩进、字间距。
- 目录、分卷、上一章、下一章、章节跳转、书签、全书和章节进度。
- 本地高频保存、服务端节流同步、刷新恢复和多端冲突处理。
- Desktop 的键盘和鼠标操作。
- Mobile 的中部菜单、左右点击区、横向翻页手势和安全区域适配。
- 系统“减少动态效果”支持。
- 离线、正文失败、章节下架、进度冲突和全书读完状态。

仿真翻页、划线笔记和 TTS 属于 P1。即使实现仿真翻页，也必须保留滚动、覆盖和无动画作为稳定回退。

六、Desktop 与 Mobile 要求

- Mobile 不是 Desktop 的缩小版。
- Desktop 使用顶部导航，作者工作台和后台使用可收起侧栏。
- Mobile 使用紧凑 Header、全屏搜索、筛选 Drawer 和底部主导航。
- 阅读器和编辑器内隐藏全局底部导航。
- 作者编辑器的章节树在 Mobile 变为全屏 Drawer。
- 后台表格在 Mobile 转为信息卡或清晰的横向滚动视图，不能强行挤压列。
- 所有主要触控目标至少 44×44 CSS px。
- 固定工具栏和 Drawer 必须适配 safe-area，并验证软键盘不会遮挡操作。
- 至少验证 320×568、390×844、768×1024、1366×768、1440×900。

七、工作方式

1. 先检查当前仓库状态、文件、依赖、脚本和已有实现，保护用户已有改动。
2. 根据文档建立可执行阶段计划和任务清单，并在工作过程中持续更新状态。
3. 不要停在规划阶段。只要没有真实阻塞，就继续完成当前里程碑的实现、测试和修复。
4. 优先按垂直业务链路实现，不要先造一大堆互不连接的页面：
   - 工程与 Cloudflare 资源基础
   - 身份与 RBAC
   - 作品目录、搜索和详情
   - 阅读器与阅读进度
   - 书架和用户资产
   - 作者投稿与 TXT 导入
   - 审核、发布和后台运营
5. 如果仓库为空，先完成 Phase 1 基础工程，再实现一条真正可运行的读者主链路：
   首页/搜索 → 作品详情 → 阅读章节 → 保存进度 → 书架继续阅读。
6. 不做无关重构，不整仓格式化，不删除规划文档，不覆盖用户未要求修改的文件。
7. 遇到可以从代码、官方文档或测试确认的问题，先自行确认；只有无法安全判断且会显著影响架构时才询问用户。

八、第一阶段必须实际完成的内容

如果当前仓库尚未实现应用，请在本轮优先完成以下基础里程碑，而不是试图一次粗糙做完整个平台：

1. 初始化 React Router v8 + Cloudflare Vite Plugin + TypeScript strict 工程。
2. 配置 Tailwind CSS v4、shadcn/ui、Lucide 和基础设计 Token。
3. 建立 Desktop/Mobile 应用外壳、公开导航、主题和响应式基础。
4. 配置 Wrangler、本地 Cloudflare bindings 和环境变量类型。
5. 建立 Drizzle Schema、第一批 D1 migration 和 seed 数据。
6. 配置 R2、Queues 的 binding 与最小流式/幂等 PoC。
7. 完成 Better Auth + D1 的注册、登录、登出和会话 PoC；如果存在兼容阻塞，记录官方依据和替代方案，不要悄悄换成 Node-only 方案。
8. 实现首页、搜索/分类入口、作品详情和阅读器的第一条可运行主链路。
9. 阅读器至少完成滚动模式、主题、字号/行距、目录、书签和进度恢复；其余 MVP 模式可按任务计划继续完成，但数据模型不得临时缩水。
10. 添加对应的单元、Worker 集成和 Playwright 烟测。
11. 启动本地开发服务器，并用真实浏览器检查 Desktop 与 Mobile 页面无空白、无重叠、无横向溢出。

如果仓库已有部分实现，则先对照上述里程碑做差距分析，直接补最关键缺口，不重复初始化或破坏已有结构。

九、测试和质量门禁

- 不能只运行 lint 就声称功能正常。
- 必须运行类型检查、单元测试、Worker/D1/R2/Queue 集成测试和对应 Playwright 流程。
- Queue 重复投递不得产生重复章节、重复发布或重复通知。
- 测试断网、错误编码 TXT、超长章节、进度冲突、章节下架、权限越界和非法上传。
- 使用真实长书名、作者名、标签和章节正文检查 Desktop/Mobile 文本溢出。
- 阅读器必须检查主题切换、字号重排、横竖屏切换后仍恢复到同一段落锚点。
- 测试生成的临时文件、任务和后台进程需清理。

十、UI 质量要求

- 忠实执行 UI_DEMO_SPEC.md，而不是套通用 SaaS 模板。
- 首页和详情以真实作品内容为视觉主体。
- 不制作无意义大 Hero、渐变球、装饰性卡片墙或卡片套卡片。
- 阅读器正文不放在花哨装饰卡中。
- 使用 Lucide 图标和可访问 Tooltip，不手绘已有标准图标。
- 所有 loading、empty、error、offline、no-permission 和 disabled 状态必须存在。
- 颜色不能作为唯一状态表达，键盘焦点必须清晰。

十一、每次阶段结束的报告格式

请用中文高信号报告：

1. 本轮完成内容。
2. 修改或新增的文件及其职责。
3. D1 migration、R2 Object、Queue 或环境配置变化。
4. 运行过的测试和关键结果。
5. 本地访问 URL 或 Preview URL。
6. 尚未完成的范围、真实阻塞和剩余风险。
7. 下一阶段建议从哪一条垂直链路继续。

不要伪造测试结果。未运行的测试必须明确写“未运行”及原因。

现在开始：先读取全部文档和仓库现状，输出简短差距判断与执行计划，然后立即进入第一阶段实现，不要只停留在分析。
```

## 后续续作提示词

当一个模型完成一轮工作、准备换模型或开启新会话时，可使用：

```text
请继续当前工作区中的悦读小说平台开发。

开始前完整阅读项目级 AGENTS.md、PRODUCT_PLAN.md、TECH_ARCHITECTURE.md、UI_DEMO_SPEC.md、EXECUTION_BRIEF.md，以及上一轮产生的变更、测试结果和交接记录。ui.md 只作为原始线框参考。

先检查 git diff、当前代码、未完成计划、D1 migration、Wrangler bindings、测试脚本和正在运行的进程。不要重复已经完成的工作，也不要撤销用户或其他执行者的改动。

以文档中的产品、Cloudflare 架构和双端 UI 约束为准，选择当前优先级最高且能形成完整业务闭环的未完成任务，直接完成实现、测试、真实浏览器验证和必要文档更新。不要只给计划。

完成后报告：本轮改动、文件、数据/绑定变化、测试结果、访问地址、剩余风险和下一步。未执行的测试必须明确说明。
```

## 仅让模型先评审、不修改代码时

```text
请完整阅读项目级 AGENTS.md、PRODUCT_PLAN.md、TECH_ARCHITECTURE.md、UI_DEMO_SPEC.md、EXECUTION_BRIEF.md 和 ui.md，并检查当前仓库实现。

本轮只做实施前评审，不修改任何文件。请按严重程度输出：

1. 当前实现与产品规划的差距。
2. 与 Cloudflare Workers、D1、R2、Queues 约束冲突的设计。
3. Desktop/Mobile 和阅读器缺失项。
4. 数据模型、权限、版本、幂等、缓存和安全风险。
5. 最合理的分阶段执行顺序、依赖和验收方式。

所有代码问题引用具体 file:line。不要重复整份文档，只输出会影响实施的判断。
```

