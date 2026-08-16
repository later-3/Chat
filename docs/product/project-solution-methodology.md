# Project Solution 方法论：Shape Up、BMAD 与 Chat 的统一取舍

> 文档类型：产品方法论与来源证据。本文定义为什么采用某些项目管理概念，不代表相关能力已经实现。实现状态仍以根目录 `PROJECT_STATE.md` 为准。
>
> 状态：待用户审核
>
> 证据日期：2026-08-09

## 1. 研究问题

Chat的目标不是复制一种项目管理软件，而是帮助不熟悉项目管理的用户，仅通过对话也能建立、维护和推进多个真实项目。方案必须回答：

1. Project如何区别于Conversation、Repository、Iteration和Task？
2. 长期Project、阶段性目标、短期Iteration、Work与具体Task如何关联？
3. 用户如何知道谁在做、改了什么、为什么决定、还剩什么？
4. Chat如何面对代码、文档、脚本、服务和外部项目系统？
5. 不同规模、类型和成熟度的项目是否需要不同方法？
6. 模型能够建议什么，哪些事实必须由用户或真实证据确认？

## 2. 固定输入与证据边界

### 2.1 Shape Up

主证据是Basecamp公开的[Shape Up官方原文](https://basecamp.com/shapeup)，作者Ryan Singer。研究覆盖：

- Introduction与三段式结构。
- Part 1 Shaping：边界、Appetite、方案要素、风险、Pitch。
- Part 2 Betting：选择、Cycle、Cool-down、Commitment、Circuit Breaker。
- Part 3 Building：团队责任、纵向切片、Scope、Hill、Scope Hammering、结束与反馈。
- Appendix `Adjust to Your Size`：基本真理与不同规模的具体做法。

官方原文描述Basecamp自己的软件产品开发方法。它证明这些概念在该组织中的真实关系，但不证明六周、团队配置或无Backlog适合所有Chat用户。

### 2.2 BMAD

固定本地源码：

```text
/Users/xulater/Code/reference-agent-sources/BMAD-METHOD-v4.44.3
commit 4c4f6dc8534f95427e66e122ac5de47ac51b5f94
tag v4.44.3
```

主要入口：

- `docs/user-guide.md`
- `docs/working-in-the-brownfield.md`
- `bmad-core/core-config.yaml`
- greenfield/brownfield workflows
- `bmad-core/templates/story-tmpl.yaml`
- `create-next-story.md`
- `validate-next-story.md`
- `qa-gate.md`
- `correct-course.md`
- change与DoD checklists

BMAD证明软件项目中Brief、PRD、UX、Architecture、Story、开发、QA与Correct Course的真实协作关系。它不拥有Chat的Project事实，也不证明这些Artifact适用于非软件项目。

### 2.3 已采用的交互结论

1. Project是长期地点；Activity只是投影。
2. Project Update是负责人署名的健康判断；系统事件不能冒充项目叙事。
3. Project归属与个人Today/Next Action正交。
4. Project、Conversation、Workbench、Today、Pulse与Agents必须保持对象连续。

这些结论只为交互和阅读层级背书，不替代领域状态机。原始研究材料已从当前树移除，需要时从Git历史读取。

### 2.4 技术输入

1. Chat Product Store：权威事实、CAS、幂等、历史与原子提交。
2. Vercel Workflow：耐久步骤、暂停、恢复、重放和Checkpoint。
3. pi：模型Provider、Agent节点、工具调用与事件边界。
4. Git/PR/CI：代码修改、作者、Review、测试与发布证据。
5. Memory：跨会话召回经验，不拥有Project当前状态。

## 3. Shape Up的完整方法结构

### 3.1 Shaping：先限定投入，再定义方案

Shape Up不是从完整需求清单开始估时，而是先确定`Appetite`：这件事值得投入多少时间和注意力。方案必须在投入边界中收敛。

Shaped work具有三个性质：

1. **Rough**：不提前决定所有细节，给执行者保留空间。
2. **Solved**：核心问题、方案要素和高风险区域已经想清楚。
3. **Bounded**：明确问题边界、投入、No-Gos与不做范围。

Pitch包含：

- Problem
- Appetite
- Solution
- Rabbit Holes
- No-Gos

### 3.2 Betting：承诺的是结果，不是填满工时

Bet表达三个语义：

1. 有明确Payout：周期结束时要得到一个有意义的结果。
2. 有资源承诺：团队在周期内不被普通事项打断。
3. 有损失上限：超过投入边界默认触发Circuit Breaker，而不是无限延期。

Basecamp使用六周Cycle和两周Cool-down，但官方附录明确指出，小团队可以使用不同长度并省略正式Betting Table和Cool-down。稳定原则是：有意识地选择投入、限制损失、避免开放式承诺。

### 3.3 Building：任务不是预先穷举出来的

执行团队接收的是完整Project/Pitch，而不是管理者预先拆尽的Task。团队在真实工作中发现Tasks，并按项目结构整理为可独立完成的Scopes。

关键做法：

1. 先完成一个端到端的有意义切片。
2. Scope按项目结构而不是人员角色划分。
3. Tasks分为imagined和discovered，计划必须容纳后者。
4. 进展区分未知问题和已知执行，而不是只数完成比例。
5. 优先解决最重要、最未知的部分。
6. Must-have与Nice-to-have分开，固定投入下持续削减范围。
7. 到期仍有未知问题时回到Shaping；只有剩余工作全部已知且必要时才考虑短扩展。

### 3.4 Move On：反馈不是自动债务

发布后的反馈是Raw Idea，不自动成为承诺。重要反馈需要重新Shaping，与其他候选竞争下一次投入，避免每次发布都带来无边界的尾巴。

## 4. Shape Up采用、调整与拒绝

| 概念 | 决定 | Chat设计 |
|---|---|---|
| Appetite | 采用 | Iteration/Proposal保存时间、预算或注意力边界；不等同Estimate |
| Fixed time, variable scope | 采用 | Commitment冻结投入边界，Scope允许在规则内裁剪，核心成功标准不能静默下降 |
| Shaping | 采用 | Raw Idea→Shaping Candidate→用户确认的Shaped Proposal |
| Problem/Solution/Rabbit Holes/No-Gos | 采用 | 成为Proposal的类型化字段，支持非软件项目使用不同名称 |
| Betting | 调整 | 转成用户确认的Iteration Commitment；个人用户不需要正式会议 |
| 六周Cycle | 拒绝写死 | Method Profile提供默认Appetite，项目可选择天/周/预算/无固定日期 |
| Cool-down | 可选 | 作为Iteration Policy；小项目不强制 |
| 无中央Backlog | 拒绝照搬 | Chat需要跨项目待办，但区分Raw Idea、Candidate、Committed Work和Someday，避免全部进入承诺队列 |
| Assign projects, not tasks | 调整 | Agent/小团队接收Work/Scope责任，同时保留用户需要的具体Action与责任人 |
| Scope Map | 采用 | Work下允许在执行中发现Scopes；Scope按交付结构而不是角色分组 |
| Hill Chart | 采用语义、拒绝品牌形态 | 保存`unknown/solving/known/executing/done`及解释，不伪造百分比或强制山形图 |
| Circuit Breaker | 采用 | Iteration到期不能自动延期；生成Review/Reshape/Stop/Extend Candidate，由用户决定 |
| Done means deployed | 调整 | Done绑定项目的完成策略；代码可能要求merge/deploy，研究或文档项目使用其他证据 |
| QA is for edges | 拒绝通用化 | Chat按风险与Method Profile决定质量门；高风险项目不能把QA降为可选尾部活动 |

## 5. BMAD采用、调整与拒绝

| 概念 | 决定 | Chat设计 |
|---|---|---|
| Greenfield/Brownfield分流 | 采用 | 软件Method Profile按新建、局部增强、重大改造选择Artifact与Gate |
| Brief→PRD→UX→Architecture | 调整 | 作为软件Stage/Artifact Policy，不是所有Project固定阶段 |
| Story状态与AC | 采用 | Software Work类型默认状态与Acceptance Criteria |
| create-next-story | 采用原则 | Work Context只选择相关Artifact与前序经验，不加载全部历史 |
| validate-next-story | 采用 | Work Ready Gate检查来源、依赖、测试、安全与实现准备度 |
| QA Gate | 采用 | Gate绑定Evidence和对象版本；PASS不能由Agent自述产生 |
| Correct Course | 采用 | 版本绑定Change Proposal→用户确认→原子更新Project事实 |
| core-config路径 | 调整 | 转成Resource/Artifact Manifest；路径不是权威状态 |
| 固定Agent角色链 | 拒绝 | Participant/Capability由Chat配置；用户、Codex、Kimi或自动化都可承担角色 |

## 6. 统一方法模型

Chat不把Shape Up和BMAD合成一条巨型固定流程，而是用`ProjectMethodSnapshot`组合六类Policy：

```text
ProjectMethodSnapshot
├─ StagePolicy       长期阶段、阶段目标与推进门
├─ IterationPolicy   Appetite、Cycle、Commitment、Review、Circuit Breaker
├─ WorkPolicy        Work/Scope/Action类型、状态、依赖与负责人
├─ ArtifactPolicy    需要哪些项目资源和文档角色
├─ QualityPolicy     Ready/Review/Release Gate与Evidence
└─ ChangePolicy      普通调整、Reshape、Correct Course与用户决定
```

Method Snapshot随Project持久化完整配置、版本和Hash。每个Iteration固定引用当时的Method Snapshot；未来调整方法不会改写历史。

### 6.1 `small-project.v1`

面向个人或小团队的有限项目：

```text
Raw Idea → Shape → Commit → Build → Review → Close/Reshape
```

默认要求Problem、Appetite、Payout、No-Gos、Risks、Scopes和Iteration Review；不强制六周、Cool-down、PRD或Architecture。

### 6.2 `software-delivery.v1`

Shape Up与BMAD的组合方法：

```text
Stage Goal
→ Shape Problem/Appetite/No-Gos
→ BMAD Artifact与架构准备
→ Iteration Commitment
→ Story/Work/Scope/Action
→ Build/Test/QA
→ Release Evidence
→ Project Update
→ Next Iteration或Correct Course
```

Shape Up控制投入、边界、未知和范围；BMAD控制软件Artifact、Story就绪、架构、测试和QA。

### 6.3 `lightweight.v1`

面向非软件或极小事务：

```text
Goal → Stage Goal → Next Work/Action → Review → Continue/Done
```

保留目标、责任、证据和决定；Iteration、Proposal、Scope均可选。

## 7. 统一对象层级

```text
Portfolio
└─ Project
   ├─ Stage
   │  ├─ Stage Goal
   │  └─ Milestones
   ├─ Iterations
   │  ├─ Proposals / Commitment
   │  ├─ Work
   │  │  ├─ Scopes
   │  │  └─ Actions
   │  └─ Iteration Review
   ├─ Resources / Artifacts
   ├─ Participants / Assignments
   ├─ Contributions / Evidence
   ├─ Decisions / Change Proposals
   ├─ Observations
   └─ Project Updates
```

### 7.1 概念边界

| 对象 | 回答的问题 | 不是什么 |
|---|---|---|
| Project | 这件长期事务为何存在、拥有哪些真实资源 | Session、Repository、Iteration |
| Stage | 长期成熟度或业务阶段是什么 | Sprint、Task状态 |
| Stage Goal | 本阶段要达成的可验证结果 | 模糊主题 |
| Milestone | 哪个关键结果已达到/待达到 | 自动完成百分比 |
| Iteration | 这一次有限投入承诺什么 | Project生命周期 |
| Proposal | 候选问题、投入、方案与边界 | 已批准Work |
| Commitment | 用户确认本轮投入、Payout、团队和边界 | 普通优先级标签 |
| Work | 一个有独立交付结果的工作单元 | 零散Todo |
| Scope | Work中可独立完成的结构区域 | 按人员分组 |
| Action | 现在可执行的具体待办 | 长期目标 |
| Project Update | 负责人对健康、变化和下一步的阶段叙事 | Activity自动摘要 |

## 8. 进展、健康和完成

Chat拒绝用单一百分比表示Project进度。至少同时投影：

1. 当前Stage与Stage Goal完成证据。
2. 当前Iteration剩余边界与Commitment状态。
3. Work/Scope的未知度：`unknown/solving/known/executing/done`。
4. 必须项、可裁剪项与新发现范围。
5. 最近Project Update的人工健康判断：`on_track/at_risk/off_track/unknown`及理由。
6. Verified Contribution和Evidence。
7. Blocker、Decision、等待确认与Resource Drift。

系统可以根据事实提示风险，但不能自动冒充负责人发布Project Update，也不能从子Task全部完成推导Project终态。

## 9. 对话驱动原则

用户不需要先学习上述术语。用户说：

> 这两周先把Memory对接打通，前端只做最小版本，Kimi开发，Codex评审。

Chat应生成可编辑候选：

- Stage Goal或当前Milestone关联。
- 两周Appetite。
- Iteration Payout与Commitment。
- Must-have、No-Gos和Rabbit Holes。
- Work/Scope/Action。
- Participant Assignment。
- BMAD Artifact与QA要求。

用户确认后才成为事实。界面负责解释、修改、确认和观察，不要求用户手工维护每个方法字段。

## 10. 待验证假设

1. 个人用户是否愿意显式确认Iteration Commitment，还是只需确认计划即隐含Commitment？
2. Stage与Milestone是否都需要独立对象，还是小项目可把Stage Goal作为Milestone？
3. Shape Up未知度应该由负责人更新、Agent提议还是Resource Evidence部分推导？
4. 一个Iteration能否覆盖多个Project？第一版建议禁止，Portfolio层另建跨项目Commitment。
5. 长期运维项目如何表达持续流，而不伪装成永不结束的Iteration？
6. Git作者、Agent身份和Chat Participant的映射如何确认，避免错认贡献者？

这些问题必须通过用户场景和领域不变量验证后再冻结合同。
