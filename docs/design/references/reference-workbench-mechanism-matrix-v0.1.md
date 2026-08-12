---
status: candidate
version: 0.1
date: 2026-08-12
scope: 6 frozen reference prototypes + 3 workbench samples
forbidden: 不选择第七参考项目，不修改生产 UI，不运行原型
---

# 参考工作台机制矩阵 v0.1

## 1. 目的与边界

本文档是 6 个冻结参考原型（Basecamp、Things、Linear、HEY Calendar、Microsoft Agent Feed、Heptabase）与 3 组新增工作台样本（AnythingLLM/Open Computer、Orca、Plane）的**工作台设计机制盘点**。

- 不选择第七个参考项目；不修改生产 UI；不运行原型；不推断截图未展示的交互状态。
- 用同一套工作台语言（6 层职责）描述 9 组机制，生成 3×3 同尺度视觉索引。
- 证据等级：`F` = 单个审计/证据卡直接记载的事实；`I` = 跨证据归纳；`U` = 当前未知/未覆盖。

## 2. 视觉索引

![九组工作台机制视觉索引](./evidence/reference-workbench-mechanism-index-v0.1.png)

**3×3 位置映射**：

| 位置 | 产品 | 来源类别 | 源图 |
|---|---|---|---|
| (0,0) | Basecamp | Chat 已冻结参考原型的已验收画面 | `basecamp-project-room-final-raw.png` |
| (0,1) | Things | Chat 已冻结参考原型的已验收画面 | `things-today-final-raw.png` |
| (0,2) | Linear | Chat 已冻结参考原型的已验收画面 | `linear-list-peek-final-raw.png` |
| (1,0) | HEY Calendar | Chat 已冻结参考原型的已验收画面 | `hey-day-final-raw.png` |
| (1,1) | Microsoft Agent Feed | Chat 已冻结参考原型的已验收画面 | `agent-feed-final-raw.png` |
| (1,2) | Heptabase | Chat 已冻结参考原型的已验收画面 | `heptabase-whiteboard-final-raw.png` |
| (2,0) | AnythingLLM / Open Computer | 既有官方/一手界面证据，非本地运行实例 | `06-open-computer-active-run-official-1280x720.png` |
| (2,1) | Orca | 既有官方/一手界面证据，非本地运行实例 | `03-diff-annotation.png` |
| (2,2) | Plane | 既有官方/一手界面证据，非本地运行实例 | `03a-github-overview.webp` |

**图例**：深绿色条（#2d5016）= 1–6 冻结原型；靛蓝色条（#4b0082）= 7–9 工作台样本。

**生成**：`scripts/design/build-reference-workbench-mechanism-index.sh`。当前 ffmpeg 无 drawtext filter，因此图内用类型色条区分来源类别，产品名由本表映射。

## 3. 基础工作台机制：六层职责（I）

所有 9 组工作台都能还原为 6 层职责（跨证据归纳），布局位置表达职责和注意力优先级：

1. **作用域/导航**：当前在什么范围（Account / Project / Workspace / Thread）。
2. **主工作表面**：页面中心由谁拥有。
3. **上下文副表面**：Peek / Sidebar / Pane / Sidecar，提供不离开主表面的参考信息。
4. **连续性/对象身份**：跨表面跳转时保持对象身份、revision、返回位置。
5. **人工检查点**：人在哪里介入（Complete / Accept / Reject / Annotate / Abort）。
6. **结果/Evidence 写回**：结果留在原上下文还是跳到独立页面。

基础骨架不是固定的"左/中/右"三栏模板，而是这 6 层职责的分配。真正差异在"谁拥有页面中心、谁保持连续性、人工在哪里介入、结果写回哪里"，不是主题色或侧栏宽度。

## 4. 九组主矩阵

| 组别 / 类型 | 页面中心 | 连续性 | 主要工作表面 | Agent / 自动化入口 | 人工介入 | 结果 / Evidence 写回 | 证据等级与链接 |
|---|---|---|---|---|---|---|---|
| **Basecamp** · 冻结机制 | Project Room；Account→Project→Tool→Item 四层作用域 | 对象层级：跨层跳转保持身份与返回位置 | Room 内 6 个 Tool + Item Detail | 不负责：无 Agent / HITL / Decision / Run | Item 评论、To-do Complete、Message Board 发帖；My bar 个人聚合 | Docs & Files、Message、附件；Activity 是投影，权威留在 Tool/Item | F · [audit](./basecamp-interaction-audit-v0.1.md) |
| **Things** · 冻结机制 | Today 投影：跨 Area/Project 的个人注意力投影，不是新容器 | 双轴正交：parent context × attention horizon | Today 列表（Calendar events → Daytime → This Evening）+ 原位展开 detail | 不负责：无 Agent / HITL / Decision | Checkbox Complete、When 改期、拖拽排序、Magic Plus、Quick Find | Logbook + Notes/Checklist；无 Resource/Evidence 系统 | F · [audit](./things-today-interaction-audit-v0.1.md) |
| **Linear** · 冻结机制 | Work List + Peek：列表扫描定位，Peek 临时理解 | 三档阅读速度：List→Peek→Detail，同一对象多表面一致 | Issue List/Board + Peek + Detail + Project Overview/Updates/Pulse | 部分覆盖：单 Agent 可起草 Update，人工 Publish；无多 Agent/Decision/Run | Peek Space/↑↓/Esc；Update composer 写 health+narrative 后 Publish | Project Update（author+health+narrative+observed changes）→ Updates history → Pulse | F · [audit](./linear-interaction-audit-v0.1.md) |
| **HEY Calendar** · 冻结机制 | 连续时间尺度：Day 连续故事 / Week 七天章节 / Year 季节轮廓 | 时间尺度递进：Day→Week→Year 主动减细节；Event/Habit/Journal/Sometime 类型区分 | Day 连续时间线 + Event composer（内嵌当天 Peek）+ Week/Year 切换 | 部分覆盖：Email→候选→冲突可见→改时间→Save/Cancel；无 Agent/Decision/Run | Event composer 拖拽排期、冲突同屏判断、Save/Cancel；Day 个人化 | Event 保存到所属 Calendar；Journal 自动保存；Email source link 保留 | F · [audit](./hey-calendar-interaction-audit-v0.1.md) |
| **MS Agent Feed** · 冻结机制 | 监督分流队列：Needs Attention + Completed，按是否需要介入分组 | 任务类型决定动作：request_assistance→Complete / data_entry→Accept+complete 或 Dismiss / review→仅信息 | Feed list（side pane / full screen）+ Agent filter + item detail | 覆盖：Decision 修订、candidate、outcome_unknown、Agent—Agent delegation 均有 typed action + owner + waiting + 终态 | Complete / Accept+complete / Dismiss / Reconcile / Escalate | Feed 只是投影；权威事实回 Product Run / Decision / Evidence / related record | F · [audit](./microsoft-agent-feed-interaction-audit-v0.1.md) · [freeze ledger](./reference-scenario-matrix-v0.1.md) |
| **Heptabase** · 冻结机制 | Card Library + Whiteboard placement：Card 属于 Library，Whiteboard 只拥有空间引用 | canonical object × placement 分离：编辑内容更新所有 placement；Card Info 列出所有 Board | Whiteboard 主画布 + 右侧 context sidebar + Card Library side panel | 部分覆盖：显式 context chips / Space search，访问日志 searched/viewed，回答先是 candidate | 手动添加上下文、拖动 AI response 到 Whiteboard / 保存为 Card、Share permission | Card 保存到 Card Library（权威源）；placement 保存 objectId+position+annotation | F · [audit](./heptabase-interaction-audit-v0.1.md) |
| **AnythingLLM / OC** · 工作台样本 | 两种模式：AnythingLLM = Conversation-owned；Open Computer = Workspace-owned（桌面中心，对话退到 sidecar） | AnythingLLM：Thread 保存上下文；OC：Run sidecar + 桌面现场保存状态 | AnythingLLM：消息流 + Sources 抽屉；OC：VNC 桌面 + sidecar（Chat/Subagents/Logs/Deliverables） | 自然语言 composer 发起；进度成为消息流中间节点或 sidecar 任务卡 | 继续回复/追问（AnythingLLM）；追问/Abort run（OC） | AnythingLLM：回答 + Sources；OC：桌面现场 + Deliverables（Download/Remove） | F · [evidence card](./anythingllm-workbench-evidence-card-v0.1.md) |
| **Orca** · 工作台样本 | Task/Worktree 隔离工作空间：主对象是任务空间，Chat/terminal 只是其中一种 pane | Worktree + pane tree + Agent sessions：布局按 worktree 保存，切换时整套恢复 | 异构 pane tree（terminal/editor/browser/diff/PR 嵌套分屏）+ 左侧 worktree/Agent 状态导航 | Agent 是可观察运行者：Working / Needs You / Done / Blocked / Idle | Diff 行级批注→批量选择接收 Agent→Send to agent；聚焦 pane；Abort/Retry | Diff 批注保留行锚点并持久化；修订后仍可 Resolve 或加入下一批复审 | F · [evidence card](./orca-workbench-evidence-card-v0.1.md) |
| **Plane** · 工作台样本 | Project / Work item / Page：长期工作事实拥有页面中心，AI 进入对象所在表面 | 长期对象及其状态：同一 Work item 集合可切换 5 种布局，身份与筛选连续 | 产品级 Rail → Workspace/Project 侧栏 → Project 内导航 → Work items 主工作面 + Page 编辑器 + Intake | 部分覆盖：3 种 AI 作用域（全局/页面/块级）；开源源码只确认 Page 编辑器 AI | Intake 队列：Accept（先编辑再加入）/ Decline（不可撤销）/ Snooze | Work item 状态写入 Project；AI Block 成为可编辑 Page block；Intake Accept 写入 Work item | F · [evidence card](./plane-workbench-evidence-card-v0.1.md) |

## 5. 差异矩阵

| 组别 | 最强可迁移机制 | 服务场景 | 明确缺口 |
|---|---|---|---|
| Basecamp | 四层作用域 + 个人入口布局与权威事实分离 | 多 Project 持续推进 | 无 Agent/HITL/Decision/Iteration/Scope/Evidence 验证 |
| Things | parent context × attention projection 双轴 + Today 来源副标题 + This Evening 软分层 | Today / 个人节奏与长期 Project 正交 | 单用户；无团队 room / 负责人 Update / 共享权限 / consent |
| Linear | List/Peek/Detail 三档阅读 + 负责人署名 Update + "未更新"作监督信号 | Work 多档阅读速度 | 无 Today/日程节奏；Issue ≠ Stage/Work/Scope/Action 通用替身 |
| HEY Calendar | Day/Week/Year 三尺度递进 + 创建时同屏冲突判断 + 颜色表达来源 | 连续时间尺度与时间承诺 | 不负责 Project/Work/Run 状态；Habit 完成 ≠ Project 进度 |
| MS Agent Feed | 风险优先类型化监督 + candidate→revision/hash→Decision→Run resume 状态机 + outcome_unknown 拒绝 Retry | 多 Agent / HITL / 运行异常 | Feed 不是事实源；无 Project 目标/阶段/持续推进 |
| Heptabase | canonical object × placement 分离 + 主表面+context sidebar + 显式 AI context/provenance | 知识资料收集、关联、编排与复用 | 无 Project 生命周期/Update；Space search 只能整个 Space 开关 |
| AnythingLLM / OC | "谁拥有页面中心"作为首要决定 + Conversation/Workspace 两种模式 + Deliverable 现场交付 | 对话型 Agent 工作区 + 电脑式执行工作面 | 无 Plan 审核/版本绑定；无 Pause/Resume/失败恢复；无 Artifact 评论修订闭环 |
| Orca | Artifact 锚定反馈（行级批注→批量交回指定 Agent）+ 异构 pane tree + Agent 状态嵌任务行 | 多 Agent 监督、Artifact 评审、可恢复工作面 | coding-only；无自然语言 Plan；无产品级 Run 终态；无非 coding 闭环 |
| Plane | Work-object-owned shell + 同一对象多布局切换 + 独立 Intake 审核队列 | 长期项目推进、结构化协作、知识沉淀 | 无 Agent Plan/Run/暂停恢复；无 Artifact Diff 版本绑定；无多 Agent visibility |

## 6. 八种工作台所有权模式（I）

| 模式 | 代表 | 页面中心 | 连续性 | 人工介入 | 结果写回 |
|---|---|---|---|---|---|
| Conversation-owned | AnythingLLM | 对话 | Thread 保存上下文 | 继续回复、追问 | 回答 + Sources |
| Room-owned | Basecamp | Project Room | 对象层级 | Item 评论、To-do Complete | Docs & Files、Message |
| Attention/time projection | Things / HEY | Today 投影 / 时间尺度 | 双轴正交 / 时间递进 | Checkbox / Event composer | Logbook / Calendar Event |
| Work-list-owned | Linear | Work List + Peek | 三档阅读速度 | Peek 预览、Update composer | Project Update → Pulse |
| Supervision-feed-owned | MS Agent Feed | 监督分流队列 | 任务类型决定动作 | Complete/Accept/Dismiss/Reconcile | 权威事实回 Product Run/Decision |
| Knowledge-canvas-owned | Heptabase | Card Library + Whiteboard | canonical × placement | 手动上下文、拖动 AI response | Card 保存到 Library |
| Task/workspace-owned | OC / Orca | 桌面 / 任务隔离空间 | Worktree + pane tree | Abort / Diff 批注 / 聚焦 Agent | 桌面现场 / Diff 持久化 |
| Work-object-owned | Plane | Project / Work item / Page | 长期对象及其状态 | Intake Accept/Decline | Work item 状态 / Page block |

真正差异在"谁拥有页面中心、谁保持连续性、人工在哪里介入、结果写回哪里"，不是主题色或侧栏宽度。

## 7. 证据边界与未知

### 7.1 跨九组共同缺口（U）

已在 [reference-scenario-matrix-v0.1.md](./reference-scenario-matrix-v0.1.md) §6.1 登记：

1. **完整 Project 对象链**：无原型同时拥有 Stage→Milestone→Iteration→Work→Scope→Action→Update→Gate→Decision。
2. **跨表面连续性**：无原型证明同一 Work 在 Project Room / Today / Agent Feed / Workbench 间往返仍保持身份、revision、返回位置和未提交草稿。
3. **正式 Evidence**：无原型能直接背书 Chat 的 Evidence 验证、版本、贡献归属与完成门。

### 7.2 新增三组样本中的四种模式特定缺口（U）

| 样本 | 未证明 |
|---|---|
| AnythingLLM | Plan 审核/版本绑定；Pause/Resume/失败恢复；Artifact 评论修订接受拒绝闭环 |
| Open Computer | 同上 + Deliverable 只有 Download/Remove，无评论/修订 |
| Orca | 非 coding 场景闭环；产品级 Run 终态；participant/visibility |
| Plane | Agent Plan/Run/工具调用；Artifact Diff 版本绑定；多 Agent participant/visibility |

### 7.3 视觉索引特定边界

1. **无失败/等待/恢复状态截图**（U）：九组现有截图均未明确展示这三种状态。这是证据缺口，不得推断。
2. **AnythingLLM/OC 单格**（I）：(2,0) 只用 Open Computer active run 截图代表 workspace-owned；AnythingLLM conversation-owned 证据在该组证据卡其它截图（02-05），单格不声称覆盖全部细节。
3. **1–6 vs 7–9 来源**（F）：1–6 是 Chat 已冻结参考原型的已验收画面；7–9 是既有官方/一手界面证据，不是本地运行实例。

## 8. 可复现视觉清单

| # | 产品 | 源图路径 | 实测尺寸 | SHA-256 | 来源类别 |
|---|---|---|---|---|---|
| 1 | Basecamp | `docs/design/combination-prototypes/evidence/stage1/visual-compare/basecamp-project-room-final-raw.png` | 1920×1200 | `266c6f00871889c46c43c0e03113d6d181141748a3abd823e1dcae790d5a0e1a` | Chat 已验收画面 |
| 2 | Things | `docs/design/combination-prototypes/evidence/stage1/visual-compare/things-today-final-raw.png` | 1920×1200 | `303d041cda0776b66e7209a6b8ed9452f3c487ec23bc5ba2b2221525920ae4cb` | Chat 已验收画面 |
| 3 | Linear | `docs/design/combination-prototypes/evidence/stage1/visual-compare/linear-list-peek-final-raw.png` | 1920×1200 | `1e3b4ef44bbf6177a2529fd95dcc6caffb91de05f0f27dcd80beb5c09c849351` | Chat 已验收画面 |
| 4 | HEY Calendar | `docs/design/combination-prototypes/evidence/stage1/visual-compare/hey-day-final-raw.png` | 1920×1200 | `f010a0d6a7967dae07d0ce86de01bb125bdbd2bcaa41102a2f05558c5c7fb43a` | Chat 已验收画面 |
| 5 | MS Agent Feed | `docs/design/combination-prototypes/evidence/stage1/visual-compare/agent-feed-final-raw.png` | 1920×1200 | `01957d57ea7f80d1d8c788b67386466e84a18e8607e292b31e68fc10f49d983d` | Chat 已验收画面 |
| 6 | Heptabase | `docs/design/combination-prototypes/evidence/stage1/visual-compare/heptabase-whiteboard-final-raw.png` | 1920×1200 | `d4992e800f94aeacb4de4ed8fc87faeeb9cb0190af6f1a76c837cf25c3e0cecf` | Chat 已验收画面 |
| 7 | AnythingLLM / OC | `docs/design/references/evidence/anythingllm-v0.1/screenshots/06-open-computer-active-run-official-1280x720.png` | 1280×720 | `5f4259c3b0f492a7a5423d5b336431d1709b96c3bde587d1560212fee608ffda` | 官方界面证据 |
| 8 | Orca | `docs/design/references/evidence/orca-v0.1/screenshots/03-diff-annotation.png` | 960×541 | `fcd5862e375cc2973ab6144a9c1c6887bdbb7ddee773a34c394dc1e2f51f0d9d` | 官方界面证据 |
| 9 | Plane | `docs/design/references/evidence/plane-v0.1/screenshots/03a-github-overview.webp` | 3240×2112 | `dfe2f6cb2e03dbfaeebe23ebd7c3092c05c59abc1e7c579bc90bf924fca81ba7` | 官方界面证据 |

视觉索引输出：`docs/design/references/evidence/reference-workbench-mechanism-index-v0.1.png`（2400×1620）。生成脚本：`scripts/design/build-reference-workbench-mechanism-index.sh`。

## 9. 当前停点

工作台基础机制与差异已盘点。没有选择第七参考项目，没有制作原型。下一步必须由用户决定继续扩大样本还是进入候选筛选。
