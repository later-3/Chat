# 第2课：端到端全链调试与Trace使用

**归档日期**：2026-07-29
**分类**：调试实战
**关联源码**：

- [App.submit](../../frontend/src/App.tsx)、[use-chat-agent.ts](../../frontend/src/use-chat-agent.ts)、[use-runtime-reconnect.ts](../../frontend/src/features/chat/use-runtime-reconnect.ts)
- [durable_agent_endpoint](../../backend/app/runtime_execution/endpoint.py)、[prepare_agui_run](../../backend/app/product_sessions/service.py)
- [ExecutionWorker](../../backend/app/runtime_execution/worker.py)、[ProductAwareWorkflow.run](../../backend/app/workflows/runtime.py)
- [continuous_chat.py（39节点）](../../backend/app/workflows/continuous_chat.py)、[continuous_chat_contracts.py（确定性规则）](../../backend/app/workflows/continuous_chat_contracts.py)
- [trace_reports.py（双Trace）](../../backend/app/product_sessions/trace_reports.py)

## 问题

[第1课](./第1课-从点击发送到ContextPackage.md)只追到节点3。本课回答：怎样用两次调试走完
**整条端到端链路**（前端→接纳→Worker→S1-S7→图外提交→SSE回流），每个断点观察什么；
以及调试结束后怎样用Trace（工作台节点详情+双Trace报告）复核你刚才单步看到的一切。

## 回答

不要试图一次调试39个节点。用**两条路径分两次**走，第一次看骨架，第二次看治理：

| 调试轮次 | 输入 | 经过的分支 | 学到什么 |
|---|---|---|---|
| Pass A（骨架） | `我有哪些项目` | 确定性短路 + 目录分支，0次模型调用 | 链路形状、路由、Trace写入、终态提交 |
| Pass B（治理） | `用一句话解释什么是递归` | 3次模型审批（意图/答复/摘要） | Draft/Hash/中断/Resume/Grant消费/采用去向 |

调试前提与第1课相同：`Chat Full Stack`启动、只读SQL、不输出私密正文；
Pass B会产生真实Provider调用，未准备费用时在审批卡上停住即可（放弃零发送）。

## 1. 断点总表（按符号搜索，不按行号）

### 第1段：前端

| # | 符号 | 观察 | 证明 |
|---:|---|---|---|
| 1 | `App.tsx` → `submit` | `prompt`、`selectedWorkflow` | 输入绑定到哪个Workflow ID/版本 |
| 2 | `use-chat-agent.ts` → `send` | `runId`、`agent.url`、`forwardedProps` | AG-UI请求真正发出什么；Workflow选择已固化 |
| 3 | `use-chat-agent.ts` → `subscribe`的`onRunFinishedEvent` | `result.outcome`、interrupts | 终态与中断在前端的分叉点（中断→审批卡） |
| 4 | `use-runtime-reconnect.ts` → `reconnect`循环 | `cursor`、`replay.lastTerminal` | 断线后按游标重放；410回退Product水合（调试恢复时用） |

### 第2段：接纳门（HTTP终止处）

| # | 符号 | 观察 | 证明 |
|---:|---|---|---|
| 5 | `endpoint.py` → `durable_agent_endpoint` | `request_body`的threadId/runId | HTTP只接纳，不跑Workflow |
| 6 | `service.py` → `prepare_agui_run` | `incoming` vs `persisted`、各Conflict分支 | 幂等门/互斥门/历史前缀门；输入先于执行落库 |
| 7 | `service.py` → `_resume_run`（Pass B批准时命中） | 活动Run绑定校验 | Resume只允许接回本会话活动Run |

### 第3段：Worker（执行与HTTP解耦处）

| # | 符号 | 观察 | 证明 |
|---:|---|---|---|
| 8 | `worker.py` → `run_once` | `claim_one`的返回 | 原子领取：多Worker只有1个拿到 |
| 9 | `worker.py` → `_execute_claim` | `payload.type`逐事件 | SSE断开后事件仍写Journal；`_is_interrupt`识别伪装终态 |

### 第4段：Workflow外层（Product生命周期包住MAF）

| # | 符号 | 观察 | 证明 |
|---:|---|---|---|
| 10 | `runtime.py` → `ProductAwareWorkflow.run` | `input_data`、恢复分支 | Product Run/Attempt与MAF的映射点 |
| 11 | `runtime.py` → `complete_active_run`调用处（约457行附近） | `committed`返回值 | **图外提交门**：MAF完成后产品事务提交才算成功 |

### 第5段：39节点（S1-S7）

| # | 符号 | 观察 | 证明 |
|---:|---|---|---|
| 12 | `IntakeExecutor` handler | `state.origin_prompt` | S1：运行态起点 |
| 13 | `HarnessDirectoryContextExecutor` handler | 目录Context items | S1：只取轻量目录，不取详情 |
| 14 | `GovernedSemanticAgentExecutor.prepare` | `is_project_catalog_query`返回值 | **Pass A命中确定性短路（0模型）；Pass B进入`_advance`** |
| 15 | `GovernedSemanticAgentExecutor._advance`（Pass B） | Draft → Policy → interrupt | 每次模型调用的治理链：草稿、评估、一次性Grant |
| 16 | `GovernedSemanticAgentExecutor._deliver`（Pass B） | `disposition`分支 | 模型输出只是候选；采用去向写入Attempt |
| 17 | `ProductDecisionExecutor._advance` | `spec.applicable`、策略解析 | 决定点统一四路收敛：不适用/拒绝/自动/人工 |
| 18 | `ScenarioRouterExecutor.route` | `route_decision`（4条边求值） | S3：选中边与未走原因同时产生 |
| 19 | `ProjectCatalogExecutor.answer`（Pass A） | `catalog_result` | 权威目录查询；空目录与候选的诚实区分 |
| 20 | `TurnSummaryPersistExecutor` handler | `turn_summary` | 摘要是候选，不是事实 |
| 21 | `FinalizeExecutor.finalize` | `ctx.yield_output(response)` | 节点39只交候选，提交在图外（断点11） |

## 2. 调试中就能看到的Trace写入

在`TraceMixin._trace_content`下一个断点：每个节点都会经过这里写公开输入/输出。
观察`executor_id`、`content_type`、`public_input/public_output`——**这就是你调试结束后
在工作台和双报告里看到的内容**。调试时看变量，调试后用Trace复核，二者同源。

## 3. 调试结束后：Trace的3种用法

### 3.1 工作台节点详情（最常用）

右侧Workbench → “查看本轮运行” → 点击节点（推荐先点`scenario_router`和
`project_catalog_query`）：

- **公开输入/输出**：就是断点18/19里你看到的对象；
- **实际步骤输入**：该节点的StepInputProjection（最小工作包+Hash）；
- **治理事实**：Decision/Draft/Attempt按同一`executor_id`关联；
- 思维导图视图同时显示4条候选边、选中目标与未走原因——与断点18的`route_decision`一致。

### 3.2 双Trace报告（终态后确定性生成）

工作台Trace报告区可下载两份：

| 报告 | 用途 | 内容 |
|---|---|---|
| `diagnostic`（JSON） | 机器排障 | 全部Trace事件、Sequence、Attempt、ToolExecution与关联ID |
| `human`（Markdown） | 人读复盘 | 实际节点路径、路由/决定原因、空值reason code、未经过节点 |

两份来自同一组结构化事实，**不调用模型生成、不含隐藏推理**；旧Run缺字段时明确
`historical_not_recorded`，不拿当前代码反推。REST入口：
`/api/sessions/{sessionId}/runs/{runId}/trace` 与 `/trace-reports`。

### 3.3 只读SQL（脱敏）

```sql
-- 一个Run的节点轨迹（不查正文，只看结构）
SELECT sequence, event_type,
       json_extract(payload,'$.executor_id') AS node,
       json_extract(payload,'$.content_type') AS kind
FROM trace_events WHERE run_id = '<product_run_id>' ORDER BY sequence;

-- 双Trace报告
SELECT report_kind, generated_at FROM run_trace_reports
WHERE product_run_id = '<product_run_id>';
```

## 4. 调试与Trace的对照练习

完成Pass A后做一遍对照，确认你理解了“变量→事实”的映射：

1. 断点18的`route_decision.selected_branch` ↔ 工作台`scenario_router`的选中边 ↔ human报告的路由原因。
2. 断点19的`catalog_result.formal_projects` ↔ 最终Assistant Message正文 ↔ 节点详情的公开输出。
3. 断点11的`committed` ↔ `product_runs.status='succeeded'` ↔ diagnostic报告的终态事件。
4. Pass B断点16的`disposition` ↔ 节点详情Attempt的采用去向（如`accepted_as_intent`）。

## 掌握验收

1. 为什么说断点11（图外提交门）比任何MAF节点都更能决定“用户看到的成功”？
2. Pass A中`GovernedSemanticAgentExecutor.prepare`为什么不进入`_advance`？哪段代码决定？
3. 双Trace报告为什么不能由Agent事后总结生成？
4. 给你一个Product Run ID，你能用哪3个入口（工作台/SQL/REST）交叉验证同一个节点的行为？
5. 调试中发现某节点`public_output`为空，human报告会用什么区分“不适用”和“未记录”？

## 关键文件

| 文件 | 职责 |
|---|---|
| [第1课](./第1课-从点击发送到ContextPackage.md) | S1节点1-5的详细实验（本课不重复） |
| [每轮双Trace如何保存、分析与可视化](../Trace与可观测性/每轮双Trace如何保存、分析与可视化.md) | Trace专题：两类事实、双报告、可视化 |
| `backend/app/continuous_workflow_learning.py` | S1-S7学习阶段唯一事实源 |
| `backend/app/product_sessions/trace_reports.py` | 双Trace报告生成器 |

## 补充记录

- 2026-07-29：建立端到端调试路径；本轮同步补齐了链路上全部后端方法级与前端关键路径的
  中文注释，断点处的类/函数docstring均标明S阶段、节点号、输入输出与设计原因。
