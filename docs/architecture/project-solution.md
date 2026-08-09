# Project Solution 架构：项目事实、方法、资源与推进

> 文档类型：目标架构。本文描述Project Solution最终边界和分阶段实现，不代表能力已经交付。当前事实以根目录 `PROJECT_STATE.md` 为准。
>
> 状态：待用户审核

## 1. 架构目标

Project Solution让用户通过对话管理多个长期项目，并把自然语言意图转成可审核、可执行、可恢复的项目事实和Workflow。系统必须同时管理：

1. 长期Project及其真实资源。
2. 阶段性目标和Milestone。
3. Iteration/Cycle及有限投入承诺。
4. Work、Scope、Task/Action和负责人。
5. 用户、Agent、自动化的参与和贡献。
6. 决定、变更、Artifact、测试与完成证据。
7. 代码、文档、脚本和服务的观察、执行与对账。
8. 多项目组合、当前关注与下一步。

方法论依据见[Project Solution方法论](../product/project-solution-methodology.md)。

## 2. 核心架构原则

1. **Project是产品事实，不是Prompt**：Product Store拥有Project身份、生命周期、方法、Work和决定。
2. **真实资源保留自身所有权**：Git、文件、脚本、服务和外部系统保存资源正文与真实状态；Chat保存引用、Observation、Contribution和Evidence。
3. **模型只产生Candidate**：建项、方法选择、Iteration、决定、贡献、状态和Correct Course未经确认不能成为权威事实。
4. **阶段与迭代分离**：Stage表达长期成熟度，Iteration表达一次有限投入；一个Stage可包含多个Iteration。
5. **进度不压成百分比**：阶段目标、Milestone、Iteration边界、未知度、负责人Update和Evidence分别表达。
6. **Task允许被发现**：计划不假装提前知道所有Task；执行中可以新增discovered Action并记录来源。
7. **审计与Trace分离**：Project Ledger保存用户可读历史；Trace保存系统路径和对象引用。
8. **方法可组合且版本化**：Method Profile编译为完整Snapshot，每个Project/Iteration固定引用版本与Hash。
9. **副作用能力按Port拆分**：Observe、Write、Execute、Verify和Reconcile不能塞进一个万能Resource接口。
10. **Chat是主要入口，UI是控制面**：用户可只靠说话驱动，界面用于观察、修改、确认和恢复。

## 3. 领域层级

```text
Portfolio Projection
└─ Project
   ├─ ProjectMethodSnapshot
   ├─ ProjectStage
   │  ├─ Stage Goal
   │  └─ ProjectMilestone
   ├─ ProjectIteration
   │  ├─ ProjectProposal
   │  ├─ Iteration Commitment
   │  ├─ ProjectWork
   │  │  ├─ ProjectScope
   │  │  └─ ProjectAction
   │  └─ Iteration Review
   ├─ ProjectResource
   │  └─ ProjectObservation
   ├─ ProjectParticipant
   ├─ ProjectContribution
   │  └─ ProjectEvidence refs
   ├─ ProjectDecision
   ├─ ProjectChangeProposal
   ├─ ProjectUpdate
   └─ ProjectCandidate
```

Portfolio第一版是按Principal查询Project形成的投影，不新建一个空壳容器实体。未来出现共享Portfolio、跨项目目标或组织权限后再增加稳定对象。

## 4. 核心对象

### 4.1 `Project`

稳定字段：

- `projectId`、owner与成员边界。
- title、objective、scope、success criteria、no-gos。
- `projectKind: software | non_software | operations | research | custom`。
- `lifecycle: active | paused | completed | archived`。
- currentStageId、currentIterationId（均可空）。
- activeMethodSnapshotId与Hash。
- revision与时间。

Project不嵌套全部历史，只引用当前对象。历史由Stage、Iteration、Decision、Contribution、Observation和Update独立保存。

### 4.2 `ProjectMethodSnapshot`

不可变，包含：

- profileId、profileVersion、tailoring inputs。
- StagePolicy、IterationPolicy、WorkPolicy、ArtifactPolicy、QualityPolicy、ChangePolicy。
- canonical SHA-256。

修改方法必须创建新Snapshot和ProjectDecision；旧Iteration继续引用旧Snapshot，不能被新配置追溯改写。

### 4.3 `ProjectStage`

Stage是Project内长期阶段实例，不是模板枚举：

- stageId、projectId、methodSnapshotId。
- key、name、sequence。
- goal与successCriteria。
- `status: planned | active | review | completed | skipped`。
- startedAt/completedAt与完成Decision/Evidence引用。

约束：同一Project最多一个active Stage。Stage完成需要显式Decision，不能由Milestone或Task数量自动推导。

### 4.4 `ProjectMilestone`

- milestoneId、projectId、可选stageId。
- outcome与acceptance criteria。
- targetAt可选。
- `status: planned | achieved | cancelled`。
- achieved Decision与Evidence refs。

Stage Goal是Stage的整体结果；Milestone是其中关键检查点。轻量项目可以只有一个Stage Goal而没有Milestone，UI不强迫用户看到两层。

### 4.5 `ProjectProposal`

Shape Up式Proposal是可选对象，软件/小项目方法默认启用：

- problem、baseline。
- appetite。
- payout/expected outcome。
- solution outline。
- rabbitHoles、noGos。
- relatedResource/Evidence refs。
- `status: raw | shaping | shaped | committed | declined | expired`。
- revision、Hash。

Proposal提交为Iteration Commitment时绑定精确revision和Hash。

### 4.6 `ProjectIteration`

- iterationId、projectId、stageId、methodSnapshotId。
- name与objective。
- `appetite`：第一版支持timebox days；轻量方法可无固定周期但必须有review trigger。
- startAt/endAt。
- participantIds。
- proposal/commitment refs。
- `status: proposed | committed | active | review | completed | stopped | cancelled`。
- outcome：shipped/partial/reshaped/stopped/cancelled。
- reviewId。

一个Iteration第一版只属于一个Project，同一Project第一版最多一个active Iteration。跨项目资源冲突由Portfolio投影显示，不把多个Project塞进同一个Cycle事实；未来确有多团队并行证据时再扩展多活动Iteration。

Iteration到期不能自动延期。系统生成`complete/stop/reshape/extend`候选：

- extend只允许剩余工作全部known/downhill、均为must-have且给出理由。
- 仍有unknown/uphill时默认reshape或stop。
- 用户Decision提交最终结果。

### 4.7 `ProjectWork`

- workId、projectId、stageId、可选iterationId/proposalId。
- type：deliverable/story/research/maintenance/operations/custom。
- objective、acceptanceCriteria、risk。
- dependencies与负责人。
- `status: draft | ready | in_progress | blocked | review | done | cancelled`。
- ready/done Gate Evidence。

Work是可独立交付的单位，不是所有聊天请求或Task的容器。

### 4.8 `ProjectScope`

- scopeId、workId、name、outcome。
- mustHave与niceToHave边界。
- `uncertainty: unknown | solving | known | executing | done`。
- status reason、updatedBy、evidence refs。

Scope可以执行中发现；创建时记录`imagined | discovered`来源。未知度由负责人更新或Agent提出Candidate，Resource Evidence可以支持但不能直接替负责人判断。

### 4.9 `ProjectAction`

- actionId、projectId、workId、可选scopeId。
- description、kind、mustHave。
- assignee participantIds。
- `status: todo | doing | blocked | done | cancelled`。
- blocker、dueAt可选、completion evidence。
- `origin: imagined | discovered | user | agent | external`。

Action是用户的具体待办。Action完成不能单独推导Scope/Work/Iteration或Project完成。

### 4.10 `ProjectResource`

类型：

- git_repository
- directory
- document
- script
- service
- deployment
- external_system
- artifact

保存安全locator、adapterKind、capabilities、ownership、current observation ref与revision。资源正文、Diff和凭据不复制到Project Store。

### 4.11 `ProjectObservation`

不可变记录Resource某一时刻的可验证状态：

- adapter/contract/config revision。
- observedAt、resource revision、Hash。
- 类型化manifest与状态摘要。
- budget、exclusions、errors。
- Evidence refs。

Observation不是Project状态。Reconcile比较Observation、Project事实与上次Observation，形成Candidate。

### 4.12 `ProjectParticipant`

- participantId、projectId。
- `kind: human | agent | automation | external`。
- displayName、projectRoles、capabilities、status。
- 可选principal/agent profile/model config引用。

Git author email或Commit author不能自动绑定Chat身份；需要已有可信映射或用户确认。

### 4.13 `ProjectContribution`

不可变回答“谁做了什么”：

- participantId、work/action/scope refs。
- kind：analysis/code/document/script/review/test/deployment/coordination。
- summary。
- affected resources before/after refs。
- Product Run、Commit、PR、Artifact、Test、Trace Evidence refs。
- `verification: reported | observed | verified`。

Agent自述最多是reported；只有Resource Adapter、Workflow/Product Commit或外部证据核验后才可升级。

### 4.14 `ProjectEvidence`

Evidence使用类型化引用，不复制真实内容：

- product_object
- git_commit
- pull_request
- test_result
- artifact
- document_revision
- deployment
- trace_span
- external_record

每种类型明确需要的ID、revision、Hash、验证状态和安全locator。不存在任意metadata口袋。

### 4.15 `ProjectDecision`

不可变记录：question/context、options、selection、rationale、decider/approver、affected refs、bound revisions/hashes、status与supersedes。

Decision kind至少包含：method_selected、stage_transition、iteration_commitment、iteration_outcome、scope_change、work_acceptance、resource_action_approval、project_change、project_completion。

### 4.16 `ProjectUpdate`

由负责人发布的阶段叙事：

- authorParticipantId。
- health：on_track/at_risk/off_track/unknown。
- narrative、observedChanges、blockers、nextFocus。
- Evidence refs。
- stage/iteration/project revision绑定。
- publishedAt。

Agent可以起草Candidate，不能自动发布并冒充负责人判断。没有按约定节奏更新是一个监督信号，不等于项目失败。

### 4.17 `ProjectCandidate`

持久化严格判别联合，覆盖：intake、method、stage、milestone、proposal、iteration、work、action、assignment、contribution、decision、update、reconcile、change proposal。

共同字段只包含候选身份、来源、bound revisions/hashes、status、过期时间与创建者。每种候选有独立payload schema；禁止`Record<string, unknown>`。

## 5. 状态机

### 5.1 Project

```text
active ↔ paused
active/paused → completed
active/paused/completed → archived
archived → active（显式恢复Decision）
```

completed表示目标由用户确认达成；archived是可见性/维护生命周期，不等于完成。

### 5.2 Stage

```text
planned → active → review → completed
planned → skipped
review → active
```

跳过必须有Decision和理由；模板可以禁止跳过某些Stage。

### 5.3 Proposal

```text
raw → shaping → shaped → committed
raw/shaping/shaped → declined/expired
```

committed后不可改写；新方案产生新Proposal revision/identity。

### 5.4 Iteration

```text
proposed → committed → active → review → completed
                       └──────→ stopped
proposed/committed → cancelled
review → active（仅批准短扩展）
```

### 5.5 Work/Scope/Action

状态转换由Method Snapshot约束。任何上层完成都要求自己的Gate与Decision，不通过子对象计数自动转换。

## 6. 事实所有权

| 事实 | Owner | 非Owner |
|---|---|---|
| Project/Stage/Iteration/Work/Action当前状态 | Product Store | 浏览器、模型、Git、Workflow |
| Resource正文与真实外部状态 | Git/文件/服务/外部系统 | Product Store、Trace |
| Observation/Contribution/Decision/Update | Product Store | Activity Feed、Trace |
| Workflow步骤和Checkpoint | Workflow Store | Product Store、浏览器 |
| Agent上下文和临时工具状态 | pi Runtime | Product Store |
| 系统调用路径和诊断 | Trace | Project Timeline |
| 项目时间线 | 多源Assembler投影 | 单一Activity实体 |

## 7. Method Profile编译

Method定义不是运行时DSL解释器。Domain中使用版本化纯函数，将已知Profile和用户裁剪输入编译为完整Snapshot并计算Hash。

### 7.1 `small-project.v1`

- Stage可配置，默认intent/build/review。
- Proposal与Iteration必需。
- timebox默认1～6周但不写死六周。
- Scope uncertainty与Circuit Breaker必需。
- Artifact最小化。

### 7.2 `software-delivery.v1`

- Stage默认discovery/planning/solutioning/implementation/release/maintenance。
- greenfield/brownfield_quick/brownfield_focused/brownfield_major子profile。
- Proposal/Iteration使用Shape Up边界。
- Artifact/Story/QA/Correct Course使用BMAD规则。
- 可在R&D/production/cleanup模式间通过Decision转换。

### 7.3 `lightweight.v1`

- Stage默认goal/active/review/done。
- Proposal、Iteration、Scope可关闭。
- Work/Action、Participant、Decision和Evidence仍必需。

## 8. 工作流设计

### 8.1 Project Intake

```text
用户建项消息
→ 识别目标与资源定位
→ Resource Observe
→ Method/Profile建议
→ 生成Intake Candidate
→ 前端修改/确认
→ 原子提交Project、Method、Resource、Participant、Stage、初始Work/Action、Decision、Observation
```

用户从Portfolio“新建项目”或对话中的可见“建项目”动作进入Project Intake模式；公开命令携带字面量`project_intake`意图。P1不使用隐藏模型分类器把普通任务消息自动改道，避免误触高影响建项流程。模式内用户仍只需用自然语言描述目标和资源。

模型不直接访问任意服务器路径；Resource Root Registry先校验允许根和能力。服务端私有配置为每个根保存`rootId/displayName/canonicalPath/allowedAdapters`，浏览器只看到安全`rootId/displayName`。用户文本中的路径必须解析到已配置根，否则返回可解释候选缺口而不是读取任意文件。

Intake使用独立`ProjectIntakeWorkflow`。它的权威暂停对象是Project Candidate，不是Plan Approval；强行复用`PlanningExecutionWorkflow`会把Project建项和任务执行的状态机混为一体。公开入口仍是Chat Message/Project Command，浏览器不直接调用Workflow。

### 8.2 Shaping与Iteration Commitment

```text
Raw Idea/用户需求
→ 加载Stage Goal、Baseline、Resource和相关Decision
→ pi生成Shaping Candidate
→ 技术Observe/风险检查
→ 用户修订Problem/Appetite/Payout/No-Gos/Rabbit Holes
→ shaped Proposal
→ 选择人员、周期和Work
→ 用户确认Iteration Commitment
→ Iteration active
```

计划批准只有在界面明确展示Commitment字段时，才可以同时提交Iteration Decision；不能用普通“批准计划”静默承诺周期和人员。

### 8.3 Work推进

```text
选择Work/Scope
→ Context Builder组织Project/Resource/Memory/Rules
→ pi规划
→ 用户批准
→ Workflow调用Resource Action Port
→ Verify/Reconcile
→ Contribution + Evidence + Work Update Candidate
→ 用户确认高影响状态
→ Project Update/下一Action
```

### 8.4 Observe与Reconcile

```text
显式刷新/后续计划任务
→ 各Resource Adapter observe
→ 保存Observation
→ 对比上次Observation与Project refs
→ drift candidates
→ 自动提交纯观察事实
→ 需要改变Project或Resource时等待用户决定
```

### 8.5 Iteration Review与Circuit Breaker

```text
Iteration到期或用户触发Review
→ 汇总Commitment、Scopes、未知度、Contributions、Evidence、No-Gos变化
→ 判断shipped/partial/uphill/downhill
→ 生成complete/stop/reshape/extend候选
→ 用户决定
→ 原子提交Review、Decision、Iteration outcome和后续Proposal/Action
```

### 8.6 Correct Course

```text
变化触发
→ 分析Stage/Iteration/Work/Resource/Artifact影响
→ 形成具体变更与备选路径
→ ProjectChangeProposal
→ 用户修改/批准
→ 原子提交Decision和Project事实变化
→ 需要真实资源动作时进入独立Workflow
```

## 9. Resource Ports

### 9.1 Observe Port

```ts
interface ProjectResourceObservePort {
  describe(): ProjectResourceObserveCapabilities;
  observe(input: ObserveProjectResourceInput): Promise<ProjectResourceObservation>;
}
```

只读、可有限重试、输出strict且受预算限制。

### 9.2 Action Port

未来副作用使用独立接口：

```ts
interface ProjectResourceActionPort {
  describeAction(input: DescribeResourceActionInput): Promise<ResourceActionPreview>;
  execute(input: ExecuteResourceActionInput): Promise<ResourceActionResult>;
  reconcile(input: ReconcileResourceActionInput): Promise<ResourceActionReconciliation>;
}
```

必须有operationId、输入manifest、前置revision、幂等、outcome_unknown和对账。普通异常重试不能处理未知外部副作用。

### 9.3 Verify Port

测试、lint、构建、文档校验和部署健康检查使用类型化Verify能力；验证结果保存Evidence，不让Executor用自然语言宣布通过。

## 10. Context Builder

Project Context Package按目的选择：

- `project_intake`
- `shaping`
- `iteration_commitment`
- `work_planning`
- `execution`
- `project_review`
- `correct_course`

稳定选择顺序：用户显式引用→当前Stage/Iteration/Work必需事实→方法必需Artifact/Decision→相关Observation/Contribution→Memory/Rules→预算裁剪。完整历史默认不进入模型。

每个包保存来源ID、revision、Hash、选择/排除理由。Plan Revision固定引用Context Package；修订默认复用，显式刷新才产生新包。

## 11. API与应用边界

Application按用例拆分：

- Portfolio Queries
- Project Intake Commands
- Stage/Milestone Commands
- Proposal/Iteration Commands
- Work/Scope/Action Commands
- Participant/Assignment Commands
- Resource Observe/Action Coordinators
- Contribution/Evidence Commands
- Decision/Update/Change Commands
- Project Context Builder

Router、Workflow Step、pi Adapter和React不能直接修改Project Store。所有写命令携带commandId与expected revision；高影响Candidate绑定全部相关对象版本和Hash。

## 12. UI信息架构

### 12.1 Portfolio / Home

回答：有哪些Project、哪些需要我处理、谁在做、哪些Iteration有风险、哪些长期未更新。Project卡/列表只提供识别和进入，不塞满全部统计。

### 12.2 Project Room

稳定包含：目标、当前Stage Goal、Milestone、当前Iteration、负责人Update、活动Work、资源、参与者、决定和证据入口。

### 12.3 Today

个人Action、决定、阻塞、到期Iteration和等待验收的投影；改变Today排序不改变Project事实。

### 12.4 Workbench

展示Plan、Run、Step、Resource Action、Evidence和Candidate；保持Project/Iteration/Work归属。

### 12.5 Pulse

聚合Project Update、Contribution和需要介入的变化。Activity只是投影，点击回到Project/Work/Decision/Evidence。

## 13. Trace、Timeline与回放

Trace只记录：对象ID、revision、Hash、状态转换、Port/Adapter kind、调用关系、耗时、outcome和稳定errorCode。

Project Timeline由以下对象组装：

- Stage/Iteration/Work/Action转换。
- Decision。
- Contribution/Evidence。
- Observation/Reconcile。
- Project Update。
- Product Run/Artifact引用。

Timeline回答“谁因为什么做了什么”，Trace回答“代码经过了哪些边界”。二者不能相互代替或复制正文。

## 14. 安全与权限

1. Resource定位由服务端Registry和允许根控制，拒绝路径/符号链接逃逸。
2. 浏览器不得直接运行脚本、写文件、调用Workflow或pi。
3. Resource Action必须显示影响对象、Diff/Preview、权限、可逆性和验证方案。
4. Agent Participant的能力不是权限；权限来自Project Role与Resource Capability共同校验。
5. Git作者身份不能自动冒充Chat用户。
6. Trace、模型输入和普通错误不记录密钥、完整Diff、隐藏推理或未裁剪资源正文。

## 15. 场景验证

### A. 多项目个人开发者

用户有Chat、pi-web和Memory三个Project。Portfolio能列出每个项目当前Stage、Iteration、负责人、待决定和下一Action；Today只展示与用户当前责任有关的内容。

### B. Shape Up小项目

用户说“两周解决移动端调试问题，不重做UI”。系统生成Problem、Appetite、Payout、No-Gos和Rabbit Holes；确认Iteration后执行中发现Scope/Action；到期根据未知度选择完成、reshape或stop。

### C. BMAD棕地软件项目

系统观察现有仓库与架构文档，使用brownfield_focused profile；Shaping控制投入与No-Gos，BMAD控制相关PRD/Architecture/Story/QA；代码、文档和测试Evidence支持Work完成。

### D. 非软件轻量项目

用户管理一次内容发布或搬家项目，只使用Goal、Stage Goal、Milestone、Work/Action、Participant和Evidence，不出现PRD、Architecture或六周Cycle。

### E. 持续运维项目

Project kind为operations，不强迫永不结束的Iteration。使用持续Work流与周期Project Update；重大改进仍可创建独立Proposal/Iteration。

### F. 外部变化与贡献身份

仓库出现新Commit。Observe生成Observation和Contribution Candidate；系统不能仅凭email绑定用户，用户确认作者映射后才成为verified Contribution。

### G. 方向改变

用户要求从Memory方案切换Provider。Correct Course分析当前Iteration、Work、文档和代码影响；拒绝后无事实变化，批准后产生新Decision/Method/Work与Resource Action。

## 16. 已冻结的设计决定

1. Stage与Iteration是不同对象。
2. Stage Goal内嵌Stage，Milestone可选且独立。
3. 一个Iteration第一版只属于一个Project。
4. 同一Project第一版最多一个active Iteration。
5. 小团队不强制六周、Betting Table或Cool-down。
6. Commitment必须显式确认，不能由普通对话暗中产生。
7. Scope未知度由负责人事实或Candidate确认，不由Task数量推导。
8. Operations Project允许持续流，不强迫Cycle。
9. Project Update是负责人叙事，Activity/Agent摘要不能冒充。
10. Agent自述Contribution最多为reported。
11. Method Snapshot和所有高影响Candidate都版本/Hash绑定。
12. PS1使用显式Project Intake模式，不用隐藏模型路由普通消息。

## 17. 分阶段纵向交付

### PS1：Project Intake、真实Resource与项目账本

对话建项、真实只读Observe、Method建议、用户确认、Portfolio/Project Room，以及Participant、初始Work/Action、Decision、Observation。

### PS2：Stage、Milestone、Iteration与任务管理

实现Method Profile、Stage Goal、Milestone、Proposal/Shaping、Commitment、Iteration、Work/Scope/Action、Project Update和Circuit Breaker完整管理闭环。

### PS3：Project Context与真实推进

Project Context Builder、pi规划、Resource Action/Verify、Contribution/Evidence、Work状态回写和真实副作用对账。

### PS4：维护、Correct Course与多项目注意力

Observe/Reconcile、Project Change Proposal、周期Review、Portfolio风险、Today/Pulse和可配置提醒。

每个PS都是用户可操作的纵向闭环，而不是只交付一层DTO。任务书在本架构审核后分别编写；不能用一个巨型PR实现全部Project Solution。
