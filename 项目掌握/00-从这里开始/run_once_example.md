用一个具体例子贯穿：**用户在浏览器敲"帮我写个 Hello World"，到看到回复**。每出现一个概念就解释，用 C++ 类比。

阅读前先记住一个核心切分：

| 切分 | 前端（frontend/） | 后端（backend/app/） |
|---|---|---|
| 运行在哪里 | 浏览器进程 | Python 进程（Uvicorn） |
| 语言 | TypeScript / TSX | Python |
| 我们写的 | `frontend/src/` 全部 React 组件、Hooks、API Client | `backend/app/` 全部 Product/Runtime/Worker 业务代码 |
| 第三方框架 | React 19、Vite、`@ag-ui/client`、`@ag-ui/core` | FastAPI、Uvicorn、Pydantic、SQLAlchemy、MAF |
| 不写但跑在进程里 | （无） | ASGI、Starlette（FastAPI 底层） |

**判断"框架 vs 自研"的方法**：看 import。`from fastapi import ...` 是框架，`from ..product_sessions.service import ...` 是自研。

---

# 第 0 层：你写的东西和正在跑的东西

你写过 C++，应该熟悉这条链：

```cpp
// 源码 .cpp
g++ main.cpp -o app
./app        // OS fork 出进程，加载可执行文件，从 main() 开始执行
```

Python 类似但少了"显式编译"这一步：

```python
# 源码 .py
python main.py    # CPython 解释器直接执行源码，顶层语句从上到下跑
```

`.venv/bin/python -m uvicorn backend.app.asgi:app` 的意思是：CPython 解释器运行 `uvicorn` 这个包，`uvicorn` 再去 `import backend.app.asgi` 这个模块，取出里面叫 `app` 的对象。

**`app` 是什么？** 是一个 FastAPI 实例对象，是 [backend/app/main.py::create_app](../../backend/app/main.py) 构造出来的自研对象。类似 C++ 里：

```cpp
class FastAPI { /* 路由表、中间件、配置... */ };
FastAPI app = create_app();   // 构造一个对象
```

但"构造对象"和"能接网络请求"是两回事。往下看。

---

## 阶段流程图 A：从敲键盘到后端进程入口

```
[浏览器进程]                          [服务器 Python 进程]
用户敲键盘
   │
   │ React onChange 更新输入框状态
   │ 用户点"发送"按钮
   ▼
React 组件调 sendMessage()
   │
   │ chat-agent-client.ts 创建 HttpAgent（@ag-ui/client 框架）
   │ HttpAgent 内部 fetch POST 到 http://127.0.0.1:18030/...
   ▼
─────────────────────────────────────────────────────────  ← 网络边界
   ▼
Uvicorn（第三方网络服务器）
   │ socket 收到 HTTP 字节
   │ 按 ASGI 协议包装成 scope 字典
   ▼
FastAPI（第三方 Web 框架）
   │ 查路由表：POST /api/agents/continuous-chat/runs -> durable_agent_endpoint
   │ 用 Pydantic 把 JSON body 解析成 AGUIRequest 对象
   ▼
durable_agent_endpoint（自研代码，endpoint.py:62）
```

---

# 第 1 层：前端 React 发了一个 HTTP 请求

用户在浏览器输入框敲"帮我写个 Hello World"，点发送。前端实际代码（自研 + 框架）：

**自研：**[frontend/src/features/chat/chat-agent-client.ts](../../frontend/src/features/chat/chat-agent-client.ts)

```typescript
import { HttpAgent } from "@ag-ui/client";        // ← 第三方框架
import { authenticatedFetch } from "../../authentication-recovery.js";  // ← 自研

export function createChatHttpAgent(): HttpAgent {
  return new HttpAgent({
    url: AG_UI_URL,            // 指向后端 AG-UI 端点
    threadId: createClientId(),
    description: "独立 AI 协作 Chat 产品",
    fetch: authenticatedFetch, // 用我们包装的 fetch（带认证）
  });
}
```

**自研：**[frontend/src/use-chat-agent.ts](../../frontend/src/use-chat-agent.ts) 调 `agent.runAgent(messages)` 触发 HTTP POST。

`HttpAgent` 是 `@ag-ui/client` 框架提供的，它内部会 `fetch` 一个 POST 请求，body 长这样：

```json
{
  "threadId": "thread-abc-123",
  "runId": "run-xyz-789",
  "messages": [
    { "role": "user", "content": "帮我写个 Hello World", "id": "msg-001" }
  ]
}
```

**概念解释**：

- **HTTP POST**：一种网络协议。浏览器发一段字节到服务器某个 URL，服务器返回一段字节。类似你写过的 socket 程序，但有固定格式（方法、路径、headers、body）。
- **JSON**：用文本表示结构化数据的格式。上面的 body 就是一段 JSON 文本。
- **18030 端口**：服务器上 65535 个端口中的一个。Uvicorn 进程"占住"这个端口，浏览器往这个端口发数据，OS 就交给 Uvicorn。
- **`HttpAgent`**：`@ag-ui/client` 框架提供的类。你 new 一个实例，调它的方法，它帮你 fetch 一个 AG-UI 协议的 HTTP 请求。**它是框架，不是我们写的**，我们只配置 `url`、`threadId`、`fetch` 三个参数。

C++ 类比：`HttpAgent` 像一个第三方库的 `HttpClient` 类，你 `HttpClient client(url); client.post(body);`。

---

# 第 2 层：Uvicorn 接到字节，交给 FastAPI

字节进到服务器：

```
浏览器 -> TCP -> Uvicorn -> ASGI -> FastAPI -> 你的函数
```

**Uvicorn 是什么（第三方）**：一个网络服务器程序，负责 `socket/bind/listen/accept`。它把收到的 HTTP 字节解析成一个叫 `scope` 的字典，然后调用你的 Python 应用对象。

**ASGI 是什么（协议标准）**：Uvicorn 和 FastAPI 之间的"合同"。Uvicorn 不直接调你的函数，而是按 ASGI 协议调：

```python
await app(scope, receive, send)
```

- `scope`：这条请求的元数据（method=POST、path=/api/agents/...、headers、client 地址）。
- `receive`：异步收后续输入（HTTP body 分块）。
- `send`：异步发响应（状态码、headers、body 分块）。

C++ 类比：ASGI 像一个稳定的回调接口/ABI。`scope` 像请求结构体，`receive`/`send` 像两个回调函数指针。

**FastAPI 是什么（第三方）**：一个 Python Web 框架。它干两件事：

1. 根据 `scope["path"]` 查路由表，找到对应的 Python 函数。
2. 把 JSON body 解析成带类型的 Python 对象（用 Pydantic）。

C++ 类比：FastAPI 像一个路由分发器 + 类型解码器，把网络字节变成"带类型的函数调用"。

---

# 第 3 层：请求进入 `durable_agent_endpoint`（AG-UI 体现在哪）

FastAPI 查路由表，找到这个自研函数 [backend/app/runtime_execution/endpoint.py:62](../../backend/app/runtime_execution/endpoint.py#L62)：

```python
from agent_framework_ag_ui import AGUIRequest   # ← 第三方框架（MAF 提供的 AG-UI DTO）

@app.post(path, tags=tags or ["AG-UI"], ...)
async def durable_agent_endpoint(request_body: AGUIRequest) -> StreamingResponse:
    input_data = request_body.model_dump(mode="json", exclude_none=True)
    ...
```

**AG-UI 在哪里体现（这一层终于能看到）**：

1. **import 层面**：`from agent_framework_ag_ui import AGUIRequest` -- `agent_framework_ag_ui` 是 MAF 提供的 AG-UI 协议库（第三方）。`AGUIRequest` 是这个库定义的 Pydantic 类，规定 AG-UI 请求 JSON 必须有哪些字段（`threadId`、`runId`、`messages` 等）。
2. **函数签名层面**：`request_body: AGUIRequest` -- FastAPI 看到 endpoint 参数类型是 `AGUIRequest`，会自动把 HTTP body 的 JSON 解析成这个类型的对象。前端 `HttpAgent` 发的 JSON 字段就是按 AG-UI 协议来的，所以能对上。
3. **路径层面**：endpoint 注册在 `/api/agents/continuous-chat/runs`，这个 URL 风格也是 AG-UI 协议建议的。
4. **tags 层面**：`tags=["AG-UI"]` 在 OpenAPI 文档里标记这是 AG-UI 类端点。

所以 **AG-UI 协议 = 前端 `@ag-ui/client` + 后端 `agent_framework_ag_ui` 共同遵守的一套 JSON 字段约定**。两边都用了第三方库来实现这套约定，我们只是配置和调用。

**`endpoint` 是什么**：就是"网络入口函数"。一个 URL 对应一个 endpoint 函数。这个词在英文里是"端点"，指网络协议的终点--从这里开始不再是 HTTP 协议层，而是你的业务代码。

**`async def` 是什么**：定义一个**协程函数**。和普通函数不同，调用它不会立即执行，而是返回一个 coroutine 对象，需要事件循环驱动。第 9 层详细讲。

C++ 类比：像 C++20 的协程，调用返回 `task<T>`，需要 `co_await` 才执行。

---

# 第 4 层：endpoint 做的第一件事 -- 写 Product Store

[endpoint.py:85](../../backend/app/runtime_execution/endpoint.py#L85)：

```python
accepted = await sessions.prepare_agui_run(input_data)
```

这一行和 Product Store 怎么关联？拆开看：

- `sessions` 是什么？是 `ProductSessionService` 的实例，在 [composition.py](../../backend/app/composition.py) 装配时创建并注入到 endpoint 的。
- `ProductSessionService` 是什么？是自研类 [backend/app/product_sessions/service.py](../../backend/app/product_sessions/service.py)，专门负责"产品会话相关业务"。
- `sessions.prepare_agui_run()` 内部做什么？看 [service.py:675](../../backend/app/product_sessions/service.py#L675)：

```python
async def prepare_agui_run(self, input_data: dict[str, Any]) -> AcceptedRun:
    ...
    async with self.database.sessions.begin() as transaction:   # ← 打开数据库事务
        session = await self._session(transaction, session_id)   # ← 查会话
        ...
        # 创建 Interaction、User Message、Product Run、Run Attempt 等记录
        # 全部在同一个事务里 insert 到数据库
```

`self.database` 就是 `ProductDatabase`，它包装了 SQLAlchemy 引擎，连到一个 SQLite 或 Postgres 数据库。所有 `transaction.add(...)` / `transaction.get(...)` 最终都翻译成 SQL 语句执行。

**Product Store 是什么**：Chat 的**权威数据库**。物理上就是一组数据库表（`ProductSession`、`Message`、`ProductRun`、`RunAttempt` 等），逻辑上是"所有产品事实的来源"。如果 Product Store 没存，就不算发生过。

`prepare_agui_run` 在这个数据库里写这几行：

| 表 | 写什么 | 通俗解释 |
|---|---|---|
| ProductSession | （已存在）thread-abc-123 这个会话 | 一次对话 |
| Message | User Message："帮我写个 Hello World" | 用户说的话 |
| Interaction | 一条交互记录 | "用户发了一条消息触发了什么" |
| ProductRun | 一条新的 Run 记录 | "这次发消息触发了一次 Agent 执行" |
| RunAttempt | 一条 Attempt 记录 | "Run 的第 1 次尝试" |
| RunProtocol | threadId ↔ productRunId 映射 | "AG-UI 的 runId 对应哪个内部 Run" |

**为什么要先存？** 因为模型可能崩、进程可能挂、网络可能断。如果先跑 Agent 再存，崩了就没证据用户发过什么。**先存权威事实，再跑 Agent** 是 Chat 的核心规则（见 `AGENTS.md` 第 5 节产品规则）。

C++ 类比：像你的程序先 `write(log_file, ...)` 落盘再执行业务逻辑，崩溃后能恢复。`ProductDatabase` 像你封装的 `Database` 类，`sessions.begin()` 像你获取一个事务句柄。

返回值 `accepted` 是一个 `AcceptedRun` 对象，包含 `product_run_id`、`session_id`、`user_message_id` 等--这些是 Product Store 刚写进去的记录的主键，后面要用它们把 Runtime Job 关联起来。

---

# 第 5 层：endpoint 做的第二件事 -- 入队 Runtime Job（Runtime 到底是什么）

[endpoint.py:86](../../backend/app/runtime_execution/endpoint.py#L86)：

```python
enqueued = await runtime.enqueue(
    accepted=accepted,
    endpoint_key=endpoint_key,                # "continuous-chat"
    workflow_definition_id=workflow_definition_id,
    workflow_version=workflow_version,
    input_data=input_data,                   # 原始 AG-UI JSON
)
```

这一层是最容易迷糊的，展开讲清楚：

## 5.1 `runtime` 是什么对象

- `runtime` 是 `RuntimeExecutionService` 的实例（自研），在 `composition.py` 创建。
- 它和 `sessions`（`ProductSessionService`）是**两个不同的自研服务对象**，都持有 `database`（同一个 `ProductDatabase`），但管理不同的表和不同的责任。

## 5.2 `runtime.enqueue()` 内部做什么

看 [service.py:100](../../backend/app/runtime_execution/service.py#L100)：

```python
async def enqueue(self, *, accepted, endpoint_key, ...) -> EnqueuedRuntime:
    async with self.database.sessions.begin() as transaction:   # ← 同一个数据库
        # 1. 查最近一条 RunAttempt（刚被 prepare_agui_run 写进去的）
        attempt = await transaction.scalar(
            select(RunAttemptRecord).where(...)
        )
        # 2. 查是否已有对应 RuntimeJob
        job = await transaction.scalar(
            select(RuntimeJobRecord).where(RuntimeJobRecord.run_attempt_id == attempt.id)
        )
        # 3. 没有就 insert 一条新的 RuntimeJobRecord
        if job is None:
            job = RuntimeJobRecord(
                id=_uuid(),
                product_run_id=accepted.product_run_id,    # ← 关联 Product Store 的 Run
                run_attempt_id=attempt.id,                  # ← 关联 Product Store 的 Attempt
                endpoint_key=endpoint_key,                  # ← 告诉 Worker 该跑哪个 Workflow
                status="queued",                            # ← 初始状态：排队中
                input_payload_json=input_data,              # ← 原始 AG-UI 输入
                ...
            )
            transaction.add(job)
```

**所以 Runtime 和 Product Store 的关系是**：它们是**同一个数据库里的两组不同的表**，由两个不同的自研 Service 管理。

| 维度 | Product Store | Runtime |
|---|---|---|
| 谁管理 | `ProductSessionService`（product_sessions/service.py） | `RuntimeExecutionService`（runtime_execution/service.py） |
| 管哪些表 | `ProductSession`、`Message`、`ProductRun`、`RunAttempt` 等 | `RuntimeJobRecord`、`RuntimeEventRecord`、`RuntimeControlCommandRecord` 等 |
| 存什么事实 | 产品事实（用户说了什么、Run 是什么状态） | 执行事实（这个 Run 现在排队中/被谁领了/产生哪些事件） |
| 主键关系 | `ProductRun.id` | `RuntimeJobRecord.product_run_id` 外键指向 `ProductRun.id` |

## 5.3 Job 是什么

Job 就是 `RuntimeJobRecord` 表里的一行。具体形态：

```
RuntimeJobRecord
├─ id:                    "runtime-job-uuid-001"
├─ product_run_id:        "run-abc-456"       ← 指向 Product Store 里的 Run
├─ run_attempt_id:        "attempt-uuid-789"  ← 指向 Product Store 里的 Attempt
├─ endpoint_key:          "continuous-chat"   ← 告诉 Worker 该跑哪个 Workflow
├─ workflow_definition_id: "continuous-chat-workflow-v1"
├─ status:                "queued"             ← 刚入队
├─ worker_id:              NULL                ← 还没被领
├─ lease_expires_at:       NULL                ← 还没租约
├─ input_payload_json:     { messages, threadId, runId, ... }  ← 原始输入
├─ last_event_sequence:    0                   ← 还没产生事件
└─ created_at:             2026-07-31T...
```

## 5.4 为什么不直接在 endpoint 里跑 Agent

三个原因：

1. **Agent 跑得慢**（几秒到几分钟）。HTTP 请求卡住这么久，浏览器会超时。
2. **流式输出**：Agent 一边跑一边产生事件（"我正在思考"、"我调了工具"、"我返回结果"），要边产生边发给浏览器，不能跑完再一次性发。
3. **崩溃恢复**：如果 endpoint 里跑 Agent，进程崩了 Job 就丢了。把 Job 入队，独立 Worker 可以重新领取。

C++ 类比：你写一个服务器，收到任务后塞进一个 `std::queue<Job>`，另一个线程从队列里取出来执行。这里"队列"是数据库表（持久化），"另一个线程"是 Worker。

返回值 `enqueued` 是一个 `EnqueuedRuntime`，包含 `job_id`、`cursor`、`start_sequence`--这些是后面 SSE 流用来订阅事件的游标。

---

## 阶段流程图 B：endpoint 三件事 + 返回 SSE

```
durable_agent_endpoint（自研，endpoint.py:62）
   │
   ├─① sessions.prepare_agui_run(input_data)
   │     │
   │     │ 调用 ProductSessionService（自研）
   │     │ 通过 ProductDatabase（自研封装）
   │     │ 往 Product Store 写：
   │     │   - Message：用户消息
   │     │   - Interaction、ProductRun、RunAttempt
   │     │   - RunProtocol（threadId↔runId 映射）
   │     ▼
   │   accepted: AcceptedRun（含 product_run_id 等主键）
   │
   ├─② runtime.enqueue(accepted, endpoint_key, input_data)
   │     │
   │     │ 调用 RuntimeExecutionService（自研）
   │     │ 通过同一个 ProductDatabase
   │     │ 往 Runtime 写：
   │     │   - RuntimeJobRecord（status=queued，关联 product_run_id）
   │     ▼
   │   enqueued: EnqueuedRuntime（含 job_id、cursor）
   │
   └─③ return StreamingResponse(event_stream())
         │
         │ 立即把 HTTP 连接切换成 SSE 长连接
         │ event_stream 协程开始轮询 Runtime 的 RuntimeEventRecord 表
         ▼
       （第 6 层展开）
```

---

# 第 6 层：endpoint 返回 SSE，开始流式读 Journal

[endpoint.py:140](../../backend/app/runtime_execution/endpoint.py#L140)：

```python
return StreamingResponse(
    event_stream(),
    media_type="text/event-stream",   # ← SSE 的 MIME 类型
    headers={
        "X-Runtime-Job-Id": enqueued.job_id,    # ← 把 job_id 暴露给前端
        "X-Runtime-Cursor": enqueued.cursor,    # ← 把游标暴露给前端（断线重连用）
    },
)
```

**SSE 是什么**：Server-Sent Events，一种 HTTP 长连接协议。服务器不一次性返回完整响应，而是一帧一帧地推字节给浏览器，连接保持开着。浏览器用 `EventSource` API 接收（前端 `@ag-ui/client` 框架内部封装了）。

和 WebSocket 区别：SSE 只能服务器->浏览器单向，WebSocket 是双向。Chat 当前只需要服务器推事件给浏览器，所以用 SSE。

**`event_stream` 是什么（自研，[endpoint.py:103](../../backend/app/runtime_execution/endpoint.py#L103)）**：一个**异步生成器**函数。每来一个新事件就 `yield` 一帧字节：

```python
async def event_stream() -> AsyncGenerator[bytes]:
    sequence = enqueued.start_sequence          # 从入队时记录的 sequence 开始
    while True:
        events, job = await runtime.events_after(
            job_id=enqueued.job_id,
            after_sequence=sequence,
        )
        if not events:
            if job["status"] in {"failed", "cancelled", "outcome_unknown"}:
                yield _sse({"type": "RUN_ERROR", ...})   # 失败帧
                return
            await asyncio.sleep(poll_interval_seconds)   # 没新事件就等一会儿
            continue
        for event in events:
            sequence = int(event["sequence"])
            yield _sse(event["payload"], sequence=sequence)   # ← yield 一帧 SSE
            if payload.get("type") in {"RUN_FINISHED", "RUN_ERROR"}:
                return                                    # 终态帧后关闭流
```

**Journal 是什么**：Runtime 里的一张表 `RuntimeEventRecord`，存 Worker 跑 Agent 时产生的事件，每条带递增的 `sequence` 号。

`runtime.events_after(after_sequence=N)` 查的是 [service.py:769](../../backend/app/runtime_execution/service.py#L769)：

```python
async def events_after(self, *, job_id, after_sequence, limit=500):
    ...
    records = await transaction.scalars(
        select(RuntimeEventRecord)
        .where(
            RuntimeEventRecord.runtime_job_id == job_id,
            RuntimeEventRecord.sequence > after_sequence,   # ← 只取 N 之后的
        )
        .order_by(RuntimeEventRecord.sequence)
        .limit(limit)
    )
    return [self._event_view(value) for value in records], job_view
```

**为什么要 Journal 而不是 Worker 直接发给浏览器**：因为浏览器可能断线、刷新、切换网络。如果 Worker 直接发给浏览器，断线就丢了。通过 Journal：

- 浏览器断了重连，可以从上次 `sequence` 继续读（用 `X-Runtime-Cursor`）。
- Worker 不关心有没有浏览器在看，只管写 Journal。
- 同一个 Run 可以被多个浏览器订阅（未来场景）。

C++ 类比：像你写一个日志服务器，事件先 `append` 到日志文件，多个客户端可以 `tail -f` 各自追自己的 offset。

---

# 第 7 层：Worker 登场 -- 谁来领 Job 跑 Agent

Job 入队了，但没人跑它，它就永远是 `queued` 状态。需要有人：

1. 从队列里领走 Job（标记为 `running`，别人不能再领）。
2. 跑 Agent（调 MAF Runner）。
3. 把 Agent 产生的事件写进 Journal。
4. 跑完标记 Job 为 `succeeded`/`failed`。

**这个角色就是 Worker**。[backend/app/runtime_execution/worker.py::ExecutionWorker](../../backend/app/runtime_execution/worker.py#L76) 是一个自研类：

```python
class ExecutionWorker:
    def __init__(self, database, runtime, registry, worker_id, ...):
        self.worker_id = worker_id         # 身份标识
        self.boot_id = str(uuid.uuid4())   # 每次启动一个新UUID
        self.database = database           # ProductDatabase（自研封装）
        self.runtime = runtime             # RuntimeExecutionService（自研）
        self.registry = registry          # RuntimeRunnerRegistry（自研）
        ...
```

**为什么叫 Worker**：英文"工人"，工业流水线的概念--一个反复领取任务并执行的角色。这里不是 OS 概念，是**产品角色**。一个 Python 进程里有一个 Worker 对象，或多个进程各有一个，都行。

C++ 类比：像你写 `class JobWorker { void run_once(); }`，持有 DB 连接和队列句柄。

---

# 第 8 层：Worker 怎么被启动 -- Lifespan

Worker 对象是在 `create_app()` 时被 new 出来的（构造），但 new 出来不等于"开始工作"。需要有人：

1. 把它注册到数据库（写一行"worker-xxx 已启动"）。
2. 启动一个循环反复调 `run_once()`。
3. 进程退出时把它标记为 stopped。

**这就是 Lifespan 干的事**。[backend/app/lifecycle.py:108-126](../../backend/app/lifecycle.py#L108-L126)（自研）：

```python
if execution_loop_enabled:
    await components.execution_worker.register()    # 注册身份到数据库

    async def execution_loop():                     # 定义循环
        while True:
            processed = await components.execution_worker.run_once()
            if not processed:
                await asyncio.sleep(0.08)           # 空闲就等80ms

    execution_task = asyncio.create_task(execution_loop())  # 启动循环（第 9 层解释）
```

**Lifespan 是什么**：ASGI 协议规定的"进程开始接请求前"和"进程退出时"两个时间点的钩子。Uvicorn 在 `bind/listen` 后、`accept` 请求前发 `lifespan.startup`；SIGTERM 时发 `lifespan.shutdown`。FastAPI 把它包装成 Python 的异步上下文管理器（自研代码用 `@asynccontextmanager` 装饰）：

```python
@asynccontextmanager
async def lifespan(app):
    # startup：连数据库、跑迁移、注册Worker、启动Worker循环
    yield
    # shutdown：取消Worker Task、关数据库
```

`yield` 之前 = 开机，`yield` 期间 = 对外服务，`yield` 之后 = 关机。

C++ 类比：像你在 `main()` 里写 `init(); serve(); cleanup();`，但 ASGI 把 `init` 和 `cleanup` 提取成协议规定的钩子，让框架来调度。

---

# 第 9 层：asyncio -- 让 Worker 循环和 HTTP 接请求共存

如果 Worker 用 `while True` 死循环跑，会怎样？整个 Python 进程卡在 Worker 里，HTTP 请求根本进不来。

**asyncio 是什么（Python 标准库）**：Python 的**事件循环并发模型**。让多个协程在单进程单线程里交替执行：

- 事件循环维护一个"就绪协程"队列。
- 某个协程 `await` 一个 I/O（数据库查询、HTTP 调用、`asyncio.sleep`）时，**主动让出**控制权，事件循环切到下一个就绪协程。
- I/O 完成后，这个协程被重新放回就绪队列。

**关键：不是多线程，是单线程里的协作式调度**。

所以 `execution_loop` 在 `await asyncio.sleep(0.08)` 时，事件循环可以去处理 HTTP 请求；HTTP 请求 `await` 数据库时，事件循环可以回去跑 Worker。大家都在让出/被调度，没有谁真正"阻塞"。

C++ 类比：像你用 `epoll` + 状态机写一个单线程服务器，所有 I/O 都是非阻塞的，事件循环 `epoll_wait` 决定下一个处理谁。Python asyncio 把这个模型封装成了 `async/await` 语法。

**Task 是什么**：`asyncio.create_task(coro)` 把一个协程"注册到事件循环"，让它并发跑。返回一个 Task 对象，可以 `cancel()`、`await`。不是 OS 线程，是协程的容器。

---

## 阶段流程图 C：asyncio 事件循环里的两个协程

```
┌──────────────────────────────────────────────────────────────┐
│  asyncio 事件循环（单进程单线程，Python 标准库）                │
│                                                              │
│  ┌────────────────────────┐    ┌──────────────────────────┐  │
│  │ HTTP 协程              │    │ Worker Task              │  │
│  │ (event_stream)         │    │ (execution_loop,自研)     │  │
│  │                        │    │                          │  │
│  │ runtime.events_after() │    │ while True:              │  │
│  │   ↓ await（让出）       │    │   run_once()             │  │
│  │ （没新事件）            │    │     ↓ await claim_one    │  │
│  │ await sleep(0.08)      │    │     ↓ await _execute     │  │
│  │   ↓                    │    │       ↓ 调 Runner        │  │
│  │ yield SSE 帧给浏览器    │    │       ↓ await MAF        │  │
│  │                        │    │       ↓ await append_    │  │
│  │                        │    │         event（写Journal）│  │
│  └────────────────────────┘    └──────────────────────────┘  │
│            ▲                              │                  │
│            │ 读 events_after(N)           │ 写 RuntimeEvent  │
│            │                              ▼                  │
│            └────────────[RuntimeEventRecord 表]              │
│                              （Journal，持久化在数据库）        │
└──────────────────────────────────────────────────────────────┘
```

---

# 第 10 层：`run_once` -- Worker 的单次动作

[worker.py:146](../../backend/app/runtime_execution/worker.py#L146)：

```python
async def run_once(self) -> bool:
    await self._maintain_runtime()           # 1. 维护心跳/续租
    claim = await self.runtime.claim_one(    # 2. 领取一个Job
        worker_id=self.worker_id,
        lease_seconds=self.lease_seconds,
    )
    if claim is None:
        return False                          # 没领到，告诉外层"空闲"
    await self._execute(claim)                # 3. 领到了，跑Agent
    return True                               # 告诉外层"处理了一个"
```

**`claim_one` 是什么（自研，[service.py:195](../../backend/app/runtime_execution/service.py#L195)）**：原子地"领取"一个 Job。SQLAlchemy 翻译成类似这样的 SQL：

```sql
-- 第 1 步：找一个 queued 状态的 Job
SELECT * FROM runtime_jobs
WHERE status = 'queued' AND available_at <= now()
ORDER BY available_at, created_at, id
LIMIT 1;

-- 第 2 步：原子地把它的状态改成 leased，并写上 worker_id 和租约过期时间
UPDATE runtime_jobs
SET status = 'leased',
    lease_owner = 'worker-xxx',
    lease_epoch = lease_epoch + 1,
    lease_expires_at = now() + interval '30 seconds'
WHERE id = '...' AND status = 'queued';
```

如果 `UPDATE` 影响行数 = 0，说明被别的 Worker 抢了，返回 `None`。

**Lease（租约）是什么**：领走 Job 时给一个"过期时间"（30秒后）。如果 Worker 崩了，30秒后 Lease 过期，Reconciler 会把 Job 状态改回 `queued`，别的 Worker 可以重新领。这是崩溃恢复机制。

**为什么不直接 `while True: 执行Job`**：因为"领一个、执行一个"是单次动作，"循环节奏"是调用方的事。`run_once` 返回 `bool` 告诉调用方"我处理了/我空闲了"，调用方决定 sleep 多久。

C++ 类比：你写 `bool run_once()` 返回"是否处理了任务"，调用方写 `while (run_once() || should_sleep()) sleep(...);`。这样测试可以单独调 `run_once()` 验证，生产可以用不同节奏循环。

---

# 第 9-10 层深入：为什么是 `while True` 循环而不是顺序流程

**核心疑问**（C++ 转过来的程序员最容易问的）：用户发消息后调大模型，看起来是顺序流程，为什么 Worker 要 `while True` 循环？这个疑问触及整个架构的核心动机，从"顺序流程在哪里崩"开始推导。

## 顺序流程是最简单的，但它会崩

你的直觉：

```
用户发消息 -> endpoint -> 跑MAF -> 大模型返回 -> 返回给浏览器
```

代码大概这样：

```python
async def durable_agent_endpoint(request_body: AGUIRequest):
    accepted = await sessions.prepare_agui_run(input_data)
    result = await maf_agent.run(input_data)   # ← 卡在这里 30 秒
    return {"reply": result}
```

这个设计在 Hello World demo 阶段完全没问题。问题是它在 5 个真实场景下崩掉：

| 场景 | 顺序流程怎么崩 |
|---|---|
| 1. Agent 跑 30 秒 | HTTP 默认超时 30 秒，浏览器/代理断开，结果丢失，但 Agent 实际还在跑 |
| 2. 流式输出没法做 | Agent 边跑边产生事件，但顺序流程必须等 `maf_agent.run()` 返回才能开始发响应 |
| 3. 进程崩了 | `maf_agent.run()` 中断，Agent 状态丢失，用户不知道是重发还是等，系统没法恢复 |
| 4. 100 个用户同时来 | asyncio 同时跑 100 个 `maf_agent.run()`，每个都在等大模型 HTTP，资源被瓜分，所有人变慢 |
| 5. 想加一台服务器 | "接请求的进程"就是"跑 Agent 的进程"，扩容只能整个进程复制，浪费 |

## 队列 + Worker 怎么解决

核心思想：把"接请求"和"跑 Agent"**分成两个独立阶段**，中间用持久化队列连接。

```
[接请求]  ──入队──>  [队列]  ──领取──>  [Worker 跑 Agent]
   endpoint              DB表              run_once
   (轻量、快)           (持久)            (重、可慢)
```

5 个问题分别被解决：

| 问题 | 队列+Worker 怎么解决 |
|---|---|
| HTTP 超时 | endpoint 只做"存+入队"，几毫秒返回，开 SSE 长连接 |
| 流式输出 | Worker 边跑边写 Journal，endpoint 边读 Journal 边推 SSE |
| 进程崩溃 | Job 在数据库里，Worker 重启后继续领 |
| 100 并发 | endpoint 接得快不卡；Worker 可单进程串行，避免 Provider 资源被瓜分 |
| 水平扩展 | 加 Worker 进程（甚至加机器）即可，endpoint 不变 |

## 那为什么不事件驱动唤醒 Worker，而要 `while True` 轮询

到这里问题变成：**Worker 既然是"等有 Job 才跑"，为什么不设计成"有 Job 时被唤醒"？**

### 方案 A：事件驱动（有 Job 时唤醒）

```
endpoint 入队 Job -> 某种机制通知 Worker -> Worker 醒来调 run_once
```

需要 Redis pub/sub、消息队列、Unix signal、PostgreSQL `LISTEN/NOTIFY` 等"通知通道"。

### 方案 B：轮询（Worker 自己 `while True` 反复查）

```
Worker while True:
    有 Job 吗？有就跑
    没有 sleep 0.08s 再查
```

只需要查数据库。

### Chat 选了 B 的 5 个原因

1. **数据库已经是权威队列，不需要再加通知系统**。Job 已经在 `RuntimeJobRecord` 表里。`claim_one` 是一条原子 SQL，"找 + 占"一步完成。如果再加 Redis pub/sub 通知，就有两个事实源（Redis 说"有 Job" vs DB 里"真有 Job"），处理幂等很麻烦。轮询让数据库成为唯一事实源。
2. **多 Worker 抢占不需要协调器**。3 个 Worker 都在 `while True` 都去 `claim_one`，SQL 的原子 UPDATE（类似 `FOR UPDATE SKIP LOCKED`）保证只有一个能领到，另外两个返回 None。数据库本身做了协调，不需要额外 dispatcher。
3. **崩溃恢复极简**。Worker 崩了重启，不需要"重新订阅消息"，只要继续 `while True` 就从队列里领下一个。崩溃前正在跑的 Job，Lease 过期后 Reconciler 改回 `queued`，会被新 Worker 领走。整个恢复机制靠"数据库状态 + 轮询"，不靠"消息确认"。
4. **80ms 延迟对 Chat 场景可接受**。大模型一次响应要几秒到几十秒，Worker 80ms 才查一次队列，相对延迟可忽略。轮询的"低效"在 Agent 这种重任务场景下不构成瓶颈。如果是高频轻任务（订单匹配、实时竞价），80ms 轮询就不可接受，必须事件驱动。但 Chat 不是。
5. **独立进程部署复用同一循环**。[execution_worker.py](../../backend/app/execution_worker.py) 是独立 Worker 进程入口，主循环也是 `while not signal.is_set(): run_once()`。如果用事件驱动，独立进程需要重新订阅消息，复杂度上升；轮询模式只要"连数据库 + 循环"，独立进程和进程内 Task 复用同一套逻辑。

## endpoint 也在 `while True` 轮询 Journal

[endpoint.py:106](../../backend/app/runtime_execution/endpoint.py#L103) 的 `event_stream` 也在轮询：

```python
async def event_stream():
    while True:
        events, job = await runtime.events_after(...)
        if events:
            yield _sse(...)
        await asyncio.sleep(poll_interval_seconds)   # 0.08s
```

完全一样的道理：Journal 是数据库表，是唯一事实源；多个浏览器订阅同一个 Run（断线重连、多窗口）时，不需要给每个浏览器建通知通道；浏览器断线重连从上次 `sequence` 继续读即可。

**整个系统就是"数据库表 + 各自轮询"的架构**。Worker 轮询 Job 表，endpoint 轮询 Event 表，Reconciler 轮询过期 Lease。所有角色都靠"查数据库"工作，不需要消息中间件。

## Chat 自身文档已经论证过这个设计

仓库里**最直接的论证段落**在 [项目掌握/运行执行与证据/Run-Worker-Cursor-Tool与Workspace怎样恢复.md](../../项目掌握/运行执行与证据/Run-Worker-Cursor-Tool与Workspace怎样恢复.md) 第 6 节"为什么这样设计"：

> 替代方案是一个后台协程直接把SSE写给浏览器。它简单，但API进程重启、浏览器断线或多实例接管时无法恢复。持久Job＋Lease＋事件日志增加数据库写入，却将网络连接与执行解耦。

更详细的决策记录在 [docs/runtime-execution-detailed-design.md](../../docs/runtime-execution-detailed-design.md)：

| 决策 | 内容 | 论证理由 |
|---|---|---|
| D4 | 数据库回放 + 轮询作为首个跨进程传输 | 权威事件已在 DB；首期减少基础设施和双写故障。未来可用 Pub/Sub 只做唤醒，不改变 Journal 事实源 |
| D5 | Lease Epoch 作为提交 Fence | Heartbeat 只能发现"可能失联"，不能阻止旧 Worker 复活后抢写 Final |
| D6 | 浏览器断开与显式取消严格分离 | 满足后台继续和多端重连；避免关闭工作台误杀任务 |
| D7 | Worker 失联后的保守恢复 | 当前尚无完整 Tool/Provider 副作用对账，自动重试可能重复写文件、发消息或付费 |
| D8 | 不直接采用 MAF Durable Task | 目标安装版未包含该包；参考源码是 Beta、需要外部基础设施 |

§2.2 当前缺口直接列出顺序流程的缺陷："浏览器连接和实际执行仍共享一个调用栈；没有持久的逐事件序号；没有通用 Runtime Job、Worker Lease 和 Heartbeat"。§11 故障矩阵把"HTTP 进程自己偷偷执行"列为**禁止行为**。

## 其他 Agent 项目的对比

| 项目 | 请求-执行关系 | 队列实现 | Worker 模型 | Lease/恢复 | 与 Chat 的关系 |
|---|---|---|---|---|---|
| **nanobot** | 异步解耦 | `asyncio.Queue`（内存） | `while True` + 1s 超时轮询内存队列 | 无（进程级 PID state，非 job 级） | **循环结构最接近**，但内存队列无恢复能力 |
| **pi** | 同步直接调用 | 无 | 无 Worker | 无 | **最不同**，CLI 同步模型，无参考价值（除 agent loop 本身） |
| **khoj** | 同步流式 | 聊天无；定时任务用 APScheduler+DB | 聊天无；定时任务有 BackgroundScheduler | **有 DB ProcessLock**（lease+过期），仅限定时任务 | **lease 机制最值得参考**，但聊天是同步的 |

### 三个项目的关键启示

1. **nanobot 的循环结构**（`/Users/xulater/Code/opc-os/nanobot/nanobot/agent/loop.py` 第 978-1071 行）和 Chat 几乎一致：`while self._running: msg = await asyncio.wait_for(self.bus.consume_inbound(), timeout=1.0)`。差别：nanobot 轮询内存 `asyncio.Queue`，Chat 轮询数据库表。nanobot 没有崩溃恢复，靠 session JSONL 重放历史，但不保证 in-flight job 恢复。

2. **khoj 的 ProcessLock**（`/Users/xulater/Code/opc-os/khoj/src/khoj/database/models/__init__.py` 第 351-362 行）是 Chat 做 Worker 租约可以直接借鉴的模式：DB 行 + unique 约束 + `started_at` + `max_duration_in_seconds` + 过期自动删除。`is_process_locked` 里"检查 started_at + max_duration 是否过期，过期就 delete 并返回 False"就是一个最小可用的 lease 过期回收实现。但 khoj 只把它用在定时任务，聊天是同步的。

3. **三个项目都没有在聊天场景下做"请求入 DB 队列 + Worker 领取 + lease + 崩溃恢复"的完整方案**。nanobot 用内存队列解耦但不持久化，khoj 用同步流式但把 lease 留给定时任务，pi 完全同步。Chat 的 `while True` 轮询 DB + Lease 是把 nanobot 的循环结构 + khoj 的 ProcessLock 自行组合的结果。

## 一句话回答

顺序流程在"小规模 demo"下成立，但一旦 Agent 跑几十秒、需要流式输出、要崩溃恢复、要水平扩展，它就崩了。**队列+Worker 把"接请求"和"跑 Agent"用数据库表解耦：endpoint 快速入队返回，Worker 独立循环领取。Worker 用 `while True` 轮询而非事件驱动，是因为数据库本身就是权威队列，`claim_one` 是原子 SQL，多 Worker 抢占靠数据库协调，崩溃恢复靠 Lease+轮询，整套设计不需要消息中间件，简单且强韧。** 80ms 的 `sleep` 是轮询的代价，但相对 Agent 几秒到几十秒的耗时可以忽略。

---

# 第 11 层：`_execute` -- 真正跑 Agent（发给大模型就在这里）

Worker 领到 Job 后，调 `_execute(claim)`，里面会：

```python
async def _execute(self, claim: ClaimedRuntime) -> None:
    runner = self.registry.require(claim.endpoint_key)   # 按 key 找 Runner
    async for event in runner.run(claim.input_data):     # 跑Agent，产生事件流
        await self.runtime.append_event(claim.job_id, event)  # 写进Journal
```

**Runner 是什么（自研）**：一个封装了 MAF Agent 的对象，实现 `RuntimeRunner` 协议（Python Protocol，类似 C++ 纯虚基类）：

```python
class RuntimeRunner(Protocol):
    def run(self, input_data: dict[str, Any]) -> AsyncIterator[Any]:
        ...
```

Worker 不关心 Agent 怎么跑，只管调 `runner.run(input_data)` 拿事件流。Runner 的具体实现是 `ProductAwareWorkflow`（自研类），它内部组装 MAF 的 `Agent` / `Workflow` 并执行。

**MAF 是什么（第三方框架）**：Microsoft Agent Framework，微软的 Agent 框架。它负责：

- 加载 LLM Provider（连 OpenAI/Anthropic/本地模型）。
- 执行 Workflow（多步骤 Agent 流程）。
- 调用 Tools（搜索、代码执行、数据库查询）。
- 产生 AG-UI 事件（`RUN_STARTED`、`TEXT_MESSAGE_CHUNK`、`RUN_FINISHED` 等）。

**发给大模型就在这一层**：MAF 内部调用 Provider（如 OpenAI 的 `/v1/chat/completions`），把 `input_data` 里的 `messages` 转换成 Provider 的请求格式，发起 HTTP 请求到大模型服务器，拿到流式响应，解码成 AG-UI 事件 yield 出来。

C++ 类比：MAF 像一个第三方库，你 `#include <maf/agent.h>`，构造 `Agent agent; auto events = agent.run(input);`。Chat 把它包装成 Runner。

**事件类型（AG-UI 协议规定）**：

| 事件 type | 含义 |
|---|---|
| `RUN_STARTED` | Run 开始 |
| `TEXT_MESSAGE_CHUNK` | 一段文字流（回复正文的分块） |
| `STEP_STARTED` / `STEP_FINISHED` | Workflow 某个步骤开始/结束 |
| `TOOL_CALL_STARTED` / `TOOL_CALL_FINISHED` | 工具调用开始/结束 |
| `RUN_FINISHED` | Run 完成 |
| `RUN_ERROR` | Run 失败 |

这些事件就是 AG-UI 协议规定的 JSON 格式--第 3 层说的"前后端共同遵守的 JSON 字段约定"在这里体现：MAF 产出这些事件，Worker 写进 Journal，SSE 读出来 yield 给浏览器，前端 `@ag-ui/client` 解析这些事件并更新 UI。

---

# 第 12 层：事件从 Journal 流回浏览器

Worker 把事件写进 Journal 表（`RuntimeEventRecord`）后，第 6 层那个 `event_stream` 协程（在 endpoint 里）就在轮询 Journal：

```python
events, job = await runtime.events_after(job_id, after_sequence=sequence)
for event in events:
    yield _sse(event["payload"], sequence=sequence)   # ← yield 一帧给浏览器
```

浏览器 `@ag-ui/client` 框架的 `HttpAgent` 收到 SSE 帧，解析 JSON，根据 `type` 字段更新 React 状态：

- `TEXT_MESSAGE_CHUNK` -> 把 chunk 拼到当前消息
- `RUN_FINISHED` -> 标记 Run 完成
- `RUN_ERROR` -> 显示错误

React 重新渲染，用户看到 Agent 的回复逐步出现："我帮你写：`print('Hello World')`"。

---

## 阶段流程图 D：完整链路一张图

```
[浏览器进程]                                       [服务器 Python 进程]

用户敲"帮我写个Hello World"
    │
    │ React 组件 onChange 更新状态
    │ 用户点发送
    ▼
useChatAgent.sendMessage()（自研 Hook）
    │
    │ 调 HttpAgent.runAgent(messages)
    │ HttpAgent（@ag-ui/client 框架）
    ▼
fetch POST /api/agents/continuous-chat/runs
    │ body: { threadId, runId, messages: [...] }   ← AG-UI 协议 JSON
    │
═══════════════════════════════════════════════  ← 网络边界
    ▼
Uvicorn（第三方）收 TCP，按 ASGI 协议包装
    │
    ▼
FastAPI（第三方）查路由表，Pydantic 解析 JSON
    │
    ▼
durable_agent_endpoint（自研，endpoint.py:62）
    │
    ├─① sessions.prepare_agui_run()
    │     ↓
    │   ProductSessionService（自研）
    │     ↓ ProductDatabase（自研封装）
    │     ↓ SQL 事务
    │   [Product Store 表] ← Message, ProductRun, RunAttempt...
    │     │
    │     ▼
    │   accepted（product_run_id 等）
    │
    ├─② runtime.enqueue(accepted, input_data)
    │     ↓
    │   RuntimeExecutionService（自研）
    │     ↓ ProductDatabase（同一个）
    │     ↓ SQL 事务
    │   [Runtime 表] ← RuntimeJobRecord(status=queued)
    │     │
    │     ▼
    │   enqueued（job_id, cursor）
    │
    └─③ return StreamingResponse(event_stream())
          │
          │ event_stream 协程（自研）注册到 asyncio 事件循环
          │
          ▼
┌──────────────────────────────────────────────────────────────────┐
│ asyncio 事件循环（单进程单线程，Python 标准库）                    │
│                                                                  │
│ ┌──────────────────────┐        ┌─────────────────────────────┐  │
│ │ event_stream 协程    │        │ execution_loop Task         │  │
│ │ （HTTP 协程）         │        │ （Worker 循环，Lifespan启动） │  │
│ │                      │        │                             │  │
│ │ while True:          │        │ while True:                 │  │
│ │   events_after(N)    │  ←──── │   run_once()                │  │
│ │   yield SSE 帧 ───────────────│─→ _execute(claim)           │  │
│ │     ↓                │  写事件  │   ↓                         │  │
│ │   await sleep(0.08)  │        │   runner.run(input)         │  │
│ │                      │        │     ↓                       │  │
│ │                      │        │   [MAF Agent 执行]           │  │
│ │                      │        │     ↓ 调 Provider HTTP       │  │
│ │                      │        │     ↓ 大模型返回流式响应     │  │
│ │                      │        │     ↓ 解码成 AG-UI 事件      │  │
│ │                      │        │   append_event(job_id, evt) │  │
│ │                      │        │     ↓ 写 SQL                 │  │
│ │                      │        │   [RuntimeEventRecord 表]   │  │
│ └──────────────────────┘        └─────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
    │
    │ SSE 帧：data: {"type":"TEXT_MESSAGE_CHUNK", ...}\n\n
    ▼
═══════════════════════════════════════════════  ← 网络边界
    ▼
浏览器 EventSource（@ag-ui/client 框架封装）收到帧
    │
    │ 解析 JSON，按 type 更新 React state
    ▼
React 重新渲染
    │
    ▼
用户看到："我帮你写：print('Hello World')"
```

---

# 关键概念速查表（按"前后端/框架自研"分类）

## 前端（浏览器进程）

| 概念 | 是什么 | 框架/自研 |
|---|---|---|
| React | UI 渲染框架 | 第三方 |
| Vite | 前端构建工具（TSX -> JS） | 第三方 |
| `@ag-ui/client` | AG-UI 协议的 HTTP Client（`HttpAgent`） | 第三方 |
| `@ag-ui/core` | AG-UI 协议的 TypeScript 类型定义（`Message` 等） | 第三方 |
| `useChatAgent` / `chat-agent-client` | 把 HttpAgent 接入 React 的 Hook 和配置 | **自研** |
| Zustand | 轻量状态管理库 | 第三方 |

## 后端（Python 进程）

| 概念 | 是什么 | 框架/自研 |
|---|---|---|
| Uvicorn | 网络服务器（socket/bind/listen） | 第三方 |
| ASGI | Uvicorn↔FastAPI 的协议 | 标准 |
| FastAPI | Web 框架（路由+DTO解析） | 第三方 |
| Pydantic | JSON ↔ Python 对象转换 | 第三方 |
| SQLAlchemy | Python ORM（翻译成 SQL） | 第三方 |
| Starlette | FastAPI 底层的 ASGI 工具箱 | 第三方 |
| MAF | 微软 Agent 框架（跑 LLM/Tool/Workflow） | 第三方 |
| `agent_framework_ag_ui` | MAF 提供的 AG-UI DTO（`AGUIRequest`） | 第三方 |
| asyncio | Python 事件循环并发 | 标准库 |
| `ProductDatabase` | 封装 SQLAlchemy 引擎的数据库句柄 | **自研** |
| `ProductSessionService` | Product Store 业务服务 | **自研** |
| `RuntimeExecutionService` | Runtime 业务服务（Job/Event/Cursor） | **自研** |
| `ExecutionWorker` | 领 Job 跑 Agent 的产品角色 | **自研** |
| `RuntimeRunnerRegistry` | 按 endpoint_key 找 Runner 的注册表 | **自研** |
| `ProductAwareWorkflow` | MAF Runner 的自研实现（包装 MAF Agent） | **自研** |
| `durable_agent_endpoint` | AG-UI HTTP 入口函数 | **自研** |
| `create_lifespan` / `execution_loop` | Worker 启停和循环 | **自研** |

## 协议 / 概念（不是代码）

| 概念 | 是什么 | 为什么需要它 | 它不是什么 |
|---|---|---|---|
| **Product Store** | Product Store 表的集合，存产品事实 | 崩溃可恢复，先落盘再执行 | 不是缓存、不是投影 |
| **Runtime** | Runtime 表的集合，存执行状态 | 管理 Job 队列和事件流 | 不是 Product Store 的别名 |
| **Job** | `RuntimeJobRecord` 表的一行 | 解耦"接纳"和"执行" | 不是 HTTP 请求 |
| **Journal** | `RuntimeEventRecord` 表 | Worker 写、endpoint 读，断线可续 | 不是完整 Run 历史 |
| **Lease** | Job 的过期时间 | Worker 崩了别人可重领 | 不是锁 |
| **SSE** | 流式 HTTP 协议 | 边产生边推送给浏览器 | 不是 WebSocket |
| **AG-UI** | 前后端共同遵守的 JSON 字段约定 | 前端 `HttpAgent` 和后端 `AGUIRequest` 能对上 | 不是传输协议（传输用 HTTP+SSE） |
| **Lifespan** | ASGI 生命周期钩子 | 管理开机/关机顺序 | 不是某个函数 |
| **endpoint** | URL 对应的入口函数 | 网络字节↔Python 调用的边界 | 不该是业务逻辑所有者 |

---

# 一句话总结

用户敲消息 -> 前端 `HttpAgent`（`@ag-ui/client` 框架）发 AG-UI 协议的 POST -> 后端 `durable_agent_endpoint`（自研）做三件事：① 调 `ProductSessionService`（自研）把消息写进 **Product Store**（产品事实先落盘）；② 调 `RuntimeExecutionService`（自研）把 **Job** 入 Runtime 队列（待执行）；③ 返回 SSE 流读 **Journal**（流式输出）。**Worker**（自研）是独立角色，由 **Lifespan**（自研，用 ASGI 钩子）在开机时启动成 asyncio Task，反复调 **`run_once`**（自研，领一个 Job、跑 MAF Runner、把事件写进 Journal），Journal 里的新事件被 endpoint 的 SSE 流读到、推给浏览器。**`run_once` 自己不循环、不 sleep，只做单次"领+跑"，循环节奏交给 Lifespan 启动的 `execution_loop`，这样同一个方法能被进程内 Task、独立进程、测试三种调用方复用**。

---

## 补充记录

- 2026-07-31：首版，从前端到后端到发给大模型完整拆解 12 层。
- 2026-07-31：第二版优化。针对反馈：①第 3 层补充 AG-UI 在代码中的 4 个体现点（import、函数签名、URL 风格、tags）；②第 4 层展开 `prepare_agui_run` 内部事务和具体表；③第 5 层把 Runtime 拆成"对象->内部代码->Job 形态->和 Product Store 关系"四小节；④新增阶段流程图 A/B/C/D 分阶段；⑤概念速查表按"前端/后端/协议"分类并标注框架/自研；⑥第 11 层补充发给大模型的具体位置和 AG-UI 事件类型表。
- 2026-07-31：第三版补充。在第 10 层后新增"第 9-10 层深入：为什么是 `while True` 循环而不是顺序流程"章节。针对"为什么不是顺序流程"的疑问展开：①顺序流程在 5 个真实场景下崩掉的反例表；②队列+Worker 怎么分别解决；③事件驱动 vs 轮询的方案 A/B 对比，Chat 选 B 的 5 个原因；④endpoint 也在 `while True` 轮询 Journal 的同理说明；⑤引用 Chat 自身文档的论证段落（`Run-Worker-Cursor-Tool与Workspace怎样恢复.md` 第 6 节 + `runtime-execution-detailed-design.md` D4-D8 决策记录）；⑥nanobot/pi/khoj 三个参考项目的架构对比表，明确 nanobot 循环结构最接近但内存队列无恢复，khoj 的 ProcessLock 是 lease 机制参考起点，三个项目都没做"DB 队列+Worker+lease+恢复"完整方案。
