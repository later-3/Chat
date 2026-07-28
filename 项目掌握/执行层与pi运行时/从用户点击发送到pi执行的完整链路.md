# 从用户点击发送到 pi 执行的完整链路

**归档日期**：2026-07-28
**分类**：执行层与pi运行时
**关联源码**：
- `frontend/src/features/chat/chat-composer.tsx`
- `frontend/src/App.tsx`
- `frontend/src/use-chat-agent.ts`
- `backend/app/runtime_execution/endpoint.py`
- `backend/app/runtime_execution/worker.py`
- `backend/app/workflows/runtime.py`
- `backend/app/workflows/pi_agent.py`
- `backend/app/pi_gateway.py`
- `backend/app/pi_runtime.py`

## 问题

当用户在 Composer 输入内容并点击发送，完整的工作流是怎样的？基于代码事实分析，从前端到后端，把从用户点击发送到最终交给 pi 的完整链路梳理出来。

## 回答

完整链路共 9 层，从前端表单提交到 pi 子进程启动：

### 第 1 层：前端 Composer 表单提交

**文件**：`frontend/src/features/chat/chat-composer.tsx` L59

用户在 `<textarea>` 输入内容，点击发送按钮（或按 Enter）。表单触发 `onSubmit`：

```tsx
<form className="composer-stack" onSubmit={onSubmit}>
```

Enter 键触发（`conversation-pane.tsx` L289-293）：
```tsx
onKeyDown={(event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    onSubmit();
  }
}}
```

### 第 2 层：App.tsx 的 submit 函数

**文件**：`frontend/src/App.tsx` L398-420

`onSubmit` 指向 `submit`：

```tsx
const submit = () => {
  if (!draft.trim() || status !== "idle" || !activeSession || networkStatus === "offline") return;
  const text = draft;
  setDraft("");
  // ...处理 retry 逻辑...
  openWorkbench("workflow");  // 打开右侧工作台
  void send(text, control, {
    endpointUrl: workflowEndpointUrl(selectedWorkflow.endpoint),
    workflowId: selectedWorkflow.id,
    workflowVersion: selectedWorkflow.version,
  });
};
```

关键点：根据用户选择的 **Workflow** 决定发送到哪个后端端点。如果选的是 `governed-pi-agent`，endpoint 就是 `/api/workflows/governed-pi-agent/run`。

### 第 3 层：useChatAgent 的 send 函数 — AG-UI HttpAgent

**文件**：`frontend/src/use-chat-agent.ts` L222-262

```tsx
const send = useCallback(async (content, control?, workflow?) => {
  const text = content.trim();
  if (!text || agent.isRunning || pendingReview) return;

  const messageId = createClientId();
  const runId = createClientId();
  
  if (workflow) agent.url = workflow.endpointUrl;  // 动态切换 AG-UI 端点
  agent.addMessage({ id: messageId, role: "user", content: text });
  setMessages(cloneMessages(agent.messages));
  setStatus("running");

  await agent.runAgent({
    runId,
    forwardedProps: {
      ...(control ? sessionControlForwardedProps(control) : {}),
      ...(workflow ? {
        workflow: { id: workflow.workflowId, version: workflow.workflowVersion },
      } : {}),
    },
  });
}, [agent, pendingReview]);
```

关键事实：
- `agent` 是 `@ag-ui/client` 的 `HttpAgent` 实例
- `agent.url` 被设置为选中 Workflow 的后端端点
- `agent.runAgent()` 向该端点发送 HTTP POST，body 是 AG-UI 协议格式的 JSON

### 第 4 层：后端 AG-UI 端点接收

**文件**：`backend/app/runtime_execution/endpoint.py` L32-120

`add_durable_agui_endpoint` 在应用启动时为每个 Workflow 注册了一个 POST 端点：

```python
@app.post(path)
async def durable_agent_endpoint(request_body: AGUIRequest) -> StreamingResponse:
    input_data = request_body.model_dump(mode="json", exclude_none=True)
    
    # 1. 创建 Product Run（产品领域事实）
    accepted = await sessions.prepare_agui_run(input_data)
    
    # 2. 入队到 Runtime Job 队列
    enqueued = await runtime.enqueue(
        accepted=accepted,
        endpoint_key=endpoint_key,
        workflow_definition_id=workflow_definition_id,
        workflow_version=workflow_version,
        input_data=input_data,
    )
    
    # 3. 返回 SSE 流，轮询事件给前端
    async def event_stream():
        while True:
            events, job = await runtime.events_after(...)
            for event in events:
                yield _sse(payload, sequence=sequence)
    
    return StreamingResponse(event_stream(), ...)
```

关键事实：
- `sessions.prepare_agui_run()` — 在 Product DB 创建 Run 记录
- `runtime.enqueue()` — 创建 Runtime Job，写入队列等待 Worker 领取
- 端点本身**不执行** Workflow，只返回 SSE 流

### 第 5 层：Execution Worker 领取 Job 并执行

**文件**：`backend/app/runtime_execution/worker.py` L111-200

后台 Worker 循环领取 Job：

```python
async def run_once(self) -> bool:
    claim = await self.runtime.claim_one(worker_id=self.worker_id, lease_seconds=self.lease_seconds)
    if claim is None:
        return False
    await self._execute(claim)
    return True

async def _execute_claim(self, claim: ClaimedRuntime) -> None:
    runner = self.registry.require(claim.endpoint_key)  # 从注册表找到 Runner
    async for event in runner.run(claim.input_data):
        # 写入事件到 journal，供 SSE 流读取
        await self.runtime.append_event(claim, payload)
```

### 第 6 层：ProductAwareWorkflow.run() — 启动 MAF Workflow

**文件**：`backend/app/workflows/runtime.py` L102-150

```python
async def run(self, input_data: dict[str, Any]):
    thread_id = self._thread_id_from_input(input_data)
    accepted = await self._sessions.prepare_agui_run(input_data)
    
    if self._run_ids is not None:
        self._run_ids[thread_id] = accepted.product_run_id  # 绑定 Product Run ID
    
    # 调用 MAF Workflow.run()，产生 AG-UI 事件
    async for event in super().run(input_data):
        yield event
```

### 第 7 层：GovernedPiToolExecutor.start() — MAF Workflow 入口

**文件**：`backend/app/workflows/pi_agent.py` L130-155

pi Workflow 只有一个 Executor：`GovernedPiToolExecutor`。

```python
@handler(input=list)
async def start(self, messages, ctx):
    normalized = normalize_agui_messages_for_provider(messages)
    self._origin_prompt = _latest_user_text(normalized)  # 提取最新用户消息
    
    active_run = await self._sessions.active_run(self._thread_id)
    self._execution_id = await self._tools.start_execution(...)
    
    # 关键：调用 pi_tool.invoke() 启动 pi
    self._execution = await self._pi_tool.invoke(
        arguments={"task": self._origin_prompt},
        skip_parsing=True,
    )
    await self._drive(ctx)  # 进入边界驱动循环
```

### 第 8 层：PiRuntimeManager.start() — 注册并启动 pi 进程

**文件**：`backend/app/pi_gateway.py` L70-122

```python
async def start(self, task, config, ...) -> PiExecution:
    provider = self.catalog.require_selection(config.provider_id, config.model)
    token = secrets.token_urlsafe(32)  # 生成认证 token
    
    execution = PiExecution(token=token, task=clean_task, config=config, ...)
    self._executions[token] = execution  # 注册到进程管理器
    
    await execution.start()  # 启动子进程
    return execution
```

### 第 9 层：PiExecution.start() — 真正启动 pi 子进程

**文件**：`backend/app/pi_runtime.py` L508-641

```python
async def start(self) -> None:
    # 1. 准备临时目录，写入 models.json 和扩展脚本
    self._temp_directory = tempfile.TemporaryDirectory(prefix="chat-pi-")
    
    # 2. 启动子进程
    self.process = await asyncio.create_subprocess_exec(
        str(self.runtime.node_path),      # Node.js
        str(self.runtime.cli_path),       # pi CLI
        "--mode", "rpc",
        "--provider", "chat-governed",
        "--model", self.config.model,
        ...
    )
    
    # 3. 启动读取任务
    self._reader_task = asyncio.create_task(self._read_stdout())
    self._stderr_task = asyncio.create_task(self._read_stderr())
    
    # 4. 发送初始 RPC 命令
    await self._command("set_auto_retry", {"enabled": False})
    await self._command("prompt", {"message": self.task})  # 把用户任务发给 pi
```

### 完整调用链总结

```
用户点击发送
    ↓
[前端] ChatComposer form onSubmit
    ↓
[前端] App.tsx submit()
    ↓
[前端] useChatAgent.send() → agent.runAgent()
    ↓ HTTP POST to /api/workflows/governed-pi-agent/run
[后端] durable_agent_endpoint() — AG-UI 端点
    ↓
[后端] sessions.prepare_agui_run() — 创建 Product Run
    ↓
[后端] runtime.enqueue() — 创建 Runtime Job
    ↓
[后端] ExecutionWorker.run_once() — Worker 领取 Job
    ↓
[后端] ProductAwareWorkflow.run() — 启动 MAF Workflow
    ↓
[后端] GovernedPiToolExecutor.start() — MAF Executor 入口
    ↓
[后端] _pi_tool.invoke() → _start_pi() → manager.start()
    ↓
[后端] PiRuntimeManager.start() — 注册 PiExecution
    ↓
[后端] PiExecution.start()
    ↓
[后端] asyncio.create_subprocess_exec(node, pi-cli, --mode rpc, ...)
    ↓
pi 子进程启动，通过 JSONL-RPC 接收任务
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `frontend/src/features/chat/chat-composer.tsx` | Composer UI 组件 |
| `frontend/src/App.tsx` | submit 编排，选择 Workflow 和端点 |
| `frontend/src/use-chat-agent.ts` | AG-UI HttpAgent，send/approve/revise |
| `frontend/src/runtime-config.ts` | AG_UI_URL 解析 |
| `frontend/src/features/workflow/workflow-api.ts` | workflowEndpointUrl 构造 |
| `backend/app/runtime_execution/endpoint.py` | AG-UI 端点注册，SSE 流 |
| `backend/app/runtime_execution/worker.py` | Execution Worker，Job 领取和执行 |
| `backend/app/runtime_execution/service.py` | Runtime Job 队列、Lease、事件日志 |
| `backend/app/product_sessions/service.py` | prepare_agui_run，Product Run 创建 |
| `backend/app/workflows/runtime.py` | ProductAwareWorkflow，MAF Workflow 包装 |
| `backend/app/workflows/pi_agent.py` | GovernedPiToolExecutor，MAF Workflow 定义 |
| `backend/app/workflows/catalog.py` | Workflow 定义注册（endpoint、节点） |
| `backend/app/composition.py` | 应用组装，注册 pi Workflow 端点 |
| `backend/app/pi_gateway.py` | PiRuntimeManager，进程管理 + Provider 网关 |
| `backend/app/pi_runtime.py` | PiExecution，子进程启动和 JSONL-RPC 通信 |

## 补充记录

（暂无）
