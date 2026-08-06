# Chat会话后管理：输入—处理—输出与落地合同

> 后续AI先读`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/Agent-Memory-MemOS-memmy-agent-总入口.md`；
> 本文件只拥有Chat候选I/O合同，不复制两项目的完整源码事实和运行证据。

> 状态：**待用户审核的详细设计输入**，不是正式Schema、迁移或开发授权。
> 日期：2026-08-01
> 上游证据：MemOS `027dc8975836c066a7d1dd80c78c3da5c0fa084e`；memmy-agent `211d521b310fc23c63dd3d9ca848941173981c5e`。
> 范围：Chat已经拥有一轮Product Session事实以后，怎样把它转成可管理工作、知识、经验和下一轮Context；不做历史会话导入。

## 1. 目标合同

Chat要实现的不是“把对话总结成Memory”，而是一条可重复运行的函数：

```text
输入：已经提交的一轮Conversation/Run/Tool/Evidence/Result事实引用
处理：主题理解 → Work对齐 → 结果归因 → 候选归纳 → 用户/规则决定 → 各Owner提交
输出：工作变化、经验/知识/协议候选、处理状态、审计链、下一轮Context
```

参考项目提供经验处理算法；Chat继续拥有Project/Work/Plan/Approval/Evidence/ResultCommit真相。

## 2. 输入合同

以下字段是候选内部Envelope，不是已批准网络DTO。

```text
TurnSettlementInput:
  command_id                    重复触发幂等身份
  principal_id / scope_id       权限与数据范围
  product_session_id
  interaction_id
  user_message_id
  assistant_message_id?         失败/取消时可空
  product_run_id? / run_attempt_id?
  workflow_definition_id/version?
  context_package_id/revision?
  context_adoption_ids[]
  tool_execution_refs[]
  artifact_refs[]
  evidence_refs[]
  validation_refs[]
  result_commit_id?
  explicit_feedback_refs[]
  observed_source_revision_set_hash
  requested_at
```

### 输入不变量

1. 输入只携带权威对象ID和revision/hash；不复制完整Session文本成为第二事实源。
2. Coordinator必须重新从各Owner读取当前对象，并验证Principal/Scope；调用方提供的scope字段不授权。
3. `assistant_message_id`为空不表示什么都没发生：失败、取消和结果未知仍可沉淀错误经验，但不能产生完成事实。
4. `result_commit_id`只有真实ResultCommit存在时才提供；模型文本“完成”不能补这个字段。
5. 相同`command_id + source revision set hash`精确重放；同command换输入返回conflict。

## 3. 处理合同

### 步骤A：装配TurnObservation

Conversation Owner读取Message/Interaction；Run Owner读取Run/Attempt/公开Trace；Tool、Evidence、Context各自返回最小快照。组装结果只包含观察事实和来源引用：

```text
TurnObservation:
  user_input_ref / visible_result_ref
  run_terminal_status / public_error_code?
  adopted_context_refs[]
  tool_outcome_refs[]
  result_commit_ref?
  explicit_feedback_refs[]
  source_revision_set_hash
```

它不生成Project结论，也不保存隐藏推理。

### 步骤B：更新EpisodeProjection

根据最近Episode、时间、Intent和候选Project/Work计算`initial/follow_up/revision/new_topic/resumed`，更新派生投影：

```text
session_id / message_seq范围 / topic / relation
candidate_project_ids / candidate_work_item_ids
classifier/model/prompt/algorithm版本
confidence / boundary_reason / source refs
status=open|closed|superseded
```

错误分类只能supersede；不能修改原Message，也不能直接创建或完成Work。

### 步骤C：Work Alignment

以Project/Work目录、Intent和EpisodeProjection生成：

```text
WorkMutationCandidate:
  operation=create|update|link|split|merge_suggestion|noop
  target_kind / target_id? / expected_row_version?
  patch / rationale / alternatives / conflicts / source_refs
```

同名或相似不自动新建Work。update必须通过`target_id + expected_row_version`；CAS过期变stale并重新计算。

### 步骤D：Outcome Attribution

按证据强度产生结果计数：

```text
accepted ResultCommit + passed Validation  >  用户明确反馈
> Tool可验证结果  >  Run终态  >  模型自述
```

最后两类只能作为弱观察，不能单独增加`support_result_count`或完成Work。

### 步骤E：归纳3类候选

1. Memory Owner：`preference/procedure/constraint/failure_avoidance/repair_instruction`。
2. Knowledge Owner：environment/inference/constraints及Note revision候选。
3. Protocol/Governance Owner：可复用步骤、前置条件、验证、Tool和Approval要求。

所有候选必须带正/负/冲突证据、来源revision集合、模型/Prompt/算法版本和Decision状态。模型达到阈值只能进入`pending_review`，不能自动成为权威事实。

### 步骤F：派生Job与Attempt

耗时的摘要、Embedding、归纳、冲突检测和索引由各Owner创建逻辑`EnrichmentJob`；共用Execution基础设施执行，但业务状态仍归Owner。

每次领取创建不可变`EnrichmentAttempt`，绑定`lease_epoch/source_scope_snapshot/policy_revision`。旧Worker、来源撤权或外发结果未知时不能写成功派生物。

### 步骤G：决定与提交

用户在“本轮沉淀”中逐项接受、编辑、拒绝、仅本Session或noop。每个Owner用自己的Application Coordinator、revision/CAS和Outbox提交；不做跨Owner长事务。

### 步骤H：下一轮Context

Context Owner检索Work、Accepted Memory、Knowledge和Protocol候选，记录`RecallLedger`：候选、权限/失效/冲突/预算丢弃、用户覆盖、实际Adoption以及最终ResultCommit outcome。

## 4. 输出合同

### 4.1 立即响应

```text
TurnSettlementResult:
  settlement_id
  source_revision_set_hash
  episode_projection_id/status
  candidate_refs[]
  enrichment_job_refs[]
  processing_status: ready|partial|pending|failed
  change_cursor / etag / duplicate?
```

立即响应只表示沉淀请求已被接纳和哪些对象已创建，不表示用户已经接受候选或异步归纳成功。

### 4.2 权威或观察事实

- 原Message、Interaction、Run/Attempt、Tool、Artifact/Evidence和ResultCommit保持原Owner。
- Work只有接受的WorkMutationCandidate经过Work命令后才变化。
- Accepted Memory、Note Revision和Protocol Revision分别由自己的Owner提交。

### 4.3 派生资产

- EpisodeProjection。
- Work/Experience/Knowledge/Protocol Candidates。
- RecallLedger与查询投影。

### 4.4 处理与失败输出

- Job queued/leased/succeeded/failed/dead_letter。
- 每次不可变Attempt和公开错误。
- `partial`、`stale`、`source_invalid`、`outcome_unknown`必须用户可见。

### 4.5 下一轮输出

版本化ContextPackage及每个ContextItem的来源、采用/排除原因和预算；实际Adoption与Run/ResultCommit可反查。

## 5. 用户看到的完整流程

### 回合前

1. “我理解你正在做”：候选Project/Work、主题与Intent。
2. “本轮准备采用”：Context来源、revision和排除原因。
3. “准备执行”：Plan、Tool、影响与Approval。

### 回合后

“本轮沉淀”按4类展示：工作变化、用户记忆、项目知识、协作协议。每项显示内容、来源、正/负/冲突证据、未来影响以及接受/编辑/拒绝/仅本Session。

### 下一轮和周期回顾

下一轮显示实际召回与排除；周期回顾显示权威Work进度、待审核候选、经验成败/冲突、dead-letter和来源失效。聊天次数不能冒充项目进度。

## 6. 一个具体例子

输入事实：

```text
User Message: “实际隔离运行MemOS和memmy，把失败恢复搞清楚”
Run: succeeded
Artifacts: 两份full-provenance JSON
Validation: 两个target test exitCode=0
ResultCommit: 研究批次证据已接受
Feedback: 用户要求始终按输入—处理—输出落实
```

处理输出：

1. EpisodeProjection继续“Agent Memory管理研究”。
2. WorkMutationCandidate=`update`现有研究Work，绑定row_version；不新建第二个Work。
3. ExperienceCandidate：开源研究必须绑定固定commit与代表性运行证据。
4. KnowledgeCandidate：两项目的I/O运行合同。
5. ProtocolCandidate：研究任务必须输出输入字段、处理链、5类输出和故障预言机。
6. 用户可分别接受或修改；只有Work Candidate被接受后才更新项目状态。
7. 下一轮Context采用已接受研究协议，并在RecallLedger关联本次ResultCommit。

## 7. 正常、冲突和失败验收预言机

| ID | 输入 | 必须输出 | 禁止输出 |
|---|---|---|---|
| IPO-01 | 成功Interaction+ResultCommit | Episode更新、update/noop Work候选、经验/知识候选、处理游标 | 自动完成Work |
| IPO-02 | 同command和同revision重放 | 相同settlement/candidate引用、duplicate | 第二组候选 |
| IPO-03 | 同command但source hash变化 | conflict/重新提交提示 | 静默覆盖 |
| IPO-04 | Work row_version过期 | Candidate=stale、保留来源、重新对齐 | last-write-wins |
| IPO-05 | Embedding/归纳失败 | 原Message/Work/Result不回滚；Job失败/重试可见 | 删除观察事实或伪造ready |
| IPO-06 | Worker强退后重领 | 新Attempt/lease epoch；旧epoch不可提交 | 双写派生物 |
| IPO-07 | 来源删除或撤权 | Candidate/Accepted派生物source_invalid并从Context排除 | 旧索引继续注入 |
| IPO-08 | 只有Agent文本“完成”无Evidence | 可生成弱经验候选 | ResultCommit或Work completed |
| IPO-09 | 越权Project/Memory候选 | 服务端forbidden并审计 | 因请求带scope字段而放行 |

## 8. 完整目标与交付顺序

完整目标包括Episode、Work对齐、Outcome Attribution、三类候选、Job/Attempt、RecallLedger、用户沉淀UI、失效传播和周期回顾，不能因分阶段而删减。

实施继续服从`PROJECT_PLAN.md`拥有的W0-W10唯一顶层工作流，以及[能力开发地图第12节](../product-capability-architecture-map.md#12-唯一主顺序)维护的当前依赖顺序。本专项不复制或另建一条全局优先级。

本合同只把Identity/Scope登记到W2-01，Work/Knowledge/Protocol候选登记到W4-01，沉淀投影登记到W4-03，Memory/Context/Recall Ledger登记到W3-01，Job/Attempt登记到W5-01，Protocol/Tool执行登记到W6-01/W7-01，Outcome Attribution登记到W8-01；不改变中间安全、Session、Schedule、Delivery、运营与Dogfood工作包的顺序和完成门。

用户批准本合同后，第一条实现纵切片应为：`已终态Interaction → EpisodeProjection → Work update/noop Candidate → 本轮沉淀UI → 用户决定 → Work CAS提交 → 下一轮Context可见`。它先验证状态所有权和用户价值；随后接Experience/Knowledge/Protocol异步归纳，但目标合同不因此缩小。

## 9. 当前尚未授权的事项

本文件没有批准对象命名、字段类型、表结构、事件名称、REST路径、Worker实现或UI设计。正式开发前仍需把候选合同归入对应W工作包，完成MAF/现有Chat源码基线核对、详细设计审核和迁移/故障测试计划。
