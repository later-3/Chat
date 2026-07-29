# MAF 在本项目中的定位与持续协作工作流概览

## 1. 核心结论

**MAF（Microsoft Agent Framework）是 Workflow 运行时引擎，不是产品框架。Chat 的产品逻辑全部自建在 MAF 之上。**

---

## 2. MAF 提供了什么

从代码 import 事实推导，MAF 提供的 API 边界：

```python
# agent_framework 提供的全部 API：
Executor              # 节点基类，提供 id、handler/response_handler 装饰器
WorkflowBuilder       # 图构建器：add_edge / add_switch_case_edge_group / build
WorkflowContext       # 节点间通信：send_message / yield_output / request_info
Case / Default        # Switch 分支条件
CheckpointStorage     # Checkpoint 持久化接口
WorkflowCheckpoint    # Checkpoint 数据结构
handler               # 标记节点入口方法
response_handler      # 标记中断恢复方法（HITL resume）

# agent_framework_ag_ui 提供的桥接：
AgentFrameworkAgent      # 单 Agent → AG-UI 事件转换
AgentFrameworkWorkflow   # Workflow → AG-UI 事件转换
```

---

## 3. MAF **不**提供什么

| MAF 没有的能力 | Chat 自己实现的位置 |
|---|---|
| Product Session / Interaction / Message | `product_sessions/` 整个模块 |
| 意图识别与 Intent Set 生命周期 | `collaboration_intents/` |
| 协作协议绑定 | `collaboration_protocols/` |
| Context 版本化与 revision | `collaboration_contexts/` |
| ExecutionDraft / RunSpec / HITL 策略 | `governance/` + `execution_dispatch/` |
| ModelCallDraft / Provider 审批 | `model_call_review.py` |
| TurnSummary 持久化 | `governance/service.py` |
| 产品 Trace | `product_sessions/service.py:record_trace` |
| 产品提交门（终态 commit） | `workflows/runtime.py:ProductAwareWorkflow` |
| Repository Binding / Snapshot | `project_resources/` |
| pi 执行隔离 | `execution_dispatch/workflow.py` + `pi_runtime.py` |
| Evidence / Artifact | `evidence/` |

---

## 4. 代码证据

### 4.1 图装配文件明确说明分工

```python
# continuous_chat_factory.py 的模块文档字符串：
"""持续协作主Workflow的图装配文件：只创建节点并连接边，不实现领域行为。

阅读顺序：先看本文件知道39个节点如何连接，再到``continuous_chat.py``、
``execution_dispatch/workflow.py``和``execution_dispatch/result_gate.py``看节点行为。
把图连接单独保存，是因为节点ID、边顺序和图签名直接决定旧MAF Checkpoint能否恢复；
业务服务不能在这里偷偷改Product状态。
"""
```

### 4.2 CollaborationState 是 Chat 定义的产品状态

```python
# continuous_chat_contracts.py
@dataclass(frozen=True, slots=True)
class CollaborationState:
    origin_prompt: str                    # Chat 产品概念
    recent_turn_summaries: tuple          # Chat 产品概念
    context_items: tuple                  # Chat 产品概念
    intent: dict | None                   # Chat 产品概念
    intent_set_id: str | None             # Chat 产品概念
    execution_draft_revision_id: str | None  # Chat 产品概念
    run_spec_id: str | None               # Chat 产品概念
    ...
```

### 4.3 MAF 的 Executor 只是基类

```python
# MAF Executor 只提供基础设施，所有业务逻辑在 Chat 的 Executor 子类中：
class IntakeExecutor(Executor, TraceMixin):           # Chat 实现
class GovernedSemanticAgentExecutor(Executor, ...):   # Chat 实现
class ProductDecisionExecutor(Executor, ...):         # Chat 实现
```

---

## 5. 一句话总结

**MAF 提供"节点怎么连、状态怎么存、中断怎么恢复"的运行时语义；Chat 提供"节点做什么、产品状态是什么、审批怎么治理"的全部产品逻辑。MAF 不知道 Product Session 是什么，不知道 Intent Set 是什么，不知道模型调用需要审批。**

---

## 6. 持续协作工作流的 5 条不变量

从代码事实推导：

1. **模型输出只是候选**：模型返回的文本经过 `_json_object()` 解析后进入 `CollaborationState`，但不会直接成为 Product 事实。只有经过 `FinalizeExecutor` 提交门的才成为 Assistant Message。

2. **每个决策点可暂停**：`ProductDecisionExecutor` 根据 HITL 策略决定 `deny` / `auto_continue` / `waiting_human`。默认是人工审批。

3. **状态是不可变快照的传递**：`CollaborationState` 是 frozen dataclass，每个节点用 `replace(state, ...)` 产生新快照。MAF Checkpoint 保存的就是这个快照。

4. **模型调用有完整的治理链**：`GovernedSemanticAgentExecutor` → `ModelCallDraft` → Policy Evaluation → Human Decision Request → Grant → Attempt → Provider Dispatch。每一步都有持久记录。

5. **产品事实与运行时状态分离**：`CollaborationState` 是 MAF 运行时状态；Product Session / Intent Set / ContextPackage 是产品事实，存在 Product DB。

---

## 7. 节点分组与职责

39 个节点按职责分为 7 个阶段：

### 阶段 A: 输入接纳与上下文召回（节点 1-5）

| 节点 ID | 类名 | 职责 |
|---|---|---|
| `input_acceptance` | `IntakeExecutor` | 保存原始 prompt，召回最近 TurnSummary |
| `context_candidates` | `CandidateContextExecutor` | 确定性关键词召回（最多 4 条） |
| `harness_directory_context` | `HarnessDirectoryContextExecutor` | 阶段 A：查询 Project 轻量目录 |
| `context_adoption` | `ProductDecisionExecutor` | HITL：确认采用的上下文 |
| `directory_context_revision` | `HarnessContextRevisionExecutor` | 投影已确认的 ContextPackage revision |

### 阶段 B: 意图识别与路由（节点 6-16）

| 节点 ID | 类名 | 职责 |
|---|---|---|
| `intent_agent` | `GovernedSemanticAgentExecutor` | 模型调用 #1：识别意图 |
| `intent_set_projection` | `IntentSetProjectionExecutor` | 持久化意图候选 |
| `intent_binding` | `ProductDecisionExecutor` | HITL：确认意图绑定 |
| `intent_set_acceptance` | `IntentSetAcceptanceExecutor` | 接受不可变 Intent Set revision |
| `harness_project_resolver` | `HarnessProjectResolverExecutor` | 解析 Project 绑定 |
| `project_work_binding` | `ProductDecisionExecutor` | HITL：确认 Project/Work 关联 |
| `harness_detail_context` | `HarnessDetailContextExecutor` | 阶段 B：加载已绑定 Project 的完整工作集 |
| `detail_context_adoption` | `ProductDecisionExecutor` | HITL：确认 Project/Repository 上下文 |
| `detail_context_revision` | `HarnessContextRevisionExecutor` | 投影阶段 B 的 ContextPackage revision |
| `collaboration_protocol_resolver` | `CollaborationProtocolResolverExecutor` | 绑定协作协议 revision |
| `scenario_router` | `ScenarioRouterExecutor` | 确定性路由：catalog / clarify / plan / run |

### 阶段 C: 规划与执行合同（节点 17-20）

| 节点 ID | 类名 | 职责 |
|---|---|---|
| `execution_draft_compiler` | `ExecutionDraftCompilerExecutor` | 编译 ExecutionDraft |
| `execution_authorization` | `ProductDecisionExecutor` | HITL：授权执行合同 |
| `run_spec_compiler` | `RunSpecCompilerExecutor` | 编译不可变 RunSpec |
| `execution_route` | `ExecutionRouteExecutor` | 路由：pi_workspace / pi_readonly / responder |

### 阶段 D: 执行与结果（节点 21-28）

| 节点 ID | 类名 | 职责 |
|---|---|---|
| `response_agent` | `GovernedSemanticAgentExecutor` | 模型调用 #3：生成回复 |
| `result_commit` | `ProductDecisionExecutor` | HITL：确认结果 |
| `work_state_commit` | `ProductDecisionExecutor` | HITL：确认 Work 状态候选 |
| `memory_commit` | `ProductDecisionExecutor` | HITL：确认 Memory 候选 |
| `harness_candidate_commit` | `HarnessCandidateCommitExecutor` | 提交 Work/Memory 候选到 Product DB |
| `turn_summary_agent` | `GovernedSemanticAgentExecutor` | 模型调用 #4：提取回合摘要 |
| `turn_summary_persist` | `TurnSummaryPersistExecutor` | 持久化 TurnSummary |
| `result_finalization` | `FinalizeExecutor` | 产品提交门 → AG-UI 输出 |

### 分支节点（不在主链上）

| 节点 ID | 类名 | 职责 |
|---|---|---|
| `project_catalog_query` | `ProjectCatalogExecutor` | 确定性回答"我有哪些项目" |
| `clarification` | `ClarificationExecutor` | 发出澄清问题，等待下一轮 |
| `planning_agent` | `GovernedSemanticAgentExecutor` | 模型调用 #2：生成计划（仅 needs_plan 时） |
| `plan_acceptance` | `ProductDecisionExecutor` | HITL：确认计划 |
| `pi_readonly_dispatch` | `PiReadonlyDispatchExecutor` | pi 只读执行 |
| `pi_workspace_dispatch` | `PiWorkspaceDispatchExecutor` | pi 隔离写入 |
| `result_claim_prepare` | `ResultClaimPrepareExecutor` | Evidence 提交准备 |
| `result_claim_decision` | `ResultClaimDecisionExecutor` | Evidence 提交决策 |

---

## 8. 关键机制

### 8.1 模型调用治理链

```python
# GovernedSemanticAgentExecutor 的完整流程：
1. _begin(state) → ModelCallDraft（编译 Provider 请求）
2. _advance(draft, state, ctx)
   ├── _require_fresh_context()  # Repository 新鲜度检查
   ├── governance.register_model_call()  # 持久化 Policy Evaluation
   ├── 分支：
   │   ├── deny → PermissionError
   │   ├── auto_continue → _dispatch() 直接发送
   │   └── waiting_human → ctx.request_info(card) 中断等待审批
3. [用户审批] → resolve(original_request, decision, ctx)
   ├── approve → _dispatch()
   ├── revise → _advance(new_draft) 重新进入治理链
   └── abandon → 放弃，不发送
4. _dispatch(draft, revision, ...)
   ├── _require_fresh_context()  # 再次检查新鲜度
   ├── store.claim()  # 单次领取，防止重复发送
   ├── governance.claim_grant()  # 消费一次性授权
   ├── governance.start_model_call_attempt()
   ├── transport.stream(prepared)  # 发送到 Provider
   └── governance.finish_model_call_attempt()
5. _deliver(dispatched, state, ...)
   ├── 解析模型输出（intent/plan/response/summary）
   ├── 记录 disposition（accepted/rejected_invalid_output/...）
   └── ctx.send_message(next_state)
```

### 8.2 HITL 决策点

```python
# ProductDecisionExecutor 的通用模式：
1. 注册 Subject（决策对象）到治理层
2. 检查 applicable：本轮是否需要这个决策
3. 评估 HITL 策略：deny / auto_continue / waiting_human
4. 如果 waiting_human：
   ├── 创建 Human Decision Request
   ├── ctx.request_info(card) 中断
   └── [用户决定] → resolve()
       ├── accept → 继续
       ├── revise → 修改 Subject，重新评估
       ├── skip → 跳过（仅 allow_skip=True 时）
       └── cancel → 停止 Run
```

### 8.3 产品提交门

```python
# FinalizeExecutor 是最后一个节点：
async def finalize(self, state, ctx):
    response = state.response or "本轮没有形成可提交的答复。"
    await ctx.yield_output(response)  # 输出到 AG-UI

# ProductAwareWorkflow.run() 捕获这个输出：
async for event in super().run(input_data):
    if isinstance(event, TextMessageContentEvent):
        assistant_text.append(event.delta)
    if isinstance(event, RunFinishedEvent):
        terminal = event

# 终态门：
if isinstance(terminal, RunFinishedEvent) and terminal.outcome == "success":
    committed = await self._sessions.complete_active_run(
        thread_id,
        assistant_text="".join(assistant_text),
        agui_message_id=assistant_message_id,
    )
    # 只有这里才把 assistant_text 写入 Product Message
```
