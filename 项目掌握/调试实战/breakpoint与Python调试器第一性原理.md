# breakpoint() 与 Python 调试器第一性原理

**归档日期**：2026-07-31

**分类**：调试实战

**定位**：从只会 C++ `gdb`/`int 3` 的视角，讲清 Python `breakpoint()` 在底层怎么工作、VS Code 怎么"接住"它、Chat 仓库里 30 个 `BP-XX` 编号断点对应到 [run_once_example.md](../00-从这里开始/run_once_example.md) 的哪一层。

**前置阅读**：[run_once_example.md](../00-从这里开始/run_once_example.md)（一次发送穿过哪些对象的 12 层架构）。

**配套中级文档**：[从断点停住到知道来路和下一跳.md](./从断点停住到知道来路和下一跳.md)（本文是它的 L1 基础版）。

## 问题

Chat 后端源码里散布着 30 个 `breakpoint()  # DEBUG-BREAKPOINT: BP-XX` 语句。从 C++ 转过来的程序员会问：

1. `breakpoint()` 在 Python 里到底做了什么？是 C++ 的 `int 3` 吗？
2. VS Code 怎么"接住"`breakpoint()`？为什么命令行 `python -m uvicorn ...` 启动时断点不生效？
3. `async def` 协程里的断点和同步函数断点有什么不同？
4. 源码里的 `breakpoint()` 和 IDE 红点断点有什么区别？为什么 Chat 要把断点写进源码？
5. BP-01 到 BP-30 这些编号代表什么？我该从哪个开始下断点？
6. BP-02 为什么会被注释掉？为什么文档说"初学者不要下 BP-02"？
7. 为什么 Worker 断点的 Call Stack 里看不到 React 代码？

## 回答

# 第 0 层：C++ 的断点 vs Python 的断点（第一性原理）

## C++ 里断点是怎么工作的

你写过 C++，应该熟悉这几种断点：

| 方式 | 底层机制 | 谁触发 |
|---|---|---|
| IDE 红点 | 调试器在对应地址插入 `0xCC`（x86 `int 3` 指令），CPU 执行到这条指令触发 SIGTRAP，OS 通知调试器 | 调试器运行时改内存 |
| `__builtin_trap()` | 编译器直接生成中断指令，不依赖调试器 | 源码 |
| `assert(...)` | 失败时调 `abort()` 发 SIGABRT | 源码 |

**核心**：C++ 断点本质是"让 CPU 执行到某条指令时触发一个信号，OS 把进程暂停，调试器接管"。

## Python 里 `breakpoint()` 是怎么工作的

Python 不是编译型语言，没有"在地址插 `0xCC`"这一步。Python 的断点是**解释器主动调用钩子函数**：

```python
# 源码里写
def some_function():
    breakpoint()    # ← 这一行
    do_something()
```

CPython 解释器执行到 `breakpoint()` 时，等价于：

```python
import sys
sys.breakpointhook()    # ← 实际调的是这个
```

**`sys.breakpointhook` 是什么**：Python 内置的一个"可替换的钩子函数"。默认实现是：

```python
# Python 标准库默认行为（伪代码）
def breakpointhook(*args, **kwargs):
    import pdb
    pdb.set_trace()
```

所以"不配置任何环境变量、直接命令行 `python xxx.py`"时，`breakpoint()` 会进入 `pdb`（Python 自带的命令行调试器）。

## `PYTHONBREAKPOINT` 环境变量

Python 允许你用环境变量替换 `breakpointhook`：

```bash
# 完全禁用 breakpoint()（让它变成 no-op）
PYTHONBREAKPOINT=0 python -m uvicorn backend.app.asgi:app

# 用 web-pdb（远程调试）
PYTHONBREAKPOINT=web_pdb.set_trace python ...

# 用 debugpy（VS Code 接管时默认就是这个）
PYTHONBREAKPOINT=debugpy.breakpoint python ...
```

**关键**：`breakpoint()` 不是"CPU 中断"，是"Python 解释器调一个钩子函数"。钩子函数是谁，由 `PYTHONBREAKPOINT` 环境变量决定。

C++ 类比：像 C++ 里你写 `raise(SIGTRAP)`，但信号处理函数可以被替换。默认是 OS 默认行为，你也可以注册自己的 handler。

---

# 第 1 层：VS Code 怎么"接住" `breakpoint()`

## 问题：命令行启动为什么断点不生效

如果你直接在终端跑：

```bash
.venv/bin/python -m uvicorn backend.app.asgi:app
```

然后浏览器发消息，源码里的 `breakpoint()` 会触发 `pdb.set_trace()`，终端进入 `pdb` 命令行交互模式。**VS Code 的红点和变量查看器完全不生效**。

为什么？因为 VS Code 调试器和 Python 进程之间**没有建立调试通道**。

## debugpy 是什么

**debugpy**（第三方库，被 VS Code Python 扩展默认使用）是一个**调试协议适配器**。它做两件事：

1. 在 Python 进程里启动一个 DAP（Debug Adapter Protocol）服务端，监听一个端口。
2. VS Code 作为 DAP 客户端连接这个端口，通过协议消息交换"断点位置、变量值、继续执行"等信息。

**流程**：

```
VS Code UI  <-->  VS Code Python 扩展  <-->  debugpy（Python 进程内）  <-->  Python 解释器
   ↑                    ↑                                              ↓
   红点/变量/调用栈     DAP 协议消息                          sys.settrace 拦截每行执行
```

## VS Code 启动配置怎么把 debugpy 注入

看 [.vscode/launch.json](../../.vscode/launch.json) 第一个配置：

```json
{
  "name": "Chat Backend (MAF + FastAPI)",
  "type": "debugpy",           // ← 告诉 VS Code 用 debugpy
  "request": "launch",          // ← launch 模式：VS Code 启动 Python 进程
  "module": "uvicorn",
  "args": ["backend.app.asgi:app", "--host", "127.0.0.1", "--port", "18030", "--reload"],
  "python": "${workspaceFolder}/.venv/bin/python",
  "justMyCode": false           // ← 允许进入第三方库源码
}
```

`"type": "debugpy"` 让 VS Code Python 扩展在启动 Python 进程时：

1. 注入 debugpy 的 sitecustomize。
2. 设置 `PYTHONBREAKPOINT=debugpy.breakpoint`（让 `breakpoint()` 调 debugpy 的钩子，不是 pdb）。
3. 建立 DAP 通道，VS Code 能接收断点事件、发送继续指令、查询变量。

**所以**：VS Code 启动 Python 时，源码里的 `breakpoint()` 会变成"通知 VS Code 暂停"而不是"进入 pdb"。命令行启动没有这个注入，就只会进入 pdb。

C++ 类比：像 GDB 启动子进程时用 `ptrace(PTRACE_TRACEME)` 建立跟踪关系；VS Code + debugpy 用 DAP 协议建立类似关系。

---

# 第 2 层：IDE 红点 vs 源码 `breakpoint()` 的区别

Chat 同时存在两种断点。它们的区别：

| 维度 | IDE 红点断点 | 源码 `breakpoint()` |
|---|---|---|
| 怎么下 | VS Code 行号左边点一下 | 在源码里写 `breakpoint()` |
| 存在哪 | VS Code workspace 设置（不进 git） | 源码文件（进 git） |
| 可单独启停 | 是（右键 Disable/Enable） | 否（要么删注释，要么设 `PYTHONBREAKPOINT=0`） |
| 跨电脑同步 | 否 | 是（git pull 就有） |
| 适合场景 | 临时调试某一行 | 教学入口、稳定链路节点 |

## Chat 为什么要把断点写进源码

Chat 把 30 个 `breakpoint()` 写进源码，不是为生产，是为**教学**：

1. **链路节点稳定**：BP-01 永远是 HTTP 接纳入口，BP-07 永远是 `ProductAwareWorkflow.run`，不依赖开发者记得在哪下红点。
2. **跨电脑一致**：你换台电脑 git clone，断点位置和文档描述完全对得上。
3. **配套注释教学**：每个 `breakpoint()` 上面都有 `DEBUG-BREAKPOINT-NOTE` 注释，说明触发条件、频率、跨边界关系、对应文档章节。

但代价是：

1. **生产必须禁用**：通过 `PYTHONBREAKPOINT=0` 让 `breakpoint()` 变 no-op，否则 `pdb` 会卡住进程。
2. **不灵活**：不能像红点一样临时启用一个、关闭其他。Chat 用 `"Chat Full Stack (with Breakpoints)"` 启动配置专门处理。

C++ 类比：像你把 `assert(...)` 写进源码，靠 `NDEBUG` 宏开关。Python 用 `PYTHONBREAKPOINT` 环境变量开关。

## Chat 有专门的"带断点"启动配置

[.vscode/launch.json](../../.vscode/launch.json) 第 131-139 行有一个 compound 配置：

```json
{
  "name": "Chat Full Stack (with Breakpoints)",
  "configurations": ["Chat Backend (MAF + FastAPI)", "Chat Frontend (React + Vite)"],
  "preLaunchTask": "chat: prepare full stack with breakpoints",
  "postDebugTask": "chat: cleanup full stack with breakpoints"
}
```

`preLaunchTask` 会运行 [tasks.json](../../.vscode/tasks.json) 里的 `chat: prepare full stack with breakpoints` 任务，把源码里被注释的 `breakpoint()` 取消注释。`postDebugTask` 会清理。

普通启动用 `"Chat Full Stack"`，不带断点。

---

# 第 3 层：`async def` 协程里的断点和同步函数有什么不同

Chat 大量代码是 `async def`。在协程里下断点，有几个和同步函数不一样的地方。

## 同步函数断点

```python
def foo():
    breakpoint()    # 停在这
    x = 1
```

执行到 `breakpoint()` 时，整个进程暂停，VS Code 显示当前栈。**只有一个执行流**。

## async 协程断点

```python
async def foo():
    breakpoint()    # 停在这
    x = 1
```

**关键区别**：Python 进程里同时有多个协程在事件循环里交替执行。当 `foo` 协程执行到 `breakpoint()` 时：

1. **当前协程暂停**，VS Code 显示 `foo` 的栈。
2. **事件循环本身也暂停了**（因为 `breakpoint()` 是同步阻塞调用，不会 `await` 让出控制权）。
3. **其他协程也跟着暂停**（因为它们都靠事件循环调度，事件循环不转它们就不能跑）。

**这有什么影响**：

- 你在 BP-01 `durable_agent_endpoint` 断点停住时，**Worker 的 `execution_loop` 协程也暂停了**（它不能继续轮询 Journal）。
- 这意味着：你点 Continue 之前，Worker 不会领 Job、不会跑 Agent、不会写事件。整个系统冻在你停的那一行。

**为什么这样设计是合理的**：因为你想调试当前请求的链路，如果 Worker 在你调试时继续跑别的请求，变量会乱、Trace 会混。冻结整个事件循环让你专心看当前栈。

C++ 类比：像单线程 GDB 断点，整个进程暂停，没有其他线程同时跑。Python asyncio 是单线程协作式调度，断点天然就是全局冻结。

## 多协程同时命中断点会怎样

如果 BP-01（HTTP 接纳）和 BP-03（Worker 执行）同时命中（比如你下了这两个断点，两条请求同时到）：

- VS Code 会显示**多个暂停的协程**。
- 你可以在 "CALL STACK" 面板里切换看哪个。
- 一个一个 Continue，不会互相干扰。

但实操中第一遍调试不要下太多断点，会乱。

---

# 第 4 层：Chat 的 BP-01..BP-30 编号体系全景

Chat 在源码里注入了 30 个断点，编号 BP-01 到 BP-30。按"链路位置 + 触发频率"分四组。

## 4 组断点分布

| 组 | 编号 | 位置 | 触发频率 | 适合谁 |
|---|---|---|---|---|
| **前端** | BP-27, BP-28, BP-29, BP-30 | `frontend/src/` | 用户每次操作 1 次 | 入门首选 |
| **HTTP 接纳** | BP-01 | `runtime_execution/endpoint.py` | 每条用户消息 1 次 | **首选后端入口** |
| **Worker 领取与执行** | BP-02（已注释）、BP-03、BP-07 | `runtime_execution/worker.py`、`workflows/runtime.py` | 每个待处理 Job 1 次 | 想看 Worker 怎么跑 Agent |
| **Product 事实写入** | BP-04、BP-05、BP-06 | `product_sessions/service.py` | 新 Run 触发 2 次 | 想看 Product Store 怎么写 |
| **Workflow 节点** | BP-08 到 BP-19 | `workflows/continuous_chat.py` | 每个 Workflow 节点 1 次 | 跑通主链路后深入 39 节点 |
| **治理与外发** | BP-20 到 BP-26 | `harness/service.py`、`execution_dispatch/`、`pi_runtime.py`、`pi_gateway.py` | 模型调用/pi 执行时 | 看模型审批、Tool 治理 |

## BP 编号和 run_once_example.md 12 层对应表

| run_once_example 层 | 对应 BP | 含义 |
|---|---|---|
| 第 0 层：Python 进程启动 | （无 BP） | Uvicorn 加载 app |
| 第 1 层：前端 React 发 HTTP | **BP-27**（App.submit）、**BP-28**（useChatAgent.send） | 浏览器栈 |
| 第 2 层：Uvicorn -> FastAPI | （无 BP） | 框架内部 |
| 第 3 层：durable_agent_endpoint | **BP-01** | HTTP 接纳入口 |
| 第 4 层：prepare_agui_run | **BP-04** | Product Store 写入 |
| 第 5 层：runtime.enqueue | （无 BP） | Runtime Job 入队 |
| 第 6 层：SSE event_stream | （无 BP） | 流式读 Journal |
| 第 7 层：Worker 登场 | **BP-02**（注释）、**BP-03**（_execute_claim） | Worker 领 Job |
| 第 8 层：Lifespan 启动 Worker | （无 BP） | 进程启动钩子 |
| 第 9 层：asyncio | （无 BP） | 事件循环（概念层） |
| 第 10 层：run_once | **BP-02**（注释，热点） | Worker 单次循环 |
| 第 11 层：_execute -> MAF | **BP-07**（ProductAwareWorkflow.run） | 跑 Agent |
| 第 12 层：Journal -> SSE -> 浏览器 | **BP-29**（RunFinished 回程） | 事件回浏览器 |

## BP-02 为什么被注释掉

[worker.py:181](../../backend/app/runtime_execution/worker.py#L181)：

```python
# breakpoint()  # DEBUG-BREAKPOINT: BP-02
```

BP-02 是 `run_once` 的断点。但 `run_once` 在 [lifecycle.py](../../backend/app/lifecycle.py) 的 `execution_loop` 里被 `while True: ... asyncio.sleep(0.08)` 反复调用，**应用一启动就每 80ms 命中一次**，即使没有用户消息也会命中。

如果启用 BP-02：

- VS Code 会不停暂停在 `run_once` 第一行。
- 你点 Continue，0.08 秒后又暂停。
- 你根本走不到 BP-04 / BP-07，因为一直被 BP-02 打断。

所以源码里默认注释掉，文档里反复强调"初学者应跳过此断点，改用 BP-03"（BP-03 在 `_execute_claim` 里，只有真正领到 Job 才触发）。

如果你想看 `run_once` 的执行流，临时取消注释即可，但调试完记得注释回去。

---

# 第 5 层：第一次调试 Chat 的实操（推荐顺序）

## 5.1 启动配置

VS Code 左侧 Debug 面板，下拉选择 **"Chat Full Stack"**（不带断点的版本，避免 BP-02 之类干扰），按 F5。

如果你想启用所有源码 `breakpoint()`，选 **"Chat Full Stack (with Breakpoints)"**，它的 `preLaunchTask` 会自动取消注释所有 `breakpoint()`。

## 5.2 推荐调试链路（BP-27 -> BP-01 -> BP-04 -> BP-03 -> BP-07 -> BP-29）

完整追一条用户消息从前端到后端到回程，按这个顺序下断点：

```
[前端]                    [后端]
BP-27 App.submit
   │ 用户点击发送
   ▼
BP-28 useChatAgent.send
   │ fetch POST ─────────────► BP-01 durable_agent_endpoint
   │                              │ HTTP 接纳入口
   │                              ▼
   │                            BP-04 prepare_agui_run
   │                              │ Product Store 写 Message/Run/Attempt
   │                              ▼
   │                            （runtime.enqueue 入队，无 BP）
   │                              │
   │ ◄────── SSE 返回 ──────────────┘
   │
   │ （Worker 协程独立运行）
   │                              ▼
   │                            BP-03 _execute_claim
   │                              │ Worker 领到 Job
   │                              ▼
   │                            BP-07 ProductAwareWorkflow.run
   │                              │ 跑 MAF Agent
   │                              ▼
   │                            （MAF -> 大模型 -> 事件 yield）
   │                              │ 写 Journal
   │ ◄────── SSE 帧推送 ──────────┘
   ▼
BP-29 onRunFinished
   │ React 更新 UI
```

## 5.3 每个断点要看什么

| BP | 位置 | 文件 | 停住后看什么变量 | 按什么键 |
|---|---|---|---|---|
| BP-27 | [App.tsx:407](../../frontend/src/App.tsx#L407) | 前端 | `draft`（用户输入）、`activeSession`、`selectedWorkflow` | Step Into 进 BP-28，或 Continue |
| BP-28 | [use-chat-agent.ts:236](../../frontend/src/use-chat-agent.ts#L236) | 前端 | `content`、`messageId`、`runId`、`agent.url` | Continue 到后端 BP-01 |
| BP-01 | [endpoint.py:82](../../backend/app/runtime_execution/endpoint.py#L82) | 后端 | `request_body`（AGUIRequest）、`input_data`（dict） | Step Into 进 BP-04 |
| BP-04 | [service.py:695](../../backend/app/product_sessions/service.py#L695) | 后端 | `session_id`、`agui_run_id`、`incoming`、`existing_protocol` | Step Over 跑完事务，返回 BP-01 |
| BP-03 | [worker.py:258](../../backend/app/runtime_execution/worker.py#L258) | 后端 | `claim.job_id`、`claim.product_run_id`、`claim.lease_epoch`、`claim.input_data` | Step Over 到 `runner.run`，Continue 到 BP-07 |
| BP-07 | [runtime.py:145](../../backend/app/workflows/runtime.py#L145) | 后端 | `input_data`、`thread_id`、`agui_run_id` | Continue 到场景 Executor |
| BP-29 | [use-chat-agent.ts:169](../../frontend/src/use-chat-agent.ts#L169) | 前端 | `nextMessages`、`result.outcome` | Step Over 看 React 重渲染 |

## 5.4 跨边界时的关键接力棒

当你在 BP-01 停住，看完后 Continue，会进入 BP-04。但 BP-03 不一定马上命中--因为 Worker 是独立协程，要等 `claim_one` 才能领到 Job。

如果 BP-03 不命中，**不要怀疑断点坏了**。在 BP-04 停住时，记录 `accepted.product_run_id`，然后 Continue 几次，BP-03 会命中，对比 `claim.product_run_id` 是否一致。

跨边界时用这些 ID 串联：

| 边界 | 上游 | 下游 | 关联 ID |
|---|---|---|---|
| 浏览器 -> FastAPI | BP-28 | BP-01 | `threadId` + AG-UI `runId` |
| HTTP 接纳 -> Worker | BP-04 | BP-03 | `product_run_id` + `runtime_job_id` |
| Worker -> MAF | BP-03 | BP-07 | `product_run_id` + `endpoint_key` |
| Worker -> 浏览器 | BP-07 | BP-29 | `runtime_job_id` + event `sequence` |

---

# 第 6 层：常见困惑

## 6.1 BP-02 为什么会刷屏

[worker.py:181](../../backend/app/runtime_execution/worker.py#L181) 的 `run_once` 在 [lifecycle.py:111-121](../../backend/app/lifecycle.py#L111-L121) 的 `execution_loop` 里被反复调用，每 0.08 秒一次。如果取消注释 BP-02 的 `breakpoint()`：

- 应用一启动就暂停。
- 你点 Continue，0.08 秒后又暂停。
- 没用户消息也一样（`claim_one` 返回 None，`run_once` 返回 False，外层 sleep 0.08 秒又调）。

**正确做法**：BP-02 保持注释，看 Worker 用 BP-03（`_execute_claim`，只有真领到 Job 才命中）。

## 6.2 为什么 Worker 断点的 Call Stack 里没有 React

```
你下 BP-03，发消息，断点命中。
你展开 VS Code 的 CALL STACK 面板，期望看到：
  App.submit -> useChatAgent.send -> durable_agent_endpoint -> ... -> _execute_claim

实际看到：
  execution_loop -> run_once -> _execute
```

为什么 React 代码不在调用栈里？因为**前端和后端是两个进程**（浏览器进程 + Python 进程），中间隔着 HTTP 网络。Worker 是被 Lifespan 启动的 `execution_loop` 协程驱动的，和 HTTP 请求处理协程是**两个独立的协程**，它们通过数据库表（Runtime Job）传递信息。

C++ 类比：像你写两个进程，进程 A 通过 pipe 发消息给进程 B，进程 B 在 `read()` 等待时被 GDB 断点停住。进程 B 的调用栈里只有它自己的代码，不会有进程 A 的 `main`。

## 6.3 断点不生效怎么办

排查清单：

1. **是否用 VS Code 启动**：命令行 `python -m uvicorn ...` 启动时 `breakpoint()` 进入 pdb，VS Code 红点不生效。
2. **是否选了正确的启动配置**：Debug 面板下拉必须是 "Chat Backend (MAF + FastAPI)" 或带断点的 compound。
3. **`PYTHONBREAKPOINT` 是否被设为 0**：检查调试进程的环境变量；`PYTHONBREAKPOINT=0` 会让所有 `breakpoint()` 变 no-op。
4. **BP-02 是否被注释**：BP-02 默认是注释的，[worker.py:181](../../backend/app/runtime_execution/worker.py#L181)。
5. **`justMyCode` 设置**：launch.json 里 `"justMyCode": false` 才能进入第三方库源码（FastAPI/MAF）。
6. **前端 `debugger;` 需要打开 DevTools**：浏览器 F12 打开 DevTools 才会命中 `debugger;` 语句。

## 6.4 生产环境怎么禁用断点

设置环境变量 `PYTHONBREAKPOINT=0`，所有 `breakpoint()` 调用变成 no-op（什么也不做）。前端 `debugger;` 只在 DevTools 打开时才触发，关闭 DevTools 就等于禁用。

Chat 的生产部署配置应该包含 `PYTHONBREAKPOINT=0`。

---

# 第 7 层：30 个断点完整清单

按链路顺序排列。`#` 列是 [从断点停住到知道来路和下一跳.md](./从断点停住到知道来路和下一跳.md) 第 3 节动态调用表的编号。

| # | BP | 文件:行 | 符号 | 触发频率 | 说明 |
|---|---|---|---|---|---|
| 1 | BP-27 | [App.tsx:407](../../frontend/src/App.tsx#L407) | `App.submit` | 用户每次点击 1 次 | 浏览器栈入口 |
| 2 | BP-28 | [use-chat-agent.ts:236](../../frontend/src/use-chat-agent.ts#L236) | `useChatAgent.send` | 用户每次发送 1 次 | 跨网络边界前最后 JS 栈 |
| 3 | BP-01 | [endpoint.py:82](../../backend/app/runtime_execution/endpoint.py#L82) | `durable_agent_endpoint` | 每条用户消息 1 次 | HTTP 接纳入口 |
| 4a | BP-04 | [service.py:695](../../backend/app/product_sessions/service.py#L695) | `prepare_agui_run` 第 1 次 | 新 Run 2 次 | Product Run 创建 |
| 5 | （无） | service.py | `RuntimeExecutionService.enqueue` | 每条消息 1 次 | Runtime Job 入队 |
| 6 | BP-02 | [worker.py:181](../../backend/app/runtime_execution/worker.py#L181) | `run_once` | 每 0.08s 1 次（频繁） | **已注释，初学者勿启用** |
| 7 | BP-03 | [worker.py:258](../../backend/app/runtime_execution/worker.py#L258) | `_execute_claim` | 每个 Job 1 次 | Worker 真正领到 Job |
| 8 | BP-07 | [runtime.py:145](../../backend/app/workflows/runtime.py#L145) | `ProductAwareWorkflow.run` | 每个 Job 1 次 | Product 生命周期包住 MAF |
| 4b | BP-04 | service.py:695 | `prepare_agui_run` 第 2 次 | 新 Run 2 次 | 幂等复核原 Run |
| 9 | BP-08 | [continuous_chat.py:211](../../backend/app/workflows/continuous_chat.py#L211) | Executor | 每节点 1 次 | Workflow 39 节点分支 |
| 9 | BP-09 | [continuous_chat.py:328](../../backend/app/workflows/continuous_chat.py#L328) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-10 | [continuous_chat.py:401](../../backend/app/workflows/continuous_chat.py#L401) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-11 | [continuous_chat.py:489](../../backend/app/workflows/continuous_chat.py#L489) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-12 | [continuous_chat.py:1000](../../backend/app/workflows/continuous_chat.py#L1000) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-13 | [continuous_chat.py:1442](../../backend/app/workflows/continuous_chat.py#L1442) | Executor | 每节点 1 次 | 模型调用治理入口 |
| 9 | BP-14 | [continuous_chat.py:1496](../../backend/app/workflows/continuous_chat.py#L1496) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-15 | [continuous_chat.py:1970](../../backend/app/workflows/continuous_chat.py#L1970) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-16 | [continuous_chat.py:2274](../../backend/app/workflows/continuous_chat.py#L2274) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-17 | [continuous_chat.py:2331](../../backend/app/workflows/continuous_chat.py#L2331) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-18 | [continuous_chat.py:2744](../../backend/app/workflows/continuous_chat.py#L2744) | Executor | 每节点 1 次 | 同上 |
| 9 | BP-19 | [continuous_chat.py:2869](../../backend/app/workflows/continuous_chat.py#L2869) | Executor | 每节点 1 次 | 同上 |
| 10 | BP-05 | [service.py:981](../../backend/app/product_sessions/service.py#L981) | `complete_active_run` | 每个 Run 1 次 | 最终 Product 事实提交门 |
| 11 | BP-06 | [service.py:1192](../../backend/app/product_sessions/service.py#L1192) | （其他 Product 提交） | 视场景 | Product 事实补充提交 |
| 11 | BP-20 | [harness/service.py:1621](../../backend/app/harness/service.py#L1621) | Harness Service | 视场景 | Harness 治理 |
| 11 | BP-21 | [continuous_chat_contracts.py:357](../../backend/app/workflows/continuous_chat_contracts.py#L357) | 合约 | 视场景 | Workflow 合约 |
| 11 | BP-22 | [execution_dispatch/contracts.py:157](../../backend/app/execution_dispatch/contracts.py#L157) | Dispatch 合约 | 模型派发时 | 外发派发门 |
| 11 | BP-23 | [execution_dispatch/drafts.py:187](../../backend/app/execution_dispatch/drafts.py#L187) | Draft 处理 | 模型调用审批 | ModelCallDraft 治理 |
| 11 | BP-24 | [pi_gateway.py:104](../../backend/app/pi_gateway.py#L104) | pi Gateway | pi 执行时 | 本机网关 |
| 11 | BP-25 | [pi_runtime.py:562](../../backend/app/pi_runtime.py#L562) | pi Runtime | pi 执行时 | pi 子进程 RPC |
| 11 | BP-26 | [pi_runtime.py:745](../../backend/app/pi_runtime.py#L745) | pi Runtime | pi 执行时 | pi 子进程事件 |
| 11 | BP-29 | [use-chat-agent.ts:169](../../frontend/src/use-chat-agent.ts#L169) | `onRunFinished` | 每个 Run 完成 1 次 | 回程第一段 JS 栈 |
| 11 | BP-30 | [use-runtime-reconnect.ts:96](../../frontend/src/features/chat/use-runtime-reconnect.ts#L96) | Reconnect | 断线重连时 | SSE 重连 |

## 推荐组合

按你的学习阶段选组合：

| 阶段 | 启用 | 目的 |
|---|---|---|
| **第一次跑通主链路** | BP-01、BP-04、BP-03、BP-07 | 看 HTTP->Product Store->Worker->MAF |
| **看前端链路** | BP-27、BP-28、BP-29 | 看浏览器栈 |
| **深入 Workflow 节点** | BP-08..BP-19 | 看 39 节点分支 |
| **看模型治理** | BP-13、BP-14、BP-15、BP-23 | 看 ModelCallDraft 审批 |
| **看 pi 执行** | BP-22..BP-26 | 看 pi 子进程 |
| **看崩溃恢复** | BP-05、BP-06、BP-07 | 看 Reconciler 和终态 |

第一遍调试**只下 BP-01、BP-04、BP-03、BP-07** 这 4 个，跑通一条用户消息的完整链路，不要一次启用全部。

---

# 第 8 层：调试器三个按钮的精确含义

VS Code Debug 工具栏有三个核心按钮，在 Chat 调试中用法不同：

| 按钮 | 快捷键 | 含义 | Chat 何时用 |
|---|---|---|---|
| Continue | F5 | 跑到下一个断点 | 跨网络、跨协程、跨大量框架代码 |
| Step Over | F10 | 执行当前行，不进函数内部 | 跑 SQLAlchemy 事务、Pydantic 解析、MAF 内部 |
| Step Into | F11 | 进入当前行调用的函数 | 只在 Chat 自研边界用（如 `prepare_agui_run`、`runtime.enqueue`） |
| Step Out | Shift+F11 | 跑出当前函数返回调用方 | 不小心进了框架内部想退出 |

## 重要区别：跨边界时不能 Step Into

| 跨边界 | 上游函数 | 下游函数 | 为什么 Step Into 不行 |
|---|---|---|---|
| 浏览器 -> FastAPI | `useChatAgent.send` | `durable_agent_endpoint` | 中间隔 HTTP 网络，是两个进程 |
| HTTP -> Worker | `runtime.enqueue` | `_execute_claim` | 中间隔数据库表，是两个协程 |
| Worker -> MAF 节点 | `runner.run` | Executor handler | 这是 Chat 自研边界，**可以 Step Into** |

跨进程/跨协程边界时只能用 Continue，然后等下游断点命中。靠**稳定关联 ID**（`product_run_id`、`runtime_job_id`）确认是同一条链路。

---

## 关键文件

| 文件 | 文件类型 | 主要责任 |
|---|---|---|
| [.vscode/launch.json](../../.vscode/launch.json) | VS Code 启动配置 | 6 个调试配置 + 4 个 compound |
| [.vscode/tasks.json](../../.vscode/tasks.json) | VS Code 任务 | 启动前后清理、断点启用/禁用 |
| [backend/app/runtime_execution/endpoint.py](../../backend/app/runtime_execution/endpoint.py) | 后端入口 | BP-01 |
| [backend/app/runtime_execution/worker.py](../../backend/app/runtime_execution/worker.py) | Worker | BP-02（注释）、BP-03 |
| [backend/app/product_sessions/service.py](../../backend/app/product_sessions/service.py) | Product Store | BP-04、BP-05、BP-06 |
| [backend/app/workflows/runtime.py](../../backend/app/workflows/runtime.py) | Workflow 包装 | BP-07 |
| [backend/app/workflows/continuous_chat.py](../../backend/app/workflows/continuous_chat.py) | 39 节点 Workflow | BP-08..BP-19 |
| [backend/app/execution_dispatch/](../../backend/app/execution_dispatch/) | 派发与 Draft | BP-22、BP-23 |
| [backend/app/pi_runtime.py](../../backend/app/pi_runtime.py) | pi 子进程 | BP-25、BP-26 |
| [backend/app/pi_gateway.py](../../backend/app/pi_gateway.py) | pi 网关 | BP-24 |
| [frontend/src/App.tsx](../../frontend/src/App.tsx) | 前端入口 | BP-27 |
| [frontend/src/use-chat-agent.ts](../../frontend/src/use-chat-agent.ts) | AG-UI Hook | BP-28、BP-29 |
| [frontend/src/features/chat/use-runtime-reconnect.ts](../../frontend/src/features/chat/use-runtime-reconnect.ts) | 断线重连 | BP-30 |
| [backend/tests/test_debug_breakpoints_tool.py](../../backend/tests/test_debug_breakpoints_tool.py) | 断点注入工具测试 | 验证断点启用/禁用脚本 |

## 掌握验收

### 复述题

1. Python `breakpoint()` 和 C++ 的 `int 3` 在底层有什么本质区别？
2. 为什么命令行 `python -m uvicorn ...` 启动时，源码里的 `breakpoint()` 会进入 pdb 而不是被 VS Code 接住？
3. VS Code 启动 Python 时 `"type": "debugpy"` 做了什么？
4. `async def` 里的 `breakpoint()` 触发时，事件循环和其他协程会发生什么？为什么这样设计是合理的？
5. 源码 `breakpoint()` 和 IDE 红点断点有什么区别？Chat 为什么要把断点写进源码？
6. `PYTHONBREAKPOINT=0` 做了什么？生产为什么要设置它？
7. BP-02 为什么被注释掉？如果想看 Worker 单次循环怎么办？
8. 在 BP-03（`_execute_claim`）的 Call Stack 里为什么看不到 `App.submit`？

### 定位与修改题

1. 想看一条用户消息从浏览器到 Worker 的完整链路，第一次调试应该启用哪 4 个 BP？
2. BP-01 命中后，怎么确认这次请求和 BP-03 命中的是同一条链路？用什么 ID 串联？
3. 如果 VS Code 断点不生效，按什么顺序排查？
4. 如果想看 Workflow 的 39 个节点分支，应该启用哪些 BP？为什么第一遍调试不要启用？

能独立回答这些问题，并在断点中亲眼看到一条用户消息穿过 4 段调用栈，才算完成后端调试 L1。

## 补充记录

- 2026-07-31：首版，从 C++ 程序员视角讲清 `breakpoint()` 底层机制、VS Code debugpy 接管、协程断点行为、Chat BP-01..BP-30 体系。配套中级文档 [从断点停住到知道来路和下一跳.md](./从断点停住到知道来路和下一跳.md)。
