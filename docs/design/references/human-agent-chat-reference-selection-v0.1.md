---
status: candidate
version: 0.1
date: 2026-08-11
scope: 第 7 个“人—Agent 聊天与协作”参考项目选型
decision: pending-user-selection
---

# 人—Agent 聊天与协作参考项目选型 v0.1

## 1. 结论先行

本轮从 9 个当前产品扫描到 3 个最终候选。推荐顺序是：

1. **Replit Agent**：首选，`93/100`。它最完整地把 `Goal → 可修订 Plan → 后台 Task → Live Artifact → Review / Apply / Dismiss → Checkpoint / Rollback` 放在一条持续对话里。
2. **Manus**：备选，`91/100`。它最接近通用的“人 + Agent + 多 Agent + 协作者”工作空间，并且把 Project context、Task progress、Computer、后台运行、Take Over 和可见范围放在同一个产品里。
3. **Microsoft Researcher with Computer Use**：第三候选，`78/100`。它最清楚地展示企业资料源、虚拟计算机、敏感动作确认和带来源报告，但 Plan 修改、Checkpoint 和恢复链较弱。

推荐不是冻结决定。用户选择之前，不登记第 7 个 frozen 参考，不制作原型，不修改生产 UI。

## 2. 研究问题、口径与证据边界

### 2.1 当前缺口

现有 6 个参考分别覆盖 Project room、Today、Project Update、Calendar candidate、多 Agent 异步监督和显式知识上下文；共同缺少一条完整连续路径：

```text
自然语言目标
→ 澄清与可修订 Plan
→ Context / 权限 / 写回范围
→ 长任务与工具 / 子任务进度
→ 暂停、介入、失败、取消或恢复
→ Artifact / Evidence 审阅
→ 接受、拒绝、继续编辑和正式交付
```

第 7 个参考重点不是再找一个“更好看的聊天页”，而是寻找能把 Chat、Plan、Task / Run、Artifact、Evidence 和 Participant / Visibility 连续起来的交互语法。

### 2.2 评分

| 标准 | 权重 |
|---|---:|
| 人—Agent 多轮闭环完整度 | 25 |
| Plan / Run / Checkpoint / HITL 可见性 | 20 |
| Artifact、Evidence 与对话连续性 | 15 |
| 长任务、暂停、恢复和错误处理 | 15 |
| 上下文、权限与写回边界 | 10 |
| 移动 / 桌面交互可迁移性 | 5 |
| 与现有 6 个原型的互补度 | 10 |

进入最终 3 个候选还必须通过一个独立证据门：有 2026 年当前官方文档，加上官方或一手真实产品画面；只有营销陈述、旧产品名或普通聊天界面的产品不得入选。

### 2.3 证据等级

- `O`：本轮下载并实际检查的官方或一手真实产品画面。
- `D`：2026-08-11 复核的官方产品 / 帮助 / 文档。
- `I`：从 `O + D` 推出的 Chat 适配判断；不冒充原产品事实。

Product Design 内置浏览器能打开资料页，但连续 3 次在 DOM / 截图阶段超时；Chrome 控制面不可用。因此本轮没有把登录态产品操作冒充“真实 E2E”。视觉证据改为直接下载官方或一手页面中的真实产品截图，逐张验收，再以相同证据格制作同屏对照。它支持屏幕级交互研究，不证明键盘、读屏、网络恢复或账户权限的运行质量。

外部截图不复制进 Git，遵守本目录 `README.md` 的 link-only 规则。同屏图只在当前 Codex 任务的私有 visualization 输出中展示。

## 3. A｜候选长名单（9 个）

### 3.1 ChatGPT Work / Deep Research / Projects

当前定位已经变化：旧 `ChatGPT agent` 帮助页明确提示改用 **ChatGPT Work**；Work 面向长时、多步骤工作和完成品，可在 Project context 中运行、查看进度、回答问题、改变方向并批准重要动作。Deep Research 仍有更明确的 `选择来源 → 提议 Plan → 修改 → 实时进度 → 中断调整来源 → 带引用报告 / Activity history`。关键证据是 [ChatGPT Work 官方帮助](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)、[Deep Research 当前帮助](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt) 和 [Projects 当前帮助](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)。明显缺口：当前 Work 公开材料没有足够的全流程真实 UI 画面；若借用已退役 agent mode 画面，会把不同版本混为一谈。Deep Research 又偏研究报告，工具副作用、Checkpoint 和通用 Artifact 审阅不足。**高能力但证据门未通过，淘汰出最终 3 个。**

### 3.2 Claude Research / Artifacts / connectors

Claude 把 Research 的多轮检索、连接的工作资料和 Artifacts 的右侧可编辑窗口组合起来；Artifact 有版本选择、代码查看、下载、多个 Artifact 切换和后续对话修改。关键证据是 [Research 官方说明](https://www.anthropic.com/news/research)、[Artifacts 当前帮助](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them) 与 [connectors 当前帮助](https://support.anthropic.com/en/articles/11817150-connect-your-tools-to-unlock-a-smarter-more-capable-ai-companion)。明显缺口：公开证据没有一等可修订 Plan、耐久 Run、Checkpoint、暂停 / 恢复或结构化失败；核心形态仍是对话 + Artifact，和 Heptabase 的 AI Chat + 可保存候选已有部分重复。**淘汰。**

### 3.3 Manus

Manus 是通用云端 Agent 工作空间：自然语言任务进入显式 Task progress，Agent 在 Computer / Browser / Editor 中工作，可后台继续、接受中途消息、停止、Take Over；Projects 提供持久 instruction / knowledge，Collab 允许多个人在同一 Task 里直接提示 Agent，Wide Research 把目标拆成并行子 Agent。关键证据是 [Projects](https://manus.im/docs/features/projects)、[Cloud Browser](https://manus.im/docs/features/cloud-browser)、[Collab](https://manus.im/docs/features/collab)、[Wide Research](https://manus.im/docs/features/wide-research) 和官方 [Wide Research replay](https://manus.im/share/IXdMjxObbFKbIjUUkBk4EH?replay=1)。明显缺口：普通任务的 Plan 常边生成边执行，缺少 Replit 式统一的 Plan 审批门；Checkpoint / 失败恢复的公开合同较弱；“同一共享 workspace”不能替代 Chat 的 Product Store。**进入最终候选。**

### 3.4 Devin

Devin 是软件工程 Agent：先在 Ask / Plan 中理解代码和形成 scoped plan，再 `Send to Devin` 进入 Agent session；Interactive Planner 支持等待批准、调整计划，Session 内可看 browser / terminal / IDE、测试录像、PR 和问题求助，2026 release notes 还显示子 Devin、睡眠 / 唤醒、移动状态与 ACU 硬上限。关键证据是 [Your First Session](https://docs.devin.ai/get-started/first-run)、[Testing & Video Recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings) 与 [2026 release notes](https://docs.devin.ai/release-notes/overview)。明显缺口：与 Replit 在 Ask / Plan → coding Agent → PR / test 上高度重叠，而 Replit 对 Artifact、Task board、Apply / Dismiss 和 Checkpoint 的连续性证据更完整；非软件可迁移性更弱。**因区分度不足淘汰。**

### 3.5 Replit Agent

Replit Agent 把自然语言目标、Plan Mode、Task board、隔离后台 Task、Live Preview / Canvas、测试结果、Apply / Dismiss、Checkpoint / Rollback 和项目恢复放在一个 Project Editor。关键证据是 [Plan vs Build](https://docs.replit.com/learn/plan-vs-build-mode)、[Build with Agent](https://docs.replit.com/learn/build-with-agent)、[Project Editor](https://docs.replit.com/learn/projects-and-artifacts/project-editor)、[Task system](https://docs.replit.com/core-concepts/agent/task-system) 与 [Version control](https://docs.replit.com/learn/projects-and-artifacts/version-control)。明显缺口：词汇和主壳层仍偏软件 / App；Git checkpoint、database restore 与通用 Product Commit 不能等同；Team workspace 并未清楚表达 Agent participant / visibility。**进入最终候选。**

### 3.6 Genspark Super Agent

Genspark 将研究、文档、Slides、Sheets、Designer、Developer 和通信工具编排为一个 Super Agent，并宣传 lead agent + specialized sub-agents。关键证据是 [Super Agent 帮助](https://www.genspark.ai/helpcenter?doc=general_What_is_Super_Agent)、[Super Agent 官方发布](https://www.genspark.ai/blog/genspark-super-agent) 与 [multi-agent orchestration](https://www.genspark.ai/blog/genspark-multiagent-orchestration)。明显缺口：当前官方资料能证明“会计划、会编排”，但缺少可审核 Plan、运行 checkpoint、人工修改门、失败 / 结果未知与可见权限的连续界面；大部分证据是功能营销。**证据不足，淘汰。**

### 3.7 Gemini Deep Research / Canvas

Gemini Deep Research 有 `Sources → 自动 Plan → Edit plan → Start research → 等待通知 → Canvas report → Share / Export Docs / Audio / Visualization`，还可从 Gmail、Drive、NotebookLM 和上传文件选择来源。关键证据是 [Gemini Deep Research 当前帮助](https://support.google.com/gemini/answer/15719111?hl=en)。明显缺口：运行期人工介入、暂停 / 恢复、错误处置和 Task / Run 对象较弱；核心仍是研究报告，和 ChatGPT Deep Research / Microsoft Researcher 同类，同时部分重复 Heptabase 的显式 AI context。**淘汰。**

### 3.8 Microsoft Researcher with Computer Use

Researcher 是 Microsoft 365 Copilot 内的长时研究 Agent；用户选择 Web / Work / SharePoint / Email 等来源，可启用安全临时虚拟计算机，看见 Visual Browser / Text Browser / Terminal，敏感动作和登录要求确认，最后得到可编辑、可共享、可转 Presentation / Document 的带来源报告。关键证据是 [Researcher 当前帮助](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-with-researcher-in-microsoft-365-copilot) 与 [Researcher with Computer Use（2026-02）](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-using-researcher-with-computer-use-in-microsoft-365-copilot-frontier)。明显缺口：没有明确的 Plan 编辑门、Checkpoint、取消 / 恢复和错误状态；仍处 Frontier，且 Microsoft 品牌视觉与现有 Agent Feed 重复，但交互场景并不重复。**作为权限 / Context / Computer Use 的差异化候选进入最终 3 个。**

### 3.9 Perplexity Research / Create files and apps

Perplexity 现在能在同一 Session 中从 Research 生成 Document、Spreadsheet、Presentation 或 HTML App，侧栏预览、后续提示精修、Edit history、下载 / 分享 / Google Drive export，Document 自动带引用。关键证据是 [Creating assets 当前帮助](https://www.perplexity.ai/help-center/en/articles/12528830-creating-assets-with-perplexity-overview) 与 [Perplexity 当前工作方式](https://www.perplexity.ai/help-center/en/articles/10352895-how-does-perplexity-work)。明显缺口：Plan、工具 / 子任务进度、HITL、暂停恢复和错误边界的公开证据弱，更像“研究 + Artifact 生成器”，与 Claude Artifact / Gemini Canvas 部分重复。**淘汰。**

## 4. B｜最终候选 1：Replit Agent

### 4.1 定位、用户场景与 UI

- **定位**：以 Agent 为主的 Project Editor；当前不只输出 Web App，也覆盖 mobile、slides、design、document、spreadsheet 和 visualization。
- **主要场景**：用户描述一个可交付目标，先和 Agent 收敛范围，再让多个隔离 Task 在后台构建；用户在 Preview / Canvas / work log / tests 中审阅并决定是否写回主版本。
- **UI 风格**：密集的多栏工作台；左侧对话 / thread，中间或右侧 Artifact preview、Canvas、console；Task board 提供 Drafts / Active / Ready / Done。

### 4.2 核心交互语法

```text
Goal + constraints
→ Plan Mode（只读，不改文件）
→ task plan：What / Why / Done looks like / Out of scope / steps
→ user asks follow-up / Revise plan / Accept tasks
→ isolated background task threads
→ Active / queued / dependency wait
→ work log + tests + live preview
→ Apply changes | Dismiss
→ checkpoint + Changes | Rollback
```

用户通过追问、缩小范围、Canvas annotation、Revise plan、Accept tasks、Task thread feedback、Apply / Dismiss 和 Rollback 影响 Agent。Agent 通过 Plan card、Task board、live status、work log、test result、Preview、checkpoint diff、耗时 / 动作 / 变更和费用反馈自己在做什么。

### 4.3 截图路径审计

| Step | 画面与证据 | 健康度 | 结论 |
|---:|---|---|---|
| 1 | 对话起点 + Plan card + Preview（`O`，一手真实画面；行为由当前官方 Plan docs 复核） | 良好 | Goal、Plan 和 Artifact 同屏，用户不必在聊天与结果之间迷路。 |
| 2 | Agent log + Running / waiting for feedback + Live Preview（`O`） | 良好 | 运行事实和可操作产物同框；暂停明确等待用户。 |
| 3 | failed checkpoint + paused + Resume（`O`，Replit Community 一手故障画面） | 良好但高密度 | 失败没有伪装完成；用户能看到失败对象、已做工作和恢复入口。 |
| 4 | Checkpoint + Changes + Rollback + effort evidence（`O`，Replit 官方 blog 画面） | 很好 | 恢复点绑定具体变更；这正是现有 6 个参考缺少的语法。 |

截图可见的风险：字号和行密度高，移动端不能照搬；紫色 Running、绿色完成和多种小图标需要文字 / 形状冗余；截图不能证明键盘、焦点、读屏、取消 race 或 rollback 原子性。

### 4.4 Take / Adapt / Refuse

**Take**

1. Plan 是独立可审阅对象，显示 Done 和 Out of scope。
2. 主对话负责方向，后台 Task thread 负责隔离执行。
3. Ready 后先看 work log、tests、Artifact，再 Apply / Dismiss。
4. Checkpoint 同时提供变更证据和恢复动作。

**Adapt**

1. `Task` 转译为 Chat 的 Work / Action / Product Run，不复制 Replit 术语。
2. isolated copy 转译为候选 Artifact / Attempt；只有 Product Commit 才写回正式事实。
3. checkpoint 绑定 Product revision、Decision 和 Evidence；不能直接暴露 Git commit 作为所有场景的恢复模型。
4. Task board 在手机改成单列状态入口，不缩放 IDE。

**Refuse**

1. 不把 IDE 多栏壳层当 Chat 全局首页。
2. 不把“代码运行 / 测试通过”自动当 Work 或 Project 完成。
3. 不允许 Cancel 无证据地丢弃已执行路径；Chat 必须保留 Attempt / Trace / partial Artifact。
4. 不用 effort / cost 数字替代结果质量或 Evidence。

### 4.5 与现有参考的区别

- **vs Microsoft Agent Feed**：Feed 是跨 Agent 例外队列；Replit 是单一目标从 Plan 到 Artifact 的连续工作 session。
- **vs Linear**：Linear 只有 Update candidate；Replit 的 Plan、Task、Run、Preview、Apply / Dismiss、Checkpoint 是完整链。
- **vs Heptabase**：Heptabase 有 context 与可保存 AI candidate；Replit 有具状态的后台 Task、测试、写回门和恢复点。

### 4.6 最小参考原型路径与可行性

若用户选择 Replit，后续原型最小路径应为：

```text
对话提出目标
→ Agent 澄清 1 次
→ Plan v1（目标 / 假设 / 范围 / Done / Out）
→ 用户删改步骤并批准 v2
→ 3 个 Task：queued / running / waiting
→ Artifact preview + Evidence
→ 用户评论中间产物
→ 1 个 Task failed，选择修订或从 checkpoint 恢复
→ Review → Accept / Reject → 正式交付
```

资料最完整，交互对象清楚，桌面与移动可分别转译；实现可行性为 **高**。后续只能制作独立参考原型，不能复制 Replit 代码或品牌资产。

## 5. B｜最终候选 2：Manus

### 5.1 定位、用户场景与 UI

- **定位**：通用个人云计算 Agent；Task、Computer、Files、Project knowledge、Collab 和 Wide Research 共享一套任务空间。
- **主要场景**：用户把研究、浏览器操作、文档、数据、设计或应用任务交给 Manus；它在云端长时间运行，可离开页面、回来看进度、发送中途指令或接管验证；团队可进入同一 Task 共创。
- **UI 风格**：比 IDE 更像聊天任务页；主列是对话 / 动作日志，右侧是 Manus's Computer / Editor / Artifact，底部保持可打断的消息框和停止键。

### 5.2 核心交互语法

```text
Goal + attachment / Project knowledge
→ Agent announces plan / creates todo.md
→ Task progress n / N
→ tool chips + Computer / Editor live surface
→ background continue + notification
→ user sends correction | Stop | Take Over
→ hand control back
→ files / report / app
→ Collab participants refine in the same Task
→ optional Wide Research subagents → synthesized result
```

用户通过补充文件、Project instruction、运行中消息、Stop、Take Over、协作者 prompt 和结果修订影响 Agent。Agent 通过 Tool chip、todo、Task progress、Computer live view、subtask status、attached files 和完成通知反馈工作状态。

### 5.3 截图路径审计

| Step | 画面与证据 | 健康度 | 结论 |
|---:|---|---|---|
| 1 | 原始自然语言目标 → “make a plan first” → browsing → Markdown output（`O`，一手任务画面） | 良好 | 目标、当前步骤、工具和交付在同一 thread；但 Plan 审批不明显。 |
| 2 | Editor + todo.md + `Task progress 2/8` + Thinking（`O`，真实 replay 画面） | 很好 | 用户同时看“产物正在怎样变化”和“任务做到哪一步”。 |
| 3 | background / can send messages / modify or stop + visible stop control（`O`，一手带注释画面；行为由 Cloud Browser docs 复核） | 良好 | 长任务允许离开和中途改向；视觉证据有第三方注释，不能作为像素参考。 |
| 4 | Wide Research `15/20` + 每个 subtask 的 finished / running 状态 + shared table（`O`） | 很好 | 多 Agent 不是头像列表，而是可展开的子任务与共同交付。 |

截图可见的风险：任务日志会变成长滚动；普通 Plan 没有统一的 Review / Approve 门；subagent 数量大时需要异常优先级；浅灰小字和进度状态不能只靠颜色。截图不能证明断线恢复、write idempotency、冲突处理或 Collab 的细粒度权限。

### 5.4 Take / Adapt / Refuse

**Take**

1. Task progress 与 Computer / Editor 同屏。
2. 后台继续、完成通知、运行中追加消息和 Stop。
3. Take Over 完成人类验证后交还 Agent。
4. Project instruction / knowledge、task-private、owner-controlled Collab 与 Wide Research subtask。

**Adapt**

1. todo 必须先成为版本化 Plan candidate，高影响任务不能边计划边执行。
2. Computer / tool log 只投影可观察动作，不显示隐藏推理。
3. Collab 的 prompt history 转译为 Participant / Contribution / Decision，不让所有人随意改同一正式事实。
4. Files / App / Report 进入 Artifact candidate，正式 Evidence 另有验证门。

**Refuse**

1. 不把“一个 Task link / one workspace”当全部产品事实源。
2. 不让 Project master instruction 以不可见 prompt 形式覆盖用户规则和版本。
3. 不让数十 / 数百子 Agent 自动扩大资料、权限或写回范围。
4. 不把 “completed” 或文件生成等同于 Product Commit。

### 5.5 与现有参考的区别

- **vs Microsoft Agent Feed**：Feed 在工作之外监督异常；Manus 的 Agent、Computer、Task progress 和 Artifact 在同一连续任务里。
- **vs Linear**：Linear 只允许 Agent 起草 Update；Manus 允许人在运行中改目标、停止、接管和继续。
- **vs Heptabase**：Heptabase AI Chat 没有耐久 Agent / Run；Manus 有后台 Task、工具 surface、Take Over、Collab 和 subagents。

### 5.6 最小参考原型路径与可行性

若用户选择 Manus，后续最小路径应为：

```text
Project 内提出目标 + 选择资料
→ Plan candidate / todo
→ 用户批准后后台运行
→ Computer / Editor + Task progress
→ 用户离开再回来
→ Agent 请求 Take Over / 补充信息
→ 用户交还控制
→ 2 个 subagent 并行 + 1 个等待
→ Artifact / sources
→ 单人接受，或邀请协作者评论后接受
```

通用场景、Participant / Visibility 和多 Agent 证据最强；Plan gate 与恢复语义需要 Chat 自己补。实现可行性为 **高**。

## 6. B｜最终候选 3：Microsoft Researcher with Computer Use

### 6.1 定位、用户场景与 UI

- **定位**：Microsoft 365 Copilot 内的企业研究 Agent，使用 Work IQ / Web / SharePoint / Email 等来源，并可启动隔离虚拟电脑完成需要真实网页操作的研究。
- **主要场景**：准备客户会议、行业趋势、阅读列表和带组织资料的报告；必要时登录 gated content、运行浏览器 / 终端，最后编辑、分享或转成 Presentation / Document。
- **UI 风格**：Fluent 白色工作壳；入口是大 prompt + Computer Use / Sources；运行期用 Activity / References，结果是文档式长报告。

### 6.2 核心交互语法

```text
Research goal
→ optional clarification
→ Sources：Web / Work / SharePoint / Email / Meetings
→ Computer Use
→ Activity：已完成步骤 + 当前研究步骤
→ confirmation for sign-in / sensitive action
→ cited report
→ edit / share / create presentation or document
```

用户通过自然语言目标、回答澄清、来源开关、组织策略、登录确认和后续编辑影响 Agent。Agent 通过 source summary、Activity / References、Visual Browser / Text Browser / Terminal 和报告引用反馈工作过程。

### 6.3 截图路径审计

| Step | 画面与证据 | 健康度 | 结论 |
|---:|---|---|---|
| 1 | Researcher 首页 + Computer Use + Sources +历史报告（`O`，Microsoft 官方 2026 图） | 很好 | 用户在发出目标前能看见能力和资料边界。 |
| 2 | Activity checklist + References（`O`，真实产品画面；当前行为由官方帮助复核） | 一般到良好 | 可看见已完成 / 当前步骤，但不等于可修订 Plan。 |
| 3 | Sources 面板：Web / Work / SharePoint / Email / Meetings（`O`，Microsoft 官方图） | 很好 | Context / visibility 是一等控件；仍缺逐对象和写回范围。 |
| 4 | structured cited report（`O`，Microsoft 官方图） | 良好 | 结果可读、可编辑、可分享，并能进入后续文档 / 演示。 |

官方文档说明敏感动作会请求确认，但当前公开资料没有捕获到确认 dialog、失败、暂停或恢复画面，因此不能把这些路径评为已视觉验证。截图中的浅灰、长行和小型 source controls 需要实测对比度、目标尺寸、键盘和读屏。

### 6.4 Take / Adapt / Refuse

**Take**

1. 在 prompt 前显式选择 Sources，并在运行 / 报告中继续可见。
2. Computer Use 是明确模式，不把工具藏在普通聊天里。
3. Activity 与 References 分层。
4. 敏感动作确认，报告可继续编辑 / 分享 / 转格式。

**Adapt**

1. Source toggle 升级为版本化 Context Package：采用、排除、理由、范围和预算。
2. Activity 前增加可修订 Plan 与用户批准门。
3. 报告先是 Artifact candidate，Evidence 和 Product Commit 分开。
4. 企业政策 / 权限拒绝要变成可理解、可恢复的产品状态。

**Refuse**

1. 不把 Work graph 的隐式相关性当用户已经选择全部上下文。
2. 不把“组织权限允许读”当本次任务应该读。
3. 不让 cited report 自动成为 Project Decision / Update。
4. 不复制 Microsoft Fluent 品牌皮肤或 Agent 左栏；场景价值不等于视觉主参考。

### 6.5 与现有参考的区别

- **vs Microsoft Agent Feed**：同品牌但不同问题。Agent Feed 是多个 Agent 的异步介入队列；Researcher 是一个目标在连续对话、来源、虚拟电脑和报告之间推进。
- **vs Linear**：没有负责人 Update 语法；它提供来源范围、工具环境和正式报告。
- **vs Heptabase**：两者都有显式 context；Researcher 额外有企业权限、虚拟电脑和敏感动作确认，但缺少 Heptabase 的可复用知识编排。

### 6.6 最小参考原型路径与可行性

若用户选择 Researcher，后续最小路径应为：

```text
选择 Project / Web / Files 来源
→ 提出研究目标
→ Agent 澄清 + Plan
→ 用户删改来源和步骤
→ Activity + Computer tool
→ permission / sign-in confirmation
→ 失败或等待人工
→ cited report
→ 编辑并转成正式 Artifact
```

官方视觉证据清晰，但完整 Plan / Run / recovery 需要较多 Chat 自有补全；实现可行性为 **中**。

## 7. C｜同屏比较

本轮已制作 `3 candidates × 4 states` 同尺度私有 contact sheet，行顺序固定为：

1. Goal / Plan
2. Run / Artifact
3. Intervene / Wait
4. Recover / Deliver

外部图不进入 Git；当前 Codex 选择门会直接渲染 contact sheet。对应来源：

| 候选 | Goal / Plan | Run / Artifact | Intervene / Wait | Recover / Deliver |
|---|---|---|---|---|
| Replit | [Plan / Build 官方文档](https://docs.replit.com/learn/plan-vs-build-mode) | [Project Editor](https://docs.replit.com/learn/projects-and-artifacts/project-editor) | [一手 failed checkpoint 画面](https://replit.discourse.group/t/agent-has-error-save-checkpoints/6681) | [Version control / checkpoint](https://docs.replit.com/learn/projects-and-artifacts/version-control) |
| Manus | [一手 Browser Operator 任务画面](https://www.testingcatalog.com/manus-ai-launches-browser-operator-extension/) | [一手 Task progress 画面](https://www.capcut.com/resource/manus-ai) | [Cloud Browser / Take Over](https://manus.im/docs/features/cloud-browser) | [Wide Research + replay](https://manus.im/docs/features/wide-research) |
| Researcher | [Computer Use 官方入口](https://support.microsoft.com/en-us/microsoft-365-copilot/media/researcher-computer-use-home-screen.png) | [Activity 真实画面及官方路径](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-with-researcher-in-microsoft-365-copilot) | [Sources 官方画面](https://support.microsoft.com/en-us/microsoft-365-copilot/media/researcher-with-computer-use.png) | [Report 官方画面](https://support.microsoft.com/en-us/microsoft-365-copilot/media/researcherreport.png) |

### 7.1 量化对照

| 标准 | Replit | Manus | Researcher |
|---|---:|---:|---:|
| 人—Agent 多轮闭环（25） | 23 | 24 | 21 |
| Plan / Run / Checkpoint / HITL（20） | 20 | 17 | 12 |
| Artifact / Evidence 连续性（15） | 15 | 14 | 13 |
| 长任务 / 暂停 / 恢复 / 错误（15） | 14 | 13 | 10 |
| Context / 权限 / 写回（10） | 8 | 10 | 10 |
| 移动 / 桌面可迁移（5） | 4 | 4 | 4 |
| 与现有 6 个互补（10） | 9 | 9 | 8 |
| **总分** | **93** | **91** | **78** |

分数是候选比较工具，不是自动选择。Replit 的优势来自闭环和恢复，Manus 的优势来自通用性、Collab 与多 Agent，Researcher 的优势来自上下文 / 权限可见性。

## 8. D｜推荐结论

### 首选：Replit Agent

选择 Replit 不是因为它功能最多，而是它最准确补上现有 6 个原型的共同断点：

```text
Plan candidate
→ 用户 Revise / Accept
→ Task state / dependency / queue
→ isolated execution
→ Artifact + work log + tests
→ Apply / Dismiss
→ Checkpoint / Rollback
```

这条链能直接回答用户提出的第 1～7、9 项问题；Context / Participant 由 Chat 自己和 Manus / Heptabase 已有证据补足。最大风险是把软件 IDE 语言误带进 Chat，因此后续原型必须只取交互语法，不取 IDE 壳层。

### 备选：Manus

如果更看重“通用生活 / 工作任务、一个人 + 多 Agent + 多个协作者、后台长时间运行和 Take Over”，Manus 更合适。它比 Replit 更接近 Chat 的长期产品方向，但普通任务缺少统一的 Plan 审批与 Checkpoint；后续原型需要 Chat 补的关键语义更多。

### 为什么第三候选和其余产品不优先

- **Microsoft Researcher**：Context / 权限 / 虚拟电脑值得借，但缺 Plan 修改和恢复闭环；同品牌 Agent Feed 已有参考，互补度低于前两名。
- **ChatGPT Work / Deep Research**：能力强，但当前 Work UI 证据不足；不能用已退役 agent mode 画面替当前版本。
- **Devin**：闭环强，但和 Replit 高度重复，Artifact / checkpoint / apply gate 的可迁移证据不如 Replit。
- **Gemini Deep Research**：Plan 与来源清楚，但仍是研究报告路径，运行期介入和错误恢复不足。
- **Claude**：Artifact 强，Run / Plan / Checkpoint 弱，并与 Heptabase AI context 有重复。
- **Perplexity**：Artifact / version history 强，Plan / Run / HITL 弱。
- **Genspark**：多 Agent 宣传强，当前可审核交互证据不足。

## 9. E｜用户选择门

当前仅等待用户从下面三项选择一个第 7 个参考项目：

1. Replit Agent
2. Manus
3. Microsoft Researcher with Computer Use

在用户明确选择之前，不创建 HTML / React 原型，不新增 UI，不写入 frozen 登记，不继续实现。

**候选与证据已经准备好，请用户选择第 7 个参考项目。**
