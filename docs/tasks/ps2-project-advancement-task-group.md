# PS2 Project Advancement 任务组：阶段、迭代、工作推进与项目更新

| 项目 | 内容 |
|---|---|
| 状态 | 待用户审核；未批准前不得创建实现 worktree 或修改产品代码 |
| 核心目标 | 用户只靠对话和少量确认，就能持续推进一个已经建立的 Project，而不是自己维护一套项目管理表格 |
| 最终用户结果 | 明确当前阶段目标与 Milestone，塑形并承诺一次有限 Iteration，推进 Work/Scope/Action，发布负责人 Project Update，并在到期时完成一次有证据的 Review/Circuit Breaker |
| 方法依据 | Shape Up 管投入、边界、未知和到期处置；BMAD 管软件 Artifact、Work Ready、测试与 QA；Basecamp/Linear/Things 管长期项目、负责人更新和个人行动投影 |
| 交付方式 | 3 个顺序、独立 worktree/分支/PR 的纵向任务；任何内部提交、合同层或单个 PR 都不能单独宣称 PS2 完成 |
| 当前基线 | PS1 已有 Project、初始 Stage、真实 Resource/Observation、Participant、Work/Action、Decision、Contribution/Evidence、Project Intake 与最小管理候选 |
| 真实验收 | 当前服务端 Model Profile 选择真实百炼 `qwen3.7-plus` 作为验收配置；模型可替换，Provider/模型不得进入 Domain、Application Command 或浏览器合同 |

设计依据：

1. [Project Solution 方法论](../product/project-solution-methodology.md)
2. [Project Solution 架构](../architecture/project-solution.md)
3. [Project Solution 场景验证](../product/project-solution-scenario-validation.md)
4. [PS1 Project Intake 任务书](./ps1-project-intake-ledger-vertical-slice.md)
5. 固定 BMAD 源码 `/Users/xulater/Code/reference-agent-sources/BMAD-METHOD-v4.44.3`，提交 `4c4f6dc8534f95427e66e122ac5de47ac51b5f94`

## 1. PS2 完成后必须达到的效果

用户不需要先学会 Stage、Shape Up、BMAD 或 Circuit Breaker。用户可以选择一个已有 Project，然后说：

> 现在先进入“可用的项目推进”阶段。两周内打通规则集后端和最小页面，不做自动规则提炼；Kimi 开发，Codex 评审。

Chat 必须把这句话转成可读、可修改、可拒绝的候选，并在用户确认后形成以下权威事实：

1. 当前 Stage Goal、成功标准和可选 Milestone。
2. Problem、Baseline、Appetite、Payout、Solution Outline、Rabbit Holes 与 No-Gos。
3. 绑定精确 Proposal revision/Hash、Method Snapshot、人员与周期的 Iteration Commitment。
4. 有独立交付结果、AC、依赖、负责人和风险的 Work。
5. 执行中可发现的 Scope，以及现在能执行的 Action、阻塞和负责人。
6. 负责人署名的 Project Update：健康度、变化、阻塞、下一重点和 Evidence。
7. 到期 Review：完成、短扩展、重新塑形或停止；不得自动延期或覆盖失败历史。
8. 可查询的“谁改了什么、谁做了什么决定、还有哪些待办、为什么这样推进”的项目账本。

PS2 结束时，刷新页面、API/Workflow 正常重启或两个页面并发操作，都不能丢失、重复或静默覆盖这些事实。

PS2 是一个完整的“项目管理与推进决定闭环”，但不执行代码、写文档、运行脚本或部署服务。真实 Resource Action、Verify、Contribution 自动对账和 Project Context 注入属于 PS3。这个边界必须在页面和测试中明确，不能用模型文本假装资源已经被修改。

## 2. 参考输入如何进入设计

### 2.1 Shape Up：采用、调整、拒绝

| 输入 | PS2 采用 | Chat 调整 | 明确拒绝 |
|---|---|---|---|
| Appetite | 保存本轮值得投入的时间/预算边界 | 第一版支持 `timebox_days`；Operations/轻量方法可使用 review trigger | 不把 Appetite 当 Estimate |
| Shaping | Problem、Baseline、Payout、Solution、Rabbit Holes、No-Gos | 模型只给临时 Interpretation，Application 编译 Candidate | 不让模型直接创建 Proposal/Iteration |
| Betting | 显式 Iteration Commitment | 个人用户在候选审核页确认，不要求正式 Betting Table | 不因普通“批准计划”暗中承诺人员和周期 |
| Scope discovery | Scope 标记 `imagined/discovered`，保存未知度 | 用户、负责人或 Agent Candidate 更新，Evidence 只能支持判断 | 不用完成 Action 数量计算百分比 |
| Circuit Breaker | 到期必须 Review，默认不延期 | 只在全部剩余 must-have 已知且有短上限时允许 extend | 不自动 carry-over，不把 partial 伪装完成 |
| 六周/Cool-down | 保留有限投入原则 | 周期由 Method/用户决定，Cool-down 可选 | 不写死六周，不强制所有项目有 Cycle |

### 2.2 BMAD：采用、调整、拒绝

| 输入 | PS2 采用 | Chat 调整 | 明确拒绝 |
|---|---|---|---|
| Greenfield/Brownfield | 软件方法按现状与影响范围选择 Artifact/Quality Policy | 由版本化 Method Snapshot 表达 | 不把方法目录当 Project 状态 |
| Story | Work 保存目标、AC、依赖、任务、测试和执行记录的职责分离 | Work 不限于软件 Story | 不把所有项目强制命名为 Epic/Story |
| Validate Next Story | Work Ready Gate 检查来源、架构、依赖、错误、测试、安全和可实施性 | Gate 绑定真实对象版本和 Evidence | 不允许 Agent 自述“准备好了”产生 PASS |
| QA Gate | `PASS/CONCERNS/FAIL/WAIVED`、问题、理由、审核者和证据 | 是否必需由 Quality Policy 和风险决定 | 不把 BMAD 的 advisory/optional 当成高风险软件 Work 的绕过口 |
| Correct Course | PS2 冻结兼容 Change Policy 与影响引用 | 完整 Change Proposal/资源修改放到 PS4 | PS2 不偷跑资源副作用或自动改道 |
| 固定角色与路径 | Artifact role、Participant capability、Assignment | 路径来自 Resource/Observation，角色来自 Project Participant | 不复制 SM/Dev/QA Agent 链和固定 `docs/prd.md` 目录 |

BMAD 的流程阶段只证明 Artifact 与协作依赖，不是 Chat 的 `ProjectStage`。Chat Stage 表达长期成熟度；BMAD 只进入 `ArtifactPolicy`、`QualityPolicy` 和软件 Work Gate。

### 2.3 已审核产品交互

1. Basecamp：Project 是长期地点，Activity 只是可下钻投影；PS2 的 Project Room 保持稳定对象归属。
2. Linear：Project Update 是负责人署名的健康判断；Agent 可以起草，不能自动发布或冒充负责人。
3. Things：Project 归属和个人下一行动正交；PS2 管 Project Action，不提前实现 Today 投影。

## 3. 当前 PS1 能力与 PS2 缺口

PS1 已经提供：

- `ProjectMethodSnapshot.v1`，但只有 4 个布尔 Policy，不能约束 Stage/Iteration/Work/Artifact/Quality/Change。
- 初始 `ProjectStage.v1`，但只有 active/completed/cancelled，没有完整 Stage Gate。
- `ProjectWork.v1` 和 `ProjectAction.v1`，但没有 Scope、未知度、Work Gate、Iteration 归属与完整转换历史。
- Resource Observation、Participant、Decision、Contribution/Evidence 和 Project Candidate。
- Project Intake Workflow、真实模型理解、真实 Resource Observe、Portfolio/Project Workspace 与 Timeline。

PS2 必须补齐：

1. 可执行的 Method Snapshot，而不是继续加布尔开关。
2. Project lifecycle、Stage Goal、Milestone 与显式 Stage transition。
3. Proposal Revision、Iteration Commitment、Iteration 与 Review。
4. Work/Scope/Action 的推进状态、来源、未知度、依赖和 Gate。
5. Project Update 及作者责任。
6. 严格的状态转换审计；Trace 不能代替产品历史。
7. 通过真实对话生成候选、用户修订/确认、Workflow 暂停恢复和 UI 投影的完整纵向链。

## 4. 冻结的领域对象与边界

### 4.1 `ProjectMethodSnapshot.v2`

Method Snapshot 是不可变、带版本和 SHA-256 的完整配置：

```text
ProjectMethodSnapshot
├─ profileId/profileVersion/tailoring
├─ StagePolicy
├─ IterationPolicy
├─ WorkPolicy
├─ ArtifactPolicy
├─ QualityPolicy
└─ ChangePolicy
```

只实现 PS2 真正执行的字段：

- `StagePolicy`：阶段模板、单 active Stage、跳过/完成需要的 Decision/Evidence。
- `IterationPolicy`：是否启用、Appetite 类型/范围、单 active Iteration、review trigger、extend 条件。
- `WorkPolicy`：允许的 Work 类型、WIP、Scope 是否启用、Ready/Done Gate。
- `ArtifactPolicy`：软件 Work 需要的 Artifact role；只引用 Resource/Observation/Evidence，不固定路径。
- `QualityPolicy`：Gate 种类、风险阈值、必需 Evidence、WAIVED 条件。
- `ChangePolicy`：哪些变化必须形成 Decision；完整 Correct Course 延后到 PS4。

`small-project.v1`、`software-delivery.v1`、`lightweight.v1` 由 Domain 纯函数编译。迁移不得凭空改变用户已确认的目标；PS1 v1 Snapshot 使用确定性兼容映射升级，保留原 profile/rationale，并明确标记迁移来源。未来修改 Method 必须创建新 Snapshot 和 Decision，旧 Iteration 继续引用旧 Snapshot。

### 4.2 Stage 与 Milestone

`ProjectStage`：

```text
planned → active → review → completed
planned → skipped
review → active
```

规则：

1. 一个 Project 最多一个 active Stage。
2. Stage 保存 goal、success criteria、sequence、Method Snapshot 引用。
3. completed/skipped 必须有 Decision、操作者、理由和适用 Evidence。
4. Milestone/Work/Action 全完成不能自动完成 Stage。

`ProjectMilestone`：

```text
planned → achieved
planned → cancelled
```

Milestone 是阶段内关键结果，不是完成百分比。`achieved` 必须绑定 acceptance criteria、Decision 和 Evidence；轻量项目可以没有 Milestone。

### 4.3 Proposal Revision、Commitment 与 Iteration

为保留历史，Proposal 使用稳定 aggregate 和不可变 Revision：

```text
ProjectProposal
└─ ProjectProposalRevision 1..n
   ├─ problem/baseline/appetite/payout
   ├─ solutionOutline/rabbitHoles/noGos
   ├─ resource/evidence refs
   └─ sha256
```

Proposal 状态：

```text
raw → shaping → shaped → committed
raw/shaping/shaped → declined/expired
```

committed Revision 不可原地改写。`ProjectIterationCommitment` 是不可变事实，必须绑定：

- Proposal Revision ID、revision 与 Hash。
- Project、Stage 与 Method Snapshot 的 ID、revision 与 Hash。
- Appetite、Payout、must-have/No-Gos、参与者、开始/结束或 review trigger。
- `iteration_commitment` Decision 与 commandId。

`ProjectIteration` 状态：

```text
proposed → committed → active → review → completed
                       └──────→ stopped
proposed/committed → cancelled
review → active（仅用户批准的有界短扩展）
```

一个 Iteration 第一版只属于一个 Project；一个 Project 最多一个 active Iteration。Operations/lightweight 可以关闭 Iteration，但仍需定期 Project Update 或 review trigger。

### 4.4 Work、Scope 与 Action

`ProjectWork`：

```text
draft → ready → in_progress → review → done
                  ↕ blocked
任意非终态 → cancelled
```

Work 保存 type、objective、AC、risk、dependencies、assignees、Stage/Iteration、Ready/Done Gate refs。ready/done 不能只由模型文本或 Action 计数产生。

`ProjectScope` 保存 must-have/nice-to-have、`imagined/discovered` 来源和未知度：

```text
unknown → solving → known → executing → done
```

允许根据真实发现回到 `solving`，但必须说明原因、操作者和 Evidence/Candidate；不能静默回退。

`ProjectAction` 保持：

```text
todo → doing → blocked → doing → done
任意非终态 → cancelled
```

PS2 增加可选 Scope、`imagined/discovered/user/agent/external` 来源、must-have 与完成 Evidence。Action done 不推导 Scope/Work/Iteration 完成。

### 4.5 Gate 与 Evidence

`ProjectGateAssessment` 是不可变评估，不是一个可覆盖字段：

- gate kind：`work_ready | work_done | iteration_review | stage_completion`。
- target object ID、revision、Hash 与 Method/Quality Policy 版本。
- `PASS | CONCERNS | FAIL | WAIVED`、稳定 issue code、理由、审核者与时间。
- Evidence refs；不得保存任意 metadata。
- WAIVED 必须有 reason、approver、expiry；过期后不能继续支持新转换。

BMAD 风险/QA 阈值只编译进 `software-delivery.v1` 的 Quality Policy；非软件/轻量 Project 不出现 PRD、Architecture 或 QA 必填。

### 4.6 Project Update

Project Update 是不可变、可被后续 Update 纠正的负责人叙事：

- authorParticipantId 与确认 Principal。
- `health: on_track | at_risk | off_track | unknown`。
- narrative、observedChanges、blockers、nextFocus。
- Evidence refs。
- Project/Stage/Iteration revision 与 Hash。
- publishedAt、可选 supersedesUpdateId。

Agent 只能生成 Draft Candidate。只有有权限代表该 Participant 的用户确认后才能发布。系统 Activity、Action 完成数或模型摘要不能冒充负责人健康判断。

### 4.7 状态转换历史

新增严格 `ProjectStateTransition` 判别联合，只记录各对象状态变化：对象 ID、before/after revision、from/to、actor、commandId、Decision/Evidence refs 与时间。它不是万能 Activity，也不复制正文。

Project Timeline 从 State Transition、Decision、Contribution/Evidence、Observation 和 Project Update 组装。Trace 继续只回答代码经过哪些边界，不能承担产品审计历史。

## 5. Candidate、模型与 Workflow

### 5.1 模型边界

新增窄 `ProjectAdvancementUnderstandingPort`。它接收受预算限制的当前 Project/Stage/Iteration/Work 摘要和用户输入，输出 strict、模型无关的 `ProjectAdvancementUnderstanding` 判别联合。

1. 用户必须先显式选择 Project 并进入“推进项目”模式；普通聊天不能被隐藏分类器直接改写项目事实。
2. 模型可以判断用户是在讨论 Stage、Milestone、Shaping、Work、Update 或 Review，但结果只是临时 Understanding。
3. Application 结合正式输入、当前事实、Method Policy 和 Evidence 编译 Candidate。
4. Provider/模型只在 `apps/api` Composition Root 的 Model Profile 中选择；浏览器不能指定。
5. 验收时使用真实百炼 `qwen3.7-plus`，只是当前配置证据，不产生“Qwen Project Candidate”产品对象。

### 5.2 `ProjectAdvancementWorkflow`

```text
Chat“推进项目”消息
→ Message/Candidate/Receipt/Start Outbox 原子提交
→ ProjectAdvancementWorkflow 启动
→ 读取版本绑定的最小项目事实清单
→ ProjectAdvancementUnderstandingPort
→ Application 编译 strict Candidate
→ 前端展示并等待 Hook
→ 用户直接修改，或提交自然语言修改要求形成新 Candidate Revision
→ 用户确认/拒绝先提交 Product Store 事实和 Resume Outbox
→ Workflow 恢复并记录终态
```

工作流支持明确的 Candidate kind，但不把各对象状态机写进 Workflow Step。Application/Domain 拥有编译、CAS、Hash、权限和原子提交；Workflow 只拥有耐久步骤、模型调用、候选循环、暂停/恢复和运行终态。

同一 `ProjectAdvancementWorkflow` 可以承载以下候选，因为它们共享“理解→编译→审核→决定”生命周期：

- stage/milestone
- shaping/iteration_commitment
- work/scope/action
- project_update
- iteration_review

每种 Candidate payload 仍是独立 `.strict()` Schema 和独立 Application commit 分支，不建立万能 `Record<string, unknown>` 或万能 ProjectService。低风险的 Action 分派/状态转换继续允许通过直接 CAS Command 完成，不必为每次点击调用模型。

### 5.3 失败与恢复

1. 模型非法输出、网络失败或 strict 校验失败：Candidate 标记可恢复失败；不得创建项目事实。
2. 同一 Candidate Revision 的模型调用在 Workflow 恢复后不得重复付费；新自然语言修订才允许新调用。
3. 用户确认时任一 bound revision/Hash 过期：409，Candidate 保留，页面刷新后可重新生成。
4. 用户决定先写 Product Store，再恢复 Hook；Hook 失败由 Outbox 重试，不回滚已提交决定。
5. 两个页面并发确认只有一个成功；另一方得到可执行的冲突信息。
6. 浏览器永远看不到 Workflow Run ID、Hook Token 或 pi Session ID。

## 6. API 与前端交互

### 6.1 API

在实现前通过合同测试冻结精确路径，责任至少包括：

- Query：Project Advancement Workspace、Proposal revisions、Iteration/Review、Milestones、Scopes、Updates、Gate/Timeline。
- Command：begin advancement、revise/confirm/reject Candidate、Stage/Milestone transition、Work/Scope/Action transition、publish Update、start/review Iteration。
- 所有写命令使用现有 Command Envelope、`commandId`、expected revision、strict Zod 与 Problem Detail。
- 服务端根据 Principal/Participant/Project Role 计算 `allowedActions`；React 不自行推导权限。
- Browser payload 出现 Provider、model、Workflow/Hook/pi 私有身份或未知字段时返回 400。

不建立一个 `PATCH /project` 万能端点。每个 Command 对应一个业务决定和一个明确事务边界。

### 6.2 最小统一 UI

1. Chat Composer 复用现有显式模式，增加“推进项目”；用户选择现有 Project 后可以直接说话。
2. Candidate 审核沿用现有“可读、可修改、确认/拒绝”语言，但按钮按事实命名，例如“承诺本轮”“发布更新”“确认 Review”，不能都叫“批准计划”。
3. Project Room 增加 4 个稳定区域：Stage/Milestone、Current Iteration、Work/Scope/Action、Latest Project Update。
4. Update 显示作者、健康文字、时间与 Evidence 入口；颜色不是唯一状态表达。
5. Proposal/Commitment 必须完整展示 Appetite、Payout、No-Gos、人员、周期和绑定版本后才能确认。
6. 到期 Review 明确展示原 Commitment、Scope 未知度、must/nice 边界、Evidence 和四种路径；不预选自动延期。
7. 390×844 可以完成候选修订、Iteration Commitment、Action 阻塞和 Project Update 发布，无横向溢出。
8. 页面只投影服务端事实；刷新、返回和候选冲突后重新 Query，不保留第二套权威状态。

本阶段只做支撑纵向闭环的最小 UI，不重做视觉系统、Portfolio、Today、Pulse 或 Workbench。

## 7. JSON Product Store 演进

PS2 按每个纵向任务实际新增的权威事实顺序升级，不一次预建空集合：

1. PS2.1：v4→v5，加入 Method v2、Stage v2、Milestone、Project Update 与 State Transition。
2. PS2.2：v5→v6，加入 Proposal/Proposal Revision、Iteration Commitment 与 Iteration。
3. PS2.3：v6→v7，加入 Scope、Gate Assessment 与 Iteration Review，并升级 Work/Action 引用。

每次迁移必须：

- 保持 Session、Run、Memory、Project PS1 事实逐对象等值。
- 对旧 Method/Stage 使用文档化、可测试的确定性映射，不伪造用户 Decision。
- 校验 Map key/ID、owner、project refs、单 active Stage/Iteration、Method/Proposal/Commitment Hash、Participant/assignee、Transition 链、Gate/Evidence 与 Update 作者。
- 截断、未知 Schema、悬空引用、Hash 篡改和 I/O 故障失败关闭，原文件逐字节不变。
- 保持单实例单写者、单写队列、fsync、atomic rename 与目录 fsync；不宣称多实例能力。

## 8. 3 个纵向实现任务

### PS2.1：阶段目标、Milestone 与负责人 Project Update

用户结果：用户在现有 Project 中说出阶段目标、关键结果和当前健康判断，看到可修改候选；确认后 Stage/Milestone/Update 与转换历史同时进入项目账本和页面。

主要范围：

- Method Snapshot v2 的 PS2 Policy 编译与 v4→v5 迁移。
- Project lifecycle、Stage/Milestone 状态机和严格 State Transition。
- Project Update Draft/发布与作者权限。
- `ProjectAdvancementWorkflow`、Understanding Port、真实 Model Profile 接入、Hook 与 Outbox。
- API、Project Room 最小区域、Chat“推进项目”入口。
- 真实模型+浏览器：修订 Stage Candidate、确认 Milestone、发布 Update、刷新/重启恢复。

不做 Proposal/Iteration/Scope/Review；页面不得显示假的空 Iteration 功能。

### PS2.2：Shaping Proposal 与 Iteration Commitment

用户结果：用户说出一轮有限投入，Chat 基于当前 Stage/Method 生成 Shaping Candidate；用户反复修改并显式承诺，页面出现真实 active Iteration。

主要范围：

- Proposal aggregate/immutable Revision、Commitment、Iteration 状态机与 v5→v6。
- Shape Up 字段、人员/周期/Method/Stage 绑定、单 active Iteration。
- software-delivery Artifact role/Ready 缺口投影；不把模型判断当 Evidence。
- Workflow Candidate 修订循环、显式 Commitment Decision、API/UI。
- 真实模型+浏览器 small-project 场景：v1→自然语言修订→v2→旧确认 409→承诺→刷新/Workflow 重启恢复。

不推进 Scope，不执行 Work，不运行脚本，不做 Iteration Review。

### PS2.3：Work/Scope/Action 推进、Gate 与 Iteration Review

用户结果：用户在执行中新增 discovered Scope/Action、记录阻塞和未知度；到期时 Chat 给出 Review Candidate，用户根据证据决定 complete/extend/reshape/stop，并发布下一条 Project Update。

主要范围：

- Work v2、Scope、Action v2、Gate Assessment、Iteration Review 与 v6→v7。
- BMAD Work Ready/Done 与 QA Gate 的类型化 Policy；轻量/非软件裁剪。
- Circuit Breaker、extend 限制、Iteration outcome Decision 和旧历史保留。
- Project Room 完整投影、Timeline、API/Workflow/UI。
- 两条最终真实模型+浏览器 E2E，以及全链自审和质量门。

不执行真实 Resource Action。若没有已验证 Evidence，系统必须诚实阻止 `done/complete`，而不是为了跑通演示伪造 PASS；真实执行与自动 Evidence 采集由 PS3 完成。

### 8.4 依赖与完成声明

```text
PS2.1 合并
→ 从最新 main 建 PS2.2 worktree/PR
→ PS2.2 合并
→ 从最新 main 建 PS2.3 worktree/PR
→ 最终全链真实 E2E 与复审通过
→ 才能宣布 PS2 完成
```

每个 PR 对应一个用户可操作的纵向结果，不允许以 Contracts、Store 或“后端已完成”作为单独 PR。任何 PR 未合并时，下一个任务不得从旧分支叠加开发。

## 9. 严格测试与真实完成门

### 9.1 合同、Domain 与 Store

1. 每种对象、Candidate、Command、DTO、Trace event 有合法 fixture 和未知字段反例。
2. Project/Stage/Milestone/Proposal/Iteration/Work/Scope/Action 全部合法与非法转换。
3. 单 active Stage/Iteration、Work DAG、Participant/assignee、Method/Proposal/Commitment revision/Hash 不变量。
4. Proposal committed 后不可改写；新 Revision 保留旧内容、Hash 和 Decision 引用。
5. Action 全 done、Milestone 全 achieved、AC 全勾选都不能自动完成上层。
6. Gate PASS 必须有符合 Policy 的 Evidence；WAIVED 缺 reason/approver/expiry 必须拒绝。
7. Project Update 冒充作者、过期 revision、无权限 Principal、Activity 自动发布全部拒绝。
8. 每次 Store 迁移、损坏失败关闭、I/O 注入、CAS、幂等和双写并发。

### 9.2 Workflow/API 集成

1. Outbox 只启动一次；Workflow restart 不重复同一 Candidate Revision 的模型调用。
2. 修订产生新 revision/Hash；旧 Candidate 确认 409；拒绝不产生事实。
3. 普通 Plan Approval 不能提交 Iteration Commitment。
4. Resume Hook 失败不撤销已提交 Decision，Dispatcher 可安全重放。
5. Browser 不能提交 Provider/model、内部 Runtime ID 或未声明字段。
6. Project/Stage/Proposal/Method 任一绑定过期都失败关闭，无半提交。
7. 两页面并发确认只有一个成功，另一页面刷新后恢复权威结果。

### 9.3 最终真实场景 A：small-project

```text
真实 Chat 选择 Project
→ “两周解决移动端调试问题，不重做 UI”
→ 当前 Model Profile 的真实模型生成 strict Understanding
→ Application 编译 Shaping Candidate
→ 用户修改 No-Go 和参与者
→ 显式 Iteration Commitment
→ 新增 discovered Scope/Action
→ Scope 保持 unknown/solving
→ 触发到期 Review
→ extend 被 Domain 拒绝
→ 用户选择 reshape 或 stop
→ 发布 at_risk Project Update
→ 刷新/API+Workflow 重启后完整恢复
```

### 9.4 最终真实场景 B：software-delivery/brownfield

```text
真实 Chat Project + 真实 Git/文档/脚本 Observation
→ 选择 software-delivery/brownfield profile
→ Shaping/Commitment 展示相关 Artifact role 与质量要求
→ Work Ready Gate 引用真实文档 revision/Hash
→ 缺测试/高风险 Evidence 时 FAIL 或 CONCERNS
→ 禁止 Work done / Iteration complete
→ 用户选择补证据后的新 Review，或诚实 reshape/stop
→ Timeline 回答谁决定、缺什么、下一步是什么
```

PS2 不为了制造 PASS 执行脚本或伪造测试结果。若仓库中已有通过可信入口提交的 verified Evidence，可以验证 PASS 路径；否则真实失败门本身就是本阶段正确结果，PS3 再交付自动 Verify。

### 9.5 浏览器、恢复与 Trace

两条场景都必须验证：

1. 真实 Chromium 桌面与 390×844 手机。
2. 真实 Model Profile；缺 Key/网络必须报告未完成，不使用 stub 降级后宣称通过。
3. API/Workflow 真重启；Candidate、Hook等待、事实和模型调用次数可恢复。
4. commandId 重放、双页面并发、旧 revision 和拒绝路径。
5. Trace/Replay 只含对象 ID、revision/Hash、状态转换、Port/Adapter、耗时、outcome/errorCode；扫描证明没有对话、Proposal、Update、Decision、路径、Diff、密钥或 Provider payload 正文。

## 10. 模块与代码质量

```text
packages/contracts          PS2事实、Candidate、Command/Query DTO、Trace合同
packages/domain             Method编译、状态机、Gate/Circuit Breaker与不变量
packages/application        Candidate编译、事务、CAS、权限、Query投影
packages/product-store-json v4→v5→v6→v7迁移与Integrity
packages/workflows          ProjectAdvancementWorkflow与耐久候选循环
packages/pi-runtime         模型无关Advancement Understanding Adapter
apps/api                    REST、Model Profile与组合根
apps/web                    Chat入口、候选审核与Project Room投影
packages/testing            Fixture、恢复、真实E2E工具
```

质量要求：

1. Domain 不依赖 Hono、React、Workflow、pi、fs 或 Git；Router/Workflow/React 不直接改 Store。
2. 不建立万能 ProjectService、Repository-per-table、任意 metadata 或一个函数处理所有 Candidate。
3. 用纯状态机、严格判别联合和小 Coordinator 表达规则；只有真实替换点才建立 Port。
4. 关键跨层路径、身份/revision/Hash、候选与事实边界、迁移、Circuit Breaker 和失败恢复必须有精炼中文注释。
5. 注释解释“是什么、为什么、如何失败”，不逐行翻译；触发规模阈值时按责任拆分。
6. 同步更新当前实现文档：前后端交互、Runtime Workflow、项目架构和本地调试。
7. VS Code 继续使用统一 `Chat：调试应用` 和既有固定端口，不新增服务端口；文档列出路由、Application、Workflow、pi Adapter、Domain 状态机和 React 候选入口的断点函数与观察变量。
8. 每次 F5 仍先安全释放本仓库旧进程；不得使用模糊 `pkill`，未知端口占用只报告不杀。
9. 不新增生产依赖，除非说明用途、所有权、许可证和退出方式。
10. 弱服务器不安装依赖、不编译、不运行测试；仅接收开发机或 CI 构建并验证的可追溯产物。

每个 PR 至少运行其直接相关的 unit/contract/store/workflow/API/React 测试和一条真实浏览器门；PS2.3 额外运行全仓 build/lint/format/typecheck/test、生产依赖审计和两条最终真实场景。

## 11. 明确不做

1. 不执行代码、写文档、运行脚本、Git commit/push、部署或外部副作用。
2. 不实现通用 Project Context Builder、Memory/Rules 注入；这些属于 PS3/Rules。
3. 不实现完整 Correct Course、Resource Drift 自动对账、提醒、Today、Pulse 或多项目优先级；这些属于 PS4。
4. 不重做 Chat、Portfolio 或设计系统；只做纵向闭环必需的统一 UI。
5. 不新增 SSE Runtime Journal、多实例数据库、生产备份或服务器部署拓扑。
6. 不把 BMAD Agent、目录、Markdown 状态或模型名称写进 Product Domain。
7. 不用百分比、Action 数量、模型摘要或 Git 状态自动完成 Stage/Iteration/Project。

## 12. Git、审核与完成规则

1. 本任务书得到明确批准后，先确认最新 `main` 基线和工作区状态，再创建 PS2.1 独立 worktree/`codex/`分支/Draft PR。
2. 每个任务实现、自审、修复、质量门、真实模型与浏览器证据完成后再请求复审。
3. 前一个 PR 合并并同步 `main` 后，删除对应本地/远端分支和 worktree，再创建下一个任务。
4. 不把用户或其他任务的未提交文件带入分支；不在弱服务器编译。
5. PR 描述必须列出用户结果、Method/Domain 决定、迁移、真实模型调用、浏览器场景、Trace 扫描和已知边界。

## 13. 用户审核点

请用户确认以下 10 项：

1. PS2 的完成定义是否是“Stage/Milestone→Shaping/Commitment→Work/Scope/Action→Project Update→Iteration Review”完整管理闭环。
2. 是否接受 PS2 不执行真实资源动作；无 verified Evidence 时诚实阻止完成，PS3 再接真实执行/Verify。
3. 是否接受 Shape Up 管投入/边界/未知/Circuit Breaker，BMAD 只进入软件 Artifact/Work/Quality Policy。
4. 是否接受 Proposal 使用稳定对象+不可变 Revision，Commitment 绑定精确 revision/Hash。
5. 是否接受 Project Update 必须由负责人确认发布，Agent 只能起草。
6. 是否接受新增严格 State Transition 产品历史，Timeline 与 Trace 继续分工。
7. 是否接受一个 `ProjectAdvancementWorkflow` 承载共同候选生命周期，各 Candidate/Application 分支仍严格独立。
8. 是否接受按 PS2.1/PS2.2/PS2.3 三个纵向 PR 和 v5/v6/v7 顺序交付，只有全部通过才宣布 PS2 完成。
9. 是否接受真实验收使用当前 Model Profile 的百炼 `qwen3.7-plus`，但产品合同完全模型无关。
10. 是否接受两条最终真实 E2E 及失败门，缺真实 Key/网络/证据时不得降级宣称完成。

未得到这份任务书的明确审核批准前，不开始 PS2.1 产品实现。
