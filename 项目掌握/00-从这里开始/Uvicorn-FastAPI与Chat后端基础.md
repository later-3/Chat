# Uvicorn、FastAPI与Chat后端基础

**归档日期**：2026-07-30

**分类**：00-从这里开始

**定位**：只会少量C++时，从Python模块导入学到Chat真实HTTP/AG-UI后端链路

**当前安装版本**：FastAPI `0.138.0`、Uvicorn `0.51.0`、Starlette `1.3.1`、Pydantic `2.14.0a1`

**关联源码**：`backend/app/asgi.py`、`backend/app/main.py`、`backend/app/composition.py`、
`backend/app/lifecycle.py`、`backend/app/api/`、`backend/app/observability/diagnostics.py`、
`backend/app/runtime_execution/endpoint.py`

## 问题

`python -m uvicorn backend.app.asgi:app` 中，Uvicorn、ASGI、FastAPI、Starlette、Pydantic、
Router、Middleware、Lifespan、`async/await`到底分别是什么？一次HTTP请求如何从18030端口
进入Python函数，又如何变成JSON或SSE回到浏览器？

## 回答：先把6个容易混的角色分开

```mermaid
flowchart LR
    C["HTTP客户端\n浏览器 / curl"]
    U["Uvicorn\n网络服务器"]
    A["ASGI\n服务器↔应用合同"]
    S["Starlette\n底层Web机制"]
    F["FastAPI\n路由 + DTO + OpenAPI"]
    P["Chat应用服务\n产品规则与事务"]

    C -->|"TCP + HTTP"| U
    U -->|"scope / receive / send"| A
    A --> S
    S --> F
    F -->|"Python参数 / DTO"| P
    P -->|"dict / Response / 异步事件"| F
    F --> S --> A --> U --> C
```

| 名称                       | 一句人话                                   | C++参照                                    | Chat里的位置                                                         | 它不是                    |
| ------------------------ | -------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------- | ---------------------- |
| Uvicorn                  | 打开18030端口、收HTTP、再把请求交给Python Web应用的服务器 | 像含`socket/bind/listen/accept`与事件循环的网络主程序 | `.venv/bin/python -m uvicorn ...`                                | 不拥有Session、Run或产品事务    |
| ASGI                     | Uvicorn调用Web应用的标准异步函数合同                | 像稳定回调接口/ABI                              | `app(scope, receive, send)`                                      | 不是进程、HTTP路由或数据库        |
| Starlette                | FastAPI下面的ASGI Web工具箱                  | 像实现网络回调、中间件和Response的基础库                 | FastAPI的底层依赖                                                     | 不是Chat产品模块             |
| FastAPI                  | 把URL/HTTP方法、Python函数、DTO校验和OpenAPI连起来  | 像类型化路由表和请求调度器                            | [`create_app`](../../backend/app/main.py#L39)                    | 不是真正的网络监听进程，也不自动等于业务架构 |
| Pydantic                 | 把JSON检查并转成带类型的Python对象                 | 像“网络解码 + struct字段校验”                     | [`CreateSessionRequest`](../../backend/app/api/contracts.py#L25) | 不是数据库行或领域对象            |
| Chat Application Service | 真正决定产品状态怎样查询/变化的用例逻辑                   | 像持有事务和状态机的业务服务                           | `product_sessions/`、`harness/`、`governance/`等                    | 不应被写在FastAPI Router里   |

最重要的结论是：**Uvicorn负责“收到网络请求”，FastAPI负责“找到哪个协议函数”，
Chat应用服务负责“产品事实发生什么”。**

## 1. 先补3个Python基础

### 1.1 Package、Module和Import

Python中：

- **Module（模块）**通常是一个`.py`文件，例如`backend/app/asgi.py`。
- **Package（包）**是可被分层导入的模块集，例如`backend.app`。
- `from .main import create_app`中的`.`表示从当前Package的`main.py`导入`create_app`符号。

用C++类比：`#include`主要在编译前把声明纳入编译单元；Python `import`是运行时加载模块。
模块第一次在该Python进程中被导入时，顶层语句会从上到下执行；之后通常从`sys.modules`缓存复用。

所以[`asgi.py`](../../backend/app/asgi.py)的：

```python
from .main import create_app
app = create_app()
```

不是两行“声明而已”：导入`backend.app.asgi`时会真正调用`create_app()`，产生一个FastAPI对象。

### 1.2 Class、Object、Function和Method

| Python名称 | 人话 | C++参照 | Chat例子 |
|---|---|---|---|
| class | 对象的类型/行为定义 | `class` | `FastAPI`、`ProductSessionService` |
| object/instance | 一个已创建的具体实例 | 栈/堆上某个类实例 | `app = FastAPI(...)` |
| function | 不必隶属某个对象的可调用代码 | 自由函数 | `create_app()` |
| method | 通过对象调用的函数 | 成员函数 | `product_sessions.list_sessions()` |

Python不需要`new`才能创建普通对象；`FastAPI(...)`会调用类的构造过程并返回实例。

### 1.3 `async def`和`await`

```python
@router.get("/api/ready")
async def ready():
    return await service.readiness()
```

- `async def`定义一个**coroutine function（协程函数）**。调用它先得到可等待对象，由事件循环驱动执行。
- `await`表示当前协程在等数据库/网络时暂时让出执行权，事件循环可以运行其他已就绪协程。
- 它不自动创建新OS线程，也不表示“函数同时把所有东西做了”。
- 如果在`async def`里直接执行很长的CPU计算或阻塞子进程等待，仍然可以卡住事件循环。

C++可以粗略类比为`co_await`和事件循环，但Python `asyncio`的调度和对象模型与C++协程并不相同。

### 1.4 `yield`是什么

`yield`在Chat后端出现在两个完全不同的场景，必须先分开：

#### 场景A：异步上下文管理器中的`yield`（Lifespan）

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    # ---- startup：yield之前 ----
    await database.initialize()
    await worker.start()

    yield  # <-- 暂停在这里，把控制权交回给FastAPI/Uvicorn

    # ---- shutdown：yield之后 ----
    await worker.stop()
    await database.close()
```

这里的`yield`不是"产出数据"，而是**分界点**：

- `yield`之前的代码在应用开始接收请求**之前**运行（startup）。
- `yield`本身表示"现在把控制权交回给框架，框架开始处理请求"。
- `yield`之后的代码在进程关闭时运行（shutdown）。

C++可以粗略类比为：你有一个`init()`和一个`cleanup()`，`yield`是中间那段"服务中"的时间。`@asynccontextmanager`把这个函数变成一个可以`async with`使用的对象——FastAPI在启动时`async with lifespan`进入，关闭时退出。

**Chat真实例子**：[`create_lifespan`](../../backend/app/lifecycle.py#L21)中，`yield`之前做数据库迁移、对账和启动Worker；`yield`期间Uvicorn正常处理HTTP请求；进程收到SIGTERM后执行`yield`之后的代码，先停Worker再断数据库。

#### 场景B：异步生成器中的`yield`（SSE事件流）

```python
async def event_stream():
    sequence = 0
    while True:
        events = await get_new_events(after=sequence)
        for event in events:
            yield sse_encode(event)  # <-- 产出一帧SSE字节，暂停
            sequence += 1
        if not events:
            await asyncio.sleep(0.08)
```

这里的`yield`是**产出值并暂停**：每次`yield`把一帧SSE字节交给`StreamingResponse`，
`StreamingResponse`把它写入HTTP响应socket，然后函数在`yield`处恢复，继续等下一批事件。

C++可以粗略类比为：一个回调函数每次被调用时往输出buffer写一帧，然后return；但Python生成器不需要每次重新进入，它在`yield`处挂起和恢复。

**Chat真实例子**：[`event_stream`](../../backend/app/runtime_execution/endpoint.py#L85)用`yield _sse(event)`逐帧产出SSE字节。每帧包含一个JSON事件（如`RUN_STARTED`、`TEXT_MESSAGE_CONTENT`、`RUN_FINISHED`），Uvicorn把每帧写入同一HTTP响应，直到流结束或客户端断开。

#### 两种`yield`的对比

| 维度 | Lifespan中的`yield` | 生成器中的`yield` |
|---|---|---|
| 作用 | 分界点：startup和shutdown的分隔 | 产出值：每次产出一帧数据 |
| 执行几次 | 整个进程生命周期只经过1次 | 循环中可能执行成百上千次 |
| 交出控制权给谁 | 框架（FastAPI/Uvicorn） | 调用方（StreamingResponse） |
| Chat出现位置 | `lifecycle.py::lifespan` | `endpoint.py::event_stream` |

## 2. Uvicorn命令逐字展开

```bash
.venv/bin/python -m uvicorn backend.app.asgi:app \
  --host 127.0.0.1 --port 18030 --reload
```

| 片段 | 精确含义 |
|---|---|
| `.venv/bin/python` | 启动Chat虚拟环境的CPython可执文件 |
| `-m uvicorn` | 按Python模块规则运行已安装的`uvicorn`package |
| `backend.app.asgi:app` | Uvicorn定义的`module:attribute`字符串；导入`backend.app.asgi`，取出名为`app`的对象 |
| `--host 127.0.0.1` | 只绑定这台电脑的回环网卡 |
| `--port 18030` | 在本机18030端口创建监听socket |
| `--reload` | 开发时用父进程观察文件，变化后重建服务子进程 |

冒号`:`不是Python对象成员语法；它是Uvicorn命令行规则。Python代码里同样的访问写作
`backend.app.asgi.app`（前提是已导入模块）。

### 2.1 Uvicorn启动后的时间线

```mermaid
sequenceDiagram
    participant SH as zsh
    participant PY as CPython
    participant UV as Uvicorn
    participant MOD as backend.app.asgi
    participant FA as FastAPI app
    participant OS as macOS

    SH->>PY: python -m uvicorn ...
    PY->>UV: 运行uvicorn模块
    UV->>MOD: import backend.app.asgi
    MOD->>FA: create_app()
    FA-->>MOD: FastAPI实例app
    MOD-->>UV: 取得app属性
    UV->>OS: bind/listen 127.0.0.1:18030
    UV->>FA: 进入ASGI lifespan.startup
    Note over FA: 迁移/初始化/对账/启动内嵌Worker
    FA-->>UV: startup完成
    Note over UV,FA: 现在才能健康处理请求
```

这解释了为什么`lsof`看到18030还不够：进程可能停在Python断点，或Lifespan初始化尚未完成。

## 3. ASGI是什么：Uvicorn怎样“调用”FastAPI

ASGI应用在概念上是一个可以这样被调用的异步对象：

```python
await app(scope, receive, send)
```

3个参数用人话理解：

| 参数 | 作用 | HTTP例子 |
|---|---|---|
| `scope` | 这条连接/请求的元数据字典 | type、method、path、headers、client |
| `receive` | 异步收取客户端后续输入事件 | HTTP body分块、断开信号 |
| `send` | 异步向服务器发送响应事件 | response start、headers、body分块 |

Chat的[`CorrelationMiddleware.__call__`](../../backend/app/api/request_context.py#L80)就是一个可直接看到
ASGI参数的实现。它在`scope`中读method/path，包装`send`加入`X-Request-ID`，然后调用
`await self.app(scope, receive, send_with_request_id)`把请求继续向内传。

用一次`GET /api/live`走一遍这3个参数：

```python
# ① Uvicorn解码HTTP后，构造scope字典，调用app：
scope = {
    "type": "http",           # 这是一个HTTP请求（不是lifespan或websocket）
    "method": "GET",
    "path": "/api/live",
    "query_string": b"",      # 没有?参数
    "headers": [
        (b"host", b"127.0.0.1:18030"),
        (b"user-agent", b"curl/8.0"),
        (b"accept", b"*/*"),
    ],
    "client": ("127.0.0.1", 54321),  # 客户端IP和端口
}

# ② receive是异步函数，调用时返回客户端发来的下一个事件：
event = await receive()
# 对于简单GET请求，通常直接返回 {"type": "http.request", "body": b"", "more_body": False}
# 对于POST，body会是JSON字节：{"type": "http.request", "body": b'{"title":"..."}', ...}

# ③ send也是异步函数，应用调用它把响应事件发回Uvicorn：
await send({"type": "http.response.start", "status": 200, "headers": [
    (b"content-type", b"application/json"),
    (b"x-request-id", b"a1b2c3d4-..."),  # CorrelationMiddleware插入的
]})
await send({"type": "http.response.body", "body": b'{"status":"live"}'})
# Uvicorn收到这两个事件后，序列化HTTP响应并写入socket
```

所以Middleware很像一圈又一圈的函数包装。用一次真实请求走一遍：

```text
浏览器发送 GET /api/sessions?include_archived=false

① Uvicorn收到TCP字节，解码为HTTP，构造ASGI scope字典：
   scope = {"type": "http", "method": "GET", "path": "/api/sessions",
            "query_string": b"include_archived=false", "headers": [...]}

② CorrelationMiddleware.__call__(scope, receive, send) 被调用：
   - 从scope读method="GET"、path="/api/sessions"
   - 生成request_id="a1b2c3d4-..."
   - 把send包装成send_with_request_id（在response header里插入X-Request-ID）
   - 调用 await self.app(scope, receive, send_with_request_id)  ← 向内层传递

③ FastAPI路由匹配到 list_sessions 函数：
   - 把query_string解析为 include_archived=False（Python bool）
   - 调用 await product_sessions.list_sessions(include_archived=False)

④ ProductSessionService查数据库，返回Session列表

⑤ FastAPI把返回的dict序列化为JSON字节

⑥ 响应向外层回传：
   - send_with_request_id 在http.response.start消息中插入 X-Request-ID: a1b2c3d4-...
   - Uvicorn把HTTP 200响应写回TCP socket

⑦ 浏览器收到响应，React解析JSON并渲染Session列表
```

ASGI还承载`lifespan`和WebSocket等scope。Chat当前Agent主交互是HTTP POST + SSE，不是WebSocket。

## 4. FastAPI App是怎样被“组装”出来的

[`create_app`](../../backend/app/main.py#L39)是**Application Factory（应用工厂）**：每调用一次，
它返回一个隔离的FastAPI应用对象。

```text
create_app
├─ 解析Settings启动快照
├─ build_components：创建Service/Adapter/Worker对象图
├─ FastAPI(...)：创建Web应用对象
├─ install_error_handlers：注册统一错误映射
├─ expose_components：暴露进程内组件给运行边界
├─ add_middleware：注册CORS与request ID中间件
├─ include_router：注册Product REST路由
├─ register_runtime_surfaces：注册AG-UI端点与Runner
└─ return app
```

用一次真实启动走一遍：

```text
你敲下: python -m uvicorn backend.app.asgi:app --port 18030

① CPython启动，加载uvicorn模块
② Uvicorn按"backend.app.asgi:app"规则，import backend.app.asgi
③ asgi.py顶层执行：from .main import create_app; app = create_app()
④ create_app()内部：
   a. Settings.from_env() 读取环境变量和config.json → 得到database_url、log_level等
   b. build_components(settings) → new出ProductDatabase、各Service、Worker
   c. FastAPI(lifespan=create_lifespan(components)) → 创建Web应用对象
   d. install_error_handlers(app) → 注册异常→HTTP映射
   e. add_middleware(CorrelationMiddleware) → 注册中间件
   f. include_router(product_router) → 注册/api/sessions等路由
   g. register_runtime_surfaces(app) → 注册AG-UI端点
   h. return app  ← 此时app对象存在，但数据库还没连、Worker还没启
⑤ Uvicorn拿到app，bind(127.0.0.1, 18030)，listen()
⑥ Uvicorn发lifespan.startup → 进入create_lifespan的yield之前：
   a. product_sessions.initialize() → 建表/迁移
   b. governance.initialize() → 初始化治理规则
   c. 对账过期Lease、终态Run
   d. asyncio.create_task(execution_loop) → 启动内嵌Worker轮询
⑦ yield → Uvicorn开始accept请求 → 现在curl /api/live才会返回200
```

### 4.1 为什么不在一个`main.py`里全做完

| 文件 | 当前责任 | 分开的原因 |
|---|---|---|
| [`asgi.py`](../../backend/app/asgi.py) | 部署导入入口，在这里才加载私有启动配置 | 测试导入`main.py`不应该自动读私有文件/连数据库 |
| [`main.py`](../../backend/app/main.py) | 应用工厂：组装Web表面 | Router、业务规则和进程生命周期不会又混成一文件 |
| [`composition.py`](../../backend/app/composition.py) | 创建进程内对象图，将依赖交给服务 | 业务类不自己到处`new`基础设施，测试可替换边界 |
| [`lifecycle.py`](../../backend/app/lifecycle.py) | 迁移、初始化、对账、内嵌Worker与关闭顺序 | 构造对象不等于启动它；进程资源需确定的开/关顺序 |
| `api/*_router.py` | 解析协议DTO、调用应用服务、映射错误 | Router不应直接成为Product Store事务所有者 |

这个拆分不是为了“每个文件尽量小”，而是4种变化原因不同：部署入口、Web表面、依赖装配和进程生命周期。

### 4.2 `ApplicationComponents`是什么

[`ApplicationComponents`](../../backend/app/composition.py#L89)是一个进程内组件容器。
[`build_components`](../../backend/app/composition.py#L133)创建Product Session、Governance、Harness、Runtime、Worker、
pi、Evidence等实例，再把它们之间的依赖连起来。

C++中可以把它类比为`main()`附近的对象装配区：上层持有`Database`、`Service`、`Worker`，
然后通过构造参数把它们显式连接。

它不是一个“拥有全部业务的超级Service”：它只拥有装配责任，Product Session和Evidence等事实仍归各自模块。

## 5. Router、Decorator和DTO怎样把URL变成函数调用

### 5.1 Decorator是什么

```python
@router.get("/api/live")
async def live() -> dict[str, str]:
    return {"status": "live"}
```

`@router.get(...)`是Python **decorator（装饰器）**语法。可以粗略理解为：定义`live`函数后，
把它交给`router.get("/api/live")`返回的注册器，从而建立`GET + /api/live → live()`关系。

这段代码是在[`create_diagnostics_router`](../../backend/app/observability/diagnostics.py#L298)被调用时执行注册，
不是每次请求都重新定义函数。随后`main.py` 用`app.include_router(...)`把它加到总路由表。

### 5.2 3种真实路由，从易到难

#### A. `GET /api/live`：只证明Python请求链能跑

```text
GET /api/live
→ Uvicorn解析HTTP
→ ASGI Middleware加request ID/日志/耗时
→ FastAPI匹配diagnostics.py::live
→ return {"status": "live"}
→ FastAPI/Starlette序列化为JSON
→ HTTP 200 + application/json
```

请求无body、不读Product Store、不跑MAF、不调Provider。所以它是Liveness（进程请求处理能力），不是全系统健康。

#### B. `GET /api/ready`：还要证明Product Store可用

[`ready`](../../backend/app/observability/diagnostics.py#L306)调用
[`DiagnosticsService.readiness`](../../backend/app/observability/diagnostics.py#L61)，后者用SQL执行`SELECT 1`。

```json
{
  "status": "ready",
  "dependencies": {
    "product_store": "ready"
  }
}
```

数据库失败时，Router把`DiagnosticsUnavailable`映射成HTTP 503 Problem Detail。

#### C. `GET /api/sessions`：进入产品应用服务

[`list_sessions`](../../backend/app/api/product_router.py#L139)不直接写SQL：

```python
values = await product_sessions.list_sessions(include_archived=include_archived)
return {"sessions": values}
```

这里的`include_archived: bool = False`是Query Parameter：

```text
GET /api/sessions?include_archived=true
```

FastAPI会把字符串`true`解析为Python `bool`。Router调用`ProductSessionService`，然后将稳定公开投影包装为JSON。

### 5.3 POST JSON怎样变成Pydantic DTO

`POST /api/sessions`的网络body可以是：

```json
{
  "title": "学习FastAPI",
  "model_provider_id": null,
  "model": null
}
```

FastAPI看到[`create_session(command: CreateSessionRequest)`](../../backend/app/api/product_router.py#L130)，会用
[`CreateSessionRequest`](../../backend/app/api/contracts.py#L25)进行：

1. JSON语法解析。
2. 字段类型校验与默认值填充。
3. `extra="forbid"`拒绝未定义字段。
4. 成功后把`command`作为Python DTO对象交给路由函数。

如果body额外带`{"admin": true}`，当前DTO应拒绝，而不是静默忽略一个可能被误以为已生效的字段。

用一次真实POST走一遍Pydantic解析过程：

```text
浏览器发送:
POST /api/sessions
Content-Type: application/json
Body: {"title": "学习FastAPI", "model_provider_id": null, "model": null}

① Uvicorn解码HTTP，receive()返回body字节
② FastAPI看到函数签名 create_session(command: CreateSessionRequest)
③ Pydantic拿到JSON字节，开始解析：
   - "title": "学习FastAPI" → str ✓
   - "model_provider_id": null → Optional[str] = None ✓
   - "model": null → Optional[str] = None ✓
   - extra="forbid"检查：没有多余字段 ✓
④ 生成DTO对象：command = CreateSessionRequest(title="学习FastAPI", model_provider_id=None, model=None)
⑤ 路由函数拿到command，调用 product_sessions.create_session(command)

如果body是 {"title": "学习FastAPI", "admin": true}：
→ Pydantic发现"admin"不在DTO定义中
→ 抛出RequestValidationError
→ install_error_handlers把它映射为HTTP 422 Problem Detail
→ 前端收到 {"code":"VALIDATION_ERROR","message":"...","request_id":"..."}
```

DTO不等于数据库行：`CreateSessionRequest`只是协议输入，Product Session ID、revision、时间和状态由
`ProductSessionService`在产品用例中创建和保存。

## 6. Middleware为什么不直接写到每个Router

Middleware处理对大量HTTP请求都相同的横切责任，例如：

- 生成/接纳request ID。
- 记录HTTP方法、路径、响应码和耗时。
- 创建观测Span与Metrics。
- 加入CORS响应Header。

Chat的[`CorrelationMiddleware`](../../backend/app/api/request_context.py#L69)使用一个request ID覆盖完整ASGI响应生命周期，
包括SSE流结束。如果只在创建`StreamingResponse`对象时记录“已完成”，实际后续流异常会被遗漏。

Middleware不应成为Product Session、Approval或Run的事实所有者：HTTP request ID是传输关联字段，
不是用户身份、Product Session ID或授权凭据。

用一次真实请求走一遍Middleware做了什么：

```text
浏览器发送: POST /api/runtime/agui  （发送一条用户消息）

① CorrelationMiddleware.__call__(scope, receive, send) 被调用
② 读scope["method"] = "POST", scope["path"] = "/api/runtime/agui"
③ 检查请求header中有没有X-Request-ID：
   - 有且合法 → 复用（上游网关已经生成过）
   - 没有 → 生成新的 uuid4，如 "f47ac10b-58cc-..."
④ 设置ContextVar: _request_id.set("f47ac10b-58cc-...")
   → 后续任何代码调用 current_request_id() 都能拿到这个ID
⑤ 记录开始时间: started = time.perf_counter()
⑥ 包装send函数：
   async def send_with_request_id(message):
       if message["type"] == "http.response.start":
           # 在响应header中插入 X-Request-ID: f47ac10b-...
           headers.append((b"x-request-id", b"f47ac10b-..."))
       await send(message)  # 调用原始send
⑦ 调用 await self.app(scope, receive, send_with_request_id)  ← 向内层传递
⑧ 内层处理完毕，响应回传：
   - send_with_request_id被调用，插入header
   - Uvicorn写入socket
⑨ 回到CorrelationMiddleware：
   - 计算耗时: elapsed = time.perf_counter() - started = 0.234秒
   - 记录日志: "POST /api/runtime/agui 200 234ms request_id=f47ac10b-..."
   - 更新Metrics: http_requests_total{method="POST",path="/api/runtime/agui",status="200"}
```

如果不在Middleware做，而是每个Router自己做：
- 每个路由函数都要写一遍“读header、生成ID、记日志、算耗时、更新Metrics”
- 漏掉一个路由就没有request ID
- SSE流结束时无法正确记录耗时（因为StreamingResponse对象创建时流还没发完）

## 7. Lifespan是什么：进程资源的开机和关机顺序

[`create_lifespan`](../../backend/app/lifecycle.py#L21)返回一个异步上下文管理器：

```text
进入yield之前（startup）
├─ Product Store迁移/初始化
├─ Governance/Harness/Repository/Profile/Tool配置初始化
├─ 播种Validation Capability
├─ 对账过期Lease、终态Run、Decision、Workspace、Operation和Artifact
└─ 按Profile启动内嵌Execution/Outbox异步循环

yield（对外服务期）
└─ Uvicorn把HTTP请求交给app

yield之后（shutdown）
├─ 取消Worker Task并等待收敛
├─ 关闭pi执行
└─ 关闭数据库连接
```

用一次真实启动和关闭走一遍：

```text
你敲下 python -m uvicorn backend.app.asgi:app --port 18030

━━━ yield之前（startup）━━━
1. product_sessions.initialize()
   → 执行SQL: CREATE TABLE IF NOT EXISTS product_sessions (...)
   → 执行SQL: CREATE TABLE IF NOT EXISTS product_runs (...)
   → 数据库现在有了正确的表结构

2. governance.initialize()
   → 加载治理规则到内存

3. 对账：扫描status=running但实际已无Worker的Run
   → 把它们标记为outcome_unknown
   → 防止"假运行中"状态

4. asyncio.create_task(execution_loop)
   → 在事件循环中创建一个后台Task
   → execution_loop开始 while True: run_once(); sleep(0.08)
   → Worker现在每80ms检查一次有没有新Job

━━━ yield ━━━
5. yield  ← 控制权交回Uvicorn
   → Uvicorn开始accept()请求
   → 现在 curl http://127.0.0.1:18030/api/live 才会返回200
   → 用户发送消息 → POST /api/runtime/agui → Worker领Job → 模型执行 → SSE输出

━━━ yield之后（shutdown）━━━
你按 Ctrl+C

6. Uvicorn发lifespan.shutdown信号
7. execution_task.cancel()
   → execution_loop的while True被CancelledInterrupt打破
   → Worker停止领取新Job
8. await execution_task  ← 等当前正在执行的run_once()完成
   → 保证不会把执行到一半的Job丢掉
9. await pi_execution.shutdown()
   → 关闭pi执行资源
10. await database.close()
    → 关闭数据库连接
    → 进程退出
```

这里`asyncio.create_task()`创建的是**同一Python进程事件循环中的异步Task**，不是新OS进程。
`Chat Distributed Stack`才会用`backend.app.execution_worker`和`backend.app.outbox_worker`启动独立Python进程。

为什么不在模块导入时直接连数据库/启Worker？

1. 单元测试只想导入类时，不应该偷偷连真实数据库。
2. 启动失败必须让Readiness失败，不能留一个“端口在但状态没准备好”的假健康进程。
3. 关闭顺序要保证不在数据库先断开后还让Worker写终态。
4. 单进程与分布式部署需要复用同一组Service，但选择不同的启动所有权。

### 7.1 从Python进程启动看Lifespan为什么必须存在

第7节给了Lifespan的三段结构，但没说它为什么必须存在。从`python -m uvicorn backend.app.asgi:app --port 18030`敲下去那一刻追起：

1. **CPython启动**：OS fork出Python进程，加载解释器本身。
2. **`-m uvicorn`**：CPython按模块规则运行`uvicorn`包入口。
3. **Uvicorn做OS层网络事**：`socket()`→`bind(127.0.0.1,18030)`→`listen()`，拿到监听socket。纯OS系统调用，和Python对象无关。
4. **Uvicorn要应用对象**：按`module:attribute`规则`import backend.app.asgi`，触发`asgi.py`顶层`app = create_app()`。
5. **`create_app()`只装配对象**：new出`ProductDatabase`、`ExecutionWorker`、各Service并接起来，但**不连数据库、不跑迁移、不启Worker**。

到第5步结束，FastAPI对象已存在，但进程还不能接请求：数据库没连、Schema没迁移、过期Lease没对账、Worker没启。需要一段"准备工作"。

这段准备工作放哪都有问题：

| 候选位置 | 问题 |
|---|---|
| `import`顶层 | 测试、CLI、文档生成都会import，不该偷偷连真实库 |
| `create_app()`里 | 构造对象和启动资源是两个变化原因，混在一起 |
| Router第一次被请求时 | 启动失败要等第一个请求才发现，健康检查失效；每个请求都要检查初始化状态 |
| Uvicorn启动前手动调函数 | 关闭顺序没保障：SIGTERM时谁先停Worker再断数据库？ |

ASGI协议为此规定了`lifespan`这种`scope["type"]`：Uvicorn在`bind/listen`完成后、`accept`请求前发`lifespan.startup`；SIGTERM/SIGINT时发`lifespan.shutdown`。FastAPI/Starlette把它包装成Python异步上下文管理器（`@asynccontextmanager` + `yield`），就是第7节那张三段图。

四个硬约束逼出了这个设计：

1. **import必须无副作用**：测试和工具任意import都不该连真实库或启后台任务。
2. **启动失败必须可观测**：迁移失败时`/api/ready`要返回503，不能"端口在但状态没准备好"。Lifespan startup抛异常→Uvicorn不进入接请求模式。
3. **关闭必须有顺序**：Worker先停→等Job收敛→再断数据库。Lifespan `finally`块保证这个顺序，否则Worker会在数据库断开后还试图写终态。
4. **单进程与分布式复用同一套Service**：[`lifecycle.py:36`](../../backend/app/lifecycle.py#L36)用`durable_store`判断——内存SQLite不启后台Task（用`endpoint.py`同步直驱），durable store才启`execution_loop`。同一组Service对象，不同的Lifespan启动所有权。

### 7.2 Lifespan和`run_once`"轮询"的关系

`ExecutionWorker.run_once`的"轮询"就是Lifespan的产物，理解这一点能消除"方法名叫`run_once`为什么注释说轮询"的困惑：

- Lifespan startup阶段，[`lifecycle.py:123-126`](../../backend/app/lifecycle.py#L123-L126)用`asyncio.create_task(execution_loop())`创建一个**同进程事件循环里的异步Task**（不是新OS进程）。
- `execution_loop`函数体是`while True: run_once(); if not processed: await asyncio.sleep(0.08)`。
- `yield`期间，这个Task和HTTP请求处理协程共享同一事件循环，并行跑。
- Lifespan shutdown时`execution_task.cancel()`，`while True`被打破。

所以`run_once`是**单次粒度**（一次claim+execute），方法名描述单次；Lifespan启动的`execution_loop`把它拼成**持续轮询**，注释描述整体行为。两者不矛盾。`sleep(0.08)`在外层`execution_loop`里，不在`run_once`内部。

调用`run_once`的三个位置：

| 调用方 | 位置 | 行为 |
|---|---|---|
| 进程内Lifespan后台Task | [`lifecycle.py::execution_loop`](../../backend/app/lifecycle.py#L111-L121) | `while True`+`sleep(0.08)`，最常见 |
| 独立Worker进程入口 | [`execution_worker.py`](../../backend/app/execution_worker.py#L43-L58) | `while not signal.is_set()`+`wait_for(signal.wait(), timeout)` |
| 内存SQLite单进程直驱 | [`endpoint.py`](../../backend/app/runtime_execution/endpoint.py#L93-L97) | 仅调一次，不循环 |

## 8. 错误是怎样变成稳定HTTP响应的

FastAPI并不会自动理解Chat领域错误。[`install_error_handlers`](../../backend/app/api/errors.py#L226)
为3类异常建立统一映射：

1. `HTTPException`：Router已经给出HTTP状态和稳定错误信息。
2. `RequestValidationError`：JSON/path/query没通过FastAPI/Pydantic校验。
3. 未处理`Exception`：对外固定为脱敏500，详细栈不直接穿过HTTP边界。

当前公开错误形状是[`ProblemDetail`](../../backend/app/api/errors.py#L63)：

```json
{
  "code": "RESOURCE_NOT_FOUND",
  "message": "请求的资源不存在。",
  "request_id": "<用于查运行日志的ID>",
  "retryable": false,
  "details": null
}
```

为什么不直接`return str(error)`？内部异常可能含绝对路径、SQL、Provider内容或不稳定文案；
前端也无法靠它稳定判断重试、刷新还是请用户处置。

用一次真实错误走一遍：

```text
浏览器请求: GET /api/sessions/nonexistent-session-id/runs

① FastAPI匹配到路由函数，调用 product_sessions.get_runs(session_id="nonexistent-...")
② ProductSessionService查数据库，找不到Session
③ 抛出 ResourceNotFoundError("Session not found")  ← Python异常，含内部信息
④ install_error_handlers捕获，映射为：
   HTTP 404
   Content-Type: application/json
   Body: {
     "code": "RESOURCE_NOT_FOUND",
     "message": "请求的资源不存在。",
     "request_id": "a1b2c3d4-...",
     "retryable": false,
     "details": null
   }
⑤ 浏览器收到404，React显示"资源不存在"提示

注意：原始异常中的内部路径、SQL查询、数据库表名都不会穿过HTTP边界。
前端只看到稳定的code+message+request_id，可以用request_id找运维查日志。
```

## 9. CORS是浏览器边界，不是产品权限

[`create_app`](../../backend/app/main.py#L85)注册`CORSMiddleware`，允许配置中的前端Origin直接18030。

CORS主要防止某个其他网站的JavaScript随意读取Chat API响应。但：

- curl、后端进程和攻击者自己写的HTTP客户端不受浏览器CORS执行。
- 被CORS允许不等于用户已登录或有权读某个Product Session。
- 真实Principal/Role/Grant尚未实现，当前固定本地Scope不能冒充正式Identity。

所以CORS是L2协议/浏览器安全边界，Identity是产品授权模块，两者不能合并。

## 10. 普通JSON响应与SSE StreamingResponse有什么不同

### 10.1 普通REST

```text
请求进来
→ endpoint await应用服务
→ 获得完整dict/DTO
→ 一次序列化完整JSON
→ 响应结束
```

### 10.2 AG-UI + SSE

[`durable_agent_endpoint`](../../backend/app/runtime_execution/endpoint.py#L58)的核心不是立即在Router里跑完Workflow，而是：

1. Pydantic把AG-UI JSON解析成`AGUIRequest`。
2. Product Session Service先提交User Message、Interaction、Product Run和Attempt。
3. Runtime Service创建Job、Cursor和初始Journal事件。
4. Worker在同一或独立Python进程领取Job，再跑MAF Runner。
5. endpoint返回`StreamingResponse(event_stream(), media_type="text/event-stream")`。
6. `event_stream`是异步生成器：按sequence读Journal，每出现一个新事件就`yield`一帧字节（参见1.4节生成器中的`yield`）。
7. Uvicorn把每帧继续写入同一HTTP响应，直到`RUN_FINISHED/RUN_ERROR`或客户端断开。

这里HTTP连接只是"当前订阅窗口"。Product Run和Runtime Job已经在Product Store中有独立生命周期，
所以浏览器断掉SSE不应该默认取消已领取的Job。

用一次真实用户消息走一遍：

```text
用户在Chat输入框发送 "帮我创建一个学习计划" 并回车

① 前端AG-UI Client构造POST请求：
   POST /api/runtime/agui
   Body: {"type":"RUN_STARTED", "threadId":"t-001", "runId":"r-100",
          "messages":[{"role":"user","content":"帮我创建一个学习计划"}]}

② FastAPI/Pydantic把JSON解析为AGUIRequest对象

③ sessions.prepare_agui_run(input_data)：
   - 在Product Store写入User Message、Interaction
   - 创建Product Run（status=accepted）和Attempt
   - 返回accepted字典（含product_run_id, session_id等）

④ runtime.enqueue(accepted, ...)：
   - 在Runtime Job表创建一条Job（status=queued）
   - 分配Cursor（start_sequence=0）
   - 写入Journal初始事件（RUN_ACCEPTED）
   - 返回enqueued字典（含job_id, start_sequence）

⑤ endpoint返回 StreamingResponse(event_stream(), media_type="text/event-stream")
   HTTP响应头发出：200 OK, Content-Type: text/event-stream

⑥ 与此同时，Execution Worker（同进程或独立进程）领到Job：
   - 调用MAF Runner，模型开始生成
   - 每产生一个事件就写入Journal表

⑦ event_stream生成器开始循环（yield的生成器用法）：
   第1轮：读到Journal中RUN_ACCEPTED事件
   → yield b'id: 1\ndata: {"type":"RUN_ACCEPTED",...}\n\n'
   → Uvicorn写入socket → 浏览器收到第1帧

   第2轮：模型开始输出文字，读到TEXT_MESSAGE_START
   → yield b'id: 2\ndata: {"type":"TEXT_MESSAGE_START",...}\n\n'

   第3轮：读到TEXT_MESSAGE_CONTENT（"学习"）
   → yield b'id: 3\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"学习"}\n\n'

   第4轮：读到TEXT_MESSAGE_CONTENT（"计划"）
   → yield b'id: 4\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"计划"}\n\n'

   ... 更多帧 ...

   第N轮：读到RUN_FINISHED
   → yield b'id: N\ndata: {"type":"RUN_FINISHED"}\n\n'
   → event_stream函数return → StreamingResponse结束

⑧ 浏览器AG-UI Client逐帧解析SSE，React实时渲染文字

如果此时浏览器断网：
- SSE连接断开，但Worker继续执行，事件继续写入Journal
- 用户重连时带Cursor（last sequence），event_stream从断点后续传
- 这就是"HTTP连接只是订阅窗口"的含义
```

## 11. 一次真实HTTP请求穿过了哪些对象

以`GET /api/sessions?include_archived=false`为例。下面同时给出每一层你**实际会看到的Python对象**：

| 时间 | 所在边界 | 当前形态 | 具体例子 | 谁创建/解释 | 下一步 |
|---:|---|---|---|---|---|
| 1 | 网卡/socket | HTTP请求字节 | `b"GET /api/sessions?include_archived=false HTTP/1.1\r\nHost: 127.0.0.1:18030\r\n..."` | 浏览器创建，Uvicorn解码 | ASGI scope |
| 2 | ASGI | scope字典 | `{"type":"http","method":"GET","path":"/api/sessions","query_string":b"include_archived=false","headers":[(b"host",b"127.0.0.1:18030"),...]}` | Uvicorn构造 | Middleware |
| 3 | 传输观测 | ContextVar + scope.state | request_id=`"a1b2c3d4-..."`, started=`time.perf_counter()`=123456.789 | CorrelationMiddleware设置 | FastAPI Router |
| 4 | FastAPI | Python函数参数 | `include_archived=False`（str `"false"` → bool `False`） | FastAPI根据`list_sessions(include_archived: bool = False)`签名解析 | Router函数体 |
| 5 | 应用查询 | Service方法调用 | `await product_sessions.list_sessions(include_archived=False)` | ProductSessionService | SQLAlchemy → Product Store |
| 6 | 产品投影 | Python list of dict | `[{"session_id":"s-001","revision":3,"status":"active","title":"学习FastAPI"}, ...]` | Product Store查询结果，Service做稳定投影 | 返回给Router |
| 7 | FastAPI/Starlette | HTTP响应字节 | `b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Request-ID: a1b2c3d4\r\n\r\n{\"sessions\":[...]}"` | FastAPI dict→JSON序列化，CorrelationMiddleware加header | Uvicorn写socket |
| 8 | socket | TCP字节流 | 同上字节写入TCP | Uvicorn | 浏览器/React解析JSON |

这些对象不能因为都含`session`/`status`字段就共用同一类。网络字节是外部输入，ASGI scope是运输对象，
Query Parameter是协议值，Product Session投影是产品读模型。

## 12. 亲手调试：按难度追3条请求

请使用VS Code `Chat Backend (MAF + FastAPI)`或`Chat Full Stack`。当前工作树可能有临时`breakpoint()`，
如果后端已暂停，先在调试器中Continue；不要为了试命令杀掉不明所有者的Python进程。

### 12.1 第1条：`GET /api/live`

1. 在[`CorrelationMiddleware.__call__`](../../backend/app/api/request_context.py#L80)下断点，观察`scope["method"]`和`scope["path"]`。
2. 在[`live`](../../backend/app/observability/diagnostics.py#L302)下断点。
3. 执行：

```bash
curl -i http://127.0.0.1:18030/api/live
```

4. 预期：第1个断点看到`GET`/`/api/live`；第2个断点无body/无Product Run；响应包含`X-Request-ID`和`{"status":"live"}`。

### 12.2 第2条：`GET /api/ready`

1. 在[`ready`](../../backend/app/observability/diagnostics.py#L306)和
   [`DiagnosticsService.readiness`](../../backend/app/observability/diagnostics.py#L61)下断点。
2. 执行：

```bash
curl -i http://127.0.0.1:18030/api/ready
```

3. 观察`await session.execute(text("SELECT 1"))`说明现在比`/api/live`多验证了Product Store。

### 12.3 第3条：`GET /api/sessions`

1. 在[`list_sessions`](../../backend/app/api/product_router.py#L139)下断点。
2. 执行：

```bash
curl -i 'http://127.0.0.1:18030/api/sessions?include_archived=false'
```

3. 观察`include_archived`已经是Python `False`，`values`是服务返回的稳定投影。
4. 这是只读查询，不会新建Session、Run或Provider Attempt。

### 12.4 进阶：在浏览器追AG-UI POST + SSE

1. 打开前端Network，发送一条SC01输入族消息。
2. 在[`durable_agent_endpoint`](../../backend/app/runtime_execution/endpoint.py#L58)观察`request_body`/脱敏`input_data`。
3. 观察`accepted`与`enqueued`：前者是Product输入事实结果，后者是Runtime Job/Cursor结果。
4. 在[`event_stream`](../../backend/app/runtime_execution/endpoint.py#L85)观察`sequence`和事件类型，不输出完整Prompt/Provider Payload。

## 13. 修改后端时怎样判断应该改哪里

| 需求 | 第一个应看的边界 | 不应该先改 |
|---|---|---|
| 增加一个只读诊断投影 | Diagnostics Query Service + Router + 响应合同 | 不在Uvicorn或MAF里加 |
| 增加Session标签 | Conversation/Product Session领域对象与事务，再加DTO/Router | 不只在React或Router dict中存 |
| 改HTTP公开错误形状 | `api/errors.py`、OpenAPI指纹和前端API Client | 不让每个Router自己返一套 |
| 修复Run断线续传 | Runtime Job/Event/Cursor + 前端重放Hook | 不把SSE socket本身当Product Run |
| 新增一个Workflow端点 | Workflow Catalog/Runner + Runtime Surface注册 | 不在Uvicorn命令里硬编路由 |
| 开启独立Execution Worker | `create_api_app`和Worker CLI/部署配置 | 不复制一份FastAPI业务逻辑 |

原则是：**先找谁拥有产品事实和事务，然后再把HTTP作为它的一个适配入口。**

## 14. 常见误区

| 误解 | 正确理解 |
|---|---|
| FastAPI就是后端的全部 | FastAPI是HTTP/ASGI适配层；Chat的产品模块、MAF和执行层都在它之外有独立责任 |
| Uvicorn会帮我保存Session | Uvicorn不理解Product Session；它只运行ASGI应用和管网络 |
| `async def`就是新线程 | coroutine通常在同一事件循环协作调度，不自动等于OS线程 |
| Router里能拿数据库就应该直接写 | 能做不表示责任正确；事务与状态机应归Application Coordinator |
| Pydantic Model就是Domain Model | DTO只负责协议字段；领域对象有自己的身份、状态机和生命周期 |
| `include_router`会启动新服务 | 它只把路由加到同一FastAPI App，不创建OS进程 |
| SSE断开就等于Run取消 | 当前合同下订阅与Product Run/Runtime Job生命周分开 |
| CORS允许了就是已授权 | CORS是浏览器Origin规则，不是Principal/Role/Grant |

## 15. 掌握验收

### 15.1 复述题

1. Uvicorn、ASGI、Starlette、FastAPI、Pydantic和Chat Application Service分别负责什么？
2. `backend.app.asgi:app`中的点和冒号分别由什么规则解释？
3. 为什么导入`asgi.py`会调用`create_app()`，而只导入`main.py`不应该自动读私有配置？
4. ASGI的`scope/receive/send`分别是什么？
5. `async def`与新OS线程有什么区别？
6. Decorator怎样把`GET /api/live`与`live()`关联起来？
7. Pydantic DTO为什么不是数据库行或Product Session领域对象？
8. `create_app`、`build_components`、`create_lifespan`和Router分别拥有什么责任？
9. `GET /api/live`、`GET /api/ready`和`GET /api/sessions`各自比前一个多验证了什么？
10. 为什么AG-UI endpoint要先建Product Run/Job，再用`StreamingResponse`读Journal，而不把Workflow生命周期绑在HTTP socket上？

### 15.2 定位与修改题

1. 要给`/api/ready`增加一个无敏感的依赖状态，哪个Query Service和Router要改？哪些不应改？
2. 要给Product Session增加一个持久字段，为什么不能只修改`CreateSessionRequest`？
3. 如果Router内开了数据库事务又调用会自己提交的Service，会产生什么边界问题？
4. 如果SSE已发`RUN_FINISHED`，但Product Store终态提交失败，为什么会造成“假成功”？当前Product Finalization Gate在保护什么？

能独立回答这些问题，并在断点中亲眼看到3条请求，才算完成后端框架基础L1/L2。

## 关键文件

| 文件 | 文件类型 | 主要责任 |
|---|---|---|
| [`backend/app/asgi.py`](../../backend/app/asgi.py) | 部署入口 | Uvicorn导入它并取`app` |
| [`backend/app/main.py`](../../backend/app/main.py) | Application Factory | 组装FastAPI Web表面 |
| [`backend/app/composition.py`](../../backend/app/composition.py) | Composition Root | 创建进程内Service/Adapter/Worker对象图 |
| [`backend/app/lifecycle.py`](../../backend/app/lifecycle.py) | Process Lifecycle | 初始化、对账、内嵌Worker与关闭 |
| [`backend/app/api/contracts.py`](../../backend/app/api/contracts.py) | HTTP DTO | 校验网络输入，不拥有产品事实 |
| [`backend/app/api/product_router.py`](../../backend/app/api/product_router.py) | REST Adapter | 产品资源URL与Application Service调用 |
| [`backend/app/api/request_context.py`](../../backend/app/api/request_context.py) | ASGI Middleware | request ID、日志、Metrics和Span |
| [`backend/app/api/errors.py`](../../backend/app/api/errors.py) | Error Adapter | 脱敏Problem Detail和统一异常映射 |
| [`backend/app/observability/diagnostics.py`](../../backend/app/observability/diagnostics.py) | Query + Router | Liveness、Readiness和脱敏运行诊断 |
| [`backend/app/runtime_execution/endpoint.py`](../../backend/app/runtime_execution/endpoint.py) | AG-UI/SSE Adapter | 接纳Run、入队Job、按Journal输出SSE |

## 补充记录

- 2026-07-30：按当前安装版本与Chat源码建立首版；不把通用FastAPI教程与当前项目行为混合。
- 2026-07-31：补充第7.1节（从Python进程启动看Lifespan为什么必须存在）和第7.2节（Lifespan与`run_once`"轮询"的关系），回应"方法名叫`run_once`为什么注释说轮询"的困惑；同步刷新`worker.py::run_once`的docstring与块注释，修正"sleep 0.08秒"归属（外层`execution_loop`，非方法内部）。
- 2026-07-31：新增第1.4节（`yield`是什么），区分Lifespan上下文管理器中的`yield`（分界点）和SSE生成器中的`yield`（产出值）；为第3节ASGI、第4节create_app、第5.3节Pydantic DTO、第6节Middleware、第7节Lifespan、第8节错误处理、第10.2节AG-UI SSE和第11节请求链路补充具体例子，使每层流程都能对照实际对象走一遍。
