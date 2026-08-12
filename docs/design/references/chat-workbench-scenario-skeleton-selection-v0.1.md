---
status: superseded
version: 0.2
date: 2026-08-12
superseded_by: human-agent-workbench-selector-v0.1.html
scope: Chat 工作台三轴选择菜单（A 轴 Workbench Surfaces + B 轴 Agent Constitution + C 轴 Agent Workflow Lifecycle）
evidence: 9 项工作台研究 + 2 份总矩阵 + AnythingLLM Agent Constitution / Workflow 视觉证据 v0.1 + 视觉索引
forbidden: 不修改生产 UI，不运行原型，不创建 HTML/React 原型，不部署，不推送，不创建 PR，不提交
---

# Chat 工作台三轴选择菜单 v0.2

> 历史中间方案。用户明确反馈 A/B/C 轴不利于直接选择，随后改成“整体骨架 + 有限场景机制”的 HTML 选择器。本文件保留分析过程；实际选择以 [`human-agent-workbench-selection-decision-v0.1.md`](./human-agent-workbench-selection-decision-v0.1.md) 为准。

> 这是给用户直接选择的菜单，不是新的全景调研，也不是实现任务。
>
> **关键纠偏**：v0.1 的"八场景"（P/C/R/A/M/K/T/D）只覆盖 A 轴（Workbench Surfaces），不是完整场景集。v0.2 使用 A/B/C 三轴，B 轴覆盖 Agent Constitution，C 轴覆盖 Agent Workflow Lifecycle 12 阶段。
>
> **版本说明**：为保留稳定路径，文件名保留 v0.1；正文版本已升级到 v0.2。
>
> 截图命名空间定义：
> - **ACW-** = `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/`（25 张：ACW-01 – ACW-25；覆盖 Memory / Skills / Flow / MCP / Scheduled Jobs / Survey / Agent Configuration）
> - **WB-** = `evidence/anythingllm-v0.1/screenshots/`（8 张：WB-00 – WB-07；覆盖 Conversation 起点 / 文件上下文 / Agent 进度 / 结果来源 / Open Computer）
>
> 证据标记：`F` = Chat 已批准合同、冻结事实或已批准研究登记；`O` = 本批已检查产品 UI 画面直接可见；`D` = 当前官方文档或官方源码说明；`I` = 跨证据归纳或 Chat 适配判断；`U` = 当前没有证明。

## 1. 结论

1. Chat 的产品对象、对话→Plan→人工决定→执行→正式结果闭环，以及最小运行投影底座已经存在（F）。
2. 不需要复制九套产品。工作台选择需要三条正交轴（I）：
   - **A 轴：Workbench Surfaces** — 工作在哪里呈现？页面中心由谁拥有？
   - **B 轴：Agent Constitution** — Agent 是谁？能力、记忆、权限边界？
   - **C 轴：Agent Workflow Lifecycle** — 怎样从目标到结果？完整生命周期。
3. 旧"八场景"只是 A 轴，不包含 Agent 身份/能力/记忆/权限（B 轴）和 Workflow 定义/执行/历史（C 轴）。
4. 当前首选仍可保持"对话入口 + 自适应工作台"（A 轴），但必须补上 B 轴和 C 轴的选择。
5. 没有任何一个项目完整覆盖三轴；组合结果属于 I。
6. 本轮停在选择门 + HTML 视觉选型板范围确认，不制作原型，不修改生产 UI。

## 2. 三轴概览

| 轴 | 回答的问题 | 二级场景数 | 段落 |
|---|---|---|---|
| **A 轴：Workbench Surfaces** | 页面中心由谁拥有？ | 8 个表面 | — |
| **B 轴：Agent Constitution** | Agent 是谁？能力/记忆/权限？ | 4 类 | — |
| **C 轴：Agent Workflow Lifecycle** | 怎样从目标到结果？ | 12 阶段 | 4 段（Phase 1–4） |

## 3. A 轴：Workbench Surfaces（工作在哪里呈现）

去重后的可用表面。旧 v0.1 的"Context/Run"表述已拆分：Context 进入 B 轴，Run 进入 C 轴。

### A1 — Project / Work / Task Board

| 项 | 内容 |
|---|---|
| **主参考** | Plane（Work-object-owned + 多布局 + Intake） |
| **补充参考** | Basecamp（Room-owned）、Linear（Work-list-owned + Peek） |
| **可直接借** | Plane 5 种布局切换 + 身份/筛选连续；Basecamp 四层作用域；Linear List/Peek/Detail 三档阅读 |
| **必须适配** | Chat 的 Work 不等于 Issue；Intake Accept/Decline 不等于完整 HITL |
| **拒绝照搬** | 不复制多套事实；不把六宫格当全局骨架 |
| **证据** | F · audit + O · 冻结原型画面 |

### A2 — Conversation / Goal / Plan

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Conversation-owned + Survey 澄清 + Sources） |
| **补充参考** | Chat 当前 B2 闭环（F） |
| **可直接借** | Conversation-owned 让状态与 Evidence 紧贴消息连续性；Survey 对话内结构化 Checkpoint |
| **必须适配** | 不把 token 数当进度；不让 Thread 吞并 Project；Survey 回答需进入版本化 Plan |
| **拒绝照搬** | 不把 Thinking UI 当 Chat 隐藏推理保存依据（F · AGENTS.md §6.6） |
| **证据** | O · WB-02–WB-05（Conversation 起点/文件/进度/来源）；O · ACW-21（Survey） |

### A3 — Execution Workspace / Browser / Files / Tools

| 项 | 内容 |
|---|---|
| **主参考** | Open Computer（Workspace-owned + sidecar） |
| **补充参考** | Orca（pane tree + task workspace） |
| **可直接借** | 桌面/浏览器/文件现场居中；Chat 退到 sidecar；异构 pane tree |
| **必须适配** | 不自动切换；切换必须显式且保留对象与草稿；不把 VNC 当通用模式 |
| **拒绝照搬** | 不照搬固定 sidecar 宽度；不把 terminal 当 Agent |
| **证据** | O · WB-06–WB-07（Open Computer 运行/产物）；O · Orca 截图 |

### A4 — Artifact / Evidence Review

| 项 | 内容 |
|---|---|
| **主参考** | Orca（diff 行级批注 → 批量交回指定 Agent） |
| **补充参考** | Heptabase（单个 Artifact + context/provenance） |
| **可直接借** | 行级批注锚点持久化；显式 context 和 searched/viewed 日志 |
| **必须适配** | 不限制在 coding；审阅结果先是 candidate，需正式 Evidence 验证 |
| **拒绝照搬** | 不把位置/颜色/连线当权威状态 |
| **证据** | F · Orca evidence card；F · Heptabase audit |

### A5 — Multi-Agent Feed / HITL

| 项 | 内容 |
|---|---|
| **主参考** | MS Agent Feed（typed supervision + outcome_unknown） |
| **补充参考** | Orca（任务内多 Agent 状态） |
| **可直接借** | 风险优先类型化监督；任务类型决定动作；outcome_unknown 拒绝 Retry |
| **必须适配** | Feed 不是事实源；正式事实回 Product Run/Decision/Evidence |
| **拒绝照搬** | 不复制 Completed 大桶；不用普通 Retry 处理 outcome_unknown |
| **证据** | F · Agent Feed audit v0.2 |

### A6 — Knowledge / Canvas

| 项 | 内容 |
|---|---|
| **主参考** | Heptabase（canonical object × placement） |
| **补充参考** | Plane Page / Work 内知识 |
| **可直接借** | Card Library 是内容源；Whiteboard 只保存 placement；显式 AI context/provenance |
| **必须适配** | 不把无限画布当首页；placement 不是产品事实 |
| **拒绝照搬** | 不让无来源 AI Card 自动进入长期事实 |
| **证据** | F · Heptabase audit |

### A7 — Today / Todo / Calendar

| 项 | 内容 |
|---|---|
| **主参考** | Things（Today 投影）+ HEY Calendar（Day/Week/Year） |
| **补充参考** | — |
| **可直接借** | parent context × attention horizon 双轴；连续时间尺度 + 创建时同屏冲突判断 |
| **必须适配** | 不把所有对象 checkbox 化；不让 Calendar 拥有 Work/Project |
| **拒绝照搬** | 不共享同一完成或优先级语法 |
| **证据** | F · Things audit + F · HEY audit |

### A8 — Delivery / Update / Writeback

| 项 | 内容 |
|---|---|
| **主参考** | Linear（署名 Project Update） |
| **补充参考** | Plane（对象写回）、Heptabase（Artifact + provenance → Evidence） |
| **可直接借** | author + health + narrative + observed changes → history / Pulse |
| **必须适配** | 模型结果先是 candidate；不让 Activity/Agent 摘要冒充负责人 Update |
| **拒绝照搬** | 不让事件流冒充 Update |
| **证据** | F · Linear audit |

## 4. B 轴：Agent Constitution（Agent 是谁及边界）

B 轴必须独立可选，不能再藏到 Knowledge/Context。4 类 Constitution 场景：

### B1 — Identity / Role / Owner / Participant

| 项 | 内容 |
|---|---|
| **主参考** | MS Agent Feed（Agent 身份 + delegation + participant visibility） |
| **补充参考** | AnythingLLM（Workspace Agent 模型选择） |
| **可直接借** | Agent 身份类型化；delegation 明示 participant visibility；Agent 有独立终态 |
| **必须适配** | Chat 需要完整耐久 Agent Profile（身份 + 职责 + 能力 + 记忆 + 权限 + 当前工作 + 贡献历史），当前无参考 |
| **拒绝照搬** | 不声称完整 Agent Profile 已有参考（U） |
| **证据** | F · Agent Feed audit；O · ACW-23 |

### B2 — Capability / Skill / Tool / MCP / Model

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Skills/MCP/Flows 同页管理 + Intelligent Selection） |
| **补充参考** | Plane（3 种 AI 作用域） |
| **可直接借** | Max Tool Calls / Intelligent Skill Selection / Max Tools 显式控制；MCP server 状态 + tools + startup command |
| **必须适配** | Chat 需要自己的工具授权和副作用对账合同 |
| **拒绝照搬** | 不证明真实工具授权和调用成功（U） |
| **证据** | O · ACW-10, ACW-04 |

### B3 — Memory / Context / Source / Provenance

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Memory sidebar Workspace/Global scope）+ Heptabase（context chips + searched/viewed） |
| **补充参考** | MS Agent Feed（related record + Evidence） |
| **可直接借** | Memory Workspace/Global scope 分开、记忆卡可见可管理；显式 context chips；访问日志区分 searched/viewed |
| **必须适配** | 自动提取和模型注入细节需 Chat 自建（D/U）；回答先是 candidate |
| **拒绝照搬** | 不假设默认搜索整个 Space 的合理性；不虚构 provenance |
| **证据** | O · ACW-02；F · Heptabase audit |

### B4 — Permission / Visibility / Consent / Write scope

| 项 | 内容 |
|---|---|
| **主参考** | MS Agent Feed（participant visibility + delegation 合同） |
| **补充参考** | Heptabase（Board permission + Space search 开关） |
| **可直接借** | delegation 明示 coordination-only；Board owner/edit/view/none；visible to / required permission 展示 |
| **必须适配** | Chat 需要自己的权限、版本、hash 和幂等校验合同 |
| **拒绝照搬** | 不虚构跨账户社交或代他人 Agent 同意 |
| **证据** | F · Agent Feed audit；F · Heptabase audit |

## 5. C 轴：Agent Workflow Lifecycle（怎样从目标到结果）

12 阶段聚合为 4 段以控制认知负担。

### Phase 1: Goal → Plan（C1–C2）

#### C1 — Goal input / Clarify / assumptions / scope

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Conversation 起点 + Agent Survey 对话内结构化澄清） |
| **补充参考** | MS Agent Feed（candidate 入口） |
| **可直接借** | 自然语言输入仍在对话主线；内嵌多题卡片提供进度、选项、Other、Skip，不跳设置页面 |
| **必须适配** | 九项没有证明“聊天消息 → 显式 Goal/assumptions/scope 对象”；Survey 回答需进入版本化 Plan 假设 |
| **拒绝照搬** | 不把普通消息框冒充 Goal 建模；不证明回答进入版本化 Plan（U） |
| **证据** | O · WB-02（对话起点）, ACW-21（结构化澄清）；U · 显式 Goal/assumptions/scope |

#### C2 — Editable Plan / confirmation

| 项 | 内容 |
|---|---|
| **主参考** | MS Agent Feed（candidate → 人工修订 → revision/hash/scope 绑定 Decision） |
| **补充参考** | — |
| **可直接借** | 可编辑 items + Approve/Deny；revision/hash 绑定 |
| **必须适配** | Chat 的 Plan 需版本化确认，不能只停留在 candidate |
| **拒绝照搬** | 不虚构生产耐久执行 |
| **证据** | F · Agent Feed audit v0.2 |

### Phase 2: Define → Publish（C3–C5）

#### C3 — Flow definition / nodes / blocks / variables / tools

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Flow Builder） |
| **补充参考** | Orca（worktree + pane tree 定义） |
| **可直接借** | Flow name/description/variables/Flow Start/Complete/Add Block/Save |
| **必须适配** | Chat 需要 version/publish/approval |
| **拒绝照搬** | 不证明 Flow 版本历史或发布审批（U） |
| **证据** | O · ACW-05, ACW-06, ACW-07, ACW-08 |

#### C4 — Configuration / version / publish

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Agent Configuration 模型选择） |
| **补充参考** | — |
| **可直接借** | Workspace Agent LLM provider/model 选择 |
| **必须适配** | Chat 需要完整 version/publish 合同 |
| **拒绝照搬** | 不证明 version/publish（U） |
| **证据** | O · ACW-23 |

#### C5 — Trigger: manual / event / schedule / object change

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Scheduled Jobs） |
| **补充参考** | MS Agent Feed（事件驱动监督） |
| **可直接借** | Name + Prompt + Schedule（cron/interval）+ allowed Tools；Run now 手动触发 |
| **必须适配** | Chat 需要事件触发和对象变化触发 |
| **拒绝照搬** | 不证明 event/object change 触发（U） |
| **证据** | O · ACW-18, ACW-19 |

### Phase 3: Run → Control（C6–C9）

#### C6 — Run / task / subtask / tool progress

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Run detail 同屏 Thinking/Tool Calls/Files/Response/Metrics）+ MS Agent Feed（typed Run 投影） |
| **补充参考** | Orca（Agent 状态嵌任务行） |
| **可直接借** | Run detail 分节展示；Tool Calls 展开工具/参数/时间/结果 |
| **必须适配** | Thinking UI 不能成为 Chat 保存隐藏推理的依据（F · AGENTS.md §6.6） |
| **拒绝照搬** | 不把 Thinking 当 Chat Trace 保存内容 |
| **证据** | O · ACW-14, ACW-15；F · Agent Feed audit |

#### C7 — Checkpoint / ask-user / HITL / edit / accept / reject

| 项 | 内容 |
|---|---|
| **主参考** | MS Agent Feed（typed human/system action）+ AnythingLLM（Survey） |
| **补充参考** | Orca（diff 行级批注 → 批量交回） |
| **可直接借** | Complete / Accept+complete / Dismiss / Reconcile / Escalate；Survey 对话内澄清 |
| **必须适配** | 高影响动作走 Chat Decision、版本/hash/权限/幂等校验 |
| **拒绝照搬** | 不用普通 Retry 处理 outcome_unknown |
| **证据** | F · Agent Feed audit；O · ACW-21 |

#### C8 — Pause / resume / cancel / abort

| 项 | 内容 |
|---|---|
| **主参考** | **当前无完整参考** |
| **补充参考** | AnythingLLM（Stop ≠ Pause/Resume）；MS Agent Feed（waiting 状态）；Orca（Blocked） |
| **可直接借** | Stop/Abort 作为终止入口 |
| **必须适配** | Chat 需要真正 Pause/Resume，当前所有参考都未证明 |
| **拒绝照搬** | **Stop 不等于 Pause/Resume**（O · ACW-12） |
| **证据** | O · ACW-12（Stop only）；U · Pause/resume |

#### C9 — Failure / timeout / retry / outcome_unknown / reconcile

| 项 | 内容 |
|---|---|
| **主参考** | MS Agent Feed（outcome_unknown → provider query → Evidence → Product Commit / manual disposition） |
| **补充参考** | AnythingLLM（Run History error status） |
| **可直接借** | outcome_unknown 拒绝普通 Retry；typed Reconcile / Escalate |
| **必须适配** | Chat 需要自己的幂等、结果未知、查询对账和人工处置语义 |
| **拒绝照搬** | 不把普通异常重试用于未知副作用 |
| **证据** | F · Agent Feed audit v0.2；O · ACW-11 |

### Phase 4: Artifact → History（C10–C12）

#### C10 — Artifact / file / diff / Evidence review

| 项 | 内容 |
|---|---|
| **主参考** | Orca（diff 行级批注 → 批量交回指定 Agent） |
| **补充参考** | AnythingLLM（Run Files 区）；Heptabase（context/provenance） |
| **可直接借** | 行级批注锚点持久化；批量选择接收 Agent |
| **必须适配** | AnythingLLM Files 只有结果展示，不能替代 Orca 式锚定评论与 Chat 正式 Evidence 完成门 |
| **拒绝照搬** | 不把 terminal 当 Agent；不限制在 coding |
| **证据** | F · Orca evidence card；O · ACW-16 |

#### C11 — Delivery / writeback / notification

| 项 | 内容 |
|---|---|
| **主参考** | Linear（署名 Project Update）+ AnythingLLM（Continue in Thread） |
| **补充参考** | Plane（对象写回） |
| **可直接借** | author + health + narrative → history / Pulse；Continue in Thread 回到对话 |
| **必须适配** | 正式 Delivery 需 Chat Decision + Evidence 绑定 |
| **拒绝照搬** | 不让 Agent 摘要冒充负责人 Update |
| **证据** | F · Linear audit；O · ACW-14 |

#### C12 — Run history / Continue in Thread / reuse / next schedule

| 项 | 内容 |
|---|---|
| **主参考** | AnythingLLM（Run History + Continue in Thread） |
| **补充参考** | Linear（Updates history / Pulse） |
| **可直接借** | Run History 列出 status/started/duration/error；Continue in Thread 明确返回对话 |
| **必须适配** | Chat 需要 Run 复用和 next schedule 的产品合同 |
| **拒绝照搬** | — |
| **证据** | O · ACW-11, ACW-14 |

## 6. 推荐组合

推荐组合必须同时说明三个轴的选择，不再只给 `S+P+C+R...` 一条代码。

### 首选：对话入口 + 自适应工作台（升级版的 G2）

| 轴 | 选择 | 具体机制 |
|---|---|---|
| **A 轴默认主表面** | A2 Conversation-owned（默认）+ A3 执行工作空间（显式进入时让位） | AnythingLLM Conversation + Open Computer / Orca 式执行现场 |
| **B 轴 Agent Constitution** | B1 Agent Feed（身份/participant）+ AnythingLLM（仅 provider/model 配置）；B2 AnythingLLM（Skills/MCP/Flows 同页）；B3 AnythingLLM + Heptabase（Memory scope + context/provenance）；B4 Agent Feed（participant visibility + delegation） | 组合 Agent Feed 身份/监督合同 + AnythingLLM 配置面 + Heptabase provenance；完整 Agent Profile 仍需 Chat 自建 |
| **C 轴 Workflow Lifecycle** | C1 AnythingLLM Survey；C2 Agent Feed Plan/Decision；C3 AnythingLLM Flow Builder；C4 AnythingLLM Agent Config；C5 AnythingLLM Scheduled Jobs；C6 AnythingLLM Run detail + Agent Feed；C7 Agent Feed typed actions + AnythingLLM Survey；C8 Chat 自建（无参考）；C9 Agent Feed outcome_unknown；C10 Orca diff 批注；C11 Linear Update + AnythingLLM Continue in Thread；C12 AnythingLLM Run History | 主要借 AnythingLLM Definition/Run + Agent Feed HITL + Orca Artifact review |

**补上的核心缺口**（相对 v0.1 G2）：
- B 轴：Agent Configuration（ACW-23）、Memory scope（ACW-02）、Skills/MCP（ACW-10）
- C 轴：Flow Definition（ACW-05）、Scheduled Trigger/Run（ACW-18, ACW-14）、Survey 澄清（ACW-21）、Continue in Thread（ACW-14）
- A4 Artifact review：Orca 行级批注（v0.1 只选 A3 Peek，升级为 Orca 主参考）
- A6 Knowledge/Canvas：Heptabase provenance 组合职责

**代价**：
- B4 Permission/Write scope 仍主要由 Chat 自建
- C8 Pause/Resume 无参考，必须 Chat 自建
- 完整耐久 Agent Profile 无参考，必须 Chat 自建

### 备选 1：对象优先

| 轴 | 选择 |
|---|---|
| **A 轴** | A1 Project/Work（Plane 主参考）+ A8 Delivery（Linear Update） |
| **B 轴** | 同首选，但 B1 以 Agent Feed 为主（Project 内的 Agent 身份） |
| **C 轴** | 同首选，但 C6–C9 以 Agent Feed 为主（Project 内的 Run 监督） |

### 备选 2：执行工作空间优先 / 多 Agent

| 轴 | 选择 |
|---|---|
| **A 轴** | A3 Execution Workspace（Orca pane tree 主参考）+ A5 Multi-Agent Feed |
| **B 轴** | B1–B4 以 Agent Feed + Orca 为主 |
| **C 轴** | C6–C10 以 Orca + Agent Feed 为主；C3–C5 仍需 AnythingLLM Flow/Scheduled |

## 7. 组合规则

1. **同一时刻只有一个页面中心所有者**（A 轴）（I）。
2. **B 轴 4 类必须全部选择**，不能跳过。任何一类选"无"等于放弃该维度的设计。
3. **C 轴 12 阶段必须全部覆盖**，可以聚合为 4 段选择，但不能跳过。
4. **Agent Workflow / Run / Business Workflow 分离**：业务 Work item 状态流不得冒充 Agent Workflow（F）。
5. C 轴的切换必须由用户动作或明确阶段动作触发；不能后台自动抢屏。
6. Sidecar / Peek / Drawer 不拥有或复制权威事实。
7. Feed / Today / Calendar / Canvas 是投影；离开后必须能从权威事实重建。
8. 同一对象跨场景保持 identity、revision、返回位置、焦点和未提交草稿。
9. 高影响动作仍受 Chat Decision、权限、版本/Hash 和幂等约束；`outcome_unknown` 不提供普通 Retry。
10. **Thinking UI 不保存为 Chat 隐藏推理**（F · AGENTS.md §6.6）。
11. **Stop ≠ Pause/Resume**（O）。

## 8. 直接选择

### 最简选择

```text
首选（对话入口 + 自适应工作台，升级版 G2）
```

### 自定义

对每个轴逐项选择：

| 轴 | 选项 |
|---|---|
| A 默认中心 | A1 Project · A2 Conversation · A3 Execution · A4 Artifact · A5 Feed · A6 Knowledge · A7 Today · A8 Delivery |
| B1 Identity | Agent Feed · Chat 自建 · AnythingLLM（仅 provider/model 配置） |
| B2 Capability | AnythingLLM · Plane · Chat 自建 |
| B3 Memory | AnythingLLM + Heptabase · Agent Feed · Chat 自建 |
| B4 Permission | Agent Feed · Heptabase · Chat 自建 |
| C1 Goal/Clarify | AnythingLLM Survey · Agent Feed · Chat 自建 |
| C2 Plan/Confirm | Agent Feed · Chat 自建 |
| C3 Flow Define | AnythingLLM Flow Builder · Chat 自建 |
| C4 Config/Version | AnythingLLM Agent Config · Chat 自建 |
| C5 Trigger | AnythingLLM Scheduled · Chat 自建 |
| C6 Run/Progress | AnythingLLM Run detail + Agent Feed · Orca |
| C7 Checkpoint/HITL | Agent Feed + AnythingLLM Survey · Orca |
| C8 Pause/Resume | Chat 自建（无参考） |
| C9 Failure/Reconcile | Agent Feed outcome_unknown · AnythingLLM |
| C10 Artifact Review | Orca diff · Heptabase · AnythingLLM Files |
| C11 Delivery/Writeback | Linear Update + AnythingLLM Continue · Plane |
| C12 History/Continue | AnythingLLM Run History · Linear Pulse |

## 9. 证据与未知

### 证据来源

- [九项工作台总报告 v0.2](./nine-workbench-study-report-v0.1.md)
- [工作台机制矩阵](./reference-workbench-mechanism-matrix-v0.1.md)
- [场景矩阵与冻结登记](./reference-scenario-matrix-v0.1.md)
- [AnythingLLM 完整参考研究 v0.2](./anythingllm-workbench-study-v0.1.md)
- [AnythingLLM Agent Constitution / Workflow 视觉证据 v0.1](./evidence/anythingllm-agent-constitution-workflow-v0.1/README.md)
- [九项视觉索引](./evidence/reference-workbench-mechanism-index-v0.1.png)

### 共同未知（U）

1. **完整耐久 Agent Profile**：把身份、职责、能力、记忆、权限、当前工作和贡献历史统一在一起。没有任何参考（U）。
2. **Plan 版本确认**：editable Plan → versioned confirm 的完整路径只有 Agent Feed 部分覆盖（F），其他项目不覆盖。
3. **真正 Pause / Resume**：所有参考都只证明 Stop/Abort，不证明暂停后可恢复（U）。
4. **Definition version / publish**：Flow Builder 没有证明版本历史或发布审批（U）。
5. **跨表面连续性**：同一 Work 在 Project Room / Today / Agent Feed / Workbench 间往返仍保持身份、revision、返回位置和未提交草稿（U）。
6. **正式 Evidence / Contribution**：Evidence 验证、版本、贡献归属与完成门（U）。
7. **移动端等价交互**（U）。

## 10. HTML 视觉选型板范围确认

下一步将制作 HTML 视觉选型板，用于辅助用户直观选择。范围确认：

### 10.1 轴/场景 → 代表截图映射

以下映射全部使用带前缀命名；每张代表图均已确认存在于对应 evidence 目录。

#### A 轴代表截图

| 表面 | 代表截图 | 文件 | 命题 |
|---|---|---|---|
| A1 Project/Work | Plane Intake / work item | `evidence/plane-v0.1/screenshots/04-detailed-intake-work-item.webp` | Work-object-owned + Intake 审核 |
| A2 Conversation | AnythingLLM 对话起点 | WB-02 `evidence/anythingllm-v0.1/screenshots/02-anythingllm-start-official-1240x720.png` | Conversation-owned 消息流 |
| A2 Survey | Agent Survey 卡片 | ACW-21 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/21-agent-survey-multiple-choice.webp` | 对话内结构化澄清 |
| A3 Execution | Open Computer 运行 | WB-06 `evidence/anythingllm-v0.1/screenshots/06-open-computer-active-run-official-1280x720.png` | Workspace-owned + sidecar |
| A4 Artifact | Orca diff 批注 | `evidence/orca-v0.1/screenshots/03-diff-annotation.png` | diff 行级批注 |
| A5 Feed | Agent Feed typed supervision | `../reference-implementations/microsoft-agent-feed-human-loop-v0.2/evidence/current-audit/01-needs-attention.png` | Supervision-feed-owned |
| A6 Knowledge | Heptabase Whiteboard | `../combination-prototypes/evidence/stage1/visual-compare/heptabase-whiteboard-final-raw.png` | Knowledge-canvas-owned |
| A7 Today | Things Today | `../combination-prototypes/evidence/stage1/visual-compare/things-today-final-raw.png` | Attention/time projection |
| A8 Delivery | Linear Updates | `../combination-prototypes/evidence/stage1/mobile-audit/work-linear-updates-391x844.png` | Update 历史/交付表面；负责人署名语义另由 audit 支持 |

#### B 轴代表截图

| 类别 | 代表截图 | 文件 | 命题 |
|---|---|---|---|
| B1 Identity | Agent Feed participant / owner | `../reference-implementations/microsoft-agent-feed-human-loop-v0.2/evidence/browser-qa/15-delegated.jpg` | participant、current owner、delegation visibility；AnythingLLM ACW-23 仅补 provider/model 配置 |
| B2 Capability | MCP Management | ACW-10 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/10-mcp-management-ui.png` | Skills/Flows/MCP 同页 |
| B3 Memory | Memory Sidebar | ACW-02 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/02-memory-sidebar.webp` | Workspace/Global scope |
| B4 Permission | Agent Feed delegation | `../reference-implementations/microsoft-agent-feed-human-loop-v0.2/evidence/browser-qa/15-delegated.jpg` | visible to participants + current owner + bounded delegation |

#### C 轴代表截图

| 阶段 | 代表截图 | 文件 | 命题 |
|---|---|---|---|
| C1 Goal entry | AnythingLLM Conversation | WB-02 `evidence/anythingllm-v0.1/screenshots/02-anythingllm-start-official-1240x720.png` | 自然语言入口；不证明显式 Goal 对象 |
| C1 Clarify | Agent Survey | ACW-21 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/21-agent-survey-multiple-choice.webp` | 对话内结构化澄清 |
| C2 Plan/Confirm | Agent Feed Decision | `../reference-implementations/microsoft-agent-feed-human-loop-v0.2/evidence/current-audit/02-decision-detail.png` | revision/hash/scope + Approve/Request changes |
| C3 Flow Define | Flow Builder | ACW-05 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/05-agent-flow-new.png` | 独立 Definition 表面 |
| C4 Config | Agent Configuration | ACW-23 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/23-workspace-agent-configuration.webp` | 模型选择 |
| C5 Trigger | Scheduled Job Create | ACW-18 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/18-scheduled-job-create.webp` | Trigger + allowed tools |
| C6 Run | Run Detail Sections | ACW-14 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/14-scheduled-job-run-detail-sections.webp` | 同屏 Thinking/Tool Calls/Files/Response |
| C7 HITL | Agent Feed Decision | `../reference-implementations/microsoft-agent-feed-human-loop-v0.2/evidence/current-audit/02-decision-detail.png` | 人工审批/请求修改；Survey 另覆盖 ask-user |
| C8 Cancel boundary | Stop Control | ACW-12 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/12-scheduled-job-running-stop-control.webp` | 只证明终止入口；真正 Pause/Resume 无参考 |
| C9 Failure/Reconcile | Agent Feed Reconcile | `../reference-implementations/microsoft-agent-feed-human-loop-v0.2/evidence/browser-qa/12-reconciling.png` | outcome_unknown、禁止盲重试、查询对账 |
| C10 Artifact Review | Orca diff 批注 | `evidence/orca-v0.1/screenshots/03-diff-annotation.png` | 锚定行级评论；AnythingLLM ACW-16 只补 Files 展示 |
| C11–C12 Continue | Continue in Thread | ACW-14 `evidence/anythingllm-agent-constitution-workflow-v0.1/screenshots/14-scheduled-job-run-detail-sections.webp` | Run → Conversation 返回路径 |

### 10.2 包含

- A 轴 8 个表面的代表截图和布局对照
- B 轴 4 类 Constitution 的代表截图（ACW-23 Agent Config / ACW-10 Skills/MCP / ACW-02 Memory / Agent Feed delegation）
- C 轴 4 段的代表截图（ACW-21 Survey → ACW-05 Flow Builder → ACW-14 Run detail → ACW-14 Continue in Thread）
- 三轴组合的查表界面

### 10.3 不包含

- 不制作可交互原型
- 不修改生产 UI
- 不部署或推送
- 不创建 PR 或提交

**当前停点**：候选与证据已经准备好，请用户选择工作台三轴组合。用户明确选择前不制作 HTML 视觉选型板；选择后是否进入原型或实现，由用户另行授权。
