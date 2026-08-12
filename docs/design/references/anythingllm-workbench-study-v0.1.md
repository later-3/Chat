---
status: candidate
version: 0.1
date: 2026-08-12
scope: AnythingLLM / Open Computer 7/9 工作台单项研究
evidence: AnythingLLM 官方演示 + Open Computer 官方演示 + 固定源码核对
---

# AnythingLLM / Open Computer 工作台单项研究 v0.1

> 本文是 9 项工作台研究集中 AnythingLLM / Open Computer 的单项研究卡。截图组来自 AnythingLLM 官方 README 当前引用的 v1.11.2 产品演示（02–05）和 Open Computer 官方演示（06–07），以及固定源码的本地布局渲染（01）。它们不是本地完整运行实例，也不是营销首页。证据标记：`O` = 本卡对既有画面的可见观察；`F` = 已批准审计/矩阵中的冻结事实；`I` = 跨证据归纳；`U` = 当前未知/未验证。

## 1. 结论卡

| 维度 | 结论 | 证据 |
|---|---|---|
| 定位 | 基础工作台 + 两种主对象布局：解决"谁拥有页面中心"作为首要决定 | F · evidence card §2 |
| 页面中心所有者 | **两种真正不同的模式**：AnythingLLM 是 **Conversation-owned**（对话拥有中心）；Open Computer 是 **Workspace-owned**（桌面/浏览器/文件现场居中，对话退到 sidecar） | F · evidence card §2, §3, §4 |
| 最适合 Chat 的场景 | 对话型 Agent 工作区（AnythingLLM）+ 电脑式执行工作面（Open Computer） | F · evidence card §3, §4 |
| 最强可迁移机制 | "谁拥有页面中心"是首要决定；Conversation 模式让状态与 Evidence 紧贴消息连续性；Workspace 模式保留主工作表面，让 Run/Subagents/Logs 进入 sidecar | F · evidence card §7 Take |
| 对人—Agent 工作台的主要缺口 | 无 Plan 审核/版本绑定；无 Pause/Resume/失败恢复；无 Artifact 评论/接受/拒绝闭环；无正式 Evidence/Decision/产品写回 | F · evidence card §8 |

## 2. 一张已检查画面

![AnythingLLM / Open Computer 工作台关键状态对照](./evidence/anythingllm-v0.1/screenshots/00-anythingllm-open-computer-evidence-grid.png)

**画面性质**：AnythingLLM 官方 README 当前引用的 v1.11.2 产品演示（02–05）和 Open Computer 官方演示（06–07），以及固定源码的本地布局渲染（01）。它们不是本地完整运行实例，也不是营销首页。01 只证明布局，不证明运行。

**可见布局**（O）：

- **02–05 AnythingLLM（Conversation-owned）**：
  - 左侧 Workspace/Thread 列表；中央 greeting + 输入框 + 快捷动作（02）。
  - 文件以 chip 进入输入框，提交入口不变（03）。
  - 折叠进度行插在用户请求与最终回答之间，显示检索数量、阶段文本和 token（04）。
  - 回答留在中央消息流；Sources 从右侧抽屉展开；底部输入仍可继续追问（05）。

- **06–07 Open Computer（Workspace-owned）**：
  - 顶栏 + 大面积桌面（VNC iframe）+ 右侧 Chat/Subagents/Logs/VM Logs sidecar + 底部输入（01，WebSocket 未连接，只证明布局）。
  - 右侧任务卡显示 running、子任务状态和 `Abort run`；桌面保持可见（06）。
  - 桌面浏览器、右侧历史与 Deliverables 同屏；产物提供 Download / Remove（07）。

**健康度**：健康 — 两种模式都包含 6 个必要区域（工作范围导航、自然语言目标入口、主工作表面、Agent/Run 状态、人工介入控制、结果与证据）（F · evidence card §5）。Conversation 模式让状态紧贴消息；Workspace 模式保留主工作表面。

**可见优点**：
- "谁拥有页面中心"是首要决定，而不是固定左/中/右模板（F · evidence card §7 Take #1）。
- Conversation 模式让状态与 Evidence 紧贴消息连续性（F · evidence card §7 Take #2）。
- Workspace 模式保留主工作表面，让 Run、Subagents、Logs 与人工控制进入 sidecar（F · evidence card §7 Take #3）。
- Deliverable 在任务现场交付，不跳到脱离上下文的下载中心（F · evidence card §7 Take #4）。

**可见风险/可访问性风险**：
- 长任务细节容易被压缩成不透明状态行（Conversation 模式的主要代价）（F · evidence card §5）。
- sidecar 信息密度高，桌面与状态需要分配注意力（Workspace 模式的主要代价）（F · evidence card §5）。
- 源码核对的固定宽度（292px 导航、366px Sources、397px sidecar）是实现证据，不是 Chat 的设计结论（F · evidence card §7 Refuse #3）。

**证据限制**：画面只证明布局结构存在。不证明可编辑 Plan 审核、版本绑定、Pause/Resume、失败恢复、Artifact 评论/接受/拒绝闭环。Open Computer 源码虽存在 `renderPlanReview()` 代码（可编辑 items + Approve/Deny），当前接受画面没有覆盖，不能写成已证明的视觉闭环（F · evidence card §6, §7 Refuse #2）。

## 3. 两条核心路径

路径事实来自证据卡（F），不来自本截图的实际运行。

**路径 A：AnythingLLM（Conversation-owned）**

```text
Workspace / Thread（确定工作范围）
  → 在同一 composer 添加文字、工具或文件（F · evidence card §3）
  → Agent 状态成为消息流中的中间节点（折叠进度行，显示检索数量/阶段/token）（F · evidence card §3）
  → 最终回答仍属于消息流（F · evidence card §3）
  → Sources 作为可关闭侧栏出现（F · evidence card §3）
  → 用户继续追问（F · evidence card §3）
```

**路径 B：Open Computer（Workspace-owned）**

```text
Goal / Prompt（任务输入）
  → Agent 在桌面中使用浏览器、文件或应用（F · evidence card §4）
  → 右侧 sidecar 投影 Run、Subagents 与 Logs（F · evidence card §4）
  → 人通过追问或 Abort 介入（F · evidence card §4）
  → Deliverable 回到同一 sidecar（Download / Remove）（F · evidence card §4）
  → 桌面保留结果验证现场（F · evidence card §4）
```

**关键事实**：
- 人影响 Agent 的方式：自然语言、文件/显式上下文、继续追问、观察/Abort（F · evidence card §3, §4）。
- 当前视觉不证明可编辑 Plan 审核、版本绑定、Pause/Resume、失败恢复、Artifact 评论/接受/拒绝闭环（F · evidence card §8）。
- 结果：AnythingLLM = answer + Sources；Open Computer = 桌面现场 + Deliverables。均不足以证明正式 Evidence/Decision/产品写回（F · evidence card §3, §4）。

## 4. 工作台交互语法（六层职责）

| 层 | AnythingLLM / Open Computer 事实 | 证据 |
|---|---|---|
| 作用域/导航 | AnythingLLM：左侧 Workspace/Thread 列表；Open Computer：顶栏 + 大面积桌面 | F · evidence card §3, §4 |
| 主工作表面 | AnythingLLM：中央对话消息流（Conversation-owned）；Open Computer：桌面/浏览器/文件现场（Workspace-owned） | F · evidence card §2, §3, §4 |
| 上下文副表面 | AnythingLLM：Sources 可关闭侧栏；Open Computer：右侧 Chat/Subagents/Logs/VM Logs sidecar | F · evidence card §3, §4 |
| 连续性 | AnythingLLM：消息连续性（状态与 Evidence 紧贴消息）；Open Computer：桌面现场连续性（Run/Subagents/Logs 在 sidecar） | F · evidence card §5 |
| 人工检查点 | AnythingLLM：继续回复、继续提问；Open Computer：回复、查看状态、Abort run | F · evidence card §3, §4 |
| 结果/证据写回 | AnythingLLM：answer + Sources（可引用、可继续追问的回答）；Open Computer：桌面现场 + Deliverables（可下载的文件 + 保留的桌面现场） | F · evidence card §3, §4, §5 |

## 5. 布局为什么成立

**"谁拥有页面中心"是首要决定**是 AnythingLLM / Open Computer 最核心的设计启发（F · evidence card §2, §7）：

同一产品组包含两种真正不同的页面中心：

1. **Conversation-owned shell（AnythingLLM）**：对话是主对象，文件、Agent 进度、Sources 都附着在消息连续性上（F · evidence card §2）。
2. **Workspace-owned shell（Open Computer）**：桌面是主对象，对话、Subagents、Logs、Run 与 Deliverables 退到固定 sidecar，负责控制和解释桌面中的工作（F · evidence card §2）。

因此，"传统三栏工作台"只是共同零件，不是唯一答案。真正需要决定的是当前任务由 **Conversation** 还是 **Workspace / Artifact** 拥有页面中心（F · evidence card §2）。

**两种模式的真实结构差异**（F · evidence card §5）：

| 问题 | AnythingLLM | Open Computer |
|---|---|---|
| 页面中心属于谁 | Conversation | Desktop / Workspace |
| 进度放在哪里 | 消息流内部 | 右侧任务/子任务面板 |
| Evidence 怎样出现 | 可关闭 Sources 抽屉 | 桌面现场 + Logs / Deliverables |
| 人怎样介入 | 继续回复、继续提问 | 回复、查看状态、Abort run |
| 结果是什么 | 可引用、可继续追问的回答 | 可下载的文件 + 保留的桌面现场 |
| 主要代价 | 长任务细节容易被压缩成不透明状态行 | sidecar 信息密度高，桌面与状态需要分配注意力 |

**与 Heptabase 的区分**（I）：

- **Heptabase 以 canonical knowledge object / placement 为中心**：Card Library 持有 canonical Card，Whiteboard 只持 placement，右侧 context sidebar 保持当前对象上下文。它回答"知识怎样收集、关联、编排与复用"。
- **AnythingLLM / Open Computer 以 conversation 或 execution workspace 为中心**：对话或桌面拥有页面中心，Agent 进度和结果附着在主对象上。它回答"Agent 在做什么"和"结果在哪里"。

Heptabase 的 canonical object 是长期知识事实；AnythingLLM / Open Computer 的主对象是单次对话或单次运行的现场。

## 6. Chat 的 Take / Adapt / Refuse

### Take

1. 把"谁拥有页面中心"作为工作台模式的首要决定，而不是固定左/中/右模板（F · evidence card §7 Take #1）。
2. Conversation 模式让状态与 Evidence 紧贴消息连续性（F · evidence card §7 Take #2）。
3. Workspace 模式保留主工作表面，让 Run、Subagents、Logs 与人工控制进入 sidecar（F · evidence card §7 Take #3）。
4. Deliverable 在任务现场交付，不跳到脱离上下文的下载中心（F · evidence card §7 Take #4）。

### Adapt

1. Chat 不能只显示不透明的 Agent 状态行；需要能展开到 Task / Run / Evidence，但默认保持轻量（F · evidence card §7 Adapt #1）。
2. `Abort` 只能是运行控制之一；Chat 仍需自己的暂停、恢复、结果未知和人工处置状态（F · evidence card §7 Adapt #2）。
3. Deliverable 不能止于 Download / Remove；至少还要能查看、评论、修订、接受或拒绝（F · evidence card §7 Adapt #3）。
4. Conversation 与 Workspace 应共享同一 Product Run 和 Artifact 身份，而不是两个互不相认的页面（F · evidence card §7 Adapt #4）。

### Refuse

1. 不把 token 数或"正在运行"当成充分进度（F · evidence card §7 Refuse #1）。
2. 不因 Open Computer 源码出现 Plan 卡片，就宣称完整 Plan 审核闭环已经被画面证明（F · evidence card §7 Refuse #2）。
3. 不照搬单一 397px sidecar 或单一 292px 导航宽度；尺寸是实现证据，不是 Chat 的设计结论（F · evidence card §7 Refuse #3）。
4. 不让浏览器/桌面运行事实替代 Chat 自己的权限、审批、写回与完成事实（F · evidence card §7 Refuse #4）。

## 7. 覆盖与不覆盖

### 覆盖

| 场景 | 判定 | 证据 |
|---|---|---|
| 对话型 Agent 工作区 | **部分覆盖**：Conversation-owned shell 证明对话可以拥有页面中心，状态与 Evidence 紧贴消息连续性 | F · evidence card §3 |
| 电脑式执行工作面 | **部分覆盖**：Workspace-owned shell 证明桌面可以拥有页面中心，Run/Subagents/Logs 进入 sidecar | F · evidence card §4 |

### 不覆盖

| 能力 | 证据 |
|---|---|
| 可修改、可版本绑定的 Plan 审核路径 | F · evidence card §8 #1 |
| Pause / Resume、失败、结果未知和恢复 | F · evidence card §8 #2 |
| 对中间 Artifact 的评论、修订、接受或拒绝 | F · evidence card §8 #3 |
| Context、Memory、权限和写回范围的可见表达 | F · evidence card §8 #4 |
| 多 Agent participant、visibility 与 Agent—Agent 协作关系 | F · evidence card §8 #5 |
| 正式 Evidence / Decision / 产品写回 | F · evidence card §3, §4 |
| 完整 Project 对象链（Stage → Milestone → Iteration → Work → Scope → Action → Update → Gate → Decision） | F · matrix §6.1 #1 |
| 跨表面连续性（同一 Work 在 Project Room / Today / Agent Feed / Workbench 间往返） | F · matrix §6.1 #4 |
| 失败 / 等待 / 恢复状态的交互证明 | U |

**结论**：AnythingLLM / Open Computer 是 Chat 工作台的**基础工作台 + 两种主对象布局参考**，不是完整人—Agent 工作台答案。它回答"谁拥有页面中心"和"Agent 在做什么"，但不回答"Plan 怎样审核""结果是否可靠""证据在哪里""知识怎样编排"。

## 8. 证据边界

以下事项本截图与证据卡**不能证明**：

| 未证明 | 等级 |
|---|---|
| 可修改、可版本绑定的 Plan 审核路径（源码存在 `renderPlanReview()` 但画面未覆盖） | F · evidence card §6, §8 #1 |
| Pause / Resume、失败、结果未知和恢复 | F · evidence card §8 #2 |
| 对中间 Artifact 的评论、修订、接受或拒绝 | F · evidence card §8 #3 |
| Context、Memory、权限和写回范围的可见表达 | F · evidence card §8 #4 |
| 多 Agent participant、visibility 与 Agent—Agent 协作关系 | F · evidence card §8 #5 |
| 正式 Evidence / Decision / 产品写回 | F · evidence card §3, §4 |
| 来源选择、评论、接受/拒绝或正式写回（AnythingLLM Sources） | F · evidence card §3 |
| Abort 后的终止、对账或恢复结果（Open Computer） | F · evidence card §4 |
| 产物内容质量、版本、评论、接受/拒绝或写回（Open Computer Deliverables） | F · evidence card §4 |

证据卡中的事实（F）来自 AnythingLLM 官方 README 当前引用的 v1.11.2 产品演示、Open Computer 官方演示和固定源码核对，不由本卡截图单独证明。本截图组只证明两种主对象布局的视觉结构存在。

---

> AnythingLLM / Open Computer 7/9 已整理；本阶段只完成研究卡，未制作原型。
