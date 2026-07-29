# pi 子进程在哪里启动

**归档日期**：2026-07-28
**分类**：执行层与pi运行时
**关联源码**：
- [backend/app/workflows/pi_agent.py](../../backend/app/workflows/pi_agent.py)
- [backend/app/pi_gateway.py](../../backend/app/pi_gateway.py)
- [backend/app/pi_runtime.py](../../backend/app/pi_runtime.py)

## 问题

找到我们调用执行层的地方，也就是在哪儿启动的 pi？

## 回答

pi 的启动调用链从外到内共 4 层：

### 1. MAF Workflow Executor 入口

`GovernedPiToolExecutor`（[pi_agent.py#L80](../../backend/app/workflows/pi_agent.py#L80)）是一个 MAF Workflow Executor。当用户发起一次 pi Agent 对话时，`start` handler（[#L130](../../backend/app/workflows/pi_agent.py#L130)）被调用，它从消息中提取用户任务，然后调用 `self._pi_tool.invoke()`。

```python
# pi_agent.py L127-128（链接：../../backend/app/workflows/pi_agent.py#L127）
async def _start_pi(self, task: str) -> PiExecution:
    return await self._manager.start(task, self._config)
```

### 2. PiRuntimeManager — 进程管理器

`PiRuntimeManager.start()`（[pi_gateway.py#L70](../../backend/app/pi_gateway.py#L70)，类定义在 [#L53](../../backend/app/pi_gateway.py#L53)）创建 `PiExecution` 对象，注册到进程管理器的 `_executions` 字典，然后调用 `execution.start()`。

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

`PiExecution.start()`（[pi_runtime.py#L508](../../backend/app/pi_runtime.py#L508)，类定义在 [#L442](../../backend/app/pi_runtime.py#L442)）是**实际启动 pi 子进程的地方**：

```python
# pi_runtime.py L629（链接：../../backend/app/pi_runtime.py#L629）
self.process = await asyncio.create_subprocess_exec(
    str(self.runtime.node_path),      # Node.js 可执行文件
    "--enable-source-maps",          # 让调试器映射回pi TypeScript源码
    str(self.runtime.cli_path),       # pi CLI 入口
    "--mode", "rpc",
    "--provider", "chat-governed",
    "--model", self.config.model,
    "--api-key", self.token,
    "--thinking", self.config.thinking_level,
    "--system-prompt", self.config.system_prompt,
    "--extension", str(extension_path),
    "--no-extensions", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files",
    "--session", str(self._pi_session.path),
    "--session-dir", str(self.runtime.session_directory),
    "--name", self._pi_session.name,
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
| [workflows/pi_agent.py](../../backend/app/workflows/pi_agent.py) | MAF Workflow 编排层，`GovernedPiToolExecutor` 定义 |
| [pi_gateway.py](../../backend/app/pi_gateway.py) | `PiRuntimeManager`，进程管理 + Provider 网关 |
| [pi_runtime.py](../../backend/app/pi_runtime.py) | `PiExecution`，子进程启动和 JSONL-RPC 通信 |

## 补充记录

### 2026-07-28：刷新代码路径为可点击链接

把全部文件引用改为相对路径链接（`../../backend/...`），IDE 中可直接点击跳转。逐项 grep 实测：原文全部行号（`_start_pi` L127、`start` handler L130、`PiRuntimeManager.start` L70、`PiExecution.start` L508、`create_subprocess_exec` L629）均未漂移，仍准确；另补充了类定义锚点（`GovernedPiToolExecutor` L80、`PiRuntimeManager` L53、`PiExecution` L442）。行号基于 2026-07-28 工作区，后续漂移时按符号名搜索定位。未改动任何说明文字。

### 2026-07-28：pi Session历史的准确边界

结论：**当前Chat为每个ToolExecution保留一份新的pi Runtime Session，但不自动续聊。**

证据是[PiExecution.start](../../backend/app/pi_runtime.py)先排他创建`chat-<tool_execution_id>`文件，
再显式传`--session/--session-dir/--name`。文件位于`~/.pi/agent/chat-sessions/`，进程结束后冻结为
当前用户只读，并把Session ID、ToolExecution/Product Run映射、字节数和SHA-256写入
`ToolExecution.metrics.pi_session`。绝对路径不进入Chat浏览器投影。

必须区分4种历史：

| 对象 | 当前是否持久 | 用途 |
|---|---|---|
| pi Runtime Session JSONL | 是，终态只读 | 查看本次pi收到的Prompt、回复和Tool消息；不是权威产品历史 |
| Product Session Message/Run/Trace | 是 | 用户可恢复的对话、运行事实和审计过程 |
| ModelCall/ToolExecution账本 | 是 | 每次Provider请求、Tool调用、结果、Hash和处置 |
| MAF Workflow Checkpoint | 主Workflow安全点已持久 | 恢复Workflow interrupt；不等于恢复已退出pi进程 |

为什么“保存但不续跑”：Chat需要一份可复核的执行层原始转录，但下一次执行仍必须从当前RunSpec、
Context Package和审批版本重新开始。若自动恢复旧pi Session，会形成第二套上下文选择和不可见的
Provider输入。pi-web因此只读展示Chat Session；本期不做继续、Fork、重命名或删除。

### 2026-07-28：进入pi源码调试

Chat私有运行配置已指向`/Users/xulater/Code/opc-os/pi`的0.82.1源码构建产物。运行
`scripts/build-local-pi.sh`可重新编译；把私有配置`node_debug_port`设为9230，必要时把
`node_debug_break`设为true，然后用VS Code的`Attach pi Source Runtime`即可在pi TypeScript源码断点。
