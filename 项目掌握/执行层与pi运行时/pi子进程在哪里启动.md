# pi 子进程在哪里启动

**归档日期**：2026-07-28
**分类**：执行层与pi运行时
**关联源码**：
- `backend/app/workflows/pi_agent.py`
- `backend/app/pi_gateway.py`
- `backend/app/pi_runtime.py`

## 问题

找到我们调用执行层的地方，也就是在哪儿启动的 pi？

## 回答

pi 的启动调用链从外到内共 4 层：

### 1. MAF Workflow Executor 入口

`GovernedPiToolExecutor`（`backend/app/workflows/pi_agent.py`）是一个 MAF Workflow Executor。当用户发起一次 pi Agent 对话时，`start` handler 被调用，它从消息中提取用户任务，然后调用 `self._pi_tool.invoke()`。

```python
# pi_agent.py L127-128
async def _start_pi(self, task: str) -> PiExecution:
    return await self._manager.start(task, self._config)
```

### 2. PiRuntimeManager — 进程管理器

`PiRuntimeManager.start()`（`backend/app/pi_gateway.py` L70-122）创建 `PiExecution` 对象，注册到进程管理器的 `_executions` 字典，然后调用 `execution.start()`。

```python
# pi_gateway.py L70-122
async def start(self, task: str, config: PiToolConfigSnapshot, ...) -> PiExecution:
    provider = self.catalog.require_selection(config.provider_id, config.model)
    token = secrets.token_urlsafe(32)
    execution = PiExecution(token=token, task=clean_task, config=config, ...)
    self._executions[token] = execution
    await execution.start()
    return execution
```

### 3. PiExecution.start() — 真正的子进程启动

`PiExecution.start()`（`backend/app/pi_runtime.py` L508-641）是**实际启动 pi 子进程的地方**：

```python
# pi_runtime.py L629-637
self.process = await asyncio.create_subprocess_exec(
    str(self.runtime.node_path),      # Node.js 可执行文件
    str(self.runtime.cli_path),       # pi CLI 入口
    "--mode", "rpc",
    "--provider", "chat-governed",
    "--model", self.config.model,
    "--api-key", self.token,
    "--thinking", self.config.thinking_level,
    "--system-prompt", self.config.system_prompt,
    "--extension", str(extension_path),
    "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-session",
    "--approve", "--offline",
    ...
)
```

启动后立即发送两条 JSONL-RPC 命令：
- `set_auto_retry` — 关闭自动重试
- `prompt` — 把用户任务发给 pi 开始执行

### 4. 通信机制

pi 子进程通过 stdin/stdout 以 JSONL-RPC 协议与 Chat 后端通信。`PiExecution` 启动两个异步任务：
- `_read_stdout()` — 解析 pi 输出的 JSONL 事件
- `_read_stderr()` — 收集错误信息

### 调用链总结

```
用户消息 → GovernedPiToolExecutor.start()
  → _pi_tool.invoke() → _start_pi()
    → PiRuntimeManager.start()
      → PiExecution.start()
        → asyncio.create_subprocess_exec(node, pi-cli, --mode rpc, ...)
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `backend/app/workflows/pi_agent.py` | MAF Workflow 编排层，`GovernedPiToolExecutor` 定义 |
| `backend/app/pi_gateway.py` | `PiRuntimeManager`，进程管理 + Provider 网关 |
| `backend/app/pi_runtime.py` | `PiExecution`，子进程启动和 JSONL-RPC 通信 |

## 补充记录

（暂无）
