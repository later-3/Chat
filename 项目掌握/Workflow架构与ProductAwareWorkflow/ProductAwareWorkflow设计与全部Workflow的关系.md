# ProductAwareWorkflow 设计与全部 Workflow 的关系

**归档日期**：2026-07-28
**分类**：Workflow架构与ProductAwareWorkflow
**关联源码**：
- `backend/app/workflows/runtime.py`
- `backend/app/workflows/catalog.py`
- `backend/app/composition.py`
- `frontend/src/workflow-run-view.tsx`

## 问题

把 "ProductAwareWorkflow.run() — 启动 MAF Workflow" 展开，现在是怎么设计的？前端页面上的：持续协作主 Workflow、Workflow Definition · v1.8.0、设计者视图展示 39 个真实 MAF 节点、系统执行链等，都是这个 ProductAwareWorkflow 吗？

## 回答

### 1. ProductAwareWorkflow 是什么

`ProductAwareWorkflow`（`backend/app/workflows/runtime.py` L77）是一个**通用包装层**，继承自 MAF 的 `AgentFrameworkWorkflow`，职责是：

- 在 MAF Workflow 运行前后做 **Product 领域事务**（创建 Run、标记状态、提交结果）
- 拦截 MAF 事件流，把 `ActivitySnapshotEvent`（节点活动）写入 Trace
- 处理 **Interrupt/Resume**（审批暂停→恢复）时的 Checkpoint 持久化
- 在 Workflow 结束时调用 `complete_active_run()` 提交 Product 终态

它是一个**壳**，真正的执行逻辑由传入的 `workflow_factory` 决定。

### 2. 所有 Workflow 的定义

在 `catalog.py` 中定义了 **6 个 WorkflowDefinition**：

| ID | 名称 | 节点数 | 可选 | 端点 |
|---|---|---|---|---|
| `continuous-collaboration` | **持续协作主 Workflow** | **39 个节点** | **是** | `/api/workflows/continuous-collaboration/run` |
| `chat-model-call-approval` | 发送前可编辑 Prompt | 1 个节点 | 否 | `/api/agent` |
| `nested-quality-demo` | 嵌套质量检查 | 8 个节点 | 否 | `/api/workflows/nested-quality-demo/run` |
| `governed-agent-handoff` | 双 Agent 会话传递 | 3 个节点 | 否 | `/api/workflows/governed-agent-handoff/run` |
| `governed-idiom-chain` | 三方成语接龙 | 5 个节点 | 否 | `/api/workflows/governed-idiom-chain/run` |
| `governed-pi-agent` | pi Agent 受控工具 | 3 个节点 | 否 | `/api/workflows/governed-pi-agent/run` |

### 3. 前端下拉框里可选的 Workflow

前端 Composer 里的 Workflow 下拉框只显示 `selectable=True` 的 Workflow。当前只有：
- **持续协作主 Workflow**（`continuous-collaboration`，39 节点，v1.8.0）
- 如果 `workflowDefinitions` 为空，则 fallback 到 `CHAT_WORKFLOW`（即 `chat-model-call-approval`，1 节点）

所以前端看到的 **"持续协作主 Workflow · v1.8.0 · 39 个真实 MAF 节点"** 就是 `CONTINUOUS_COLLABORATION_WORKFLOW`。

### 4. 每个 Workflow 都对应一个 ProductAwareWorkflow 实例

在 `composition.py` 中，每个 WorkflowDefinition 都被包装成一个 `ProductAwareWorkflow` 实例：

```python
# 持续协作
continuous_workflow = ProductAwareWorkflow(
    workflow_factory=continuous_factory,     # ← 真正的 MAF Workflow 工厂
    sessions=product_sessions,
    definition=CONTINUOUS_COLLABORATION_WORKFLOW,  # ← 39 节点定义
    ...
)

# pi Agent
pi_workflow = ProductAwareWorkflow(
    workflow_factory=pi_factory,             # ← pi 的 MAF Workflow 工厂
    sessions=product_sessions,
    definition=GOVERNED_PI_AGENT_WORKFLOW,   # ← 3 节点定义
    ...
)
```

**每个都是 `ProductAwareWorkflow` 实例**，但传入的 `workflow_factory` 不同，所以实际运行的 MAF 图完全不同。

### 5. ProductAwareWorkflow.run() 展开

当 Execution Worker 调用 `runner.run(input_data)` 时，`ProductAwareWorkflow.run()` 做了以下事情：

```
1. sessions.prepare_agui_run(input_data)
   → 创建/恢复 Product Run

2. self._run_ids[thread_id] = accepted.product_run_id
   → 绑定 Product Run ID 到 thread

3. if not is_resume:
     self.clear_thread_workflow(thread_id)
   → 新 Run 清除旧 Workflow 缓存，确保全新图

4. if is_resume and checkpoint_storage:
   → 查找 Governance 层的 Interrupt 合同
   → 校验 graph_signature_hash 没变
   → 从 Checkpoint 恢复 MAF Runner 状态
   → 标记 Interrupt 为 "resuming"

5. sessions.mark_running(thread_id)
   → Product Run 状态 → running

6. async for event in super().run(input_data):
   → 调用 MAF Workflow.run()，产生 AG-UI 事件流

   拦截处理：
   - RunStartedEvent → 直接 yield
   - TextMessageContentEvent → 收集 assistant 文本
   - ActivitySnapshotEvent(executor) → 写 Trace，剥离 workflow_id
   - RunFinishedEvent/RunErrorEvent → 缓存为 terminal，不直接 yield

7. 终态处理：
   - terminal 是 RunError → fail_active_run()
   - terminal 是 interrupt → 持久化 Checkpoint + 绑定 Interrupt 合同
                           → mark_waiting_approval()
   - terminal 是 finish → complete_active_run() 提交 Product 终态
```

### 6. "系统执行链" — 持续协作主 Workflow 的 39 节点路径

```
input_acceptance → context_candidates → harness_directory_context → context_adoption
→ directory_context_revision → intent_agent → intent_set_projection → intent_binding
→ intent_set_acceptance → harness_project_resolver → project_work_binding
→ harness_detail_context → detail_context_adoption → detail_context_revision
→ collaboration_protocol_resolver → scenario_router
  ├── project_catalog_query → result_commit
  ├── clarification
  ├── planning_agent → plan_acceptance → execution_draft_compiler
  └── execution_draft_compiler → execution_authorization → run_spec_compiler
      → execution_route
        ├── execution_workspace_prepare → pi_workspace_dispatch → ... (pi 隔离编辑)
        ├── pi_readonly_dispatch → ... (pi 只读)
        └── response_agent → ... (Chat 回答)
      → turn_summary_agent → result_commit → work_state_commit → memory_commit
      → harness_candidate_commit → turn_summary_persist → result_finalization
```

### 7. 总结

| 概念 | 是什么 |
|------|--------|
| `ProductAwareWorkflow` | 通用包装层，所有 Workflow 都用它，负责 Product 事务 |
| `WorkflowDefinition` | 静态图定义（节点、边、版本），在 catalog.py 中声明 |
| `workflow_factory` | 真正的 MAF Workflow 工厂，每个 Workflow 不同 |
| 持续协作主 Workflow | `CONTINUOUS_COLLABORATION_WORKFLOW`，39 节点，v1.8.0，`selectable=True` |
| 设计者视图 39 节点 | 就是 `CONTINUOUS_COLLABORATION_WORKFLOW.nodes` 的可视化 |
| pi Agent 受控工具 | `GOVERNED_PI_AGENT_WORKFLOW`，3 节点，是独立的 Workflow |

## 关键文件

| 文件 | 职责 |
|------|------|
| `backend/app/workflows/runtime.py` | `ProductAwareWorkflow`，通用 MAF Workflow 包装层 |
| `backend/app/workflows/catalog.py` | 6 个 `WorkflowDefinition` 静态图定义 |
| `backend/app/composition.py` | 应用组装，为每个 Workflow 创建 `ProductAwareWorkflow` 实例并注册端点 |
| `backend/app/runtime_execution/endpoint.py` | `add_durable_agui_endpoint`，注册 AG-UI SSE 端点 |
| `backend/app/runtime_execution/worker.py` | Execution Worker，领取 Job 后调用 `runner.run()` |
| `frontend/src/workflow-run-view.tsx` | 前端工作台，显示 Workflow 名称、版本、节点数、设计者视图 |
| `frontend/src/features/workflow/workflow-mind-map.tsx` | 前端节点图可视化 |
| `frontend/src/features/workflow/workflow-api.ts` | Workflow API 和 `workflowEndpointUrl` |

## 补充记录

（暂无）
