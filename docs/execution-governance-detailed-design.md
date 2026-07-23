# ExecutionDraft、RunSpec 与 HITL 详细设计

> 状态：**已批准；D1-D7 纵向切片已实现**（2026-07-22）
> 日期：2026-07-22
> 上位合同：[ExecutionDraft、RunSpec 与 HITL 治理合同](./execution-governance-contract.md)
> 本文授权边界：D1-D7 已获用户批准；正式 Schema、应用服务、主 Workflow 接合、前端 HITL 矩阵、ExecutionDraft完整编辑以及主Workflow审批安全点的Outbox/Checkpoint跨进程恢复已有纵向实现。完整 Work/Memory 生命周期仍未获详细设计审核，具体事实以 `PROJECT_STATE.md` 和测试证据为准。

## 1. 结论

建议采用一套“产品事实与运行时恢复分离”的混合关系模型：

1. `ExecutionDraft`、`ModelCallDraft`都使用“稳定聚合 + 不可变 revision”。修改永远产生新 revision，不覆盖已经审核的内容。
2. `RunSpec`是一次编译生成的不可变执行合同；它只保存固定合同，不保存运行进度。
3. HITL使用统一的`DecisionSubject -> PolicyEvaluation -> HumanDecisionRequest/DecisionRecord -> AuthorizationGrant`链路，不为12种决策点各写一套审批表。
4. 策略使用“Policy Set + 不可变 revision + 激活指针”，系统安全下限与用户偏好分层解析；用户配置永远不能放宽安全、身份、能力和当前运行事实形成的下限。
5. 人工决定先成为Product Store中的事实，再通过事务Outbox恢复MAF Workflow；不能先恢复运行、后补审批记录。
6. 前端不展示一张难以理解的`12 × 16`巨型表。用户每次选择一个作用域，在同一张12行矩阵里同时看“本层配置、继承来源、最终生效结果和重新暂停条件”。
7. Web通过AG-UI Resume提交当前Run的决定；AG-UI入口先调用产品应用命令记录事实，再由Outbox驱动MAF `request_info`恢复。Channel Adapter也调用同一个应用命令，不能各自维护审批状态。

目标关系如下：

```text
ExecutionDraftRevision ──compile──> RunSpec ──bind──> Product Run / Attempt
          │                              │
          └──────────> DecisionSubject <─┴─ ModelCallDraftRevision / ToolCallRequest
                              │
                              v
                       PolicyEvaluation
                        /             \
              auto/deny               require_human
                 │                         │
          DecisionRecord        HumanDecisionRequest
                 │                         │
                 └──────────────┬──────────┘
                                v
                      AuthorizationGrant
                                │
                       AuthorizationConsumption

HumanDecisionRequest ── RuntimeInterruptLink ── MAF request_info / Checkpoint
          │
          └── decision transaction ── GovernanceOutbox ── resume Worker
```

## 2. 证据边界

### 2.1 MAF事实

当前项目安装版为`agent-framework-core==1.11.0`、`agent-framework-ag-ui==1.0.0rc8`；本地参考源码提交为`9c4cd07899502157284b64a73f9a0adfb4594d96`。

1. Workflow `request_info(request_data, response_type, request_id)`能暂停并通过`Workflow.run(responses={request_id: response})`恢复；同一Executor必须有`@response_handler`。
2. `WorkflowCheckpoint`保存图签名、消息、状态和`pending_request_info_events`；恢复时校验图签名，未知request id或响应类型错误会失败。
3. 未解决的多个pending request可以分批恢复，剩余请求会继续被重新发出。
4. AG-UI把`request_info`投影成标准Interrupt，并携带MAF request id、Executor、请求/响应类型等元数据；AG-UI Snapshot仍只是协议投影，不是Product Approval事实。
5. MAF `ToolApprovalMiddleware`是实验性、AgentSession-backed的Tool审批机制，支持Tool级或“Tool + 精确参数”standing rule，并保留hosted `server_label`边界；它只覆盖Tool Call，不覆盖本项目12类决策点、系统下限、RunSpec或持久Product Decision。

因此：MAF拥有工作流暂停、Checkpoint和恢复语义；本项目必须拥有策略、人工请求、决定、授权和运行对象到Checkpoint的持久映射。

### 2.2 参考项目事实

| 参考源 | 真实覆盖 | 本设计采用 | 不采用 |
|---|---|---|---|
| pi `2b00dade…` | 全局/项目设置合并、一次运行override、Project Trust、扩展式Tool gate；无内置通用permission popup | 明确作用域、无UI时关闭失败、临时override不污染持久默认 | 不把扩展中的进程内确认当持久HITL；不复制“没有内置权限治理” |
| nanobot `2c789767…` | Channel pairing持久许可、Tool allow/deny pattern、显式Agent loop | Channel身份先于运行策略；Tool请求有明确单次边界 | 不采用允许用户allow pattern越过内置deny的优先级；未发现通用HITL策略模型 |
| QwenPaw `21344275…` | Tool风险分级、builtin/user两层规则、exact/similar批准、session/permanent scope、统一Channel审批卡和审计 | 系统规则不可被用户文件覆盖、严格度合并、审批范围明确、决策来源可解释 | 不采用进程内`Future`作为恢复事实；不让LLM泛化结果直接获得授权；不把Tool专用规则冒充全部HITL |
| LibreChat `8e5ef1fb…` | Tool Approval mode、只可收紧的hook、持久Checkpoint、pending action、CAS恢复、TTL、同批Tool按call id决策 | pending action与Checkpoint分离、action id CAS、server-only resume context、批量决定完整性校验 | 不复制LangGraph/Redis/Mongo实现；它的agent/skill策略层仍是预留接口，不能为本项目全部作用域背书 |

### 2.3 本项目推导

下面内容不是MAF或参考项目的原生保证，而是由Chat产品规则推导：

1. 17部分ExecutionDraft、16部分RunSpec和12种Decision Point。
2. 11级作用域优先级、4类不可放宽下限和自动决定留痕。
3. `DecisionSubject`统一技术超类型、`AuthorizationGrant`及一次性消费账本。
4. 人工决定与MAF Resume之间的事务Outbox。
5. 面向设计者的前端有效策略矩阵和运行时决定收件箱。

## 3. 数据设计原则

### 3.1 关系字段管理身份与生命周期，JSON管理版本化语义

不采用“所有对象塞进一张JSON表”，也不把17/16部分拆成数十张难以版本化的小表。固定做法是：

1. ID、FK、revision、状态、CAS、Hash、时间和常用查询字段关系化。
2. ExecutionDraft、RunSpec、策略条件、决定可见依据使用经过Schema验证的canonical JSON。
3. Provider实际请求同时保存JSON投影和最终UTF-8 bytes；审批Hash绑定bytes，发送时复用同一bytes。
4. JSON中只保存业务内容和引用，不保存API Key、Authorization Header、Provider Client、回调函数或模型隐藏推理。

### 3.2 Canonical与Hash

项目固定`canonical-json-v1`：UTF-8、对象key排序、紧凑分隔符、保留Unicode、禁止NaN/Infinity。Hash使用域分隔：

```text
sha256("<object-kind>:<schema-version>\0" + canonical-bytes)
```

至少固定：

1. `context_hash`
2. `draft_hash`
3. `run_spec_hash`
4. `policy_snapshot_hash`
5. `decision_subject_hash`
6. `request_hash`
7. `provider_body_sha256`
8. `authorization_binding_hash`

Hash只能证明内容绑定，不能代替Principal授权、有效期或一次性消费。

### 3.3 不可变含义

“不可变”指语义列不可原地更新；生命周期列可以变化。例如RunSpec的`spec_json`与`run_spec_hash`不可改，但可以被标记为`invalidated`。正式实现必须在Service和数据库合同测试中同时验证这一点。

## 4. ExecutionDraft正式Payload

`execution-draft-v1`要求17个语义部分全部存在；暂时没有内容时使用空数组或明确的`not_applicable`，不能静默省略：

| JSON key | 类型 | 固定内容 |
|---|---|---|
| `identity_lineage` | object | Draft、Session、Interaction、Workflow、父revision和创建来源 |
| `intent_goal` | object | 当前Intent、用户目标、成功定义、置信度及revision引用 |
| `project_work_binding` | object | Project、WorkItem、ActionItem、TaskPlan引用和绑定原因 |
| `background` | array | 最小充分背景事实；每项有来源、revision、采用理由 |
| `accepted_decisions` | array | 已接受Decision Record引用；候选意见不得进入 |
| `scope` | object | 包含/排除范围、交付边界、责任边界 |
| `plan` | object | 步骤、依赖、检查点、并行/顺序、负责人 |
| `context_binding` | object | ContextPackage/Manifest引用、锁定项、排除项和`context_hash` |
| `resource_manifest` | array | 文件、知识、Evidence、外部资源的引用与读取策略 |
| `runtime_target` | object | Runtime、工作目录、隔离方式、Worker能力和版本 |
| `capability_grant` | object | Tool、路径、网络、外部系统、预算和副作用上限 |
| `model_envelope` | object | Provider/模型允许集、推理/输出/Token/费用边界 |
| `prompt_assembly_plan` | object | 8个逻辑Prompt块、来源、优先级、何时让Agent自行读取 |
| `hitl_plan` | object | 适用Decision Point、预计暂停、强制暂停和策略摘要 |
| `validation_plan` | object | 验证层级、测试、Evidence、完成门和失败处理 |
| `output_commit_contract` | object | 候选结果、Product Message、Work/Memory提交条件 |
| `stop_escalation` | object | 停止、预算耗尽、失败、结果未知、扩权和升级条件 |

附加但不增加第18个语义部分的顶层元数据：

1. `schema_version`
2. `execution_brief.generated_text`
3. `execution_brief.override_text`
4. `execution_brief.generated_from_hash`

`override_text`非空时是当前可执行Brief；生成文本仍保留用于Diff。用户修改Brief会形成新Draft revision并重算`draft_hash`。

## 5. RunSpec正式Payload

`run-spec-v1`固定16部分：

| JSON key | 固定内容 |
|---|---|
| `identity` | RunSpec ID、Schema/Compiler版本、编译时间 |
| `source_binding` | Draft revision/hash及Intent、Context、Work、Plan、Decision引用 |
| `principal_scope` | Principal、Tenant/Scope、Channel Binding、授权边界 |
| `workflow_binding` | Workflow definition/version、图签名、入口、节点清单 |
| `execution_brief` | 已确定的最终Brief和来源hash |
| `context_manifest` | 唯一Context Manifest、来源revision、顺序和`context_hash` |
| `plan` | 已解析步骤、依赖、Agent/Tool/Runtime分配 |
| `prompt_assembly_contract` | 8个逻辑块、装配器版本、禁止隐式历史来源 |
| `runtime_agent` | Runtime、Worker要求、Agent Profile revision、隔离边界 |
| `capability_envelope` | Tool allowlist、参数/路径/网络/副作用限制 |
| `model_envelope` | Provider/模型、调用/Token/费用/时间预算、`store=False`等硬约束 |
| `hitl_policy_snapshot` | Policy Snapshot引用、12点结果、下限和重新暂停触发器 |
| `validation_evidence` | 测试要求、Evidence收集、完成门 |
| `output_commit` | 结果、消息、Work、Memory的候选与提交门 |
| `control` | cancel/steer/retry/restart、outcome_unknown、升级语义 |
| `correlation_idempotency` | Product/AG-UI/MAF关联ID与幂等key生成规则 |

RunSpec不保存当前节点、已用Token、Tool结果或流式内容。这些分别属于Product Run、Run Attempt、Trace、Tool Execution、Model Call Attempt和Evidence。

## 6. 正式关系Schema

### 6.1 Execution与RunSpec：3张表

#### `execution_drafts`

稳定聚合和当前指针。

| 列 | 类型/约束 |
|---|---|
| `id` | UUID PK |
| `session_id` | FK `product_sessions.id`, NOT NULL |
| `interaction_id` | FK `interactions.id`, NOT NULL |
| `principal_id` | String, NOT NULL |
| `workflow_definition_id` / `workflow_version` | String, NOT NULL |
| `current_revision_id` | FK `execution_draft_revisions.id`, deferrable application binding |
| `accepted_revision_id` | nullable FK `execution_draft_revisions.id` |
| `acceptance_decision_record_id` | nullable FK `decision_records.id` |
| `status` | `building/reviewable/awaiting_decision/accepted/rejected/expired/superseded` |
| `row_version` | Integer CAS, NOT NULL |
| `created_at/updated_at` | UTC datetime |

约束：同一Interaction默认只有1个未终结ExecutionDraft；Workflow显式拆分多个Run时可用`branch_key`扩展，不能复用同一个Draft表达两个不同执行目标。

#### `execution_draft_revisions`

| 列 | 类型/约束 |
|---|---|
| `id` | UUID PK |
| `draft_id` | FK `execution_drafts.id`, NOT NULL |
| `revision` | Integer, `UNIQUE(draft_id, revision)` |
| `previous_revision_id` | nullable self FK |
| `subject_id` | UNIQUE FK `decision_subjects.id` |
| `schema_version` | `execution-draft-v1` |
| `payload_json` | JSON, NOT NULL，17部分校验通过 |
| `execution_brief_text` | Text, NOT NULL，最终有效Brief |
| `context_hash` / `draft_hash` | SHA-256 String(64), NOT NULL |
| `author_type` | `user/agent/system/import` |
| `author_id` | String, NOT NULL |
| `status` | 当前revision生命周期；语义列不可更新 |
| `created_at` | UTC datetime |

#### `run_specs`

| 列 | 类型/约束 |
|---|---|
| `id` | UUID PK |
| `draft_revision_id` | FK, NOT NULL |
| `subject_id` | UNIQUE FK `decision_subjects.id` |
| `policy_snapshot_id` | FK `hitl_policy_snapshots.id`, NOT NULL |
| `schema_version` / `compiler_version` | String, NOT NULL |
| `spec_json` | JSON, NOT NULL，16部分校验通过 |
| `run_spec_hash` | SHA-256, NOT NULL |
| `status` | `compiled/ready/bound/invalidated/retired` |
| `bound_run_id` | nullable UNIQUE FK `product_runs.id` |
| `invalidated_at/reason_code` | nullable |
| `created_at` | UTC datetime |

同一Draft revision可以因为编译器或有效策略变化产生多个RunSpec，但同一`draft_revision + compiler_version + policy_snapshot_hash`只能有一份相同Hash的有效结果。

### 6.2 Decision Point与策略：5张表

#### `decision_point_definitions`

代码/迁移拥有的只读目录，复合唯一键`(key, version)`。列包括：

`id, key, version, category, label, description, subject_kind, default_mode, allowed_human_actions_json, applicability_schema_json, response_schema_json, active, definition_hash`。

首批固定12个key：

`intent_binding, project_work_binding, context_adoption, plan_acceptance, execution_authorization, model_call_authorization, tool_execution_authorization, work_state_commit, memory_commit, result_commit, runtime_recovery, unknown_or_high_risk`。

#### `hitl_policy_sets`

一个确定作用域上的稳定策略身份。

| 列 | 说明 |
|---|---|
| `id` | UUID PK |
| `authority` | `system_safety/identity_scope/capability/product_default/user_preference` |
| `scope_kind` | 16种具体scope kind，见第9节 |
| `scope_ref_id` | 对应对象稳定ID；Product Default为`*` |
| `scope_ref_revision` | Workflow/Profile等需要版本绑定时填写 |
| `owner_principal_id` | 用户偏好所有者；系统策略为空 |
| `active_revision_id` | nullable FK revision |
| `status` | `active/disabled` |
| `row_version` | CAS |
| `created_at/updated_at` | UTC datetime |

唯一约束：`authority + scope_kind + scope_ref_id + scope_ref_revision + owner_principal_id`只能有一个Policy Set。

#### `hitl_policy_revisions`

| 列 | 说明 |
|---|---|
| `id` | UUID PK |
| `policy_set_id` / `revision` | FK + 单调整数，唯一 |
| `base_revision_id` | 创建本版时看到的上版，供CAS/Diff |
| `status` | `draft/active/superseded/disabled` |
| `schema_version` | `hitl-policy-v1` |
| `policy_hash` | 包含所有规则的Hash |
| `change_summary` | 面向人的变更说明 |
| `effective_from/expires_at` | 可选有效期 |
| `created_by/activated_by` | Principal |
| `created_at/activated_at` | UTC datetime |

每个Policy Set最多一个`active` revision；激活通过`expected_active_revision_id`做CAS，不能最后写入覆盖。

#### `hitl_policy_rules`

每个Policy revision对每个Decision Point最多1行，唯一`(policy_revision_id, decision_point_key)`。

| 列 | 说明 |
|---|---|
| `id` | UUID PK |
| `policy_revision_id` | FK |
| `decision_point_key` / `definition_version` | 固定目录引用 |
| `mode` | `inherit/deny/require_human/conditional/auto_continue` |
| `condition_json` | nullable，受限DSL；只有conditional需要 |
| `on_match` | conditional时仅`deny/require_human` |
| `constraints_json` | 自动范围、预算、路径/Tool/模型等硬约束 |
| `reason_template` | 展示为什么采取该模式 |
| `condition_specificity` | 激活时由编译器计算，不接受前端填写 |
| `rule_hash` | 规则Hash |

条件DSL只允许`all/any/not`与白名单事实的`eq/in/gte/lte/prefix`操作。事实白名单首批包括：

`risk.level, uncertainty.score, side_effect.kind, data.sensitivity, tool.id, resource.path_class, external.destination_class, cost.estimated, tokens.estimated, model.call_ordinal, context.changed, capability.expanded, runtime.recovery_kind, subject.changed_since_decision`。

禁止脚本、任意表达式和任意数据库字段名。缺少事实、DSL错误或Evaluator版本不支持时，最终结果为`require_human`。

#### `hitl_policy_snapshots`

RunSpec编译时冻结用户偏好和当时下限引用：

`id, principal_id, resolver_version, active_revision_refs_json, preference_rules_json, floor_rules_json, snapshot_hash, created_at`。

运行时每个决策点使用“已固定Snapshot + 当前更严格的系统/身份/能力/运行事实”。策略后来放宽不影响已编译Run；策略收紧、权限撤销或能力边界变化可以立即使旧授权失效。

### 6.3 决策与授权：7张表

#### `decision_subjects`

这是技术超类型，不是新的用户概念。任何要被决定的不可变对象先注册成Subject，其他表用FK引用，避免无法校验的`object_type + object_id`多态外键。

`id, subject_kind, resource_id, resource_revision, subject_hash, session_id, interaction_id, run_id, run_attempt_id, workflow_definition_id, workflow_version, node_id, decision_view_json, created_at`。

唯一约束：`subject_kind + resource_id + resource_revision + subject_hash`。`decision_view_json`只保存可展示摘要；完整权威内容仍在所属领域表中。

#### `policy_evaluations`

一次适用性与策略解析结果，append-only：

`id, subject_id, decision_point_definition_id, policy_snapshot_id, principal_id, applicability_status, facts_json, facts_hash, matched_rule_refs_json, floor_action, preference_action, final_action, result_status, reason_codes_json, resolver_version, evaluated_at`。

规则：

1. `applicability_status=not_applicable`时`final_action`为空并记录原因。
2. 适用点的`final_action`只能是`deny/require_human/auto_continue`。
3. 解析异常写`result_status=failed_closed`且`final_action=require_human`。

#### `human_decision_requests`

一个可投影到AG-UI/Channel的人工交互信封，可以装1个或同类多个item：

`id, decision_point_key, principal_id, session_id, interaction_id, run_id, request_hash, title, reason_summary, visible_evidence_json, consequence_json, status, row_version, created_at, expires_at, resolved_at, superseded_by_request_id`。

状态只表示请求生命周期，不把“拒绝”混成请求状态。拒绝是一条Decision Record。

#### `human_decision_request_items`

解决并行Tool Call或并行Agent节点的批量决策：

`id, request_id, policy_evaluation_id, subject_id, item_key, ordinal, allowed_actions_json, status, decision_record_id`。

1. `item_key`使用Provider `tool_call_id`、MAF request id或稳定Subject ID，绝不按数组位置关联。
2. 同一个Request只允许一个Decision Point类型。
3. 提交时必须完整覆盖全部pending item；缺项、重复item或不允许的动作整体拒绝，不能半恢复Workflow。

#### `decision_records`

不可变的人工、策略或系统决定：

`id, policy_evaluation_id, request_id, request_item_id, subject_id, source, actor_principal_id, decision_code, authorization_effect, reason, bound_subject_hash, policy_rule_refs_json, input_hash, record_hash, revokes_record_id, created_at`。

`source`为`human/policy/system`；`authorization_effect`为`allow/deny/none`。修改、返回重做和取消使用`decision_code`表达，但不会生成执行授权。

#### `authorization_grants`

Decision Record中真正允许后续动作的子类型：

`id, decision_record_id UNIQUE, subject_id, grant_kind, binding_hash, constraints_json, max_consumptions, consumed_count, valid_from, expires_at, status, revoked_at, invalidated_at, invalidation_reason, row_version, created_at`。

`grant_kind`首批包括`compile_run_spec, start_run, send_model_call, execute_tool, commit_work_state, commit_memory, commit_result, perform_recovery`。

#### `authorization_consumptions`

一次实际使用授权的账本：

`id, grant_id, consumption_no, consumer_kind, consumer_id, attempt_id, idempotency_key, status, claimed_by, claimed_at, dispatched_at, finished_at, error_code`。

约束：

1. `UNIQUE(grant_id, consumption_no)`。
2. `UNIQUE(idempotency_key)`。
3. 领取在事务中同时校验grant状态、有效期、binding hash和剩余次数。
4. `send_model_call`、高副作用Tool和恢复操作默认`max_consumptions=1`。
5. `outcome_unknown`不自动释放额度；重试生成新Subject、新Evaluation和新授权。

### 6.4 MAF恢复：2张表

#### `runtime_interrupt_links`

Product请求到MAF/AG-UI运行对象的桥：

`id, decision_request_id UNIQUE, product_run_id, run_attempt_id, maf_workflow_name, maf_graph_signature_hash, maf_checkpoint_id, maf_request_id, maf_executor_id, agui_thread_id, agui_run_id, agui_interrupt_id, status, last_projected_at, resume_attempts, last_error_code, created_at, updated_at`。

唯一约束：`(maf_checkpoint_id, maf_request_id)`。Checkpoint、request id和图签名缺一时不能进入可恢复状态。

#### `governance_outbox`

`id, aggregate_kind, aggregate_id, event_type, payload_json, dedupe_key UNIQUE, status, available_at, attempt_count, locked_by, locked_until, last_error_code, created_at, published_at`。

用户决定的同一数据库事务必须同时：

1. CAS解决HumanDecisionRequest。
2. 插入Decision Record和必要的Authorization Grant。
3. 把Interrupt Link推进到`decision_recorded`。
4. 插入`runtime.resume_requested` Outbox事件。

任何一步失败都回滚。Worker崩溃时Outbox可重放；`dedupe_key`和Interrupt状态确保不会二次驱动同一MAF请求。

### 6.5 逐次模型与Tool接合：4张表

#### `model_call_drafts`与`model_call_draft_revisions`

稳定call slot与不可变Provider请求版本：

1. `model_call_drafts`：`id, run_id, run_attempt_id, workflow_node_id, call_ordinal, current_revision_id, status, row_version, created_at`。
2. `model_call_draft_revisions`：`id, model_call_draft_id, revision, previous_revision_id, subject_id, provider_id, provider_protocol, model, provider_request_json, provider_body BLOB, provider_body_sha256, binding_hash, effective_context_json, context_source_annotations_json, adapter_version, status, created_at`。

人类可读视图和Provider JSON都从同一`provider_body`投影；来源说明与Token估算明确标为“不会发送给模型”。

#### `model_call_attempts`

`id, model_call_draft_revision_id, authorization_consumption_id UNIQUE, run_id, run_attempt_id, attempt_number, transport_idempotency_key, status, http_status, provider_response_id, usage_json, started_at, first_byte_at, finished_at, failure_code`。

批准一次最多创建一个Attempt。Provider SDK和Transport自动重试保持关闭；用户重试必须重新形成Authorization。

#### `tool_call_requests`

`id, run_id, run_attempt_id, workflow_node_id, provider_tool_call_id, tool_id, tool_definition_revision, arguments_json, arguments_hash, target_summary, risk_snapshot_json, subject_id, status, created_at`。

现有`tool_executions`增加`tool_call_request_id`与`authorization_consumption_id`，真实Tool仍必须来自服务端Tool Catalog，前端不能创建新Tool name。

### 6.6 现有表的目标调整

| 现有表 | 目标调整 |
|---|---|
| `product_runs` | 增加`execution_draft_revision_id`、`run_spec_id`；`draft_id/approval_id`在新链路稳定后退役 |
| `run_attempts` | 增加`start_authorization_consumption_id`；Retry/Restart是否复用RunSpec必须显式记录 |
| `product_messages` | Assistant候选提交时增加`commit_decision_record_id`；没有结果提交门不得标记committed |
| `tool_executions` | 关联ToolCallRequest和授权消费；保留`outcome_unknown` |
| `trace_events` | 只记录可观察事件与引用，不复制完整敏感Payload或隐藏推理 |

### 6.7 全库约束、索引与保留边界

正式迁移不得只创建列，还必须固化下面的跨表合同：

1. 所有时间使用UTC且由服务端写入；所有可并发更新的聚合使用`row_version`做CAS。
2. Revision、Decision、Evaluation、Grant、Consumption和Attempt使用`ON DELETE RESTRICT`；Product Session归档不能级联删除治理证据。可删除内容通过单独的保留/擦除流程处理，并保留不含敏感正文的墓碑与Hash引用。
3. `payload_json/spec_json/condition_json`在写入前经过版本化JSON Schema验证；SQLite阶段由应用服务和合同测试保证，未来数据库支持时再增加等价`CHECK`，不能形成两套不一致校验器。
4. 完整Provider Body属于高敏内容：与普通Trace分开授权、默认不进入列表API、不得包含密钥；保留期届满后可擦除Body，但保留`provider_body_sha256`、Attempt结果和擦除记录。
5. 至少建立以下复合索引：
   - `human_decision_requests(principal_id, status, expires_at)`；
   - `human_decision_requests(run_id, status, created_at)`；
   - `hitl_policy_sets(scope_kind, scope_ref_id, status)`；
   - `policy_evaluations(subject_id, decision_point_definition_id, evaluated_at)`；
   - `authorization_grants(status, expires_at)`；
   - `runtime_interrupt_links(product_run_id, status)`；
   - `governance_outbox(status, available_at)`；
   - `model_call_drafts(run_id, workflow_node_id, call_ordinal)`。
6. SQLite领取Grant和Outbox使用短事务`BEGIN IMMEDIATE`与条件更新；Repository隐藏这一实现，迁移到支持行锁的数据库时改用等价CAS/lease，领域状态机不变。
7. 所有跨表创建命令先分配稳定ID，再在一个事务中写Subject和领域对象；不得留下只有多态字符串、无法验证目标是否存在的悬空决定。

## 7. 状态机

### 7.1 ExecutionDraft revision

```text
building -> reviewable
reviewable -> accepted          (Policy auto_continue或人工接受)
reviewable -> rejected          (Policy deny)
reviewable -> awaiting_decision (require_human)
awaiting_decision -> accepted | rejected | expired | superseded
building/reviewable/awaiting_decision/accepted -> superseded (出现新revision)
accepted -> expired             (授权/绑定在启动前失效)
```

关键语义：

1. 编辑任何影响执行的内容：旧revision变`superseded`，新revision从`building/reviewable`开始；旧Decision和Grant不能迁移。
2. `accepted`只允许编译RunSpec，不代表Run已创建或成功。
3. 用户选择“返回修改”会为旧Subject写`revise` Decision Record，但不产生Authorization；新revision重新评估。

### 7.2 RunSpec

```text
compiled -> ready -> bound -> retired
compiled/ready -> invalidated
bound --尚未启动且绑定失效--> invalidated
bound --已运行--> 不改Spec；Run进入HITL/Steer/Stop并形成Amendment或新Run
```

`compiled -> ready`必须通过Schema、引用存在、Policy Snapshot、当前权限、Workflow图签名和能力校验。RunSpec不使用`running/succeeded`，因为这些是Product Run状态。

### 7.3 Policy revision

```text
draft -> active -> superseded
draft -> disabled
active -> disabled
```

激活新revision时，旧active和新active在同一事务中切换。激活更宽松的规则必须展示Diff、有效范围和重新暂停条件；CAS冲突时前端重新加载，不自动覆盖。

### 7.4 HumanDecisionRequest

```text
pending -> resolved
pending -> cancelled
pending -> expired
pending -> superseded
```

1. `resolved`的具体结果在Decision Record，不在status。
2. 关闭卡片或“稍后处理”保持`pending`；它不是拒绝。
3. 修改审核对象先以`revise`解决旧请求，再创建新Subject/Evaluation/Request。
4. 同一个`request_hash + row_version`只有一个提交者能成功；第二个点击得到`409 DECISION_ALREADY_RESOLVED`。

### 7.5 Authorization Grant与Consumption

```text
Grant: active -> exhausted | expired | revoked | invalidated

Consumption:
claimed -> dispatched -> completed
claimed -> failed_before_dispatch
dispatched -> failed_known | outcome_unknown
```

任何`failed/outcome_unknown`都不会偷偷把同一批准重新变成`active`。是否重试由新的`runtime_recovery`或具体请求Authorization决定。

### 7.6 Runtime Interrupt Link

```text
waiting_checkpoint -> pending
pending -> decision_recorded -> resume_queued -> resuming -> resumed
pending -> cancelled | expired | superseded
resume_queued/resuming -> recovery_required
recovery_required -> resume_queued | cancelled
```

1. `pending`要求Product Request、MAF Checkpoint、MAF request id和图签名都已绑定。
2. `decision_recorded`表示人已经决定，但运行尚未恢复；UI必须显示这一区别。
3. Worker恢复前重新验证Principal、Request状态、Subject Hash、Checkpoint图签名和MAF pending request。
4. MAF响应只包含服务端加载的`decision_record_id`和item结果；不信任前端重复提供的工具参数或Provider Payload。

### 7.7 Product Run集成状态

目标粗粒度状态：

```text
accepted -> preparing -> ready -> running
preparing/running/committing -> waiting_human -> running/committing
running -> committing -> succeeded
任意非终态 -> cancelling -> cancelled
任意非终态 -> failed | outcome_unknown | interrupted
```

`waiting_human`只告诉列表“Run在等人”，具体等什么由HumanDecisionRequest和Workflow节点决定。一次Run可以多次进入`waiting_human`，不能只保存单个`approval_id`。

## 8. Policy Evaluation正式算法

### 8.1 最终动作严格度

```text
deny > require_human > auto_continue
```

`inherit`和`conditional`不能成为最终动作。`not_applicable`是适用性结果，不参与严格度比较。

### 8.2 两段解析

1. 计算不可放宽下限：System Safety、当前Identity/Scope、Capability边界和Runtime Facts。
2. 在用户偏好层按作用域从具体到宽泛找到命中规则；更具体偏好可以放宽更宽泛偏好。
3. 最终动作取“下限动作”和“用户偏好动作”的更严格者。
4. Run已经固定的用户偏好Snapshot不会因后来放宽而变化；当前下限如果收紧则立即参与。

### 8.3 同层冲突

1. 先比较作用域rank。
2. 同rank的所有实际命中对象先分别求值，取更严格最终动作。
3. 严格度相同，exact ID/version selector优于类型/wildcard。
4. 仍相同，`condition_specificity`更高者优先。
5. 仍相同，使用较新的已激活revision。
6. 仍无法唯一决定属于Evaluator错误，关闭失败为`require_human`。

### 8.4 Conditional

```text
条件命中 -> on_match（deny或require_human）
条件未命中 -> auto_continue
事实缺失/过期/解析失败 -> require_human
```

系统不能用低置信模型输出直接产生“事实缺失=false”。风险、权限、预算和副作用事实必须来自确定性分类器、服务端Catalog或已接受Decision。

## 9. HITL作用域与优先级矩阵

下面16个具体scope kind映射到已经批准的11级作用域。数字越大越具体：

| rank | 作用域组 | `scope_kind` | 生命周期/入口 |
|---:|---|---|---|
| 1100 | Decision Instance | `decision_instance` | 当前Subject revision/hash；决定卡就地 |
| 1000 | Run | `run` | 到Run终态；运行工作台就地 |
| 900 | Interaction | `interaction` | 当前用户输入形成的完整Interaction |
| 800 | Product Session | `product_session` | 当前会话；会话设置就地 |
| 730 | Project/Work/Plan | `task_plan` | 当前TaskPlan revision |
| 720 | Project/Work/Plan | `work_item` | 当前WorkItem |
| 710 | Project/Work/Plan | `project` | 当前Project |
| 620 | Workflow | `workflow_node` | definition + version + node/point |
| 610 | Workflow | `workflow_version` | 当前Workflow definition version |
| 500 | Scenario | `scenario` | 已注册场景分类，不接受自由字符串冒充 |
| 400 | Resource Profile | `agent_profile` | Agent ID + revision |
| 400 | Resource Profile | `tool_profile` | Tool ID + definition/config revision |
| 400 | Resource Profile | `model_profile` | Provider + Model capability revision |
| 300 | Channel/Surface | `channel` | Web、Telegram等真实Channel |
| 200 | Principal Default | `principal` | 用户跨会话默认 |
| 100 | Product Default | `product_default` | 产品默认；普通用户只读 |

强制下限不占用这些rank，也不参与“更具体覆盖更宽泛”；它始终与偏好结果取更严格值。

## 10. 12个Decision Point配置矩阵

前端标签不直接暴露内部enum：

| 内部mode | 用户标签 |
|---|---|
| `inherit` | 沿用更上层 |
| `require_human` | 每次询问我 |
| `conditional` | 满足条件时询问 |
| `auto_continue` | 在这个范围内自动继续 |
| `deny` | 始终阻止 |

正式首批矩阵：

| 决策点 | 产品默认 | 人工卡主要动作 | 自动继续边界 |
|---|---|---|---|
| 理解用户意图 | conditional | 接受、修改、拆分、取消 | 单一高置信Intent且不改变活动工作 |
| 关联Project/Work | conditional | 采用候选、改选、不关联 | 单一明确匹配且不跨敏感Project |
| 采用Context | conditional | 采用、移除/替换来源、返回修改 | 来源有效、同Scope、无敏感扩展、未排除锁定项 |
| 接受Plan | conditional | 接受、编辑、暂不规划、取消 | 低影响、边界明确、无权限/副作用扩张 |
| 授权ExecutionDraft | conditional | 执行、修改Draft、取消 | 只读/低影响且目标、范围、验证已明确 |
| 发送ModelCallDraft | require_human | 确认发送、直接编辑全部请求、放弃 | 用户在明确作用域配置；任何Payload/模型/预算变化重新暂停 |
| 执行Tool | conditional | 批准、修改参数、拒绝/返回Agent | 只读低风险、目标在Capability Envelope内 |
| 提交Work状态 | conditional | 提交、编辑候选、拒绝 | 不创建/删除工作、不扩大目标、不伪造完成 |
| 提交Memory | require_human | 保存、编辑、仅保留本Session、拒绝 | 仅用户明确陈述、低敏感、用户已配置范围；推断事实仍暂停 |
| 提交Result | conditional | 接受结果、要求继续验证、编辑结论 | Evidence满足且不触发外部交付/长期状态变化 |
| Runtime恢复/干预 | require_human | 重试、Restart、新Run、停止、人工处理 | 仅已证明未发送/无副作用、同RunSpec、同能力范围 |
| 未知/高风险结果 | require_human | 停止、检查外部状态、对账、明确下一步 | System Safety Floor禁止自动重试或自动宣称成功 |

即使用户选择“自动继续”，矩阵仍显示该Decision Point；运行视图记录“按策略自动通过”，不能把节点隐藏。

## 11. 前端信息架构

### 11.1 配置中心增加“人工介入”一级入口

现有配置中心为`会话 / Workflow / Agent / Tool / 系统`。目标增加：

```text
会话 / Workflow / Agent / Tool / 人工介入 / 系统
```

“人工介入”内部不是JSON编辑器，分3区：

1. **作用域导航**：我的默认、Channel、Project/Work、Workflow/节点、场景、Agent/Tool/模型、系统规则（只读）。
2. **12行有效策略矩阵**：当前层配置、继承来源、最终生效、条件摘要、重新暂停触发器。
3. **解释与影响侧栏**：为什么最终是这个结果、命中哪些revision、哪些下限锁定、保存后影响哪些对象。

Session、Interaction、Run和Decision Instance是短生命周期设置，放在当前会话/运行工作台就地修改；配置中心可以查看，但不鼓励从全局入口创建脱离当前对象的临时规则。

### 11.2 一行矩阵的固定字段

每个Decision Point一行：

| 区域 | 内容 |
|---|---|
| 名称 | 用户可读名称、1句用途 |
| 本层设置 | 5态单选；System Floor锁定项只读 |
| 条件 | 结构化摘要，如“写操作或跨Project时询问” |
| 最终生效 | 自动继续/询问/阻止，显示锁图标和颜色但不只靠颜色 |
| 来源 | “当前Project规则”“继承我的默认”“系统安全下限” |
| 重新暂停 | 关键触发器数量和首要原因 |
| 详情 | 打开解释、Diff和受影响对象 |

不要同时铺开16个作用域列。那会产生192个主单元格，用户无法判断“配置值”和“有效值”的差别。

### 11.3 条件编辑器

条件编辑器使用受控表单：

```text
当 [风险等级] [至少] [中]
并且 [副作用] [属于] [写入、外部发送]
则 [询问我]
否则 [自动继续]
```

1. 不允许输入JSON、正则或脚本。
2. Tool、Agent、模型、Workflow、Channel均来自服务端目录选择。
3. 路径使用服务端分类后的`workspace/sensitive/external/unknown`，不能用浏览器字符串匹配作为安全依据。
4. 条件缺少必需事实时，预览明确显示“事实不足时将询问”。

### 11.4 保存与激活

```text
编辑本地表单 -> 保存策略草稿 -> 检查影响 -> 激活revision
```

激活前固定展示：

1. 作用域和有效期。
2. 12行Diff。
3. 哪些规则从“询问/阻止”变为“自动继续”。
4. 系统下限仍会强制暂停的情况。
5. 受影响的当前Run不会因为规则放宽而自动改变；规则收紧可能使其下一Decision Point暂停。

使用`expected_active_revision_id`；发生冲突显示“其他页面已激活新版本”，提供比较和重新应用，不能自动覆盖。

### 11.5 “以后跳过”

决定卡上的“以后跳过”不是直接批准全部未来调用。点击后打开范围选择：

```text
仅这一次（默认）
当前Run
当前Interaction
当前Session
当前Project / Work / TaskPlan
当前Workflow版本 / 当前节点
我的默认
```

前端先展示新规则的精确Subject、约束和过期条件；`Tool + 当前精确参数`与`整个Tool`必须是不同选项。System Floor不允许的范围不显示或只读解释。

### 11.6 有效策略模拟器

配置页面提供只读模拟：选择或填入一个已注册场景，服务端`preview`返回：

```text
适用性 -> 当前下限 -> 命中作用域 -> 条件求值 -> 最终动作 -> 原因 -> 重新暂停触发器
```

模拟器不能签发Decision Record或Authorization，只用于解释。

### 11.7 运行时决定收件箱

Workflow工作台显示当前Run的1个或多个pending请求：

1. 为什么暂停。
2. 审核对象和revision/hash短标识。
3. 采用的Context、风险、Evidence和策略来源。
4. 每个允许动作及后果。
5. 批量Tool按`tool_call_id`逐项决定；全部完成后才可提交。
6. 状态明确区分“等待决定”“决定已记录，等待恢复”“正在恢复”“恢复失败，需要处理”。

决定卡不展示模型隐藏推理；只展示公开依据和可验证事实。

### 11.8 响应式与可访问性

1. 宽屏为表格 + 解释侧栏；窄屏按Decision Point转换为卡片列表。
2. 所有mode都有文本，不只使用颜色/图标。
3. 表单支持键盘导航、焦点返回、错误摘要和`aria-describedby`。
4. 未保存草稿关闭配置中心时明确确认；已激活revision永不因前端状态丢失。

## 12. 网络与运行时合同

### 12.1 REST管理产品资源

候选端点：

```text
GET  /api/hitl/decision-points
GET  /api/hitl/policy-sets?scope_kind=&scope_ref_id=
POST /api/hitl/policy-sets/{id}/revisions
POST /api/hitl/policy-sets/{id}/revisions/{revision}/activate
POST /api/hitl/policy-preview
GET  /api/hitl/decision-requests?status=pending&run_id=
GET  /api/runs/{run_id}/governance
```

策略命令携带`expected_active_revision_id`；返回同时包含configured和effective projection。

### 12.2 AG-UI处理活动Run决定

Web对当前Interrupt发送canonical AG-UI Resume。入口只接受：

`decision_request_id, expected_request_hash, expected_row_version, item_decisions[]`。

应用层步骤：

1. 用认证Principal加载Request，不能信任Thread ID授权。
2. 校验全部item、Subject Hash、允许动作、未过期和当前权限。
3. 在Product DB事务中写Decision/Grant/Outbox。
4. 立即向前端返回“决定已记录”；真正MAF恢复由Worker执行。
5. Worker从Product Store生成MAF response；成功后AG-UI继续发Run事件。

这样没有另一套Agent事件协议：REST负责策略资源，AG-UI负责活动Run的interrupt/resume和实时事件，Product Store负责授权事实。

### 12.3 Channel

Telegram等Channel的按钮或命令只解析成同一个`ResolveHumanDecisionCommand`，并绑定可信Channel Principal；不得直接调用MAF Future，也不得在Channel本地记“已批准”。

## 13. 完整场景自验证

| # | 场景 | 期望链路与结果 |
|---:|---|---|
| 1 | 简单知识问答 | Intent/Project/Plan可以not_applicable或auto并留Evaluation；默认ModelCall仍人工确认；不创建Project/Task，原始Interaction保留 |
| 2 | 用户给Project配置“ModelCall自动继续” | Snapshot命中Project；生成auto Decision + 单次Grant；发送1次；Provider/Payload/预算变化立即新Subject并重新评估 |
| 3 | 读取普通源码 vs 写`.env` | 读取可由conditional自动；敏感写入命中System/Capability Floor，用户Project级auto不能放宽，最终deny或require_human |
| 4 | Context误选了另一个Project | Context Adoption暂停；用户移除来源产生新Draft revision/hash，旧Request写revise且无授权，新Request重新展示 |
| 5 | 用户拒绝ModelCall后直接改要发送内容 | 旧ModelCall revision不发送；修改产生新revision、Subject、Request；第二次确认只消费新版Grant，完整链路可继续 |
| 6 | 用户放弃当前Run | Human Request resolved为cancel/abandon；Run取消；原始用户Prompt仍在Product Session/输入恢复投影中，用户可显式删除；旧审批协议消息不进入新模型Context |
| 7 | 双击确认/两端同时确认 | Request Hash + row_version CAS只允许一个事务成功；只有一个Grant、一个Consumption、一个ModelCallAttempt；另一个返回409 |
| 8 | 浏览器刷新、服务重启后仍待决定 | REST重建Product Request，AG-UI重建Interrupt投影；Worker用Interrupt Link加载MAF Checkpoint；无需重跑前置Executor |
| 9 | 决定已写库但Worker崩溃 | UI显示“决定已记录，等待恢复”；Outbox Lease到期后重试；同一dedupe key只恢复一次 |
| 10 | Checkpoint图版本变化 | 图签名不匹配，Interrupt进入`recovery_required`，不得拿旧决定驱动新图；要求Restart/New Run HITL |
| 11 | 两个Agent并行产生3个Tool Call | 可以有多个Request，或同一类型的批量items；每项按稳定call id决定；MAF部分resume后仍保留其他pending，Run仍waiting_human |
| 12 | 批量Tool只提交2/3项 | 服务端整体400，不写任何Decision，不恢复Workflow；用户补齐后再一次提交 |
| 13 | 用户把更宽作用域改为auto，但当前Run已Snapshot | 当前Run不因放宽而跳过原规则；新Run使用新版；如果系统下限收紧，当前Run下一点立即按更严格结果执行 |
| 14 | Tool结果`outcome_unknown` | 旧Consumption保持outcome_unknown；禁止盲重试；创建unknown/high-risk Request，用户选择对账、停止或新授权重试 |
| 15 | 无UI的Channel或后台触发 | `require_human`不能伪装auto；进入持久pending并通知可用Channel，无法通知则保持pending/超时，不执行副作用 |
| 16 | Policy条件事实缺失 | Evaluation写failed_closed，最终require_human；前端解释缺少哪个事实，不静默放行 |
| 17 | “继续昨天那个开发”同时匹配两个Project | Intent与Project Binding分别形成候选和依据；Project关联暂停，用户选定后才生成新Draft revision；未选时不启动Run |
| 18 | 一轮对话提取出长期Memory候选 | 原始Interaction照常保留；候选Memory单独进入Memory Commit，用户编辑/拒绝只影响长期Memory，不删除原始会话，也不伪装为已接受事实 |
| 19 | Agent声称任务完成但验证Evidence失败 | Result Commit不能auto；Work状态保持`in_progress/blocked`而不是`completed`，用户可要求继续验证、修改结论或停止 |
| 20 | Tool卡选择“以后跳过” | 默认仍只批准本次；用户显式选择当前精确参数、Run或更宽scope后创建Policy revision。危险Tool和系统下限不展示可放宽选项 |

以上20个场景没有发现必须回退到“每个决策点独立表”或“把Approval放进MAF Session”的情况；批量item和Outbox是保证多Agent、并发和跨进程完整性的必要结构。

## 14. 失败语义与不变量

1. 没有有效Subject Hash就不能评估。
2. 没有PolicyEvaluation就不能建立Human Request或Auto Decision。
3. 没有允许型Decision Record和有效Grant就不能编译、发送、执行、提交或恢复。
4. `auto_continue`也必须写Decision Record；“没有弹窗”不等于“没有决策”。
5. 当前权限、Capability或System Floor比Snapshot更严格时，旧Grant立即失效。
6. 用户修改审核对象必然生成新revision和新Hash；旧Grant不能转移。
7. 决定已记录与运行已恢复是两个状态；崩溃时用Outbox接续。
8. MAF Checkpoint、AG-UI Thread/Run/Interrupt ID都不是授权凭据。
9. Provider/Tool外部副作用的`outcome_unknown`不能被标成失败后自动重试。
10. Trace记录决定来源、状态、Hash和Evidence引用，不保存隐藏推理、密钥或完整敏感Body。

## 15. 测试方案

### 15.1 Schema与领域状态

1. 17/16部分缺项、未知Schema版本、非法JSON、NaN和Hash不一致拒绝。
2. 不可变语义列更新拒绝；revision单调、previous链和current指针一致。
3. 12类Decision Point目录、默认模式和允许动作快照测试。
4. 所有状态转换正向/非法边表驱动测试。
5. `inherit/conditional/not_applicable`绝不泄漏成最终动作。

### 15.2 策略解析

1. 16种scope kind逐项命中与rank测试。
2. `deny > human > auto`全组合穷举。
3. System Floor无法被Decision/Run/Project/Principal级auto放宽。
4. Conditional命中、未命中、缺事实、过期事实、非法DSL。
5. Snapshot固定、当前下限收紧、偏好放宽不影响活动Run。
6. Preview与真实Evaluate对同一输入得到完全相同结果，但Preview不写Decision/Grant。

### 15.3 并发与恢复

1. 8个并发Worker领取同一Grant只有1个成功。
2. 两个前端同时Resolve同一Request只有1个成功。
3. Decision事务后、Outbox发布前崩溃；恢复后恰好一次MAF Resume。
4. Resume中崩溃、Lease过期、再次接手；不重跑已完成前置节点。
5. Checkpoint丢失、图签名不符、request id不符进入`recovery_required`。
6. 多pending request部分恢复和批量item完整性。

### 15.4 Provider与Tool合同

1. 人类视图、Provider JSON和实际HTTP bytes同源、Hash一致。
2. `store=False`、无Continuation、关闭自动Tool loop和Provider retry。
3. 修改任一可发送字段使旧Approval失效。
4. Tool name只能来自服务端Catalog；参数修改重算Subject Hash。
5. 已发出后断线产生outcome_unknown，不能重复消费同一Grant。

### 15.5 前端

1. 矩阵显示configured/inherited/effective三者，不把继承值保存为当前层值。
2. System Floor锁定和原因可键盘访问。
3. 草稿、激活、CAS冲突、Diff、过期和恢复。
4. 条件编辑无JSON入口，非法组合在客户端和服务端都拒绝。
5. 批量请求完整决定、错误定位、刷新重建、已决定等待恢复。
6. 宽屏表格、窄屏卡片、焦点管理、屏幕阅读器标签。

### 15.6 真实纵向E2E

至少验证：

1. 默认每次ModelCall人工确认的真实Provider回合。
2. Project级auto后真实Provider回合，并在Payload变化时重新暂停。
3. 真实Tool低风险auto、高风险HITL、拒绝和参数修改。
4. 两个Agent并行Tool、刷新、后端重启和Checkpoint恢复。
5. outcome_unknown注入、对账和新授权重试。

## 16. 待审核决策卡

### D1：混合关系表 + canonical JSON，而不是单表JSON或完全拆表

- 原因：既要强FK/CAS/查询，又要稳定承载17/16部分的版本化语义。
- 选择：A 单表JSON；B 完全关系化；C 混合模型。
- 建议：C。
- 优点：可审计、可迁移、避免数十张内容子表；与当前SQLite/SQLAlchemy相容。
- 代价：必须维护Payload Schema和Hash编译器。
- 信心：高。

### D2：统一DecisionSubject，而不是12套审批表

- 原因：12种点共享版本、Hash、策略、请求、决定和授权不变量。
- 选择：A 每种独立表；B 无FK多态字符串；C 技术超类型 + 领域表反向FK。
- 建议：C。
- 优点：统一状态机且保持数据库引用完整性。
- 代价：创建领域对象时要预分配Subject ID。
- 信心：高。

### D3：Policy Set revision激活，而不是原地修改规则

- 参考：pi有scope覆盖但无审计revision；QwenPaw分builtin/user；LibreChat deny/hook只收紧。
- 建议：不可变revision + active pointer + CAS。
- 原因：RunSpec要固定策略快照，且前端必须展示Diff与来源。
- 代价：多2张表和激活命令。
- 信心：高。

### D4：Product Decision先落库，再Outbox恢复MAF

- 选择：A 前端直接resume后补记录；B Product事务 + Outbox；C 长期保持Python Future。
- 建议：B。
- 原因：只有B能覆盖“决定已记录但进程崩溃”和跨Worker恢复。
- MAF/LibreChat参考：都证明Checkpoint/interrupt与产品决定需要分离；MAF不提供Product事务。
- 代价：需要Worker Lease和Reconciler。
- 信心：高；正式跨进程E2E仍待实现。

### D5：批量Request + item，而不是假设一次只等一个决定

- 原因：多Agent和一次模型响应的多个Tool Call都会产生并发请求。
- 建议：同一Decision Point可批量，按稳定item key关联，完整提交。
- 代价：UI与API比单卡复杂。
- 信心：高；MAF支持多个pending，LibreChat按tool_call_id处理同批请求。

### D6：前端选择一个scope看12行有效矩阵，而不是完整巨型网格

- 选择：A 12×16全展开；B 一次一个scope；C 只显示最终开关。
- 建议：B。
- 原因：同时保留设计者所需细节和可理解性；configured/inherited/effective不会混成一个值。
- 代价：跨scope比较需要单独的“比较/解释”视图。
- 信心：高。

### D7：MAF ToolApprovalMiddleware不作为产品策略源

- 建议：显式Workflow工具循环使用Product Tool Governance；MAF middleware只可作为不放宽权限的防御层，不能保存用户长期规则。
- 原因：它仅覆盖Tool、状态属于AgentSession，且standing rule不包含本项目完整scope、System Floor和RunSpec绑定。
- 代价：本项目必须实现ToolCallRequest、授权消费和恢复。
- 信心：高。

## 17. 审核后实施顺序

D1-D7 已于 2026-07-22 获用户批准，实施顺序固定为：

1. Payload Schema、Decision Point目录、状态枚举和纯领域解析器。
2. Alembic迁移与Repository，先完成ExecutionDraft/RunSpec/Policy/Decision核心表。
3. 持久ModelCallDraft、ToolCallRequest和现有Run/Attempt/Trace接合。
4. AG-UI Resume应用命令、Interrupt Link、Outbox Worker和MAF Checkpoint恢复。
5. 配置中心“人工介入”矩阵、运行时决定收件箱和有效策略解释器。
6. 并发、重启、真实模型、真实Tool和多Agent E2E。

本文已经成为获批的详细设计基线。步骤1、2、主Workflow所需的步骤3、4及配置矩阵已有纵向实现；通用ToolCallRequest、运行时决定收件箱、任意Workflow/Tool恢复和完整领域生命周期仍必须以`PROJECT_STATE.md`、迁移、代码、测试和真实运行证据判断，不能由设计批准或单一路径测试外推。
