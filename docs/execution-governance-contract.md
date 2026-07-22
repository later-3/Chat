# ExecutionDraft、RunSpec 与 HITL 治理合同

## 1. 决定状态

| 项目 | 内容 |
|---|---|
| 状态 | 有效；2026-07-22 用户要求逐项固定。 |
| 适用范围 | Chat 持续协作主 Workflow 中从用户目标、上下文和计划到 Agent/Runtime 执行的产品治理边界。 |
| 实现状态 | 未实现目标能力；当前只有逐次 ModelCallDraft 审批纵向切片，仍是单进程内存状态。 |
| 不授权内容 | 本合同不代表正式 Schema、迁移、持久 HITL、Worker 或跨进程恢复已经实现。 |
| 详细设计 | [正式 Schema、状态机与前端 HITL 配置矩阵](./execution-governance-detailed-design.md)，D1-D7 已于 2026-07-22 获用户批准并进入实施。 |

## 2. 固定关系

```text
User Prompt
+ Intent / Project / Work / TaskPlan
+ ContextPackage
+ Capability / Risk / Policy
+ Validation / Output requirements
-> ExecutionDraft（可编辑、可审核）
-> HITL Policy Evaluation
-> Human Decision 或有界 Auto Decision
-> RunSpec（不可变执行合同）
-> Product Run / Run Attempt
-> 运行中每次需要 Provider 时生成 ModelCallDraft
-> 运行中每次需要 Tool 时生成 Tool Execution Draft
```

固定边界：

1. User Prompt 是用户原始表达，不是执行规格。
2. ExecutionDraft 描述“准备怎样完成这项工作”，可以包含多步骤、多 Agent、多次模型调用和多个 Tool。
3. RunSpec 是 Worker/MAF Runtime 可以执行的不可变合同；Worker 无权扩大它。
4. ModelCallDraft 只描述一次具体 Provider 调用的最终协议请求；一个 RunSpec 可以产生多份 ModelCallDraft。
5. Tool Execution Draft 只描述一次具体 Tool 操作；Tool 提议不等于授权。
6. MAF AgentSession、Workflow Checkpoint 和 AG-UI Interrupt 不拥有 ExecutionDraft、RunSpec 或 Approval 产品事实。

## 3. ExecutionDraft 固定内容

ExecutionDraft 必须同时具有面向用户的语义结构和可计算的绑定信息。字段名可在详细 Schema 审核时调整，但下面 17 个部分不能省略。

| # | 部分 | 必须表达的内容 |
|---:|---|---|
| 1 | Identity 与血缘 | `draft_id`、revision、所属 Principal/Product Session/Interaction、替代的旧 Draft、创建来源。 |
| 2 | Intent 与目标 | 已选择 Intent 版本、用户当前目标、期望结果、优先级；多 Intent 时说明本 Draft 覆盖哪些。 |
| 3 | Project / Work 绑定 | Project、WorkItem、TaskPlan、ActionItem 的 ID 与 revision；无关联时显式为无。 |
| 4 | Background | 与当前执行直接相关的背景、当前状态、已知问题和已发生结果；每项带来源。 |
| 5 | Accepted Decisions | 已被用户或规则接受、会约束本次执行的决定；不把候选意见写成已接受事实。 |
| 6 | Scope | `in_scope`、`out_of_scope`、禁止改变的对象和允许影响的边界。 |
| 7 | Plan | 有序步骤、依赖、责任方、检查点，以及哪些步骤只是分析、哪些会产生副作用。 |
| 8 | Context Binding | ContextPackage ID/revision/hash、纳入与排除摘要、Token 预算、锁定项和用户覆盖项。 |
| 9 | Resource Manifest | 建议优先读取的文件、目录、知识、Artifact、Evidence和原始片段；区分内联内容与按需读取引用。 |
| 10 | Runtime Target | Workflow Definition/version、场景范式、Agent Profile revision、Runtime 类型、工作目录、仓库/分支或其他目标环境。 |
| 11 | Capability Grant | 可用 Tool/能力 allowlist、路径/网络/参数/副作用范围、禁止能力和动态扩权规则。 |
| 12 | Model Envelope | 允许的 Provider/模型集合、最大模型调用次数、Token/费用/时间预算、输出能力；不包含尚未生成的具体 Provider Body。 |
| 13 | Prompt Assembly Plan | 逻辑块及顺序、每块来源与采用原因、内联或按需读取方式、Token分配与裁剪规则、不同Agent/步骤拿到的输入；完整历史默认不直接拼接。 |
| 14 | HITL Plan | 本次可能出现的决策点、解析后的策略摘要、预计暂停次数和强制暂停条件。 |
| 15 | Validation Contract | Definition of Done、测试/检查命令、Evidence 要求、回归范围、结果未知和验证失败语义。 |
| 16 | Output / Commit Contract | 用户可见回复、Artifact、Evidence、允许提出的 Work/Memory Patch、交付格式和产品提交门。 |
| 17 | Stop / Escalation | 必须停止、澄清、重新规划、请求扩权或人工处置的条件。 |

### 3.1 Execution Brief

Execution Brief 是 ExecutionDraft 中面向人和 Agent 的可读表达，不是独立事实源。固定展示顺序：

```text
任务
背景与当前状态
目标与期望结果
已接受决定
范围与非目标
执行步骤
优先读取的资源
允许的能力与权限
完成标准与验证
输出要求
停止与询问条件
```

用户可以编辑上述语义部分，也可以直接编辑最终 Execution Brief。直接文本编辑记录为本 Draft 的 `user_override`，只影响本次 Draft；除非用户另行接受对应 Project/Work/Memory Patch，否则不能反写长期事实。

同一Draft中，结构化语义部分是可追踪来源，`user_override`是最终Execution Brief的最高优先内容。产生override后再修改目标、背景、范围、计划、资源、能力、验证或停止条件时，系统必须把override标为冲突并要求重新生成或重新确认，不能把新结构与旧文本静默拼接。

### 3.2 Prompt 组装逻辑块

Prompt Assembly Plan和RunSpec中的Prompt Assembly Contract使用同一组逻辑块；目标Provider协议可以把它们映射为Instructions、Messages或Input，但不能改变来源、优先关系或静默补充内容。

```text
1. 可见的产品与Agent行为指令
2. 当前Execution Brief：背景、目标、已接受决定、范围、计划、验证和停止条件
3. Project / Work / TaskPlan当前状态与本轮主题摘要
4. 经选择的Memory、Evidence、Artifact和知识内容
5. 与当前焦点相关的历史回合摘要；完整历史只作为按需证据来源
6. 当前User Message原文与用户明确锁定内容
7. 当前Workflow节点输入、上游公开结果和已授权Tool Result
8. 本步骤输出格式、完成标准、禁止事项和需要回报的Evidence
```

每个逻辑块必须记录来源、revision/hash、采用原因、预计Token、裁剪/摘要方式和接收它的Agent/步骤。某块不适用时显式标记，不用空文本或隐式省略冒充“没有历史”。最终ModelCallDraft必须能反查各Provider字段来自哪些逻辑块；用户在ModelCallDraft审核中直接改写内容后，以新Draft/hash为准，但不会自动反写Project、Work或Memory。

### 3.3 ExecutionDraft 状态

```text
building
-> reviewable
-> awaiting_decision
-> accepted | rejected | expired | superseded
```

`accepted`只表示该版本允许编译 RunSpec，不表示已经执行、成功或完成。

## 4. RunSpec 固定内容

RunSpec 是已解析、已授权、不可变的执行合同。它不保存运行中的可变进度；进度属于 Product Run、Run Attempt、Runtime Event、Tool Execution 和 Evidence。

| # | 部分 | 固定要求 |
|---:|---|---|
| 1 | Identity | `run_spec_id`、schema/version、compiled_at、compiler_version、规范 hash。 |
| 2 | Source Binding | ExecutionDraft ID/revision/hash、Context/Intent/Project/Work/Plan revision 与接受它们的 Decision/Approval 引用。 |
| 3 | Principal 与 Scope | 执行主体、授权 Scope、Channel/Binding上下文；ID本身不构成授权。 |
| 4 | Workflow Binding | Workflow Definition ID/version、入口节点、场景范式版本；运行中不得静默升级图。 |
| 5 | Execution Brief | 由已接受 Draft 规范化产生的最终语义工作包。 |
| 6 | Context Manifest | 实际物化的上下文项、来源版本、内联内容hash、按需读取边界、排除项和Token预算。 |
| 7 | Plan Contract | 固定步骤、依赖、检查点、责任方和允许的分支；运行时可以记录进度，不能修改合同。 |
| 8 | Prompt Assembly Contract | 固定逻辑块、顺序、来源revision/hash、采用原因、每块Token预算、裁剪/摘要规则、按需读取边界，以及每个Agent/步骤可接收哪些块；不保存尚未产生的具体Provider Body。 |
| 9 | Runtime / Agent Binding | Runtime、Agent Profile revision、工作目录、仓库/分支、环境引用和隔离边界。 |
| 10 | Capability Envelope | Tool allowlist、参数/路径/网络/副作用限制、动态扩权回到HITL的规则。 |
| 11 | Model Envelope | Provider/模型allowlist、调用次数、Token/费用/时间上限和输出约束。 |
| 12 | HITL Policy Snapshot | 解析时使用的全部规则revision、各决策点最终动作、强制底线和重新暂停触发器。 |
| 13 | Validation / Evidence | 完成标准、验证步骤、所需Evidence类型、可接受失败和不得自动重试的情况。 |
| 14 | Output / Commit Envelope | 允许生成的回复、Artifact和Patch类型；允许修改的Product聚合与revision前置条件。 |
| 15 | Control Contract | Cancel、Steer、Retry、Restart、Resume的适用边界、截止时间和安全点要求。 |
| 16 | Correlation / Idempotency | Product Run关联、幂等命名空间、Attempt/ModelCall/Tool/Delivery关联规则。 |

### 4.1 RunSpec 不可变规则

以下任一变化都不能原地修改 RunSpec：

1. 用户目标、范围、计划或验证标准变化。
2. ContextPackage内容、来源revision或锁定项变化。
3. Workflow、Agent Profile、Runtime、工作目录或目标仓库变化。
4. Tool、权限、路径、网络、模型、调用次数或预算扩大。
5. Project/Work/Plan revision 已过期。
6. HITL策略变化会放宽原授权。

变化后的处理只有两类：

1. 运行前：生成新 ExecutionDraft revision，旧Draft/Approval/RunSpec失效。
2. 运行中：Steer到安全点，形成版本化 RunSpec Amendment 或新Run；不能让Worker私自改合同。Amendment的具体存储模型留给Run控制详细设计，但语义必须可追溯且不可原地覆盖。

## 5. Hash 与授权绑定

固定使用4级绑定，不能用一个模糊hash代替：

1. `context_hash`：ContextPackage规范内容、来源revision、选择/排除和Token策略。
2. `draft_hash`：ExecutionDraft全部会影响执行的语义内容。
3. `run_spec_hash`：全部固定绑定、能力、预算、HITL快照、验证和控制合同。
4. `model_call_hash` / `tool_call_hash`：某次实际Provider canonical body或Tool规范请求。

任一绑定内容变化，对应Approval或自动决定立即失效。时间戳、显示排序和纯UI折叠状态不进入语义hash。

## 6. HITL 固定对象

HITL不是弹窗组件，而是5个对象的协作：

| 对象 | 责任 |
|---|---|
| DecisionPointDefinition | 定义可能需要人判断的位置、主体、风险、动作和默认规则。 |
| HITLPolicyRule | 在某个作用域内决定暂停、条件暂停、自动推进或禁止。 |
| PolicyEvaluation | 保存命中的规则、输入revision、风险/不确定性、最终模式和原因。 |
| HumanDecisionRequest | 最终要求人处理时，保存问题、可见依据、允许动作和后果。 |
| DecisionRecord | 保存人的回答或策略自动决定；Approval是其中授权特定版本执行的子类型。 |

MAF `request_info`、Workflow pending request、AG-UI Interrupt/Resume只是运行时和协议投影；Product Store中的HumanDecisionRequest、DecisionRecord和Approval才是长期事实与授权依据。

## 7. 决策点类型

固定支持12类，可由不同场景选择是否适用：

1. `intent_review`：意图是否正确。
2. `project_association`：关联或切换哪个Project/Work。
3. `context_review`：采用、排除或锁定哪些上下文。
4. `plan_review`：任务拆分、顺序、责任和检查点。
5. `execution_authorization`：是否接受整个ExecutionDraft并编译RunSpec。
6. `model_call_authorization`：是否发送某一份具体ModelCallDraft。
7. `tool_authorization`：是否执行某一份具体Tool请求。
8. `work_state_commit`：是否接受Project/Work/Plan状态变化。
9. `memory_acceptance`：是否让Memory Candidate跨会话生效。
10. `result_acceptance`：是否接受结果、Artifact或完成判断。
11. `runtime_intervention`：暂停、取消、Steer或扩大范围。
12. `unknown_outcome_resolution`：Provider/Tool/Delivery结果未知时如何处置。

## 8. HITL 策略模式

| 模式 | 语义 |
|---|---|
| `deny` | 当前动作不允许发生，不提供普通自动绕过。 |
| `require_human` | 必须建立HumanDecisionRequest并暂停。 |
| `conditional` | 风险、不确定性、成本、变化或规则条件命中时暂停，否则记录自动决定并继续。 |
| `auto_continue` | 在已声明范围内不暂停，但必须生成PolicyEvaluation和DecisionRecord并在Trace可见。 |
| `inherit` | 本层不作决定，继续解析较低优先级偏好。 |

不存在“删除HITL点”模式。决策点不适用时记录`not_applicable`；适用但跳过人工时记录`auto_continue`，二者不能混用。

`conditional`是配置模式，不是最终执行动作。Policy Evaluation必须先用当前风险与事实求值：命中条件后得到`require_human`或`deny`，未命中得到`auto_continue`；求值所需事实缺失、过期或解析失败时按`require_human`关闭失败。`inherit`同样不能成为最终动作。因此一次适用决策点的最终动作只能是`deny`、`require_human`或`auto_continue`。

## 9. 作用域与优先级

HITL解析分成两段，不能采用简单的最后写入覆盖。

### 9.1 强制约束下限

依次计算并合并：

1. System Safety Floor：不可跳过的产品安全和恢复规则。
2. Identity / Scope Policy：Principal权限、Channel Binding和资源授权。
3. Capability Policy：Tool、Provider、模型、外部系统、路径和网络自身限制。
4. Runtime Facts：当前风险、结果未知、revision冲突、预算和实际请求变化。

合并规则：

```text
deny > require_human > conditional > auto_continue
```

allowlist取交集，数值预算取更小值，风险条件取并集。下层配置只能更严格，不能放宽强制下限。

### 9.2 用户可配置偏好

在不突破强制下限的前提下，按最具体优先：

1. Decision Instance：只对当前待决对象版本和hash。
2. Product Run：仅当前Run；Run结束即过期。
3. Interaction：仅当前一轮用户交互及其可能产生的多个Run。
4. Product Session：仅当前协作会话，跨Interaction但不扩散到其他会话。
5. Project / Work / TaskPlan：当前项目、工作项或计划；对象越具体越优先。
6. Workflow Definition + version：当前Workflow版本；同一版本内指定Node/Decision Point的规则优先于整图规则。
7. Scenario / Execution Pattern：问答、研究、学习、开发、Debug等范式。
8. Agent / Tool / Model Profile：对特定运行资源及其revision的偏好。
9. Channel / Surface：Web、外部Channel或特定交互表面的偏好；Channel实际能力仍属于强制下限。
10. Principal Default：用户跨会话默认值。
11. Product Default：系统产品默认。

先选择当前对象最具体、且确实命中的作用域；更具体的用户偏好可以放宽或收紧更广作用域的用户偏好，但不能突破强制下限。同一作用域多条规则同时命中时，先分别求值，再由更严格最终动作优先；严格度相同则条件更具体者优先；仍相同才使用最新有效revision。最终动作取“强制下限结果”和“用户偏好结果”中更严格者。

## 10. 默认策略

| 决策点 | 产品默认 | 典型强制暂停条件 |
|---|---|---|
| Intent | `conditional` | 低置信、多Intent冲突、用户纠正。 |
| Project关联 | `conditional` | 多候选接近、跨Project敏感数据、会改变活动工作焦点。 |
| Context | `conditional` | 纳入敏感/跨项目来源、关键来源失效、用户锁定项被排除。 |
| Plan | `conditional` | 多步高影响执行、责任或范围不清、依赖冲突。 |
| ExecutionDraft | `conditional` | 有写操作、外部副作用、长期状态变化或权限扩展。 |
| ModelCallDraft | `require_human` | 当前产品默认保留逐次可编辑审批；用户可在Run/Interaction/Session/Project/Workflow等范围配置有界自动通过。 |
| Tool | `conditional` | 写/删、外部发送、付费、凭据、权限变化或不可逆副作用。 |
| Work状态 | `conditional` | 创建/删除Project、改变目标/范围、完成/取消且Evidence不足。 |
| Memory | `require_human` | 推断出的跨会话信息；用户明确“记住”可构成当前候选的人工决定。 |
| Result | `conditional` | 完成判断影响后续计划、交付或长期状态。 |
| Runtime干预 | `require_human` | 扩大范围、扩权、改变副作用路径。 |
| 结果未知 | `require_human` | 始终属于System Safety Floor，不盲目重试。 |

## 11. 自动通过必须重新暂停的触发器

任一项发生时，已有自动决定不得继续覆盖新状态：

1. 被决定对象的revision或hash变化。
2. Intent、Project、Work或Context切换。
3. Workflow/Agent/Runtime版本变化。
4. 能力、Tool参数范围、目标路径、网络目标或副作用扩大。
5. Provider/模型、调用次数、Token、费用或耗时越界。
6. 风险或不确定性上升到策略阈值。
7. Approval/Policy过期、撤销或Principal权限变化。
8. CAS冲突、来源失效或验证证据矛盾。
9. Provider、Tool或Delivery进入outcome_unknown。
10. 用户Steer、纠正或明确要求暂停。

## 12. 前端固定行为

1. 配置中心提供“全局默认、Channel、Project/Work、Workflow/场景、Agent/Tool/模型”策略矩阵；Session和当前Interaction/Run提供就地临时设置，不直接编辑内部JSON。
2. 当前Run可以临时覆盖偏好，但界面必须显示作用域和过期条件。
3. 每个Decision Point显示最终模式、命中规则和会重新暂停的条件。
4. `auto_continue`节点在Workflow Run View中显示“按策略自动通过”，不能伪装成不存在。
5. 人工卡片必须显示：为什么暂停、审核对象、证据、允许动作、每个动作后果和影响范围。
6. 用户选择“以后跳过”时必须选择作用域，例如“仅本次Run”“当前Project”“当前Workflow版本”，不能生成无边界永久授权。
7. ExecutionDraft提供语义编辑与最终Execution Brief编辑；ModelCallDraft继续提供同源可读视图与Provider JSON。

## 13. 验收不变量

1. 删除完整Session History后，系统仍可从Project/Work/Memory/Evidence和引用重建当前Run的最小充分ContextPackage；原始历史仍作为证据保留。
2. Worker只能执行RunSpec允许的目标、能力、预算和提交范围。
3. 任一会影响执行的Draft/Context/Plan/Policy/Capability变化使旧授权失效。
4. 自动通过与人工批准具有同等可追溯性，但不能突破System Safety Floor。
5. 未暂停不等于未经过决策；每个适用HITL点都有PolicyEvaluation与DecisionRecord。
6. 一个RunSpec可产生多份ModelCallDraft和Tool请求；每份具体请求都有独立hash与授权判断。
7. Provider、Tool和Delivery结果未知时不自动重放。
8. Assistant宣称完成不能替代Validation Contract和Evidence。
