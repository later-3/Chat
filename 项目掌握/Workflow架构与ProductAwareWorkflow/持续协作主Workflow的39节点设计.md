# 持续协作主Workflow的39节点设计

**归档日期**：2026-07-28
**分类**：Workflow架构与ProductAwareWorkflow
**关联源码**：
- `backend/app/workflows/catalog.py`（39 节点静态产品定义）
- `backend/app/workflows/continuous_chat.py`（Executor 行为与决策规格，2803 行）
- `backend/app/workflows/continuous_chat_factory.py`（MAF 图组装）
- `backend/app/workflows/continuous_chat_contracts.py`（CollaborationState 与纯函数）
- `backend/app/workflows/continuous_chat_prompts.py`（4 个模型任务构造器）
- `backend/app/execution_dispatch/workflow.py`（pi 执行相关 6 个 Executor）
- `backend/app/execution_dispatch/result_gate.py`（Result Claim 2 个 Executor）

## 问题

持续协作主 Workflow 是怎么设计的？39 个节点都是哪些、各自做了什么事？代码是怎么组织和实现的？

## 回答

### 1. 一句话概览

`continuous-collaboration` v1.8.0 是唯一发送前可选的根 Workflow（`selectable=True`，端点 `/api/workflows/continuous-collaboration/run`），把一次用户输入变成一条完整闭环：

```text
输入接纳 -> 选择性上下文（两阶段Harness Context） -> 意图识别与Intent Set治理
-> Project/Work绑定 -> 协作协议绑定 -> 场景路由（4分支）
-> [目录查询 | 澄清 | 规划->计划审批] -> ExecutionDraft编译 -> 执行授权 -> 不可变RunSpec
-> 执行路由（3分支：pi隔离编辑 | pi只读 | 直接回答）
-> 回合摘要 -> Result/Work/Memory三级候选审批 -> 幂等提交 -> 摘要持久化 -> 产品终态提交
```

39 个节点全部是真实 MAF Executor，由 `WorkflowBuilder` 组成一张图。最多 4 次模型调用（意图、规划、响应、摘要），每次都经 HITL 治理；9 个决策节点全部可暂停等人。运行时它被 `ProductAwareWorkflow` 包装以获得 Product Run 生命周期、Trace、Checkpoint 和 Interrupt/Resume——这层关系已归档在 [ProductAwareWorkflow设计与全部Workflow的关系](./ProductAwareWorkflow设计与全部Workflow的关系.md)，本文只讲图内部。

### 2. 代码分层：5 + 2 个模块

| 模块 | 职责 | 为什么分开 |
|------|------|-----------|
| `catalog.py` | 39 个 `WorkflowNodeDefinition` + 全部边的**静态产品元数据**（frozen dataclass） | 用户可检视的目录；运行进度从 MAF 事件推导，绝不从这张静态图推断 |
| `continuous_chat_factory.py` | `ContinuousWorkflowComponents`（Executor 构造器集合）+ `build_continuous_collaboration_workflow()` 用 MAF `WorkflowBuilder` 接线 | 节点 ID、边顺序和 Checkpoint 兼容性可以单独审查，不和行为代码混在一起 |
| `continuous_chat.py` | 全部自有 Executor 的行为实现、9 个 `ProductDecisionSpec`、6 个 revise 函数、兼容入口 `create_continuous_collaboration_workflow()` | 行为与接线分离；工厂通过依赖注入拿到 Executor 类 |
| `continuous_chat_contracts.py` | `CollaborationState`（不可变 dataclass）与全部纯函数（路由判定、意图归一化、写回策略、Hash） | 纯合同可独立测试，路由条件不藏在 lambda 里 |
| `continuous_chat_prompts.py` | `intent_task` / `plan_task` / `response_task` / `summary_task` 4 个任务构造器 | Prompt 内容和治理机制分离 |
| `execution_dispatch/workflow.py` | pi 执行相关 6 个 Executor（路由、Workspace、只读/隔离编辑 dispatch 与装配） | 执行层有自己的模块边界（SD2/SD3） |
| `execution_dispatch/result_gate.py` | Result Claim 2 个 Executor（SD4-C 证据链） | Evidence 域所有权 |

图的入口配置（factory 尾部）：

```python
WorkflowBuilder(
    name=components.workflow_id,
    start_executor=intake,
    output_from=[finalizer],                                    # 只有终结节点产出最终输出
    intermediate_output_from=[pi_readonly_dispatch, pi_workspace_dispatch],  # pi子活动流式外发
    checkpoint_storage=checkpoint_storage,                       # Product绑定的持久Checkpoint
)
```

### 3. 三个复用模式：39 个节点其实只有约 20 个 Executor 类

这是本 Workflow 最重要的设计判断——节点数量多，但类不膨胀：

1. **`ProductDecisionExecutor` × 9 个节点**：`context_adoption`、`intent_binding`、`project_work_binding`、`detail_context_adoption`、`plan_acceptance`、`execution_authorization`、`result_commit`、`work_state_commit`、`memory_commit` 共用同一个类，行为差异全部由数据（`ProductDecisionSpec`）表达：主体投影、适用条件、治理事实、可编辑字段、revise 函数、是否可跳过、Grant 类型。
2. **`GovernedSemanticAgentExecutor` × 4 个节点**：`intent_agent`(ordinal=1)、`planning_agent`(2)、`response_agent`(3)、`turn_summary_agent`(4) 共用同一个类，差异只有 Agent Profile、任务构造器和 `result_kind`。
3. **`HarnessContextRevisionExecutor` × 2 个节点**：`directory_context_revision` 与 `detail_context_revision` 用 `stage="directory"/"detail"` 参数区分。

另有 `TraceMixin` 被所有自有 Executor 混入：每个节点都把公开输入/输出写成 `workflow.node.content` Trace，并按需生成 `StepInputProjection`（最小工作包、能力、预算、输出合同、停止条件、Hash）——设计者工作台点击节点看到的内容就来自这里。

### 4. 39 个节点逐一说明

贯穿全图的消息是 `CollaborationState`（frozen dataclass），每个节点用 `replace()` 产生新状态传给下一个节点，从不原地修改。

#### 4.1 入口与目录上下文（节点 1-5）

| # | 节点 | Executor | 做了什么 |
|---|------|----------|---------|
| 1 | `input_acceptance` | `IntakeExecutor` | `normalize_agui_messages_for_provider()` 过滤审批协议消息，取最后一条用户消息为 prompt；读最近 8 条 TurnSummary、最新未回答澄清、从摘要提取 Project 提示；构造初始 `CollaborationState` |
| 2 | `context_candidates` | `CandidateContextExecutor` | 确定性检索：对摘要按 prompt 关键词命中计分，未回答澄清强制优先带回，最多选 4 条。**不默认叠加完整历史** |
| 3 | `harness_directory_context` | `HarnessDirectoryContextExecutor` | 阶段 A：读正式 Project 轻量目录，生成候选 `ContextPackage`（token 预算 1800）。Project 事实来自权威 Harness，不从聊天摘要猜 |
| 4 | `context_adoption` | `ProductDecisionExecutor` | HITL：确认本轮采用的主题摘要。可编辑字段是 `selected_summary_ids` 多选；`_revise_context()` 按选中 ID 过滤摘要，skip 则清空；允许跳过 |
| 5 | `directory_context_revision` | `HarnessContextRevisionExecutor(stage="directory")` | 读当前 Run 最新目录 Context revision 投影回状态——保证用户在决策卡上排除/修改的内容**真正进入**后续意图识别，旧来源不会被装回 |

#### 4.2 意图识别与 Project 绑定（节点 6-15）

| # | 节点 | Executor | 做了什么 |
|---|------|----------|---------|
| 6 | `intent_agent` | `GovernedSemanticAgentExecutor`(intent_router, 第1次调用) | 识别 1-4 个目标、顺序依赖、Project 提示和澄清需要。**确定性护栏**：`_is_project_catalog_query()` 命中"我有哪些项目"类输入时直接构造意图，0 次模型调用 |
| 7 | `intent_set_projection` | `IntentSetProjectionExecutor` | 把模型候选保存为不可变 Intent revision（Intent Set），并恢复/回答跨 Run 澄清 |
| 8 | `intent_binding` | `ProductDecisionExecutor` | HITL：确认意图理解。`clarify` 场景不适用（不会造出无法回答的审批卡）；可整体编辑 Intent Set；`_revise_intent()` 校验 1-4 个 Intent、场景白名单，手工修改后 `confidence=1.0` |
| 9 | `intent_set_acceptance` | `IntentSetAcceptanceExecutor` | 把审核后意图同步为新 revision，只接受当前 Hash 绑定的完整 Intent Set；clarify 场景保持 candidate |
| 10 | `harness_project_resolver` | `HarnessProjectResolverExecutor` | 把意图中的 Project 提示解析到权威目录已有 ID；**只有唯一匹配才绑定**，零匹配或多匹配交给下一个决策点 |
| 11 | `project_work_binding` | `ProductDecisionExecutor` | HITL：确认关联的 Project/Work。选项只来自 `state.project_matches` 权威候选，`_revise_project()` 拒绝目录外 ID；可选择"本轮不关联"；简单问答不适用 |
| 12 | `harness_detail_context` | `HarnessDetailContextExecutor` | 阶段 B：按已绑定 Project 装配开放 Work、当前 Plan、Action、Note、Accepted Memory、Repository Snapshot 和匹配治理规则（token 预算 6000），逐项记录采用与排除 |
| 13 | `detail_context_adoption` | `ProductDecisionExecutor` | HITL：确认项目与仓库 Context。主体逐项公开 source_kind/revision/adopted/reason/token_estimate；本卡不提供行内编辑（调整走 Context 面板生成新 revision），不允许跳过 |
| 14 | `detail_context_revision` | `HarnessContextRevisionExecutor(stage="detail")` | 同节点 5，投影用户审核后的最新详情 Context revision |
| 15 | `collaboration_protocol_resolver` | `CollaborationProtocolResolverExecutor` | 按 Work → Project → 用户 → 系统优先级绑定不可变协作协议 revision；多 Intent 时用可审计 `composition_overlay` 公开本轮实际启用的组合 Plan 策略 |

#### 4.3 场景路由与两个短分支（节点 16-18）

| # | 节点 | Executor | 做了什么 |
|---|------|----------|---------|
| 16 | `scenario_router` | `ScenarioRouterExecutor` | 纯投影：调用合同层 `_evaluate_scenario_route()` 记录路由决定并原样转发状态；真正的分支由 MAF SwitchCase 边完成（见 §5） |
| 17 | `project_catalog_query` | `ProjectCatalogExecutor` | 确定性产品目录查询：从 Harness 权威事实回答项目列表；目录为空时明确说"没有正式项目"并展示对话候选，**绝不让模型编造**。之后直接接 `result_commit`（节点 34） |
| 18 | `clarification` | `ClarificationExecutor` | 把澄清问题作为本轮 response 提交（提示"请直接在下方输入框回答"），标记 `awaiting_user_answer: True`；之后**跳过整条结果审批链**，直接接 `turn_summary_persist`（节点 38），下一轮 Intake 会把开放问题带回 |

#### 4.4 计划与执行合同（节点 19-24）

| # | 节点 | Executor | 做了什么 |
|---|------|----------|---------|
| 19 | `planning_agent` | `GovernedSemanticAgentExecutor`(task_planner, 第2次调用) | 对新任务、继续 Project、明确规划请求和多 Intent 组合形成步骤与验证门 |
| 20 | `plan_acceptance` | `ProductDecisionExecutor` | HITL：接受/修改/本轮跳过计划。`_revise_plan()`：skip 清空 plan，修改必须非空 |
| 21 | `execution_draft_compiler` | `ExecutionDraftCompilerExecutor` | 把目标、最小上下文、计划、能力和完成门编译成版本化 `ExecutionDraft`（`compile_execution_draft_v2`）；同时施加 Repository Fence 并**冻结 Validation Contract**（P0-1，防止授权后 Plan 推进偷换验证规则）；失败用稳定错误码脱敏（P1-5） |
| 22 | `execution_authorization` | `ProductDecisionExecutor` | HITL：授权执行合同。`accept_action="execute"`、`grant_kind="start_run"`——批准产生一次性 Grant，**绑定当前 Draft revision Hash**；编辑走 ExecutionDraft 完整工作台，`_revise_execution_draft()` 只接受新 revision ID（新 Hash 必须重新审批） |
| 23 | `run_spec_compiler` | `RunSpecCompilerExecutor` | 只从已授权的 ExecutionDraft revision 编译**不可变 RunSpec**（`compile_run_spec_v2`）并绑定 Product Run；这是执行阶段的唯一合同来源 |
| 24 | `execution_route` | `ExecutionRouteExecutor` | 只读已批准 RunSpec 决定 `pi_workspace` / `pi_readonly` / `answer_only`，**不再重新解释用户文本**；分支同样由 SwitchCase 边完成 |

#### 4.5 pi 执行分支（节点 25-31，SD2/SD3/SD4-C）

| # | 节点 | Executor | 做了什么 |
|---|------|----------|---------|
| 25 | `execution_workspace_prepare` | `ExecutionWorkspacePrepareExecutor` | 从已批准的干净 Repository Snapshot 创建受管 detached Git worktree，校验 base revision，公开安全 Workspace 投影（不泄露绝对路径） |
| 26 | `pi_workspace_dispatch` | `PiWorkspaceDispatchExecutor` | 在受管 worktree 启动受治理 pi 隔离编辑：每次模型请求逐次审批，Tool 只允许有界读取和绑定 Hash 的单文件精确 `edit`；每个副作用记入 ToolOperation/Attempt 账本。子活动经 `intermediate_output_from` 流式外发到工作台 |
| 27 | `pi_workspace_result_assembly` | `PiWorkspaceResultAssemblyExecutor` | 保留工作区，校验 ToolExecution 与 Result Hash，公开变化文件；**不提交、不推送、不声明 Work 完成** |
| 28 | `result_claim_prepare` | `ResultClaimPrepareExecutor` | 经 `ResultPipelineCoordinator` 建立证据链：diff_patch Artifact（真实 Diff 字节）、冻结的 ValidationContract、绑定 Action 版本/Snapshot/Artifact Revision 的 CompletionClaim 与非空 mandatory Requirements；确定性 Validation 在 Workspace 真实执行。全部写入用 `sd4:{run_id}:...` 幂等 command_id |
| 29 | `result_claim_decision` | `ResultClaimDecisionExecutor` | HITL：决定结果 Claim（accept/waive/reject）。复用 `result_commit` 决策点，不可变 DecisionSubject 冻结 Claim id/hash/row_version，创建即绑定，篡改必失败 |
| 30 | `pi_readonly_dispatch` | `PiReadonlyDispatchExecutor` | 受治理 pi 只读检查：Chat-owned `read/grep/find/ls` 逐次重验路径与快照；pi 禁用内置 Tool、Context 文件发现、Session 和自动重试 |
| 31 | `pi_readonly_result_assembly` | `PiReadonlyResultAssemblyExecutor` | 装配只读结果，校验后写回状态，交给回合摘要 |

#### 4.6 响应与回合收尾（节点 32-39）

| # | 节点 | Executor | 做了什么 |
|---|------|----------|---------|
| 32 | `response_agent` | `GovernedSemanticAgentExecutor`(response_agent, 第3次调用) | `answer_only` 分支的协作响应：用已采用 Context、意图和计划生成答复候选 |
| 33 | `turn_summary_agent` | `GovernedSemanticAgentExecutor`(turn_summarizer, 第4次调用) | 提取本轮主题、开放问题、Work 状态候选和 Memory 候选；只读回合经 `_apply_summary_writeback_policy()` 过滤写回候选（去向记为 `accepted_with_writeback_filter`），三条执行分支在此汇合 |
| 34 | `result_commit` | `ProductDecisionExecutor` | HITL：确认提交给会话的答复（长文本可编辑），`grant_kind="commit_result"`。`project_catalog_query` 分支也汇入这里 |
| 35 | `work_state_commit` | `ProductDecisionExecutor` | HITL：Work 状态候选决定，`grant_kind="commit_work_state"`，可跳过；候选不会自动变成长期状态 |
| 36 | `memory_commit` | `ProductDecisionExecutor` | HITL：长期 Memory 候选决定，`grant_kind="commit_memory"`，可跳过；只有明确接受的候选进长期 Memory |
| 37 | `harness_candidate_commit` | `HarnessCandidateCommitExecutor` | 把已批准候选经 `commit_turn_candidates()` 幂等提交到 Product Harness：command_id 为 `turn-candidates:{run_id}`，绑定各 Decision Record ID，重放不重复 |
| 38 | `turn_summary_persist` | `TurnSummaryPersistExecutor` | `save_turn_summary()` 保存回合主题摘要（下一轮候选召回的来源），并附上已提交产品事实引用；`clarification` 分支直接汇入这里 |
| 39 | `result_finalization` | `FinalizeExecutor` | 以 `product_finalization_gate` 身份记录 result_candidate Trace，`ctx.yield_output(response)` 产出最终答复。外层 ProductAwareWorkflow 在此提交 Product Message 终态，防止过早 `RUN_FINISHED` |

### 5. 两个分支点的真实条件

分支不写在 Executor 里，而是 MAF `add_switch_case_edge_group` 的声明式条件（按声明顺序求值，工作台"未走原因"就来自这份顺序）：

```python
# scenario_router 之后：4 条候选边
.add_switch_case_edge_group(router, [
    Case(condition=components.is_project_catalog_state, target=project_catalog),  # 1 确定性目录查询
    Case(condition=lambda value: value.scenario == "clarify", target=clarification),  # 2 澄清
    Case(condition=components.needs_plan, target=planner),                        # 3 需要规划
    Default(target=compiler),                                                     # 4 直接进入执行合同
])

# execution_route 之后：3 条候选边
.add_switch_case_edge_group(execution_route, [
    Case(condition=...kind == "pi_workspace", target=execution_workspace_prepare),  # 隔离编辑
    Case(condition=...kind == "pi_readonly", target=pi_readonly_dispatch),          # 只读检查
    Default(target=responder),                                                      # answer_only 直接回答
])
```

`is_project_catalog_state` 和 `needs_plan` 是合同层纯函数（`continuous_chat_contracts.py`），可单测；多 Intent 时 `needs_plan` 强制成立（多目标必须组合 Plan）。

四条主要路径与模型调用次数：

| 场景 | 走过的节点 | 模型调用 |
|------|-----------|---------|
| 明确项目目录查询 | 1-16 → 17 → 34-39（护栏命中时 6 也不调模型） | 0-1 次 |
| 需要澄清 | 1-16 → 18 → 38-39 | 1 次（意图） |
| 简单问答 | 1-16 → 21-24 → 32 → 33 → 34-39 | 3 次 |
| 规划 + pi 隔离编辑 | 1-16 → 19-24 → 25-29 → 33 → 34-39 | 2 次 + pi 内部逐次审批 |

### 6. 两个核心复用类的内部流程

#### 6.1 `ProductDecisionExecutor`（9 个决策节点的共同引擎）

```text
handler(state):
  spec.applicable(state) 为假 -> 直接透传
  register_subject      # 不可变DecisionSubject，内容Hash提交时复算
  evaluate_subject      # HITL策略矩阵求值（系统下限+用户偏好两阶段）
  ├─ deny          -> 抛 PermissionError（Run失败关闭）
  ├─ auto_continue -> 记录自动Decision + 消费Grant，直接推进
  └─ waiting_human -> create_human_request + mark_waiting_approval
                      + ctx.request_info(决策卡, dict)   # MAF Interrupt，Checkpoint落盘

@response_handler resolve(response):
  accept -> 记录Decision、消费一次性Grant、推进
  revise -> spec.revise(state, changes) 产生新状态（目录Context修改会先落成
            新的不可变Context revision再推进，幂等command_id）
  skip   -> allow_skip 时按spec清空对应候选后推进
  cancel -> Run以用户取消收敛，零后续副作用
```

关键不变量：批准绑定当前主体 Hash；Grant 一次性消费；崩溃重进按不可变 Subject 重入复用，不产生重复审批。

#### 6.2 `GovernedSemanticAgentExecutor`（4 个模型调用节点的共同引擎）

```text
_begin:    task_builder(state) 生成任务 -> 建 ModelCallDraft revision（可编辑、有Hash）
           确定性护栏命中（仅intent节点的项目目录查询）-> 跳过全部Provider流程
_register: register_model_call -> 治理评估（人工审批或有界自动推进）
_dispatch: claim_grant（唯一领取）-> start_model_call_attempt
           -> Provider流式发送已批准bytes（逐段记录 provider.dispatch/receive/decode）
           -> finish_model_call_attempt（HTTP、用量、可见输出Hash持久化）
_deliver:  按 result_kind 解析文本：
           intent   -> _normalize_intent_candidates（多候选归一化）
           plan     -> 纯文本计划
           response -> 答复文本
           summary  -> JSON + 写回策略过滤
           record_model_output_disposition 记录去向：
           accepted_as_intent/plan/response/summary、rejected_invalid_output、
           overridden_by_deterministic_guard、accepted_with_writeback_filter
```

ModelCallDraft 准备、审批和 Provider Dispatch 前都会执行 `RepositorySourceFreshnessGuard`：仓库 Context 过期则以 `context_source_stale` 失败关闭且 Provider Attempt 保持 0（零发送）。

### 7. 版本与演进轨迹

图版本随节点增量演进，旧 Checkpoint 按图签名规则失败关闭，不静默兼容：

| 版本 | 节点数 | 增加了什么 |
|------|--------|-----------|
| v1.4.0 | 28 | Intent Set 与多 Intent 组合 Plan（阶段 B） |
| v1.5.0 | 31 | Repository Context 与两级 Context revision 投影（SD1-C） |
| v1.6.0 | 34 | pi 只读执行分支（SD2） |
| v1.7.0 | 37 | 受管 Workspace 与 pi 隔离编辑分支（SD3） |
| v1.8.0 | 39 | `result_claim_prepare` + `result_claim_decision` 结果证据链（SD4-C） |

## 关键文件

| 文件 | 职责 |
|------|------|
| `backend/app/workflows/catalog.py` | `CONTINUOUS_COLLABORATION_WORKFLOW` 静态定义：39 节点、全部边、分支条件文案，供前端目录与设计者视图 |
| `backend/app/workflows/continuous_chat.py` | 约 20 个 Executor 类、`TraceMixin`、9 个 `ProductDecisionSpec`（`_decision_specs()`）、6 个 revise 函数、`create_continuous_collaboration_workflow()` 兼容入口 |
| `backend/app/workflows/continuous_chat_factory.py` | `ContinuousWorkflowComponents` 依赖注入容器 + `WorkflowBuilder` 接线（边顺序、两个 SwitchCase 组、输出与 Checkpoint 配置） |
| `backend/app/workflows/continuous_chat_contracts.py` | `CollaborationState` 不可变状态、路由纯函数、意图归一化、摘要写回策略、canonical Hash |
| `backend/app/workflows/continuous_chat_prompts.py` | `intent_task` / `plan_task` / `response_task` / `summary_task` |
| `backend/app/execution_dispatch/workflow.py` | `ExecutionRouteExecutor`、`ExecutionWorkspacePrepareExecutor`、pi 只读/隔离编辑 dispatch 与 result assembly 共 6 个 Executor |
| `backend/app/execution_dispatch/result_gate.py` | `ResultClaimPrepareExecutor`、`ResultClaimDecisionExecutor` |
| `backend/app/evidence/result_pipeline.py` | `ResultPipelineCoordinator`：Claim/Contract/Artifact 编排与幂等 |

## 补充记录

（后续对话中的补充、修正或新发现，按日期追加）
