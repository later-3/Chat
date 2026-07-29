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

3. **状态以受控消息传递**：`CollaborationState` 是 frozen dataclass，字段不能直接重新赋值；Executor通常通过
   `replace(state, ...)`或受控结果对象产生下一状态。冻结是浅层防误改，不表示嵌套`dict/list`天然不可变；
   MAF Checkpoint保存的是可恢复运行状态，也不等同于Product Store权威事实。

4. **模型调用有完整的治理链**：`GovernedSemanticAgentExecutor` → `ModelCallDraft` → Policy Evaluation → Human Decision Request → Grant → Attempt → Provider Dispatch。每一步都有持久记录。

5. **产品事实与运行时状态分离**：`CollaborationState` 是 MAF 运行时状态；Product Session / Intent Set / ContextPackage 是产品事实，存在 Product DB。

---

## 7. 节点学习分组与职责

当前主Workflow为`continuous-collaboration` v1.8.0：39个节点、43条静态边。为了阅读代码，
`backend/app/continuous_workflow_learning.py`把39个节点唯一映射为S1–S7。这个分组不参与MAF执行：

| 学习阶段 | 节点范围 | 核心责任 |
|---|---|---|
| S1 输入接纳与目录级上下文 | 1–5 | 输入证据、TurnSummary候选、directory Context和采用revision |
| S2 意图、Project绑定与详情上下文 | 6–15 | Intent Set、权威Project/Work绑定、detail Context和协议revision |
| S3 场景路由与可选规划 | 16–20 | 目录查询/澄清/规划/直接执行选择与Plan决定 |
| S4 执行草稿、授权与运行路由 | 21–24 | ExecutionDraft、授权Hash、不可变RunSpec和三路执行选择 |
| S5 pi执行、Workspace与Evidence | 25–31 | pi只读/隔离编辑、Artifact、Validation和Completion Claim |
| S6 响应、摘要与提交决定 | 32–36 | Response、TurnSummary以及Result/Work/Memory分别决定 |
| S7 产品事实写入与本轮终态 | 37–39 | 幂等候选提交、TurnSummary持久化和图内最终输出 |

节点的唯一完整清单、8条可达路径和每阶段专题见
`项目掌握/Workflow架构与ProductAwareWorkflow/持续协作主Workflow的39节点设计.md`。

不要再用“阶段A–D”描述整张图。旧材料中的A/B只表示Context装配的`directory/detail`两步；项目交付
阶段0–8、单模型审批Workflow的12个代码阶段和S1–S7也分别是不同维度。

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
