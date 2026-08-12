---
status: candidate_selection
version: 0.1
date: 2026-08-12
scope: Chat 工作台骨架与八场景选择菜单
evidence: 9 项工作台研究 + 2 份总矩阵 + 视觉索引
---

# Chat 工作台骨架与场景选择 v0.1

> 这是给用户直接选择的菜单，不是新的全景调研，也不是实现任务。证据标记：`F` = 仓库事实/已批准审计；`O` = 已检查画面；`I` = 跨证据归纳；`U` = 未证明。

## 1. 结论

1. Chat 的产品对象、对话→Plan→人工决定→执行→正式结果闭环，以及最小运行投影底座已经存在（F）。Rich Artifact 审阅、执行工作空间、多 Agent 监督、Today / Calendar / Canvas 等表面尚未完整具备或未定型（F/U）。
2. 不需要复制九套产品。工作台可以收敛为：**一个稳定六层骨架 + 三种默认页面中心 + 八个场景模块**（I）。
3. 最关键的选择不是左栏还是右栏，而是：此刻由 Conversation、Project/Work，还是执行工作空间拥有页面中心；其他信息退到 Peek / Drawer / Sidecar（I）。
4. 当前推荐顺序：**G2 对话入口 + 自适应工作台**、**G1 对象优先**、**G3 执行工作空间优先 / 多 Agent**。
5. 本轮停在选择门，不制作原型，不修改生产 UI。

## 2. 九项视觉索引

![九组工作台机制视觉索引](./evidence/reference-workbench-mechanism-index-v0.1.png)

| 位置 | 参考 | 主要证明的页面中心 | 证据边界 |
|---|---|---|---|
| (0,0) | Basecamp | Project Room | Chat 冻结参考原型已验收画面 |
| (0,1) | Things | Today 注意力投影 | Chat 冻结参考原型已验收画面 |
| (0,2) | Linear | Work List + Peek | Chat 冻结参考原型已验收画面 |
| (1,0) | HEY Calendar | Day / Week / Year 时间投影 | Chat 冻结参考原型已验收画面 |
| (1,1) | Microsoft Agent Feed | 类型化监督 Feed | Chat 冻结参考原型已验收画面 |
| (1,2) | Heptabase | Knowledge Canvas | Chat 冻结参考原型已验收画面 |
| (2,0) | AnythingLLM / Open Computer | Conversation / 执行工作空间 | 官方/一手画面，非本地运行 |
| (2,1) | Orca | Task / 执行工作空间 | 官方仓库逐帧，非本地运行 |
| (2,2) | Plane | Project / Work object | 官方画面 + 部分开源源码，非本地完整运行 |

**静态图限制**（F）：这些画面只证明已看到的布局结构，不证明悬停、拖拽、键盘、屏幕阅读器、失败、等待、恢复、暂停或移动端等价路径。

## 3. 稳定骨架：六层职责

所有 9 项都可以还原为 6 层职责（I）。具体位置可以变，但职责不能丢。

| 层 | 回答的问题 | Chat 必须固定 | 可选择的呈现 |
|---|---|---|---|
| 1. 作用域 / 导航 | 我现在在哪个范围？ | Portfolio、Project、Product Session 身份不混合 | Rail、侧栏、搜索、收藏、面包屑 |
| 2. 主工作表面 | 我此刻主要在做什么？ | 同一时刻只有一个页面中心所有者 | Conversation、Project/Work、执行工作空间 |
| 3. 上下文副表面 | 我还需要参考什么？ | 副表面不复制权威事实 | Peek、Drawer、Sidecar、Context sidebar |
| 4. 对象身份 / 连续性 | 切走再回来还是同一件事吗？ | 保持 identity、revision、返回位置、未提交草稿 | 返回锚点、焦点恢复、布局恢复 |
| 5. 人工检查点 | 我在哪里修改、确认或介入？ | 高影响动作走 Chat Decision、版本/Hash/权限/幂等校验 | 内嵌 Plan、Peek、Feed、Artifact 批注 |
| 6. 结果 / Evidence 写回 | 最终结果保存在哪里？ | Product Store 和真实 Resource owner 仍是事实源 | Update、对象状态、Artifact、Evidence 绑定 |

### 已具备、必须固定、仍待选择

| 已具备的底座（F） | 必须固定的边界（F） | 仍待选择或补齐（I/U） |
|---|---|---|
| 响应式 PWA、对话与正式消息 | Product Store 拥有权威产品事实 | 默认页面中心和表面切换方式 |
| 可修订/批准/拒绝的 Plan 与 Decision | 模型输出先是 candidate | Rich Artifact / File / Evidence 审阅 |
| Workflow 耐久执行、最小 Run 投影 | 浏览器不直接调用 Workflow / pi | Open Computer / Orca 式执行工作空间 |
| Memory 查询/导入、Trace / Replay | Feed / Today / Calendar / Canvas 只是投影 | 多 Agent 全局监督和任务内协作 |
| Project、Stage、Milestone、Work、Action、Update 等事实 | Product Session、Product Run、Run Attempt、Workflow Run、pi Session 不合并 | Today、Calendar、Canvas 和交付表面 |

> 术语：`Project Workspace` 是 Chat 当前的项目页面/投影；`执行工作空间`是 Open Computer / Orca 式桌面、浏览器、文件和 pane 现场。二者不是同一个对象。当前主线实际 Store 版本为 `chat-product-store.v10`，P6 Run Viewer / Designer 核心已落地；这些事实只证明底座，不代表工作台组合已经冻结。

## 4. 三种默认页面中心（S）

| 代码 | 方向 | 页面中心与布局 | 最适合 | 优势 | 代价 / 拒绝照搬 | 定位 |
|---|---|---|---|---|---|---|
| **S2** | 对话优先 | Conversation 默认居中；显式进入执行、文件或 Artifact 场景时让位，Chat 可变 sidecar，返回后恢复原对话位置 | 对话驱动的规划与协作 | 最符合 Chat“以对话为入口”；认知与改造成本最低 | 多 Project 扫描较弱；不让 Thread 吞并 Project，不自动抢屏 | **当前首选** |
| **S1** | 对象优先 | Project / Work 默认居中；对话从对象内触发 | 多 Project、长期推进、高密度 Work | 长期目标、Work 和状态更容易扫读 | 纯对话多一步；不复制 Plane 五套事实或 Basecamp 六宫格 | 长期 Project 备选 |
| **S3** | 执行工作空间优先 | 桌面 / 浏览器 / 文件 / pane 居中；Chat 成为 sidecar | 多 Agent、工具执行、Artifact 密集审阅 | 执行现场与多 Agent 状态最完整 | 依赖最多；不把 VNC 当通用模式，不把 terminal 当 Agent | 未来目标态 |

## 5. 八个场景选择

### P — Project / Work 管理

| 代码 | 参考机制 | 页面与交互 | 适合 / Chat 适配 | 拒绝照搬 |
|---|---|---|---|---|
| P1 | Plane Work-object + 多布局 + Intake | Project / Work item 居中；同一对象集合切 List、Board 等布局；候选先进入 Intake | 结构化协作；映射 Chat Stage/Milestone/Work/Action。Iteration / Shaping 仍属后续独立范围 | 不复制多套事实；Intake Accept/Decline 不等于完整 HITL |
| P2 | Basecamp Project Room | Account → Project → Tool → Item；稳定返回 | 多 Project 地点感与团队协作 | 不把六宫格当全局骨架，不让 Tool 拥有事实 |
| P3 | Linear List / Peek / Detail | List 扫描 → Peek 临时理解 → Detail 深入 | 高频 Work 读写；Chat Work 不等于 Issue | 不把 Issue 当全部层级，不从完成比例推健康 |

推荐：S1→P1；S2→P3；S3→P2。

### C — Goal / Chat / Plan

| 代码 | 参考机制 | 页面与交互 | 适合 / Chat 适配 | 拒绝照搬 |
|---|---|---|---|---|
| C1 | AnythingLLM Conversation-owned + Chat 当前 B2 | Thread / composer / Plan / Sources 都紧贴消息 | 问答、澄清、快速 Plan 审核 | 不把 token 数当进度，不让 Thread 吞并 Project |
| C2 | Open Computer Workspace-owned | 从对话显式进入执行工作空间；Chat 退到 sidecar；可返回原对话 | 工具、文件、浏览器任务；负责“怎样进入/返回” | 不自动切换，不照搬固定 sidecar 宽度 |
| C3 | C1 + C2 自适应 | 目标/澄清/Plan 时 Conversation；用户进入执行阶段后切换中心，完成/退出后恢复 | 最符合“对话为入口、工作表面按任务让位” | 切换必须显式且保留对象与草稿 |

推荐：S1→C1；S2→C3；S3→C3。

### R — Run / Workspace / Tool 现场

| 代码 | 参考机制 | 页面与交互 | 适合 / Chat 适配 | 拒绝照搬 |
|---|---|---|---|---|
| R1 | Chat 当前最小 Run Viewer | 时间线 / 步骤作为副表面，显示工作进度但不拥有终态 | 当前 Planning-Execution 看护 | 不暴露 Runtime 私有身份，不把 Viewer 当控制台 |
| R2 | Open Computer 桌面 + sidecar | 进入执行工作空间后显示桌面、浏览器、文件、日志；C2 负责进入/返回 | 通用电脑操作和浏览器任务 | 不把 VNC 当所有任务的主表面 |
| R3 | Orca pane tree / task workspace | 执行工作空间拥有 terminal/editor/browser/diff 等 pane 的布局 | 多 Agent 编码、复杂 Artifact 现场 | 不把 terminal 当 Agent，不照搬 coding 复杂度 |

推荐：S1/S2→R1；S3→R3。

### A — Artifact / File / Evidence 审阅

| 代码 | 参考机制 | 页面与交互 | 适合 / Chat 适配 | 拒绝照搬 |
|---|---|---|---|---|
| A1 | Orca Diff 行级批注 | 单个 Artifact 居中；行级批注 → 批量交回指定 Agent | 代码、文档和可锚定内容的精确审阅 | 不限制在 coding，不让 terminal 拥有审阅 |
| A2 | Heptabase 单个 Artifact + context | 检查、评论、接受/拒绝；显式显示采用的 context / provenance | 研究材料和知识类 Artifact | 不把位置/颜色/连线当权威状态 |
| A3 | Linear Peek / Detail | 列表扫读 → Peek 快速检查 → Detail 深入 | 轻量文件和 Evidence 检查；作为主表面的临时副表面 | 不把所有详情塞进抽屉 |

推荐：S1/S2→A3；S3→A1。

### M — 多 Agent / HITL / 异常监督

| 代码 | 参考机制 | 页面与交互 | 适合 / Chat 适配 | 拒绝照搬 |
|---|---|---|---|---|
| M1 | Microsoft Agent Feed typed supervision | Needs Attention / Completed 分流；任务类型决定 Complete、Accept、Dismiss、Reconcile、Escalate | 全局回答“先看什么”；当前单 Agent 时可退化为内嵌检查点 | Feed 不是事实源；outcome_unknown 不普通 Retry |
| M2 | Orca 任务内多 Agent | 执行工作空间内显示 Working / Needs You / Done / Blocked；人聚焦 Agent 或处理请求 | 回答“这个任务里谁在做、谁在等我” | 不让状态头像代替权限、风险或 Evidence |
| M3 | M1 + M2 双层 | 全局 Feed 选择任务 → 进入任务内执行工作空间处理 | 完整多 Agent 监督 | 全局与任务内不能建立两套事实 |

推荐：S1/S2→M1；S3→M3。

### K — Knowledge / Canvas / Context

| 代码 | 参考机制 | 页面与交互 | 适合 / Chat 适配 | 拒绝照搬 |
|---|---|---|---|---|
| K1 | Heptabase canonical object × placement | Card Library 是内容源；Whiteboard 只保存 placement；显式 context 和 searched/viewed 日志 | 长期资料收集、关联、空间编排 | 不把无限画布当首页，不让 placement 变产品事实 |
| K2 | Plane Page / Work 内知识 | 文档与知识块贴在 Work object 中 | 结构化项目知识与文档型 Evidence | 不让 Page block 冒充独立知识对象 |
| K3 | K1 + K2 混合 | 长期事实留 Chat 对象；Canvas 只保存 placement 与视图配置 | 最符合 Chat Product Store 边界 | 不把 Canvas 状态写成领域事实 |

推荐：S1→K3；S2→K2；S3→K1。

### T — Today / Todo / Calendar

| 代码 | 参考机制 | 页面与交互 | 适合 / Chat 适配 | 拒绝照搬 |
|---|---|---|---|---|
| T1 | Things Today | 跨 Project Action 投影；原位详情；When / Move / Complete 分责 | 回答“今天做什么” | 不把所有对象 checkbox 化，不让 Today 拥有 Project |
| T2 | HEY Day / Week / Year | 连续时间尺度；source → candidate → conflict → save/cancel | 回答“什么时候做”与时间冲突 | 不让 Calendar 拥有 Work / Project |
| T3 | T1 + T2 双投影 | Today 选做什么，Calendar 决定何时做；Action 与 Event 保持不同身份 | 完整个人节奏与时间承诺 | 不共享同一完成或优先级语法 |

推荐：三种骨架当前都先选 T1；T3 是完整目标。

### D — 结果交付 / Update / 写回

| 代码 | 参考机制 | 页面与交互 | 适合 / Chat 适配 | 拒绝照搬 |
|---|---|---|---|---|
| D1 | Linear 署名 Project Update | author + health + narrative + observed changes → history / Pulse | Project 健康、跨 Project 扫描；Chat 已有 Update 对象 | 不让 Activity / Agent 摘要冒充负责人 Update |
| D2 | Plane 对象写回 | Work item 状态或可编辑 Page block 写回原 Project | 结构化工作交付 | 模型结果仍先是 candidate，不把 Accept 当完整 HITL |
| D3 | Heptabase Artifact + provenance → Chat Evidence | 审阅后保存可继续编辑的 Artifact，并绑定来源与正式 Evidence | 研究与知识类交付 | 无来源 AI Card 不能自动成为正式事实 |

推荐：S1/S2→D1；S3→D2。

### 同源机制为什么不重复

| 场景职责 | 只回答什么 | 不回答什么 |
|---|---|---|
| C | 怎样从对话进入/返回某个工作表面 | 进入后显示哪些运行状态 |
| R | Agent/Tool 正在什么现场做什么 | 哪个 Agent 请求应先处理 |
| M | 谁在做、谁在等待、什么风险先看 | 执行工作空间怎样布局 |
| A | 当前 Artifact 怎样评论、修订、接受/拒绝 | 长期知识怎样编排 |
| K | 长期对象、context 和 placement 怎样复用 | 本轮交付何时正式成立 |
| D | 审阅后的结果怎样发布、写回和绑定 Evidence | 具体审阅动作本身 |

一句话：Feed 决定“先看什么”，执行工作空间决定“在哪里做”，Artifact 决定“正在审什么”，交付决定“什么正式留下”。

## 6. 三套推荐组合

下表中的“中心”是该场景激活时的临时页面中心，不是多个中心同时共存。

| 排名 | 组合 | 完整代码 | 补上的核心缺口 | 为什么适合 / 代价 |
|---|---|---|---|---|
| **1** | **G2 · 对话入口 + 自适应工作台** | `S2+P3+C3+R1+A3+M1+K2+T1+D1` | 保留自然语言入口，同时补 Work 扫描、显式表面切换、监督、Today 和交付 | 最符合 Chat 产品身份，改动和认知成本最低；Rich 执行现场仍需后续扩展 |
| **2** | **G1 · 对象优先** | `S1+P1+C1+R1+A3+M1+K3+T1+D1` | 让长期 Project / Work 成为首屏中心 | 适合多 Project 密集工作；纯对话多一步，Plane 多布局适配量较大 |
| **3** | **G3 · 执行工作空间优先 / 多 Agent** | `S3+P2+C3+R3+A1+M3+K1+T1+D2` | 最大程度补多 Agent、工具现场和 Artifact 锚定审阅 | 最有差异、依赖也最多；当前是未来目标态，不宜默认 |

### 组合规则

1. 同一时刻只有一个页面中心所有者；S1 / S2 / S3 决定默认中心（I）。
2. Chat 以对话为入口，但是否长期占据中心是设计选择（I）。
3. C3 的切换必须由用户动作或明确阶段动作触发；不能后台自动抢屏。
4. Sidecar / Peek / Drawer 不拥有或复制权威事实。
5. Feed / Today / Calendar / Canvas 是投影；离开后必须能从权威事实重建。
6. 同一对象跨场景保持 identity、revision、返回位置、焦点和未提交草稿。
7. 高影响动作仍受 Chat Decision、权限、版本/Hash 和幂等约束；`outcome_unknown` 不提供普通 Retry。

## 7. 直接选择

最简单的做法：先选一套 G，再只替换不喜欢的 1–2 项。

```text
G2
```

或：

```text
G2，M→M3，D→D2
```

也可以完全自定义：

```text
S2+P3+C3+R1+A3+M1+K2+T1+D1
```

| 类别 | 选项 |
|---|---|
| S 默认中心 | S1 对象 · S2 对话 · S3 执行工作空间 |
| P Project/Work | P1 Plane · P2 Basecamp · P3 Linear |
| C Chat/Plan | C1 Conversation · C2 Workspace · C3 自适应 |
| R Run/Tool | R1 Chat Viewer · R2 Open Computer · R3 Orca |
| A Artifact | A1 Diff 批注 · A2 单次 Artifact 审阅 · A3 Peek |
| M 多 Agent | M1 Feed · M2 任务内 Agent · M3 双层 |
| K Knowledge | K1 Heptabase · K2 Plane Page · K3 混合 |
| T 时间 | T1 Today · T2 Calendar · T3 双投影 |
| D 交付 | D1 Update · D2 对象写回 · D3 Artifact + Evidence |

## 8. 证据与未知

- [九项工作台总报告](./nine-workbench-study-report-v0.1.md)
- [工作台机制矩阵](./reference-workbench-mechanism-matrix-v0.1.md)
- [场景矩阵与冻结登记](./reference-scenario-matrix-v0.1.md)
- [九项视觉索引](./evidence/reference-workbench-mechanism-index-v0.1.png)

共同未知（U）：

1. 没有任何一个参考完整覆盖 goal → clarify → editable Plan → versioned confirm → Run/tool → pause/resume/cancel → failure/outcome_unknown → Artifact review → formal Evidence → writeback。
2. 没有参考证明同一 Work 在 Project Room / Today / Agent Feed / 执行工作空间之间往返时，identity、revision、返回位置和草稿全部保持。
3. 正式 Evidence 验证、Contribution 归属、participant / visibility、移动端等价路径仍需由 Chat 自己的产品合同和后续验证补足。

## 9. 当前停点

**候选与证据已经准备好，请用户选择工作台骨架与场景组合。**

用户明确选择前不制作原型；选择后是否进入原型或实现，由用户另行授权。
