# SC01：确定性查询正式Project目录

<!-- debug-scenario: id=SC01; status=current; oracle=exact -->

**归档日期**：2026-07-30  
**输入族**：只查看正式Project目录，不创建、不修改、不执行  
**自动证据**：`backend/tests/test_continuous_chat.py::test_explicit_project_catalog_query_cannot_be_rewritten_as_create_or_clarify`

## 1. 你可以怎样输入

下面3种只是同一输入族的例子，不是必须照抄的脚本：

- `我有哪些项目？`
- `列出我现有的正式Project。`
- `只查看项目列表，不要新建或修改任何事项。`

不属于本场景：`新建一个项目`、`列出项目并修改Chat代码`、`继续那个项目`。它们分别涉及创建、
多Intent执行或澄清，不能继续套用0模型预期。

## 2. 运行前预言机

| 观察项 | 必须满足的预期 | 强度 |
|---|---|---|
| 意图 | `query_kind=project_catalog`、`execution_mode=deterministic_guard` | 精确 |
| 模型调用 | ModelCallDraft=0，Provider Attempt=0 | 精确 |
| 路由 | `scenario_router`选`project_catalog -> project_catalog_query` | 精确 |
| 数据来源 | 正式Project来自Product Harness查询；不从摘要或模型猜 | 精确 |
| 长期写入 | 不创建Project、Work、Plan、Action、Accepted Memory | 精确 |
| 用户答复 | 有项目就列权威目录；空目录就明确说没有正式Project | 语义 |
| 终态 | Product Run=`succeeded`，Assistant Message与双Trace存在 | 精确 |

2026-07-29真实Run `c8f26dd0-4a6d-4d97-957f-30b419fa7541`的human Trace记录了23个实际节点、
16个未访问节点。正式Project数量取决于运行时Product Store，不能把历史的2个项目写成永久预期。

## 3. 39节点逐项预期

| # | 节点 | 本场景状态 | 关键输入/输出或未走原因 |
|---:|---|---|---|
| 1 | `input_acceptance` | 经过 | 原Prompt；读取最多8条已持久TurnSummary候选 |
| 2 | `context_candidates` | 经过 | 关键词选择最多4条摘要；不会改旧摘要 |
| 3 | `harness_directory_context` | 经过 | 创建directory ContextPackage；读取正式Project轻目录 |
| 4 | `context_adoption` | 经过 | 按Policy自动/人工决定采用来源 |
| 5 | `directory_context_revision` | 经过 | 投影当前Context revision与adopted/excluded来源 |
| 6 | `intent_agent` | 经过但0模型 | 确定性护栏直接产生Project目录Intent |
| 7 | `intent_set_projection` | 经过 | 保存Intent Set候选revision |
| 8 | `intent_binding` | 经过 | 明确只读查询通常自动通过 |
| 9 | `intent_set_acceptance` | 经过 | 接受当前Hash绑定的Intent revision |
| 10 | `harness_project_resolver` | 经过 | 不把“查询目录”绑定成某一个Project |
| 11 | `project_work_binding` | 经过 | 本场景通常`not_applicable` |
| 12 | `harness_detail_context` | 经过 | 无单一绑定目标时详情集为空或有界 |
| 13 | `detail_context_adoption` | 经过 | 对空/有界详情作确定性决定 |
| 14 | `detail_context_revision` | 经过 | 投影最新detail revision；没有详情也要留下原因 |
| 15 | `collaboration_protocol_resolver` | 经过 | 选择直接查询/回答类协议 |
| 16 | `scenario_router` | 经过 | 第1条Case命中；其余Case记录未选原因 |
| 17 | `project_catalog_query` | 经过 | 查询Harness权威Project目录并形成答复/摘要事实 |
| 18 | `clarification` | 未走 | 第1条Case已经命中 |
| 19 | `planning_agent` | 未走 | 目录查询不需要Plan |
| 20 | `plan_acceptance` | 未走 | 没有Plan候选 |
| 21 | `execution_draft_compiler` | 未走 | 产品查询不编译ExecutionDraft |
| 22 | `execution_authorization` | 未走 | 没有执行草稿需要授权 |
| 23 | `run_spec_compiler` | 未走 | 没有执行合同 |
| 24 | `execution_route` | 未走 | 不进入回答/pi执行Switch |
| 25 | `execution_workspace_prepare` | 未走 | 没有写执行 |
| 26 | `pi_workspace_dispatch` | 未走 | 没有写执行 |
| 27 | `pi_workspace_result_assembly` | 未走 | 没有Workspace结果 |
| 28 | `result_claim_prepare` | 未走 | 没有执行产物Claim |
| 29 | `result_claim_decision` | 未走 | 没有Claim |
| 30 | `pi_readonly_dispatch` | 未走 | 权威查询由Harness完成，不启动pi |
| 31 | `pi_readonly_result_assembly` | 未走 | 没有pi结果 |
| 32 | `response_agent` | 未走 | 节点17直接形成权威查询答复 |
| 33 | `turn_summary_agent` | 未走 | 目录分支使用确定性摘要，不再调用模型 |
| 34 | `result_commit` | 经过 | 决定答复候选可提交 |
| 35 | `work_state_commit` | 经过 | `not_applicable`；候选数0 |
| 36 | `memory_commit` | 经过 | `not_applicable`；候选数0 |
| 37 | `harness_candidate_commit` | 经过 | 不写Project/Work/Memory；保留幂等命令事实 |
| 38 | `turn_summary_persist` | 经过 | 保存带`query_kind=project_catalog`的派生摘要 |
| 39 | `result_finalization` | 经过 | 产出候选；图外提交门再写Assistant Message和Run终态 |

这里的“经过”指human Trace的实际路径；`workflow.node.content`事件可能只是一部分公开内容投影，不能用
某个节点没有content事件反推它没有执行。

## 4. 关键数据怎样传

```text
AG-UI User Message
-> Product Message / Interaction / Product Run
-> ContextPackage(directory)
-> Intent Set(query_kind=project_catalog)
-> route_decision(第1条Case)
-> Harness Project查询结果
-> TurnSummary(candidate)
-> Assistant Message + succeeded Product Run + 双Trace
```

在`GovernedSemanticAgentExecutor.prepare`观察的脱敏Intent应包含：

```json
{
  "scenario": "simple_question",
  "query_kind": "project_catalog",
  "needs_plan": false,
  "execution_mode": "deterministic_guard",
  "model_call_count": 0
}
```

在`ScenarioRouterExecutor.route`观察：

```text
selection_mode = first_match
selected_branch = project_catalog
selected_target = project_catalog_query
options.length = 4
```

## 5. 为什么这样设计

看似更简单的方案是“任何输入都先问模型，再用模型说的项目名查询”。它被拒绝，因为：

1. Product Harness已经拥有权威目录，模型调用只增加费用和延迟。
2. 模型可能遗漏、编造或把聊天候选冒充正式Project。
3. 确定性查询可以精确测试0发送、0长期写入和空目录语义。

代价是必须维护只读查询护栏和输入族；护栏不能识别的表达会进入模型意图识别，但后续仍不得凭模型创建
正式Project。

## 6. 亲手验证

断点：`prepare_agui_run`、`GovernedSemanticAgentExecutor.prepare`、
`ScenarioRouterExecutor.route`、`ProjectCatalogExecutor.answer`、`complete_active_run`。

只读SQL：

```sql
SELECT COUNT(*) FROM model_call_attempts WHERE run_id='<Product Run ID>';
SELECT sequence, json_extract(payload,'$.executor_id') AS node
FROM trace_events
WHERE run_id='<Product Run ID>' AND event_type='workflow.node.content'
ORDER BY sequence;
```

第一条必须为0。工作台`scenario_router`必须同时显示4条候选边和第1条被选中。

自动复验：

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_continuous_chat.py::test_explicit_project_catalog_query_cannot_be_rewritten_as_create_or_clarify
```

## 7. 通过/失败判定

- 通过：0模型、权威目录、无长期资源写入、23节点路径/16未访问节点可解释、Run成功。
- 失败：出现Provider Attempt；把空目录改问“是否新建”；创建Work/Memory；路由没有未选原因。

## 掌握验收

1. 为什么节点6经过却可以0次模型调用？
2. 为什么节点17可以跳过节点32和33？
3. Project数量为什么不能成为固定预言机？
4. 如何用3处证据证明没有创建长期事项？
