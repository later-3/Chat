# 第1课：从点击发送到ContextPackage

**归档日期**：2026-07-29  
**分类**：调试实战  
**关联源码**：

- [App.submit](../../frontend/src/App.tsx)
- [useChatAgent.send](../../frontend/src/use-chat-agent.ts)
- [durable_agent_endpoint](../../backend/app/runtime_execution/endpoint.py)
- [ProductSessionService.prepare_agui_run](../../backend/app/product_sessions/service.py)
- [ExecutionWorker._execute_claim](../../backend/app/runtime_execution/worker.py)
- [ProductAwareWorkflow.run](../../backend/app/workflows/runtime.py)
- [主Workflow节点1-3](../../backend/app/workflows/continuous_chat.py)
- [HarnessService.create_context_package](../../backend/app/harness/service.py)

## 问题

怎样不靠阅读抽象说明，亲手观察一条消息从前端点击发送，经过Product Run和MAF Workflow，最终把
`recent_turn_summaries`装配成持久化ContextPackage？

## 回答

本实验只追到第3个Workflow节点，不要求你一次理解39个节点。完成后你应该拿到1个Product Run ID、
1组内存摘要候选、1个ContextPackage ID、1个package hash，以及数据库中对应的Header和Items。

## 1. 实验前提与安全边界

1. 使用项目虚拟环境和现有VS Code配置，不读取或输出`backend/config.json`。
2. 默认Product Store是`backend/.data/chat.db`；私有配置可能覆盖路径。路径不一致时只在本机确认，
   不把私有配置内容复制进文档或聊天。
3. SQL只读Header、ID、状态、Hash前缀和标题，不查询密钥、完整Prompt或Provider Payload。
4. 为了看到非空`recent_turn_summaries`，选择一个已有完成回合的Product Session；若没有，先完成一轮
   简单问答，再在同一Session开始本实验。
5. 本实验会继续走到第一次模型审批暂停；未准备产生Provider费用时不要批准该请求。

## 2. 启动方式

在VS Code“运行和调试”选择：

```text
Chat Full Stack
```

它会启动：

- FastAPI/MAF后端：`127.0.0.1:8030`
- React/Vite前端：`127.0.0.1:5073`
- 当前`asgi`入口内嵌的Execution Worker

打开`http://127.0.0.1:5073`，进入一个已有完成回合的Product Session，并选择
`continuous-collaboration v1.8.0`。

## 3. 设置8组断点

行号会漂移，请用符号搜索，不只按行号。

| 顺序 | 文件与符号 | 观察变量 | 这一步证明什么 |
|---:|---|---|---|
| 1 | `App.tsx` → `submit` | `prompt`、`selectedWorkflow` | 页面将哪段输入绑定到哪个Workflow |
| 2 | `use-chat-agent.ts` → `send` | `content`、`workflow.endpointUrl`、`runId` | AG-UI客户端真正发送什么端点和runId |
| 3 | `runtime_execution/endpoint.py` → `durable_agent_endpoint` | `input_data`、`accepted`、`enqueued` | HTTP端点只接纳并入队，不直接跑Workflow |
| 4 | `product_sessions/service.py` → `prepare_agui_run` | `session_id`、`workflow_binding`、返回的`product_run_id` | Product Message/Interaction/Run先成为事实 |
| 5 | `runtime_execution/worker.py` → `_execute_claim` | `claim.job_id`、`endpoint_key`、`lease_epoch` | Worker按持久Job执行，不依赖SSE连接活着 |
| 6 | `workflows/runtime.py` → `ProductAwareWorkflow.run` | `thread_id`、`accepted.product_run_id`、是否`resume` | Product生命周期怎样包住MAF运行 |
| 7 | `workflows/continuous_chat.py` → `IntakeExecutor.accept`与`CandidateContextExecutor.select_candidates` | `summaries`、`state.recent_turn_summaries`、`selected` | 摘要从DB投影到内存，再从最多8条收窄到4条 |
| 8 | 同文件`HarnessDirectoryContextExecutor.assemble`及`harness/service.py` → `create_context_package` | `items`、`projects`、`normalized`、`package.id`、`package_hash` | 临时候选怎样变成持久、预算化、可审核的产品对象 |

前端断点需要浏览器开发工具或VS Code JavaScript调试接管页面；如果当前环境只命中Python断点，先从
第3组开始，仍可完成本实验的后端主目标。

## 4. 发送实验输入

在同一Product Session发送：

> 继续上一轮的主题，只解释Context为什么要保存，不要修改Project、Work或Memory。

逐个断点继续运行，并把以下4个ID记在临时纸上，不需要写进项目文件：

```text
Product Session ID =
Product Run ID     =
Runtime Job ID     =
ContextPackage ID  =
```

## 5. 每个关键断点应该看到什么

### 5.1 `IntakeExecutor.accept`

- `prompt`等于刚输入的文字。
- `summaries`是数据库查询返回的`list[dict]`，最多8条。
- 每条通常有`id/topic/summary/project_hint/status/summary_hash/created_at`。
- 创建`CollaborationState`后，它们变为tuple字段`recent_turn_summaries`。

若为空，先确认同一Product Session是否有已经走过`turn_summary_persist`的完成回合；不要把空值直接判为
Context功能失败。

### 5.2 `CandidateContextExecutor.select_candidates`

- `state.recent_turn_summaries`是节点1拿到的候选。
- `selected`最多4条。
- 没命中关键词且不是未回答澄清的摘要会被排除。
- 此时数据库中的旧TurnSummary行没有被修改。

### 5.3 `HarnessDirectoryContextExecutor.assemble`

- `items`已经把TurnSummary、Project目录和Contributor结果统一成相同字段。
- `projects`是正式Product Store查询结果，不是模型猜测。
- `package["items"]`同时包含`adopted=true`和可能的`adopted=false`项。
- `directory_context_package_id`只是运行态保存的引用；完整Header与Items已经落库。

### 5.4 `HarnessService.create_context_package`

重点观察：

```text
token_budget = 1800
normalized[*].source_kind/source_id/source_revision
normalized[*].adopted/reason/token_estimate
revision
package_hash
effective_command_id
```

`effective_command_id + request_hash`保证恢复或重复调用不会为同一确定性命令产生内容不同的包。

## 6. 用只读SQL核对Product Store

在新的终端打开默认数据库；若私有配置覆盖路径，替换成本机实际路径：

```bash
sqlite3 -readonly backend/.data/chat.db
```

进入SQLite后：

```sql
.headers on
.mode box

SELECT
  id,
  topic,
  extraction_status,
  substr(summary_hash, 1, 12) AS hash12,
  created_at
FROM turn_summaries
WHERE session_id = '<Product Session ID>'
ORDER BY created_at DESC
LIMIT 8;

SELECT
  id,
  run_id,
  stage,
  revision,
  status,
  token_budget,
  estimated_tokens,
  substr(package_hash, 1, 12) AS hash12
FROM context_packages
WHERE run_id = '<Product Run ID>'
ORDER BY stage, revision;

SELECT
  ordinal,
  source_kind,
  source_id,
  source_revision,
  title,
  adopted,
  token_estimate,
  reason
FROM context_adoption_records
WHERE context_package_id = '<ContextPackage ID>'
ORDER BY ordinal;
```

这里刻意不查询`content_text`。要核对某项正文时优先使用产品工作台公开投影；只有定位明确、确有需要时
才在本机查看特定来源，避免把整段私密Context复制到终端或对话。

## 7. 进阶实验：观察revision而不是原地修改

如果本轮出现“确认采用Context”的HITL卡片：

1. 记下revision 1的ID和hash。
2. 选择“修改”，排除一张TurnSummary并保存。
3. 不要立刻批准下游模型请求。
4. 再次查询`context_packages`和`context_adoption_records`。

预期：

- 新增revision 2；
- revision 1状态变为`superseded`；
- revision 2的`previous_package_id`指向revision 1；
- 新hash不同；
- 被排除Item仍保留，但`adopted=false`并有原因；
- 节点5投影后，运行态`recent_turn_summaries`不再含该来源。

如果没有出现卡片，说明当前HITL策略认为该决定不适用或允许自动推进。先在Trace/治理视图确认命中的
策略和原因，不要为了做实验直接修改生产策略。

## 8. 用Trace把断点串起来

拿到Product Run ID后，可以运行：

```bash
.venv/bin/python -m backend.app.diagnostics_cli --run-id '<Product Run ID>'
```

或在Run终态后读取人读/机器双Trace。你要找到：

- `input_acceptance`公开输入；
- `context_candidates`候选数与选择规则；
- `harness_directory_context`的package ID、adopted/excluded明细；
- Context决定是否人工、自动或不适用；
- `directory_context_revision`最终投影的来源集合。

Trace没有隐藏推理；它只记录可观察输入、规则、决定、状态和公开结果。

## 9. 常见误判

1. `recent_turn_summaries=[]`不必然是Bug：该Session可能没有已持久化的上一轮摘要。
2. ContextPackage行存在不等于已经给Provider发送：它在模型调用前就作为候选保存。
3. `candidate`不等于Accepted Memory：只是本轮Context候选状态。
4. 浏览器断开不等于Run取消：Worker继续执行，事件可按Cursor补回。
5. MAF Checkpoint能恢复节点不等于它拥有Context事实：节点5仍从Product Store读取最新revision。

## 10. 掌握验收

完成实验后，不看文档画出下面对象链，并给每条箭头写出函数名：

```text
Product Message
-> TurnSummaryRecord
-> recent_turn_summaries
-> Context Item
-> ContextPackage revision
-> CollaborationState投影
-> Intent Agent输入
```

再回答：

1. 哪一步第一次写入Product Run？
2. 哪一步只入队但不执行Workflow？
3. `recent_turn_summaries`在哪一步是8条、在哪一步最多4条？
4. 哪两张表共同表达一个ContextPackage？
5. 为什么节点5必须重新读数据库，而不能完全相信节点4返回的内存state？

能在10分钟内重新命中关键断点、查到对应行并回答5题，算完成L2。

## 关键文件

| 文件 | 职责 |
|---|---|
| [frontend/src/App.tsx](../../frontend/src/App.tsx) | 页面发送编排 |
| [frontend/src/use-chat-agent.ts](../../frontend/src/use-chat-agent.ts) | AG-UI HttpAgent运行与恢复 |
| [runtime_execution/endpoint.py](../../backend/app/runtime_execution/endpoint.py) | 接纳请求、创建Job、返回SSE |
| [runtime_execution/worker.py](../../backend/app/runtime_execution/worker.py) | 领取Job并执行Workflow |
| [workflows/runtime.py](../../backend/app/workflows/runtime.py) | Product生命周期与MAF事件接合 |
| [workflows/continuous_chat.py](../../backend/app/workflows/continuous_chat.py) | Context节点实际行为 |
| [harness/service.py](../../backend/app/harness/service.py) | ContextPackage创建事务 |

## 补充记录

（暂无）
