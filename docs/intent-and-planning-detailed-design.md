# Intent、多事项、澄清与计划详细设计

> 状态：阶段B实施中；Intent Set、跨Run澄清和复合Plan链已实现，独立分支Execution/Evidence仍属阶段C。
> 更新日期：2026-07-24。
> 上位架构：[Chat系统分阶段实现基线](./chat-system-implementation-roadmap.md)。

## 1. 用户问题

一句用户输入可能属于4种不同情况：

1. 一个明确目标，例如“解释幂等”。
2. 多个有顺序的目标，例如“先学Outbox，再把它用于Chat”。
3. 一个无法可靠绑定的目标，例如“继续昨天那个”。
4. 对上一轮澄清的回答，例如“第一个”。

这些情况不能只保存在MAF Executor内存或一段Prompt里。否则刷新、Worker退出、用户修改和第二天继续时，
系统无法证明“理解了什么、采用了哪个版本、为什么这样走、上一问是否已回答”。

## 2. MAF事实与项目取舍

当前安装版为`agent-framework-core 1.11.0`。本地参考源码显示：

1. `WorkflowBuilder`支持静态fan-out/fan-in、多选边和switch-case。
2. `python/samples/03-workflows/parallelism/aggregate_results_of_different_types.py`
   展示静态并行和fan-in列表聚合。
3. `concurrent_request_info.py`展示并发分支可以同时产生多个`request_info`。
4. Checkpoint可以保存多个pending request；但这不等于当前产品审批界面已经能安全处理多个同时到达的
   ModelCall approval。

因此本项目不直接把动态多Intent映射成并发模型分支。当前采用：

```text
Intent Agent
-> 持久Intent Set candidate
-> 用户审核完整Intent Set
-> 接受精确revision hash
-> 按依赖形成一个复合Plan
-> 编译一个包含全部Intent的ExecutionDraft / RunSpec
-> Response Agent逐项覆盖目标
```

阶段C再把需要真实外部执行的Intent拆成独立Branch Execution；只有Tool/Evidence/部分成功状态和多个
同时审批的前端合同准备好后，才启用安全并发。

## 3. 权威对象

### 3.1 Intent Set

`collaboration_intent_sets`是一轮Product Run的聚合根：

| 字段 | 语义 |
|---|---|
| `session_id/interaction_id/run_id` | Product对象链，不冒充MAF或AG-UI ID |
| `current_revision_id` | 当前候选快照 |
| `accepted_revision_id` | 用户或有效策略接受的精确快照 |
| `status` | `candidate/accepted/superseded` |
| `row_version` | CAS |

`collaboration_intent_set_revisions`不可变保存：

1. 有序`intent_revision_ids`。
2. `execution_order`。
3. `combination_policy=single/sequential/parallel_safe`。
4. 原始用户输入Hash和完整revision Hash。

### 3.2 Intent与revision

`collaboration_intents`保存稳定`branch_key`和顺序；`collaboration_intent_revisions`不可变保存：

```text
scenario / query_kind
goal / expected_outcome / confidence
project_hint / selected_project_id
needs_plan / needs_clarification / clarification_question
context_keywords / dependency_branch_keys / constraints
reason_summary
source_model_call_revision_id / author_kind / revision_hash
```

最多4个Intent。依赖只能指向执行顺序中更早的分支；目标、置信度、场景或依赖无效时关闭失败到澄清，
不静默丢弃某个分支。

### 3.3 Clarification

`clarification_requests`保存问题、回答Schema、状态和来源Intent revision；
`clarification_answers`保存后续User Message文本Hash与回答它的Product Run。

澄清不是“批准/拒绝”按钮。用户直接在聊天输入框回答；Intent Agent必须明确返回
`answers_clarification_id`，系统才把本轮输入绑定为答案。用户开始一个无关新目标时，不会假装回答了
旧问题。

## 4. Workflow v1.4.0

主Workflow现有28个真实MAF节点，新增：

1. `intent_set_projection`：在产品决策前保存模型候选和开放澄清。
2. `intent_set_acceptance`：同步用户修改，接受精确Intent Set revision Hash；澄清场景保持candidate。

关键链：

```text
input_acceptance
-> context candidates / Harness directory / Context decision
-> intent_agent
-> intent_set_projection
-> intent_binding
-> intent_set_acceptance
-> Project / detail Context / Protocol
-> scenario_router
-> deterministic query | clarification | composite planning | direct
-> ExecutionDraft / RunSpec / response / summary / Product commit
```

多Intent强制进入规划分支，即使第一个Intent本身不需要Plan。Planner和Response收到完整Intent Set、
revision ID、依赖、约束和采用Context；ExecutionDraft的`intent_goal`保存同一快照。

基础协作协议不因多Intent被复制或改写。Resolver保留基础`definition_hash/selection_hash`，并生成
带`effective_selection_hash`的`composition_overlay`：基础策略仍可表达“简单询问不需要Planner”，
而本轮有效策略明确表达“Intent Set含多个目标，必须先形成组合Plan”。二者由同一
StepInputProjection公开给前端和设计者审计。

若Intent Set中包含`query_kind=project_catalog`，Project Resolver会先查询Product Store并保存
`authoritative_product_facts.project_catalog`。单Intent可以直接终结为确定性回复；多Intent则把这份
已经完成的事实交给Planner和Response，不再次规划不存在的Project Tool。

## 5. 用户修改

发送前的Intent审批使用专用Intent Set编辑器：

1. 逐项目标、预期结果、场景、Project提示、边界和是否需要Plan。
2. 可新增或删除目标，最多4个。
3. 只能选择前序目标作为依赖，界面不能构造环。
4. 保存修改后MAF状态和Product Intent revision一起更新，再重新评估策略。

REST的Intent revision接口使用Set Hash CAS；RunSpec已经绑定后拒绝追溯修改，要求创建新Run。
这避免已发送的Provider请求被界面“改写历史”。

## 6. 前端渐进披露

“本轮”工作台按3层展示：

1. **结论**：系统认为本轮有几件事、各自目标、预期结果和推进方式。
2. **操作信息**：Project提示、Plan需要、前置依赖、边界和开放澄清。
3. **审计**：Intent Set ID、revision/hash、公开判断摘要和来源ModelCall revision。

用户不需要从Workflow Trace里反推意图；设计者仍可在Workflow节点详情查看真实代码路径和
StepInputProjection。

## 7. 错误与恢复

| 情况 | 行为 |
|---|---|
| 模型不是合法JSON或Intent超过4个 | 生成一个低置信澄清candidate |
| 依赖不存在、重复或指向后续分支 | 422/关闭失败，不执行 |
| 用户提交过期Set Hash | 409，重新加载 |
| RunSpec已经绑定后修改Intent | 409，基于新Intent重新运行 |
| Worker在Intent模型后退出 | MAF Checkpoint恢复；`record_candidate`按Hash幂等 |
| 用户回答开放澄清 | Answer绑定新Product Run；原Request变为`answered` |
| 用户开始无关新目标 | 不生成Answer；旧开放问题由新语义决定是否supersede |
| 多Intent中某个真实执行失败 | 阶段C由Branch Execution/Evidence记录局部失败；当前复合响应不得伪称完成 |

## 8. 验证

当前自动验证覆盖：

1. 多Intent顺序、依赖、4项上限和无效结构关闭失败。
2. candidate幂等、不可变revision、CAS冲突和精确Hash接受。
3. 澄清跨两个Product Run回答，不依赖完整历史Blob。
4. 主Workflow真实走4次受治理模型调用：Intent、Plan、Response、TurnDigest。
5. ExecutionDraft保留全部Intent和已接受Plan，不只保存第一个目标。
6. REST查询、本轮前端投影、TypeScript、生产构建和数据库完整升降级。
7. 新Product Run清除线程级MAF Workflow缓存，避免复用旧Run的Checkpoint；Profile旧内置revision
   只做精确迁移，不覆盖用户编辑。
8. 多Intent中的Project目录分支不会提前终结整轮；Planner和Response收到已完成的权威Product事实。
9. 前端同时展示基础方法与本轮有效组合策略，并以纯投影测试保证不从卡片数量猜测运行策略。

真实模型与浏览器证据（2026-07-24）：

1. Product Session `PS-78979C26`，Product Run
   `87e4ec66-56ab-47b2-ae2b-184766719112`。
2. 输入包含2个相互独立目标：只读查看正式Project目录，以及一句话解释斐波那契数列。
3. Intent、Planner、Response、TurnDigest共4次火山方舟`glm-5.2`调用逐次审批；28节点Run完成。
4. 正式Project数为0，未创建Project、Work、Task或长期Memory；最终回答逐项覆盖两个目标。
5. “本轮”工作台显示基础`直接回答@r1`与本轮`必须形成组合计划`，展开后显示策略差异、阶段和规则。

阶段B剩余完成门：

1. 把长期Plan接受到已有WorkItem的`TaskPlanRevision`，无Work场景保持Run内Plan。
2. 为真正独立外部执行建立Branch Execution、局部成功和聚合结果。
3. 浏览器验证Intent Set修改、澄清回答、窄屏和键盘操作。
4. 扩展真实模型抽样，覆盖3-4个Intent、依赖链和一个目标失败，仍不按具体措辞断言。
