---
status: candidate
version: 0.1
date: 2026-08-12
scope: 9 项工作台研究的分类、比较与查表总报告
evidence: 9 份单项研究卡 + 2 份总矩阵 + 9 张视觉证据
---

# 九项工作台研究与分类报告 v0.1

> 本报告是 9 项工作台研究的汇总，用于以后设计 Chat 工作台时按场景查表。它不是 9 份摘要的拼接，而是分类、比较和查表工具。证据标记：`F` = 已批准审计/矩阵/冻结登记中的事实；`O` = 对既有画面的可见观察；`I` = 跨证据归纳；`U` = 当前未知/未验证。

## 1. 结论先行

九项研究不是九种皮肤，而是**五类主要场景 + 一组通用工作台骨架**。

**五类主要场景**（分类非互斥，每项一个主类别 + 可重叠的跨场景能力标签）：

1. **长期项目 / 工作对象**：Basecamp（Room-owned）、Linear（Work-list-owned）、Plane（Work-object-owned + Intake）。
2. **个人注意力 / 时间**：Things（Today projection-owned）、HEY Calendar（Time-scale-owned）。
3. **对话 / Agent 执行**：AnythingLLM（Conversation-owned）、Open Computer（Workspace-owned）。
4. **多 Agent 监督 / HITL**：Microsoft Agent Feed（Supervision-feed-owned）、Orca（Task/workspace-owned + Artifact review）。
5. **知识 / Artifact / Evidence**：Heptabase（Knowledge-canvas-owned）。

**通用工作台骨架**：所有 9 项都可以还原为 6 层职责（作用域/导航、主工作表面、上下文副表面、对象身份/连续性、人工检查点、结果/Evidence 写回），差异在"谁拥有页面中心、谁保持连续性、人工在哪里介入、结果写回哪里"，不是主题色或侧栏宽度。

**核心发现**：不需要一种永久三栏布局；应先决定当前任务由哪个主对象拥有页面中心。不同工作面可切换，但 Product object identity、Run、Decision、Artifact、Evidence 的事实所有者不能随布局改变。

## 2. 九项同屏视觉索引

![九组工作台机制视觉索引](./evidence/reference-workbench-mechanism-index-v0.1.png)

**3×3 位置映射**：

| 位置 | 产品 | 来源类别 | 页面中心所有者 |
|---|---|---|---|
| (0,0) | Basecamp | Chat 冻结参考原型已验收画面 | Room-owned |
| (0,1) | Things | Chat 冻结参考原型已验收画面 | Attention/time projection-owned |
| (0,2) | Linear | Chat 冻结参考原型已验收画面 | Work-list-owned |
| (1,0) | HEY Calendar | Chat 冻结参考原型已验收画面 | Time-scale-owned |
| (1,1) | MS Agent Feed | Chat 冻结参考原型已验收画面 | Supervision-feed-owned |
| (1,2) | Heptabase | Chat 冻结参考原型已验收画面 | Knowledge-canvas-owned |
| (2,0) | AnythingLLM / OC | 官方/一手界面证据，非本地运行 | Conversation-owned / Workspace-owned |
| (2,1) | Orca | 官方仓库逐帧抽取，非本地运行 | Task/workspace-owned |
| (2,2) | Plane | 官方视觉 + 部分开源源码，非本地完整运行 | Work-object-owned |

**来源边界**：
- **1–6（上两行）**：Chat 冻结参考原型的已验收画面，已在各自 worktree 中实际运行并通过 QA。
- **7–9（第三行）**：官方/一手界面证据，非本地运行实例。静态图只证明结构，不冒充完整交互路径。

## 3. 五类主要场景

### 3.1 长期项目 / 工作对象

| 维度 | Basecamp | Linear | Plane |
|---|---|---|---|
| **用户问题** | "我在哪个范围、下一件事在哪里" | "怎样快速扫描又不丢深度" | "AI 怎样进入工作对象所在表面" |
| **主表面** | Project Room（Room-owned） | Work List + Peek（Work-list-owned） | Project / Work item / Page（Work-object-owned） |
| **代表项目** | Account → Project → Tool → Item 四层作用域 | List → Peek → Detail 三档阅读速度 | Rail → 侧栏 → Project 内导航 + 5 种布局 |
| **人工介入** | Item 评论、To-do Complete | Peek 预览、Update composer | Intake Accept/Decline/Snooze |
| **结果写回** | Docs & Files、Message 留在 Room | Project Update → Updates history → Pulse | Work item 状态写入 Project |
| **适合借鉴** | 多 Project 地点骨架 + 对象下钻 | 多档阅读 + 负责人署名 Update | 长期对象中心 + 多布局 + Intake 审核 |
| **不能证明** | Agent/Plan/Run/Evidence 验证 | 耐久 Agent/Plan/Run/完整 HITL | Agent Plan/Run/Artifact Diff 版本绑定 |

### 3.2 个人注意力 / 时间

| 维度 | Things | HEY Calendar |
|---|---|---|
| **用户问题** | "今天真正要做什么，怎样不丢长期语境" | "时间怎样被阅读，时间承诺怎样从来源进入日历" |
| **主表面** | Today 投影（Attention/time projection-owned） | Day/Week/Year 连续时间线（Time-scale-owned） |
| **代表项目** | parent context × attention horizon 双轴正交 | Day 连续故事 / Week 七天章节 / Year 季节轮廓 |
| **人工介入** | Checkbox Complete、When 改期、This Evening | 拖拽排期、冲突同屏判断、Save/Cancel |
| **结果写回** | 完成 → Logbook；改期 → 新 start date | Event 保存到所属 Calendar；source link 保留 |
| **适合借鉴** | Today 个人节奏与长期 Project 正交 | 连续时间尺度 + 创建时同屏冲突判断 |
| **不能证明** | Agent/Plan/Run/HITL/Evidence/共享权限 | Agent/Plan/Run/工具调用/Evidence 完成门 |

### 3.3 对话 / Agent 执行

| 维度 | AnythingLLM | Open Computer |
|---|---|---|
| **用户问题** | "Agent 在做什么，结果在哪里" | "Agent 正在什么环境里做事" |
| **主表面** | 中央对话消息流（Conversation-owned） | 桌面/浏览器/文件现场（Workspace-owned） |
| **代表项目** | Workspace/Thread → composer → answer → Sources | 桌面现场 + Chat/Subagents/Logs sidecar |
| **人工介入** | 继续回复、继续提问 | 追问、观察、Abort run |
| **结果写回** | answer + Sources（可引用、可继续追问） | 桌面现场 + Deliverables（Download/Remove） |
| **适合借鉴** | "谁拥有页面中心"是首要决定 | Workspace 模式保留主工作表面 |
| **不能证明** | Plan 审核/版本绑定/Pause/Resume/Artifact 评论闭环 | 同左 + 正式 Evidence/Decision/产品写回 |

### 3.4 多 Agent 监督 / HITL

| 维度 | MS Agent Feed | Orca |
|---|---|---|
| **用户问题** | "哪些 Agent 现在需要我介入，风险与后果是什么" | "多 Agent 怎样进入同一任务空间，人怎样在 Artifact 上批注" |
| **主表面** | Needs Attention + Completed 监督分流队列（Supervision-feed-owned） | Worktree/task workspace + 异构 pane tree（Task/workspace-owned） |
| **代表项目** | 任务类型决定动作；outcome_unknown 拒绝 Retry | worktree 行内 Agent 状态 + diff 行级批注→批量交回 |
| **人工介入** | Complete / Accept+complete / Dismiss / Reconcile / Escalate | 聚焦 Agent、行级批注、批量发回指定 Agent |
| **结果写回** | 动作写回权威 Product Run/Decision/Evidence；Feed 重新投影 | diff notes 行锚点持久化 + 工作空间布局恢复 |
| **适合借鉴** | 风险优先类型化监督 + outcome_unknown 语法 | 任务隔离 + Artifact 锚定反馈回路 |
| **不能证明** | 生产耐久执行 + 完整 Project 生命周期 | coding-only + 无自然语言 Plan + 无产品级 Run 终态 |

### 3.5 知识 / Artifact / Evidence

| 维度 | Heptabase |
|---|---|
| **用户问题** | "资料怎样收集、关联、编排与复用" |
| **主表面** | Card Library + Whiteboard placement（Knowledge-canvas-owned） |
| **代表项目** | canonical object × placement 分离 + 显式 AI context/provenance |
| **人工介入** | 显式上下文 chips、拖动 AI response 到 Whiteboard / 保存为 Card |
| **结果写回** | Card 保存到 Library（权威源）；placement 保存 objectId+position+annotation |
| **适合借鉴** | 知识工作台 + 同一对象跨 Board 复用 + AI 访问日志 |
| **不能证明** | Project 生命周期/Update + 耐久 Agent/Plan/Run/任务闭环/正式 Evidence 验证 |

## 4. Agent 参与程度谱系

同一项目可跨级，不要因为有 AI 按钮就称为耐久 Agent。

| 级别 | 定义 | 代表项目 | 说明 |
|---|---|---|---|
| **L0 无 Agent** | 纯人工操作的项目管理/日历工具 | Basecamp、Things；HEY 的 source→Event candidate 也不是 Agent | 没有 Agent 身份、Plan/Run/Checkpoint |
| **L1 AI 辅助 / candidate** | 有 AI 生成内容，但无耐久 Agent Run | Linear（Agent 起草 Update candidate）、Heptabase（AI answer 是 candidate）、Plane（AI 进入 Page） | AI 输出是候选，人工采纳后才成为承诺 |
| **L2 Agent 执行工作台** | Agent 在执行任务，工作台呈现执行过程 | AnythingLLM（对话型）、Open Computer（电脑式）、Orca（任务隔离型） | Agent 是工作空间里的可观察运行者 |
| **L3 多 Agent 监督 / HITL** | 多个 Agent 并行工作，人需要介入 | MS Agent Feed（类型化监督队列）、Orca（多 Agent + Artifact review） | 任务类型决定动作；outcome_unknown 拒绝 Retry |

**关键边界**：
- HEY Calendar 的 Email→Event candidate 只是从来源创建 Event 的便捷路径，不是有身份耐久 Agent。
- Linear 的 Agent 起草 Update 必须标记来源，人工 Publish 后才成为项目承诺。
- Orca 跨 L2 和 L3：既是 Agent 执行工作台（L2），又是多 Agent 监督（L3）。

## 5. 基础通用骨架：六层职责

所有 9 项都可以还原为 6 层职责。布局位置表达职责和注意力优先级，不是固定的"左/中/右"模板。

| 层 | 基础机制 | 九项怎样变化 | Chat 以后设计时需守住的边界 |
|---|---|---|---|
| **1. 作用域/导航** | 当前在什么范围（Account / Project / Workspace / Thread） | Basecamp 四层；Linear Workspace→Project；Plane 三级 Rail；Things 双轴；HEY Day/Week/Year；Agent Feed Agent filter；Heptabase apps/tabs；AnythingLLM Workspace/Thread；Orca worktree 导航 | 范围切换不改变对象所有权；导航层级与工作范围相互对应 |
| **2. 主工作表面** | 页面中心由谁拥有 | Room / Today / Work List / Time Scale / Feed / Canvas / Conversation / Workspace / Task Workspace 九种不同所有者 | 先决定当前任务由哪个主对象拥有页面中心；不同工作面可切换，但事实所有者不能随布局改变 |
| **3. 上下文副表面** | Peek / Sidebar / Pane / Sidecar，提供不离开主表面的参考信息 | Linear Peek；Heptabase context sidebar；Agent Feed item detail；Orca pane tree；AnythingLLM Sources drawer；OC sidecar | 副表面不复制主表面事实；关闭后恢复入口焦点与滚动 |
| **4. 对象身份/连续性** | 跨表面跳转时保持对象身份、revision、返回位置 | Basecamp 对象层级；Things 双轴正交；Linear 三档一致；Heptabase canonical×placement；Orca worktree 持有连续性 | 同一 Work 在不同投影间往返仍保持身份、revision、返回位置和未提交草稿 |
| **5. 人工检查点** | 人在哪里介入（Complete / Accept / Reject / Annotate / Abort） | Things checkbox；HEY Save/Cancel；Agent Feed typed actions；Orca diff notes；Plane Intake；Heptabase 拖动保存 | 高影响决定使用版本、hash、权限和幂等校验；outcome_unknown 拒绝普通 Retry |
| **6. 结果/Evidence 写回** | 结果留在原上下文还是跳到独立页面 | Basecamp 留在 Room；Linear → Updates history；Agent Feed 写回权威对象；Heptabase → Library；Orca diff notes 持久化；Plane → Work item 状态 | Feed/Today/Canvas 都是投影，不是事实源；正式 Evidence 验证、版本、贡献归属必须由 Chat 自己的合同补足 |

## 6. 真正有差异的特性机制

差异在"谁拥有页面中心、谁保持连续性、人工在哪里介入、结果写回哪里"，不是主题色或侧栏宽度。

| 机制 | 代表项目 | 为什么存在 | Chat 可借鉴 | Chat 应拒绝 |
|---|---|---|---|---|
| **Room** | Basecamp | Project 是长期协作地点，Tool 是 Room 内的固定插槽 | 多 Project 地点骨架 + 对象下钻 | 不把六宫格 Tool 当全局骨架 |
| **Today projection** | Things | Today 是跨 Project 的个人注意力投影，不是新容器 | parent context × attention horizon 双轴正交 | 不把所有对象 checkbox 化 |
| **List/Peek/Detail** | Linear | 三种阅读速度对应三种注意力强度 | 同一对象多表面身份一致 | 不把所有详情都做成右侧抽屉 |
| **Day/Week/Year** | HEY | 三个尺度回答不同问题，每次放大主动减少细节 | 连续时间尺度 + 创建时同屏冲突判断 | 不让 Calendar 拥有 Project |
| **Typed supervision feed** | Agent Feed | 任务类型决定动作，避免通用万能 CTA | 风险优先类型化监督 + outcome_unknown 语法 | 不让 Feed 成为事实源 |
| **Canonical object × placement** | Heptabase | 同一知识可进入多个思考语境，不复制 | 对象归 Product Store，Workbench 只拥有布局 | 不把位置/颜色/箭头当权威状态 |
| **Conversation-owned** | AnythingLLM | 对话是主对象，状态与 Evidence 紧贴消息 | "谁拥有页面中心"是首要决定 | 不把 token 数当充分进度 |
| **Workspace-owned** | Open Computer | 桌面是主对象，对话退到 sidecar | 保留主工作表面，Run/Logs 进入 sidecar | 不照搬固定 sidecar 宽度 |
| **Pane tree + diff notes** | Orca | 任务隔离空间是骨架，Chat/terminal 只是其中一种 pane | 异构 pane tree + Artifact 锚定反馈 | 不把 terminal 当 Agent |
| **Multi-layout + Intake** | Plane | 长期对象拥有中心，人工决定在进入下一阶段前集中处理 | 同一对象集合多布局 + Intake 审核队列 | 不把 Accept/Decline 当完整 HITL |

## 7. 场景 → 参考项目查表

| 场景 | 首要参考 | 补充参考 | 应借机制 | 不要误借的边界 |
|---|---|---|---|---|
| **Project room** | Basecamp | — | Account→Project→Tool→Item 四层作用域 | 不把六宫格当全局骨架 |
| **多 Project** | Basecamp | Linear, Plane | Folder/Search/Star 入口 + 跨项目聚合 | 不让 Everything 成为万能搜索 |
| **Today** | Things | — | parent context × attention horizon 双轴 | 不把所有对象 checkbox 化 |
| **Calendar** | HEY | — | Day/Week/Year 三尺度 + 创建时同屏冲突 | 不让 Calendar 拥有 Project |
| **工作列表与详情** | Linear | Plane | List/Peek/Detail 三档阅读 | 不把 Issue 当全部工作层级 |
| **负责人 Update** | Linear | — | 署名 + health/narrative/time + observed changes | 不让事件流冒充 Update |
| **多 Agent 看护** | Agent Feed | Orca | 任务类型决定动作 + outcome_unknown 语法 | 不让 Feed 成为事实源 |
| **异常 / HITL** | Agent Feed | Orca | revision/hash/scope 绑定 Decision | 不用普通 Retry 处理 outcome_unknown |
| **对话型 Agent** | AnythingLLM | — | Conversation-owned + Sources | 不把 token 数当充分进度 |
| **电脑式执行** | Open Computer | — | Workspace-owned + sidecar | 不照搬固定 sidecar 宽度 |
| **Artifact review** | Orca | — | diff 行级批注→批量交回指定 Agent | 不把 terminal 当 Agent |
| **白板 / 知识** | Heptabase | — | canonical×placement + 显式 context/provenance | 不把无限画布当默认首页 |
| **Task board** | Plane | Linear | 5 种布局切换 + 身份/筛选连续 | 不复制五套任务事实 |
| **多布局** | Plane | — | 同一 Product Store 查询，多布局投影 | 不为每种布局建立互不相认的事实 |
| **Intake** | Plane | Agent Feed | 独立审核队列 + 决定前展示关键属性 | 不把 Accept/Decline 当完整 HITL |

## 8. 跨场景能力标签

可重叠标签，用紧凑矩阵标九项覆盖。

图例：`●` = 该项的核心机制；`◐` = 有相关能力，但不是页面中心或不能单独完成该场景；`—` = 当前证据不覆盖。

| 标签 | Basecamp | Things | Linear | HEY | Agent Feed | Heptabase | AnythingLLM/OC | Orca | Plane |
|---|---|---|---|---|---|---|---|---|---|
| 多 Project 地点与导航 | ● | ◐ | ● | — | ◐ | ◐ | — | ◐ | ● |
| 个人注意力投影 | ◐ | ● | — | ◐ | — | — | — | — | — |
| 多档阅读 | — | — | ● | — | ◐ | — | ◐ | ◐ | ◐ |
| 时间承诺 | ◐ | ◐ | — | ● | — | — | — | — | ◐ |
| 类型化监督 | — | — | — | — | ● | — | ◐ | ● | ◐ |
| Artifact 锚定反馈 | ◐ | — | — | — | ◐ | ◐ | — | ● | ◐ |
| 知识编排 | ◐ | — | — | ◐ | — | ● | ◐ | — | ● |
| 显式 AI context | — | — | ◐ | — | ◐ | ● | ● | ◐ | ◐ |
| Intake 审核 | — | — | — | — | ◐ | — | — | — | ● |
| 工作空间布局恢复 | — | — | ◐ | — | — | ◐ | ◐ | ● | ◐ |
| 长期对象多布局 | — | — | ● | ◐ | — | ◐ | — | — | ● |

## 9. 九项共同仍缺

### 9.1 九项都未完整覆盖

1. **完整闭环**：goal → clarify → editable Plan → versioned confirm → Run/tool/subtasks → pause/resume/cancel → failure/outcome_unknown → Artifact review → formal Evidence → writeback。没有任何一项同时拥有全部环节。
2. **跨表面连续性**：同一 Work 在 Project Room / Today / Agent Feed / Workbench 间往返仍保持身份、revision、返回位置和未提交草稿。
3. **Memory/context/permission/writeback visibility**：上下文、记忆、权限和写回范围的可见表达。
4. **participant/visibility/Agent—Agent 责任**：用户—用户、用户—他人 Agent、Agent—Agent 的 visibility / consent / participant 合同。
5. **正式 Evidence 验证/贡献/完成门**：Evidence 验证、版本、贡献归属与完成门。
6. **移动端等价交互**：键盘/辅助技术/拖拽/焦点管理的移动端等价路径。

### 9.2 单个项目缺口（不在 9.1 中重复）

| 项目 | 特定缺口 |
|---|---|
| Basecamp | 无 Agent/Plan/Run/Evidence 验证 |
| Things | 无 Agent/HITL/Evidence/共享权限 |
| Linear | 无耐久 Agent/Plan/Run/完整 HITL |
| HEY | 无 Agent/Plan/Run/工具调用/Evidence 完成门 |
| Agent Feed | 不证明生产耐久执行 + 无完整 Project 生命周期 |
| Heptabase | 无 Project 生命周期/Update + 无耐久 Agent/Plan/Run |
| AnythingLLM/OC | 无 Plan 审核/版本绑定/Pause/Resume/Artifact 评论闭环 |
| Orca | coding-only + 无自然语言 Plan + 无产品级 Run 终态 |
| Plane | 无 Agent Plan/Run/Artifact Diff 版本绑定/多 Agent visibility |

## 10. 对 Chat 下一步的研究结论

以下结论是研究推论，不是设计稿。

1. **不需要一种永久三栏布局**。应先决定当前任务由哪个主对象拥有页面中心。Room / Today / Work List / Time Scale / Feed / Canvas / Conversation / Workspace / Task Workspace 是九种真正不同的所有者，不是同一种布局的九种皮肤。

2. **不同工作面可切换，但事实所有者不能随布局改变**。Project、Today、Calendar、Feed、Conversation、Workspace、Canvas 都是不同投影/表面，不能相互吞并。Product object identity、Run、Decision、Artifact、Evidence 的事实所有者必须由 Chat 自己的合同定义，不能借参考产品的外观假装已经成立。

3. **Feed / Today / Canvas 都不是事实源**。离开这些 projection 后，正式状态必须能由 Chat 的权威产品事实重新投影。

4. **Agent 参与程度是谱系，不是二元**。L0 无 Agent → L1 AI 辅助/candidate → L2 Agent 执行工作台 → L3 多 Agent 监督/HITL。不要因为有 AI 按钮就称为耐久 Agent。

5. **下一步若进入 Chat 工作台设计，应以场景组合与最小完整路径为输入**。本轮停在研究报告，不开始原型。

## 11. 证据索引

### 11.1 九份单项研究卡

| # | 研究卡 | 主场景类别 | 页面中心所有者 | 证据等级 |
|---|---|---|---|---|
| 1 | [basecamp-workbench-study-v0.1.md](./basecamp-workbench-study-v0.1.md) | 长期项目/工作对象 | Room-owned | F · audit + O · 冻结原型画面 |
| 2 | [things-workbench-study-v0.1.md](./things-workbench-study-v0.1.md) | 个人注意力/时间 | Attention/time projection-owned | F · audit + O · 冻结原型画面 |
| 3 | [linear-workbench-study-v0.1.md](./linear-workbench-study-v0.1.md) | 长期项目/工作对象 | Work-list-owned | F · audit + O · 冻结原型画面 |
| 4 | [hey-calendar-workbench-study-v0.1.md](./hey-calendar-workbench-study-v0.1.md) | 个人注意力/时间 | Time-scale-owned | F · audit + O · 冻结原型画面 |
| 5 | [agent-feed-workbench-study-v0.1.md](./agent-feed-workbench-study-v0.1.md) | 多Agent监督/HITL | Supervision-feed-owned | F · audit + F · matrix (v0.2) + O · v0.1 画面 |
| 6 | [heptabase-workbench-study-v0.1.md](./heptabase-workbench-study-v0.1.md) | 知识/Artifact/Evidence | Knowledge-canvas-owned | F · audit v0.2 + O · 冻结原型画面 |
| 7 | [anythingllm-workbench-study-v0.1.md](./anythingllm-workbench-study-v0.1.md) | 对话/Agent执行 | Conversation-owned / Workspace-owned | F · evidence card + O · 官方演示 |
| 8 | [orca-workbench-study-v0.1.md](./orca-workbench-study-v0.1.md) | 多Agent监督/HITL | Task/workspace-owned | F · evidence card + O · 官方仓库逐帧 |
| 9 | [plane-workbench-study-v0.1.md](./plane-workbench-study-v0.1.md) | 长期项目/工作对象 | Work-object-owned | F · evidence card + O · 官方视觉 |

### 11.2 两份总矩阵

| 矩阵 | 用途 | 证据等级 |
|---|---|---|
| [reference-workbench-mechanism-matrix-v0.1.md](./reference-workbench-mechanism-matrix-v0.1.md) | 9 项六层职责 + 8 种所有权模式 + 差异矩阵 | I（跨证据归纳） |
| [reference-scenario-matrix-v0.1.md](./reference-scenario-matrix-v0.1.md) | 6×7 事实场景矩阵 + 组合策略 + 缺口登记 | F（冻结登记）+ I |

### 11.3 静态截图限制

所有 9 张视觉证据都是静态帧，只证明布局结构存在，不冒充完整交互路径。具体限制：

- **不证明**：悬停、点击展开、拖拽排序、键盘导航、屏幕阅读器行为、完成动画、Reduce Motion 降级。
- **不证明**：失败/等待/恢复三种状态的完整交互路径。
- **不证明**：移动端等价交互（部分项目已登记 P1/P2 复用阻断）。
- **7–9 非本地运行**：AnythingLLM/OC、Orca、Plane 的截图来自官方/一手界面证据，不是 Chat 冻结原型的实际运行。

---

> 九项工作台研究与分类报告已完成；本轮停在研究结论，不制作原型。
