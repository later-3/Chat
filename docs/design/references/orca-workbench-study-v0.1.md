---
status: candidate
version: 0.1
date: 2026-08-12
scope: Orca 8/9 工作台单项研究
evidence: Orca 官方仓库产品 GIF/JPG 逐帧抽取 + 固定源码核对
---

# Orca 工作台单项研究 v0.1

> 本文是 9 项工作台研究集中 Orca 的单项研究卡。截图来自 Orca 官方仓库产品 GIF/JPG 逐帧抽取并人工检查，非本地运行实例。证据标记：`O` = 本卡对既有画面的可见观察；`F` = 已批准审计/矩阵中的冻结事实；`I` = 跨证据归纳；`U` = 当前未知/未验证。

## 1. 结论卡

| 维度 | 结论 | 证据 |
|---|---|---|
| 定位 | 任务隔离工作空间 + 多 Agent 监督 + Artifact 锚定反馈：解决"多 Agent 怎样进入同一任务空间，人怎样在 Artifact 上批注并交回指定 Agent" | F · evidence card §1, §4 |
| 页面中心所有者 | **Task/workspace-owned**：Project/repo group → Worktree/task workspace 拥有页面中心；Chat/terminal/editor/browser/diff/PR 都只是 pane，不是唯一中心 | F · evidence card §4.1 |
| 最适合 Chat 的场景 | 多 Agent 并行编码监督、Artifact 评审回路、可恢复工作面布局 | F · evidence card §6 Take; §7 |
| 最强可迁移机制 | worktree/task 行内状态（Working/Needs You/Done/Failed）；Agent 行与真实工作面互相定位；异构 pane tree；Artifact 锚定反馈（行级批注→批量交回指定 Agent） | F · evidence card §6 Take |
| 对人—Agent 工作台的主要缺口 | coding-only；无自然语言可编辑 Plan；无产品级 Run 终态；无 participant/visibility 完整合同；无正式 Evidence/Decision/非 coding 产品写回 | F · evidence card §6 Refuse; §8 |

## 2. 一张已检查画面

![Orca 工作台三种关键状态同尺度对照](./evidence/orca-v0.1/orca-workbench-visual-strip.png)

**画面性质**：Orca 官方仓库产品 GIF/JPG 逐帧抽取并人工检查，非本地运行实例。同尺度三帧（640×360）分别证明 Agent 状态嵌工作条目、diff 行级批注、异构 pane tree。静态帧不证明完整路径。

**可见布局**（O）：

- **左帧：Agent 状态嵌在工作条目里**：左侧多个 worktree/task 条目，`Agent Statuses` 展开 `AGENTS (2)`；每个 Agent 行有任务摘要、状态符号（Working/Needs You/Done/Blocked/Idle）、最近活动时间和一行预览；右侧保留当前工作输出。
- **中帧：人工意见直接锚定 Artifact**：主体是 `All Changes` diff，人在 `LINE 21` 打开批注框输入具体修改意见；批注粒度是 diff 行/行段。
- **右帧：工作面是可嵌套的 pane tree**：左侧任务/worktree 导航、中央 8 个可见终端 pane（尺寸和嵌套关系不均匀）、右侧文件树同屏存在。

**健康度**：健康 — 三种关键状态（Agent 监督、Artifact 批注、异构工作面）在同一视觉语法下共存。"找到需要关注的 Agent"和"查看它正在做什么"不必跳到另一套产品（F · evidence card §3.1）。

**可见优点**：
- worktree/task 行内状态：用户不用进入每个会话就能发现 Working/Needs You/Done/Failed（F · evidence card §6 Take #1）。
- Agent 行与真实工作面互相定位：状态不是孤立 feed，点击可回到具体运行 pane（F · evidence card §6 Take #2）。
- 异构 pane tree：Chat、浏览器、文件、diff、白板等能在同一工作面并排（F · evidence card §6 Take #3）。
- Artifact 锚定反馈：评论先绑定具体产物位置，再批量交回指定 Agent（F · evidence card §6 Take #4）。
- 未识别 shell 不冒充 Agent：Participant/Agent 身份必须由真实运行证据支持（F · evidence card §6 Take #5）。

**可见风险/可访问性风险**：
- 视觉原则"monochrome and quiet"，中性色承载 chrome，颜色只用于状态/危险/git decoration（F · evidence card §5）；但状态符号的对比度和色盲友好性未实测（U）。
- diff 行级批注的键盘等价路径、屏幕阅读器播报未证明（U）。
- pane tree 的拖拽调整、焦点管理、Escape 关闭行为未证明（U）。

**证据限制**：静态帧只证明布局结构存在。不证明 Plan/暂停恢复/失败恢复/权限边界/Agent—Agent 调度（F · evidence card §3.1）。不证明完整 Artifact 评审闭环（批注→发送→修订→Resolve 的全路径）。

## 3. 一条核心路径

路径事实来自证据卡（F），不来自本截图的实际运行。

```text
任务/worktree 创建（后台进度、可取消、失败后 Retry）（F · evidence card §4.1, §4.4）
  → 多 Agent 状态呈现（Working/Needs You/Done/Blocked/Idle）（F · evidence card §4.2）
  → 聚焦具体 pane（从状态行直接定位到对应 terminal/editor/diff pane）（F · evidence card §5）
  → Agent 修改文件（F · evidence card §4.3）
  → 人在 diff 精确行/行段上留下多条 review notes（F · evidence card §3.2, §4.3）
  → notes 保留行锚点并组成一批（F · evidence card §4.3）
  → 批量选择接收 Agent（当前 worktree 的可用 Agent 或新开 Agent）（F · evidence card §3.2, §5）
  → Send to agent（汇成一个带行锚点的 prompt）（F · evidence card §3.2）
  → Agent 修订（F · evidence card §4.3）
  → 原 notes 仍在，供复核 / Resolve / 加入下一批复审（F · evidence card §3.2, §4.3）
```

**关键事实**：
- 人影响 Agent 的方式：聚焦状态、行级 Artifact 批注、批量交回指定 Agent、Abort/Retry（F · evidence card §4.2, §4.3, §6 Take）。
- 多终端不等于多 Agent：普通 shell 没有 Agent 身份或状态标识（F · evidence card §3.3）。
- 结果写回是 diff notes 的行锚点与工作空间布局恢复；仍无正式 Evidence/Decision/非 coding 产品写回（F · evidence card §4.3, §8）。

**长任务三层能力**（F · evidence card §4.4）：

1. **任务空间层**：worktree 创建有后台进度、取消、失败和 Retry。
2. **Agent 进程层**：Launch → Work → Idle → Exit，退出后出现 Restart chip。
3. **资源回收层**：实验性 hibernation 只在 Agent done、无人操作、无未决 dispatch、无活跃子 Agent 等条件同时成立时暂停；重新打开 worktree 时按 provider session 自动恢复，恢复失败则进入新 prompt，旧 transcript 仍可查看。

**这不是一个统一的 `Run` 状态机**。对 Chat 来说，应借鉴它的可见边界，但不能把 worktree、terminal process、Agent session 和产品 Run 合并（F · evidence card §4.4）。

## 4. 工作台交互语法（六层职责）

| 层 | Orca 事实 | 证据 |
|---|---|---|
| 作用域/导航 | Project/repo group → Worktree/task workspace；左侧 worktree 导航 + Agent 状态行 | F · evidence card §3.1, §4.1 |
| 主工作表面 | 异构 pane tree（terminal/editor/browser/diff/PR tabs 嵌套分屏）；Chat 可以是一个 pane，但不是唯一中心 | F · evidence card §3.3, §4.1 |
| 上下文副表面 | Agent 状态行内嵌在 worktree 条目中；右侧文件树；diff 批注框 | F · evidence card §3.1, §3.2, §5 |
| 连续性 | worktree 持有连续性（边界位置和整棵布局按 worktree 保存，切换时整套恢复） | F · evidence card §3.3, §4.1 |
| 人工检查点 | 聚焦 Agent 状态、行级 diff 批注、批量选择接收 Agent、Abort/Retry | F · evidence card §4.2, §4.3, §6 Take |
| 结果/证据写回 | diff notes 行锚点持久化；工作空间布局恢复；无正式 Evidence/Decision/产品写回 | F · evidence card §4.3, §8 |

## 5. 布局为什么成立

**任务隔离工作空间是骨架**是 Orca 最核心的设计决定（F · evidence card §4.1, §7）：

Orca 的层级是 Project/repo group → Worktree/task workspace → Agent sessions + Terminal/editor/browser/diff/PR tabs + Nested pane layout + Review/ship lifecycle（F · evidence card §4.1）。

这说明 Orca 的"连续性"主要由 task/worktree 持有，而不是由一条聊天记录持有。Chat 可以是一个 pane，但不是工作台的唯一中心（F · evidence card §4.1）。

**与 AnythingLLM / Open Computer 的区分**（F · evidence card §7, I）：

| 参考 | 主要所有者 | 工作面语法 | 人工介入 | 最有价值的缺口覆盖 |
|---|---|---|---|---|
| AnythingLLM | conversation / workspace | Chat 为主，工具和结果围绕会话展开 | 继续对话、配置 Agent / 工具 | 基础对话型 Agent 工作区 |
| Open Computer | task workspace | 运行过程与文件/结果面更突出 | 观察、停止、取回产物 | 单 Agent 的电脑式执行工作面 |
| **Orca** | **task/worktree** | **左侧任务与 Agent 状态 + 中央异构 pane tree + 文件/diff** | **聚焦 Agent、行级批注、批量发回指定 Agent** | **多 Agent 监督、Artifact 评审回路、可恢复工作面布局** |

Orca 不是"传统 Chat 再加一个右侧预览"。它把任务隔离空间设为骨架，Chat/terminal 只是其中一种运行表面；这正是它与 AnythingLLM 的结构性差异（F · evidence card §7）。

**Artifact 锚定反馈是"先批注、后成批发送"**（F · evidence card §4.3）：

```text
Agent 修改文件
→ 人在 diff 精确行上留下多条 review notes
→ notes 保留行锚点并组成一批
→ 人选择当前 worktree 的某个可用 Agent，或新开 Agent
→ Agent 修订
→ 原批注仍在，供复核 / Resolve / 再发送
```

它把"对中间产物评论"与"给 Agent 发下一轮自然语言"连接起来，但没有把 Artifact 退化成聊天附件（F · evidence card §4.3）。

## 6. Chat 的 Take / Adapt / Refuse

### Take

1. worktree/task 行内状态：用户不用进入每个会话就能发现 Working/Needs You/Done/Failed（F · evidence card §6 Take #1）。
2. Agent 行与真实工作面互相定位：状态不是孤立 feed，点击可回到具体运行 pane（F · evidence card §6 Take #2）。
3. 异构 pane tree：Chat、浏览器、文件、diff、白板等应能在同一工作面并排，而不是每种对象单独造一个固定页面（F · evidence card §6 Take #3）。
4. Artifact 锚定反馈：评论先绑定具体产物位置，再批量交回指定 Agent（F · evidence card §6 Take #4）。
5. 未识别 shell 不冒充 Agent：Participant/Agent 身份必须由真实运行证据支持（F · evidence card §6 Take #5）。

### Adapt

1. 把 Git worktree 抽象为 Chat 的 `Work / Scope / Run workspace`，保留任务隔离和布局恢复，不复制 coding 专用对象（F · evidence card §6 Adapt #1）。
2. 把 `terminal pane` 扩展为 Chat 可识别的 Chat、Artifact、Browser、File、Whiteboard、Calendar、Task Board、Evidence pane（F · evidence card §6 Adapt #2）。
3. 把 diff 批注推广为任意 Artifact 的 block/range/cell/object 批注（F · evidence card §6 Adapt #3）。
4. 把 Agent 状态点与可读的阶段、当前动作、等待原因、最近证据组合，避免只靠颜色（F · evidence card §6 Adapt #4）。
5. 把自动 hibernation 适配为 Chat 自己的耐久 Run/Checkpoint 语义，而不是直接停止外部进程（F · evidence card §6 Adapt #5）。

### Refuse

1. 不接受"worktree 就是权限沙箱，因此 Agent 默认全自治"的安全模型。Orca 当前会给受支持 Agent 预置 full-autonomy 启动参数；Chat 必须显式展示权限、可见范围和写回范围（F · evidence card §6 Refuse #1）。
2. 不把 terminal 当成 Agent，不把 CLI 进程状态当成产品 Run 终态（F · evidence card §6 Refuse #2）。
3. 不照搬 coding-only 的 Project → repo → branch 词汇（F · evidence card §6 Refuse #3）。
4. 不把实验性自动休眠当成可靠暂停/恢复证明（F · evidence card §6 Refuse #4）。
5. 不用宣传合成图证明完整交互路径（F · evidence card §6 Refuse #5）。

## 7. 覆盖与不覆盖

### 覆盖

| 场景 | 判定 | 证据 |
|---|---|---|
| 多 Agent 监督与 Artifact 评审回路 | **部分覆盖**：worktree 行内 Agent 状态、异构 pane tree、diff 行级批注→批量交回指定 Agent | F · evidence card §3, §4, §6 Take |
| 可恢复工作面布局 | **部分覆盖**：worktree 持有连续性，边界位置和整棵布局按 worktree 保存，切换时整套恢复 | F · evidence card §3.3, §4.1 |

### 不覆盖

| 能力 | 证据 |
|---|---|
| 自然语言目标怎样变成可编辑 Plan | F · evidence card §8 |
| Plan 假设、范围、资料和权限怎样共同确认 | F · evidence card §8 |
| 非 coding 场景的 Evidence、Calendar、Todo、Whiteboard 与 Run 怎样闭环 | F · evidence card §8 |
| Agent—Agent 协作中的 participant、visibility 和决策责任怎样表达 | F · evidence card §8 |
| 产品级暂停/恢复/结果未知/外部副作用对账怎样呈现 | F · evidence card §8 |
| 正式 Evidence / Decision / 非 coding 产品写回 | F · evidence card §8 |
| 完整 Project 对象链（Stage → Milestone → Iteration → Work → Scope → Action → Update → Gate → Decision） | F · matrix §6.1 #1 |
| 跨表面连续性（同一 Work 在 Project Room / Today / Agent Feed / Workbench 间往返） | F · matrix §6.1 #4 |
| 失败 / 等待 / 恢复状态的完整交互证明 | U |

**结论**：Orca 是 Chat 工作台的**任务隔离 + 多 Agent 监督 + Artifact 锚定反馈参考**，不是完整人—Agent 工作台答案。它回答"多 Agent 怎样进入同一任务空间"和"人怎样在 Artifact 上批注并交回指定 Agent"，但不回答"Plan 怎样审核""非 coding 场景怎样闭环""结果是否可靠""证据在哪里""知识怎样编排"。

## 8. 证据边界

以下事项本截图与证据卡**不能证明**：

| 未证明 | 等级 |
|---|---|
| Plan/暂停恢复/失败恢复/权限边界/Agent—Agent 调度 | F · evidence card §3.1 |
| 完整 Artifact 评审闭环（批注→发送→修订→Resolve 的全路径） | F · evidence card §4.3 |
| 状态符号的对比度和色盲友好性 | U |
| diff 行级批注的键盘等价路径、屏幕阅读器播报 | U |
| pane tree 的拖拽调整、焦点管理、Escape 关闭行为 | U |
| 实验性 hibernation 的可靠暂停/恢复证明 | F · evidence card §6 Refuse #4 |
| 自然语言可编辑 Plan | F · evidence card §8 |
| 非 coding 场景闭环 | F · evidence card §8 |
| participant/visibility 完整合同 | F · evidence card §8 |
| 正式 Evidence / Decision / 产品写回 | F · evidence card §8 |

证据卡中的事实（F）来自 Orca 官方仓库产品 GIF/JPG 逐帧抽取、官方文档和固定源码核对，不由本卡截图单独证明。本截图组只证明任务隔离工作空间、多 Agent 监督和 Artifact 锚定反馈的视觉结构存在。

---

> Orca 8/9 已整理；本阶段只完成研究卡，未制作原型。
