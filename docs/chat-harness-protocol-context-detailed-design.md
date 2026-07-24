# Chat Harness协议、Context与步骤输入详细设计

> 状态：已批准并实施中。
> 更新日期：2026-07-24。
> 上位决策：[Chat持续协作系统研究](./chat-collaboration-system-research.md)与
> [Chat愿景场景验证](./chat-vision-scenario-validation.md)已获用户批准。

## 1. 目标与非目标

本设计补齐3个直接影响长期协作的合同：

1. `CollaborationProtocolDefinition`与`ProtocolBinding`：让项目、学习、研究和周期工作的方法有
   可查看、可绑定、可追溯的revision。
2. `TurnDigest`：固定每轮重点、来源、候选和已提交事实之间的边界。
3. `StepInputProjection`：为每个MAF Agent/Executor/外部Runtime编译当前职责的最小输入。

不建立第二套Project、Task、Learning或Memory模型；不把协议正文全部注入每次Prompt；不把前端
选择状态当事实；不允许执行层直接提交Product状态。

## 2. Protocol Definition Schema

`collaboration_protocol_definitions`保存不可变revision：

| 字段 | 约束 |
|---|---|
| `id` | UUID主键 |
| `protocol_key` | 稳定机器名，例如`software-delivery` |
| `revision` | 同一key单调递增，和key组成唯一键 |
| `name`、`description` | 用户可见名称与作用 |
| `status` | `active/deprecated/blocked` |
| `scenario_kinds_json` | 适用Intent/场景枚举 |
| `phases_json` | 推荐阶段、进入/退出条件及公开说明 |
| `context_policy_json` | 必需/可选来源族、预算与渐进读取规则 |
| `hitl_policy_json` | 方法级建议暂停点，不得放宽系统下限 |
| `execution_policy_json` | Agent角色、Tool/Skill建议与步骤模板 |
| `validation_policy_json` | 确定性检查、Reviewer条件、修复上限 |
| `writeback_policy_json` | 允许提出的Project/Work/Note/Memory/Evidence Patch |
| `ui_schema_json` | 前端摘要、分组和帮助文案，不拥有业务规则 |
| `definition_hash` | 上述语义字段的canonical SHA-256 |
| `created_by/created_at` | 来源和时间 |

`collaboration_protocol_rules`保存需要单独呈现和执行的规则：

| 字段 | 约束 |
|---|---|
| `definition_id/rule_key` | 协议revision内唯一 |
| `name/description/category` | 用户可理解的规则身份 |
| `enforcement` | `deterministic/reviewer/human` |
| `severity` | `advisory/required/prohibited` |
| `overridable` | 用户能否在非安全下限内覆盖 |
| `condition_json` | 何时适用 |
| `validator_json` | 脚本、Schema、Agent Reviewer或人工验证合同 |
| `failure_action` | `warn/repair/rehitl/block` |
| `ordinal` | 稳定展示顺序 |

定义发布后不可原地修改；修改产生新revision。`blocked`可以阻止新Run使用有安全缺陷的旧revision，
历史Run仍保留原引用。

## 3. Protocol Binding Schema

`collaboration_protocol_bindings`把一个Scope与场景绑定到某个定义revision：

| 字段 | 约束 |
|---|---|
| `id` | UUID |
| `scope_id` | 租户/权限Scope |
| `scope_kind` | `system/user/project/work_item` |
| `scope_ref_id` | system使用`*`，user使用Principal ID，其他使用资源ID |
| `scenario_kind` | `simple_question/software_delivery/project/task/learning/research/recurring` |
| `protocol_definition_id` | 精确definition revision |
| `parameter_overrides_json` | 仅覆盖Schema允许的参数 |
| `disabled_rule_keys_json` | 只能关闭`overridable=true`规则 |
| `status` | `active/disabled` |
| `row_version` | CAS |
| `created_by/created_at/updated_at` | 来源与时间 |

唯一键为`scope_id + scope_kind + scope_ref_id + scenario_kind`。解析优先级固定：

```text
WorkItem exact
-> Project exact
-> User scenario
-> System scenario
```

相同优先级多条有效Binding是数据冲突，必须停止并修复，不能让模型选择。用户跳过协议方法时只对
当前Run形成显式`no_method_defaults`选择，不删除长期Binding，也不能跳过安全、权限、来源或高影响
动作下限。

## 4. 首批内置协议

| key | 场景 | 目的 |
|---|---|---|
| `simple-answer` | 简单问答、产品目录查询 | 最少上下文和零副作用；权威查询优先0模型 |
| `software-delivery` | 软件项目与功能开发 | 现状→方案→实现→验证→交付→回写 |
| `general-project` | 通用项目 | 目标→里程碑→工作→复盘 |
| `standalone-task` | 独立任务 | 明确结果、步骤、验证和停止条件 |
| `learning-loop` | 学习 | 诊断→学习→练习→验证→复习 |
| `research-with-sources` | 研究 | 问题→来源→提取→交叉验证→结论 |
| `recurring-brief` | 周期资讯/日常工作 | Schedule→检索→去重→证据→Delivery |

内置定义通过应用初始化幂等同步；它们是可查询的Product配置，不从Prompt字符串临时构造。用户
自定义协议和可视化编辑在同一Schema上演进。

## 5. Protocol Selection

输入：

1. 已接受Intent/scenario。
2. 已绑定Project/Work。
3. 可信Principal与Scope。
4. 系统禁止项和当前HITL策略。

输出：

```json
{
  "protocol_key": "software-delivery",
  "revision": 1,
  "definition_id": "...",
  "binding_id": "...",
  "selection_source": "project|work_item|user|system",
  "applicable_rule_keys": ["..."],
  "disabled_rule_keys": [],
  "selection_reason": "...",
  "selection_hash": "..."
}
```

它由确定性Executor解析并作为真实MAF节点公开到Trace。语义Agent可建议scenario，但不能自行选择
任意协议revision。简单Project目录查询固定为`simple-answer`，协议选择不得引入额外模型调用。

## 6. TurnDigest合同

现有`TurnSummaryRecord.summary_json`演进为`TurnDigest v1`，不新建重复表：

```text
digest_version
topic
confirmed_facts[]          仅用户确认或Product查询确认的内容
decisions[]                带Decision/Product引用
open_questions[]
product_fact_refs[]        已提交Project/Work/Note/Memory/Evidence引用
work_state_candidates[]    未提交候选
memory_candidates[]        未提交候选
source_refs[]              Message/Run/ModelCall/Tool/Evidence
discarded[]                丢弃类别与原因，不保存隐藏推理
extraction_warning?
```

持久化前由确定性Normalizer补齐版本、来源和空数组，并验证：

1. `confirmed_facts`不能包含无来源的模型推测。
2. `product_fact_refs`只能引用已经提交的资源。
3. Work/Memory候选保持候选状态。
4. 摘要失败时保存最小主题与来源，不修改原始Message。

## 7. Context修订与用户选择

`ContextPackage`保持不可变revision。用户采用、排除、锁定或新增来源时，不原地修改
`ContextAdoptionRecord`，而是用CAS创建同一Run/stage的新revision：

```text
ReviseContextPackage(
  package_id,
  expected_package_hash,
  item_changes[],
  added_source_refs[],
  reason,
  command_id
)
```

结果原子写新ContextPackage、Adoption、Trace和Outbox。旧ExecutionDraft/Approval如果绑定旧
Context hash，必须失效或重新编译。

Context前端分3层：

1. 本轮概览：目标、协议、采用/排除数量、预算和风险。
2. 来源分组：项目与工作、规则与经验、历史重点、文件与证据；显示原因和主动作。
3. 审计详情：source/id/revision/hash、公开内容和Trace。

## 8. StepInputProjection Schema

`step_input_projections`保存运行时实际使用的公开最小工作包：

| 字段 | 约束 |
|---|---|
| `id` | UUID |
| `run_id/workflow_definition_id/workflow_version/node_id` | 运行和真实节点定位 |
| `projection_revision` | 同一Run/node单调递增 |
| `agent_profile_key` | 可空，确定性Executor也可有投影 |
| `context_package_id` | 实际采用的Context revision |
| `protocol_definition_id/binding_id` | 实际协议revision与来源 |
| `run_spec_id` | RunSpec生成前的理解/计划节点可空 |
| `input_json` | 当前目标、背景、约束、上游公开结果和资源入口 |
| `capability_allowlist_json` | 当前节点可见Tool/Skill/文件/网络能力 |
| `budget_json` | Token、费用、时间和调用次数 |
| `output_contract_json` | 结构Schema、Evidence/Product Patch类型 |
| `stop_conditions_json` | 询问、越界、失败和停止条件 |
| `projection_hash` | canonical SHA-256 |
| `created_at` | 创建时间 |

Intent Agent只看当前输入、轻量目录、开放澄清和协议适用条件；Planner增加已绑定目标、规则和验证；
Executor只看当前Plan节点、资源入口、Allowlist和完成门；Reviewer只看候选结果、标准、Diff和Evidence；
TurnDigest节点只看本轮公开结果和已提交引用。

## 9. 日志与Trace

结构化日志记录：

1. 协议目录同步结果与耗时，不记录完整规则正文。
2. Binding创建/更新的Scope、scenario、revision和结果。
3. Protocol Selection的Run/node/definition/binding/selection source。
4. Context revision的旧/新hash、采用/排除数量和Token。
5. StepInputProjection的node、hash、能力数量和预算。

Product Trace保存可审核选择原因和公开投影；普通日志不保存完整Prompt、Context正文、Provider Body
或隐藏推理。

## 10. 异常与恢复

| 异常 | 行为 |
|---|---|
| Binding引用blocked定义 | 停止新Run，要求选择可用revision |
| 多个同优先级Binding | `PROTOCOL_BINDING_CONFLICT`，不让模型猜 |
| 覆盖required且不可覆盖规则 | 422，Binding不提交 |
| Context CAS冲突 | 409并返回当前revision入口 |
| Context来源失效 | 新revision排除；相关Draft/Approval失效 |
| Step投影超预算 | 保留目标、约束、已接受决定、验证和停止条件；低优先来源改为Tool引用 |
| 模型摘要Schema错误 | 保存最小确定性TurnDigest并记录warning |
| 进程在协议选择后退出 | Checkpoint恢复时重读持久selection/projection并核对hash |

## 11. 测试

1. 7个内置定义Hash稳定、初始化幂等、revision不可原地修改。
2. 4级Binding优先级、CAS、冲突、禁用规则和blocked定义。
3. 简单查询选择`simple-answer`且模型调用为0。
4. 项目和学习场景选择不同协议并加载不同规则。
5. TurnDigest来源、候选、最小降级与重放一致。
6. Context采用/排除产生新revision，旧hash不被覆盖。
7. Intent/Planner/Executor/Reviewer/TurnDigest五类StepInput最小权限和预算。
8. Worker退出、Checkpoint恢复、旧协议blocked、Context来源撤销和Approval失效。
9. 前端渐进展开、键盘、窄屏、加载失败Error Boundary和生产构建。
10. 真实模型抽样验证协议选择、Context来源和结构合同，不按回答措辞逐字断言。

## 12. 已批准决定

1. `PC1`：协议使用不可变Definition revision与有CAS的Binding。
2. `PC2`：协议规则单独建模，核心规则不藏在Prompt或UI JSON。
3. `PC3`：Binding按Work→Project→User→System确定性解析。
4. `PC4`：首批7类协议复用现有核心对象，不复制生命周期。
5. `PC5`：TurnDigest演进现有TurnSummary存储，不建第二表。
6. `PC6`：Context用户修改产生新revision，旧Draft/Approval按hash失效。
7. `PC7`：每个真实运行节点拥有可审计StepInputProjection。
8. `PC8`：简单权威查询优先0模型，协议选择不额外调用模型。
9. `PC9`：前端使用三层渐进披露和加载失败隔离。
10. `PC10`：模型、Agent和执行Runtime都不能直接提交Product事实。
