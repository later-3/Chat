# 每轮双Trace如何保存、分析与可视化

**归档日期**：2026-07-28  
**分类**：Trace与可观测性  
**关联源码**：

- [双报告确定性生成器](../../backend/app/product_sessions/trace_reports.py)
- [终态事务与报告读取](../../backend/app/product_sessions/service.py)
- [报告数据库模型](../../backend/app/product_sessions/database.py)
- [REST入口](../../backend/app/api/product_router.py)
- [前端可视化](../../frontend/src/features/workflow/workflow-trace-reports.tsx)
- [运维时间线](../../backend/app/observability/diagnostics.py)

## 结论

一条消息对应的Product Run走完后，系统会确定性生成2份报告：

1. `diagnostic`：机器定位版，保存原始Product Trace事件、Sequence、Run Attempt、pi ToolExecution摘要、路由与产品决定及关联ID。
2. `human`：人读学习版，保存实际经过的节点、阶段、节点职责、为什么进入、公开输入/输出摘要、未选分支、空值原因和没有经过的节点；同时生成可下载Markdown。

两份报告都**不调用Agent或LLM**，不保存模型隐藏推理。它们由同一组Product Store结构化事实生成，是可重建投影，不是第二套事实源。

## 1. 保存在哪里

默认Product Store是`backend/.data/chat.db`；实际位置可由`backend/config.json`的`product_store.url`修改。核心表：

| 表 | 保存内容 | 权威性 |
|---|---|---|
| `trace_events` | Product Run逐事件Trace，`(run_id, sequence)`唯一 | Product过程事实 |
| `run_trace_reports` / `diagnostic` | 机器版报告JSON、来源Sequence范围、Hash | 可重建投影 |
| `run_trace_reports` / `human` | 人读JSON、Markdown、来源Sequence范围、Hash | 可重建投影 |
| `product_runs` / `run_attempts` | Run和Attempt终态、失败码、时间 | Product运行事实 |
| `tool_executions` | pi执行、内部模型/Tool计数、结果Hash和终态 | Tool执行事实 |

报告和Run终态在同一Product DB事务里提交：成功写Assistant Message时一起生成；失败、取消、放弃、中断和结果未知也一样生成。迁移前旧Run会在启动或首次读取时从现有Trace补建，不改旧事实。

## 2. 和`chat.jsonl`是什么关系

默认进程日志在`backend/.data/logs/chat.jsonl`，由`observability.log_file`配置。它用于查进程异常、调用边界和跨模块关联；轮转后可能不再长期存在，因此不能当Product事实源。

| 需要回答的问题 | 应查什么 |
|---|---|
| 用户这一轮实际经过哪些Workflow节点 | 人读报告 / Product Trace |
| 为什么选pi只读而不是直接回答 | 人读报告里的`route_decisions` |
| 为什么某字段为空 | 人读报告里的`empty_fields.code/reason` |
| Worker、Lease、Checkpoint、Provider Attempt如何串联 | 机器报告 + Diagnostics Timeline |
| 进程当时抛了什么脱敏异常 | `chat.jsonl`，按`product_run_id`检索 |

## 3. “为什么”和“空值”怎样记录

路由节点在运行时就保存`selected_branch`、`selected_target`、`selection_reason`，以及每个未选Option的`reason`；人读报告只是重排这些事实，不让模型事后编理由。

空值原因使用稳定代码：

| 代码 | 含义 |
|---|---|
| `not_applicable` | 本轮不适用，例如没有Project便不装配Project详情 |
| `not_selected` | 所在分支未被选中 |
| `not_produced` | 节点执行了但没有产出该字段，且Trace有明确原因 |
| `redacted` | 因安全/隐私规则脱敏 |
| `failed_before_production` | Run在字段产出前失败或中止 |
| `historical_not_recorded` | 当时结构化Trace没有记录更细原因；系统拒绝用当前代码倒推旧Run |

这里不会记录“模型心里为什么这样想”。只能记录系统可观察的输入、Policy/规则求值、用户决定、路由事实和公开结果。

## 4. 怎样读取和分析

REST：

```text
GET /api/sessions/{session_id}/runs/{run_id}/trace
GET /api/sessions/{session_id}/runs/{run_id}/trace-reports
GET /api/diagnostics/runs/{run_id}/timeline
```

推荐定位顺序：

1. 先读人读报告，确认实际路径、终态和哪个节点开始偏离预期。
2. 再读机器报告，按`trace_sequence`、`run_attempt_id`、`tool_execution_id`定位原始事件。
3. 查Diagnostics Timeline，连接Runtime Job、Worker、Checkpoint、ModelCall Attempt和Transport事件。
4. 最后按`product_run_id`搜索`chat.jsonl`，只补充进程异常；不能用日志覆盖Product终态。

## 5. 怎样可视化

Workflow工作台现有39节点图继续展示Definition和实时Product Trace。Run终态后新增“本轮流程报告”卡片：

- 按Trace Sequence列出真实经过路径，不按目录顺序猜。
- 每个节点显示所属阶段、职责、为什么进入、公开输入/输出摘要。
- 折叠展示未经过节点与空值原因。
- 可下载人读Markdown和机器JSON；两份文件都带来源Sequence范围和内容Hash。

前端只渲染后端报告，不自行推断历史原因；因此刷新、换浏览器或重新打开完成Run仍得到同一份路径说明。

## 6. 当前边界

1. 报告能完整还原**已提交到Product Store**的过程；进程在持久化前突然崩溃的瞬时局部变量无法凭空恢复。
2. 活动Run尚未“走完”，只展示实时Product Trace，不提前生成终态双报告。
3. 每个ToolExecution另存一份只读pi JSONL转录。双Trace解释Chat为何路由、批准和提交；pi转录用于
   复核执行层实际收到/产生的消息。两者都不能恢复已经退出的pi进程或绕过当前RunSpec续跑。
4. 主MAF Agent的Provider Attempt细节主要在Diagnostics Timeline；人读报告只展示公开节点内容，不混淆主MAF调用计数与pi内部调用计数。
