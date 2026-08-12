---
status: candidate
version: 0.1
date: 2026-08-12
scope: Plane 9/9 工作台单项研究
evidence: Plane 官方视觉 + 部分固定开源源码核对
---

# Plane 工作台单项研究 v0.1

> 本文是 9 项工作台研究集中 Plane 的单项研究卡。截图来自 Plane 官方视觉与当前一手资料，非本地完整运行实例。证据标记：`O` = 本卡对既有画面的可见观察；`F` = 已批准审计/矩阵中的冻结事实；`I` = 跨证据归纳；`U` = 当前未知/未验证。

## 1. 结论卡

| 维度 | 结论 | 证据 |
|---|---|---|
| 定位 | 长期工作事实拥有页面中心 + 独立 Intake 审核队列：解决"AI 进入工作对象所在表面，人工决定在对象进入下一阶段前集中处理" | F · evidence card §1, §4.1, §4.5 |
| 页面中心所有者 | **Work-object-owned**：长期 Project / Work item / Page 持有主工作面；AI 进入对象所在表面，不由聊天或 Run 替代对象事实 | F · evidence card §1, §4.1 |
| 最适合 Chat 的场景 | 长期项目推进、结构化协作、知识沉淀 | F · evidence card §5 Take |
| 最强可迁移机制 | 多级范围导航（产品级 Rail → Workspace/Project 侧栏 → Project 内导航）；同一 Work item 集合多布局切换（List/Kanban/Calendar/Spreadsheet/Gantt）；独立 Intake 审核队列 | F · evidence card §4.2, §4.3, §4.5 |
| 对人—Agent 工作台的主要缺口 | 无 Agent Plan/Run/暂停恢复；无 Artifact Diff 版本绑定；无多 Agent visibility；无正式 Evidence/Decision 产品写回 | F · evidence card §7; §5 Refuse |

## 2. 已检查画面

### 2.1 Project / Work item 拥有主工作面

![Plane Projects 工作台](./evidence/plane-v0.1/screenshots/03a-github-overview.webp)

**画面性质**：Plane 官方视觉与当前一手资料，非本地完整运行实例。静态图只证明结构。

**可见布局**（O）：

- **产品级 App rail**（最左侧）：icon-only 导航，包含 Projects、Views 等入口。
- **Workspace / Teamspace / Project 侧栏**：可伸缩、折叠的范围导航，当前选中 Project 可见。
- **Project 内导航**：Work items、Cycles、Modules、Views、Pages、Intake 等入口。
- **当前 Work items 主工作面**：按状态分组的 Work item 卡片，布局切换 / 筛选控件在顶部。
- **`+ New work item` 按钮**：动作入口存在，但不能证明点击、拖拽、状态切换或数据保持已经发生。

**健康度**：健康 — 三级范围导航清晰（Rail → 侧栏 → Project 内），Work item 主工作面占据中心，AI 不替代对象事实。

**可见优点**：
- 长期对象（Work item / Page / Cycle / Module）拥有页面中心，用户离开 AI 对话后工作仍由 Project 和对象状态保持（F · evidence card §4.1）。
- 多级范围导航表达"我正在什么范围工作"（F · evidence card §4.2）。

**可见风险/可访问性风险**：
- 三层侧栏的固定宽度在窄屏可能压迫主工作面（U）。
- 按状态分组的卡片密度在大量 Work item 时可能需要虚拟滚动（U）。
- 布局切换控件的键盘可达性和屏幕阅读器标签未证明（U）。

**证据限制**：静态帧只证明布局结构存在。不证明点击、拖拽、状态切换或数据保持已经发生（F · evidence card §3.3）。

### 2.2 Intake 把人工决定放在对象进入下一阶段之前

![Plane Intake 的 Accept / Decline](./evidence/plane-v0.1/screenshots/04-detailed-intake-work-item.webp)

**画面性质**：Plane 官方视觉与当前一手资料，非本地完整运行实例。静态图只证明结构。

**可见布局**（O）：

- **Intake 队列**：候选 Work item 处于 `Triage` 状态。
- **候选详情面板**：展示编号、标题、部分描述、负责人头像、优先级、日期、Label 和 Work item type。
- **Accept / Decline 按钮**：动作入口存在。
- **Snooze / Duplicate / Delete 边界**：源码确认存在（F · evidence card §4.5）。

**健康度**：健康 — Intake 队列集中处理需要人决定的候选对象，决定前先展示关键属性（F · evidence card §5 Take #4）。

**可见优点**：
- 人工决定在对象进入下一阶段之前集中处理，避免候选散落（F · evidence card §4.5）。
- Accept 先打开编辑 modal，允许在加入 Project 前修订（F · evidence card §4.5）。
- Decline 先打开确认框，明确提示不可撤销（F · evidence card §4.5）。

**可见风险/可访问性风险**：
- Decline 不可撤销可能导致误操作（F · evidence card §4.5）。
- Intake 队列的键盘导航和批量操作未证明（U）。
- 候选来源（是否由 AI 生成）在画面中不可见（U）。

**证据限制**：静态帧只证明布局结构存在。不证明候选来源、是否由 AI 生成、Accept 后精确写入范围、Decline 后去向、失败处理或撤销（F · evidence card §3.4）。

## 3. 一条核心路径

路径事实来自证据卡（F），不来自本截图的实际运行。

```text
产品级 App rail
  → Workspace / Teamspace / Project 侧栏（范围导航）（F · evidence card §4.2）
  → Project 内导航（Work items / Cycles / Modules / Views / Pages / Intake）（F · evidence card §4.2）
  → 当前 Work items 主工作面
  → 同一 Work item 集合在 List / Kanban / Calendar / Spreadsheet / Gantt 切换（F · evidence card §4.3）
  → 身份与筛选保持连续（布局切换更新同一组 display filters）（F · evidence card §4.3）
  → Intake 队列（候选 Work item 处于 Triage）（F · evidence card §4.5）
  → 人看编号 / 标题 / 部分描述 / 负责人头像 / 优先级 / 日期 / Label / Work item type（F · evidence card §3.4）
  → Accept（先打开 CreateUpdateIssueModal，允许在加入 Project 前编辑）（F · evidence card §4.5）
  → 或 Decline（先打开确认框，明确提示不可撤销）（F · evidence card §4.5）
  → 或 Snooze / Duplicate / Delete（F · evidence card §4.5）
  → 写入 Project Work item 状态（F · evidence card §4.5）
```

**关键事实**：
- Intake 是明确的人工队列，但当前证据没有证明候选来自 Agent，也没有展示版本绑定、决定 Hash、结果未知或恢复（F · evidence card §4.5）。
- 同一 Work item 集合可以换表达方式，对象身份不变（F · evidence card §4.3）。
- 主对象是长期工作事实，不是 Chat 或 Run（F · evidence card §4.1）。

## 4. 工作台交互语法（六层职责）

| 层 | Plane 事实 | 证据 |
|---|---|---|
| 作用域/导航 | 产品级 Rail → Workspace/Teamspace/Project 侧栏 → Project 内导航（Work items / Cycles / Modules / Views / Pages / Intake） | F · evidence card §4.2 |
| 主工作表面 | Project / Work item / Page 拥有主工作面；AI 进入对象所在表面 | F · evidence card §1, §4.1 |
| 上下文副表面 | 布局切换 / 筛选控件；Intake 候选详情面板 | F · evidence card §3.3, §3.4 |
| 连续性 | 同一 Work item 集合多布局切换（List / Kanban / Calendar / Spreadsheet / Gantt），身份与筛选保持连续 | F · evidence card §4.3 |
| 人工检查点 | Intake Accept / Decline / Snooze / Duplicate / Delete；决定前先展示关键属性 | F · evidence card §4.5 |
| 结果/证据写回 | 写入 Project Work item 状态；AI Block 生成的内容成为可继续编辑的 Page block | F · evidence card §4.5; §3.2 |

## 5. 布局为什么成立

**长期工作事实拥有页面中心**是 Plane 最核心的设计决定（F · evidence card §1, §4.1）：

Plane 的中心对象是 Project 里的 Work item、Page、Cycle、Module、View 和 Intake。AI 的价值是查询、生成或修改这些对象，而不是用一条 Agent 会话替代它们（F · evidence card §4.1）。

这意味着用户离开一次 AI 对话后，工作仍由 Project 和对象状态保持，而不是依赖聊天历史恢复（F · evidence card §4.1）。

**多级范围导航与工作范围相互对应**（F · evidence card §4.2）：

| 层级 | 源码 owner | 责任 |
|---|---|---|
| 产品级 Rail 容器 | `AppRailRoot` | icon-only / icon-with-label；Dock / Undock；条目由 HOC 注入 |
| Workspace / Project 侧栏 | `ProjectAppSidebar` | 可伸缩、折叠、Peek 的范围导航 |
| Project 内导航 | `ProjectNavigation` | Work items、Cycles、Modules、Views、Pages、Intake；权限与 feature flag 决定可见性 |

当前固定公开源码的 `app-rail-hoc.tsx` 只直接注入 `Projects`；画面里的 Wiki、AI、Desk、Bridge 可能来自未公开扩展或不同版本，不能写成开源等价实现。可以采用的是"多级范围导航"的交互语法，而不是这些具体产品入口（F · evidence card §4.2）。

**同一 Work item 集合可以换表达方式**（F · evidence card §4.3）：

`HeaderFilters` 和 `ProjectIssueLayout` 共同确认 5 种布局：List / Kanban / Calendar / Spreadsheet / Gantt。布局切换更新同一组 display filters；主区域根据 active layout 分发到对应视图，并保留筛选行、保存 View 和详情 Peek。这支持"对象身份不变，表达方式可换"的设计，而不是为 Calendar、Board 和 Table 分别建立互不相认的产品事实（F · evidence card §4.3）。

**AI 有 3 种可能的作用域，但公开证据不完整**（F · evidence card §4.4）：

2026 官方画面显示：
1. 全局级：`AI Assistant`；
2. 页面工具级：`AI summary`；
3. 内容块级：`AI Block`。

公开源码只直接确认邻近的 Page 编辑器 AI：
- `editor-body.tsx` 把 `EditorAIMenu` 注入编辑器；
- `ai/menu.tsx` 和 `ask-pi-menu.tsx` 允许对选中文本提问、生成、Replace、插入下一行和重新生成；
- 当前读取到的路径通过 `editorRef.insertText()` 写入编辑器。

因此不能把开源 `EditorAIMenu / Ask Pi` 说成 2026 Cloud 的全局 Assistant、AI summary 或独立 AI Block，也不能由这一条路径推断 Plane 的全部 AI 写回都没有审核（F · evidence card §4.4）。

**与 Basecamp / Linear 的区分**（I）：

| 参考 | 页面中心由谁拥有 | 连续性由谁保持 | 人工介入 |
|---|---|---|---|
| Basecamp | Project Room（Room-owned） | 对象层级 | Item 评论、To-do Complete |
| Linear | Work List + Peek（Work-list-owned） | 三档阅读速度 | Peek 预览、Update composer |
| **Plane** | **Project / Work item / Page（Work-object-owned）** | **长期工作对象及其状态** | **编辑对象、Intake Accept/Decline** |

Plane 的新增价值是**把 AI 嵌入长期 Project 事实，而不是让 Agent 会话拥有一切**（F · evidence card §6）。

## 6. Chat 的 Take / Adapt / Refuse

### Take

1. 让 Project / Work / Artifact 等长期对象拥有中心，不让所有工作退化为聊天消息（F · evidence card §5 Take #1）。
2. 用产品级、范围级、对象级三层导航表达"我正在什么范围工作"（F · evidence card §5 Take #2）。
3. 同一对象集合可切换 Board、Calendar、List、Table 等布局，身份与筛选保持连续（F · evidence card §5 Take #3）。
4. 用独立 Intake 队列集中处理需要人决定的候选对象；决定前先展示关键属性（F · evidence card §5 Take #4）。

### Adapt

1. 把 Plane 的 Intake 扩展为 Chat 的通用 Review Queue：可接受、拒绝、修订、评论、稍后处理，并绑定候选版本与 Agent Run（F · evidence card §5 Adapt #1）。
2. 把多级 AI 入口收敛为明确作用域：全局 Agent、当前工作区 Agent、当前 Artifact 操作，界面要直接显示读取和写回范围（F · evidence card §5 Adapt #2）。
3. 把普通 Page 版本与同步状态连接到 AI 写回：显示 AI 修改 Diff、来源、候选状态、用户接受和恢复点（F · evidence card §5 Adapt #3）。
4. 把五种布局用于同一 Product Store 查询，不复制五套任务事实（F · evidence card §5 Adapt #4）。

### Refuse

1. 不把 `Accept / Decline` 两个按钮本身当成完整 HITL 状态机（F · evidence card §5 Refuse #1）。
2. 不把普通 Project 状态列当成 Agent Run 的进度、等待或失败事实（F · evidence card §5 Refuse #2）。
3. 不因产品"开源"就假设当前 Cloud AI 表面也已有等价公开源码（F · evidence card §5 Refuse #3）。
4. 不复制三层侧栏的固定宽度；保留其范围语义，再根据 Chat 的桌面和移动模式适配（F · evidence card §5 Refuse #4）。

## 7. 覆盖与不覆盖

### 覆盖

| 场景 | 判定 | 证据 |
|---|---|---|
| 长期项目推进、结构化协作、知识沉淀 | **部分覆盖**：Project / Work item / Page 拥有主工作面；多级范围导航；同一 Work item 集合多布局切换；独立 Intake 审核队列 | F · evidence card §4.1, §4.2, §4.3, §4.5 |

### 不覆盖

| 能力 | 证据 |
|---|---|
| 自然语言目标如何形成可编辑 Plan | F · evidence card §7 #1 |
| Agent 工具调用、子任务、等待、失败和结果未知 | F · evidence card §7 #2 |
| 长任务暂停、恢复和取消 | F · evidence card §7 #3 |
| Artifact Diff、逐项评论和版本绑定的接受/拒绝 | F · evidence card §7 #4 |
| Evidence / 来源与 Project 写回的连续性 | F · evidence card §7 #5 |
| 多 Agent participant、visibility 和 Agent—Agent 协作 | F · evidence card §7 #6 |
| 完整 Project 对象链（Stage → Milestone → Iteration → Work → Scope → Action → Update → Gate → Decision） | F · matrix §6.1 #1 |
| 跨表面连续性（同一 Work 在 Project Room / Today / Agent Feed / Workbench 间往返） | F · matrix §6.1 #4 |
| 正式 Evidence 验证、版本、贡献归属与完成门 | F · matrix §6.1 #6 |
| 失败 / 等待 / 恢复状态的交互证明 | U |

**结论**：Plane 是 Chat 工作台的**长期工作事实拥有页面中心 + 独立 Intake 审核队列参考**，不是完整人—Agent 工作台答案。它回答"AI 怎样进入工作对象所在表面"和"人工决定怎样在对象进入下一阶段前集中处理"，但不回答"Plan 怎样审核""Agent 怎样执行""结果是否可靠""证据在哪里""知识怎样编排"。

## 8. 证据边界

以下事项本截图与证据卡**不能证明**：

| 未证明 | 等级 |
|---|---|
| 自然语言目标如何形成可编辑 Plan | F · evidence card §7 #1 |
| Agent 工具调用、子任务、等待、失败和结果未知 | F · evidence card §7 #2 |
| 长任务暂停、恢复和取消 | F · evidence card §7 #3 |
| Artifact Diff、逐项评论和版本绑定的接受/拒绝 | F · evidence card §7 #4 |
| Evidence / 来源与 Project 写回的连续性 | F · evidence card §7 #5 |
| 多 Agent participant、visibility 和 Agent—Agent 协作 | F · evidence card §7 #6 |
| 候选来源（是否由 AI 生成） | F · evidence card §3.4 |
| Accept 后精确写入范围 | F · evidence card §3.4 |
| Decline 后去向 | F · evidence card §3.4 |
| 失败处理或撤销 | F · evidence card §3.4 |
| 点击、拖拽、状态切换或数据保持已经发生 | F · evidence card §3.3 |
| 开源 `EditorAIMenu / Ask Pi` 等价于 2026 Cloud 的全局 Assistant、AI summary 或独立 AI Block | F · evidence card §4.4 |
| 布局切换控件的键盘可达性和屏幕阅读器标签 | U |
| Intake 队列的键盘导航和批量操作 | U |
| 三层侧栏的固定宽度在窄屏的实际表现 | U |

证据卡中的事实（F）来自 Plane 官方视觉与当前一手资料、部分固定开源源码核对，不由本卡截图单独证明。本截图组只证明长期工作事实拥有页面中心和独立 Intake 审核队列的视觉结构存在。

---

> Plane 9/9 已整理；本阶段只完成研究卡，未制作原型。
