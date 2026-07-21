# Session 持久化研究、证据与方案推导

> 定位说明：本文是持久化与首个文本回合的证据底稿，不是完整Session能力全集或开发路线。总体审核请先阅读[Session能力全集](./session-capability-catalog.md)和[Session交付路线](./session-delivery-roadmap.md)。

> 状态：`限定研究已完成；作为总体规划证据底稿；D1-D6暂停审核；尚未创建Schema、迁移或持久化服务`
>
> 更新日期：2026-07-21
>
> 阅读顺序：先审核能力全集与交付路线；批准后，再按本文、[候选设计](./session-persistence-design.md)和[审核包](./session-persistence-review.md)重审Phase 1的D1-D6。

## 1. 先给结论：研究后改变了什么

这一轮不是在旧方案上补几张表，而是纠正了历史所有权和成功语义。当前最重要的 6 个结论是：

1. **Product Session、MAF AgentSession/Workflow Checkpoint、AG-UI Thread、Product Agent Run 是 4 个不同对象。** 第一阶段可以让 Product Session ID 与 AG-UI `threadId` 同值，但职责、授权和生命周期不能合并；Product Agent Run 必须有独立身份。
2. **Product DB 是产品事实源。** AG-UI Snapshot 只有 `messages/state/interrupt`，保存失败会被当前 MAF 适配器吞掉，仍可能发送 `RUN_FINISHED`，所以它不能承担 Product Message 或 Product Run 的提交。
3. **MAF 原生 `HistoryProvider` 可以成为唯一模型历史加载器和模型可见 Checkpoint 的持久化扩展点。** 当前版本探针证明：`save_messages()` 成功返回发生在 `RUN_FINISHED` 前；它抛出异常会转成 `RUN_ERROR`，不会再发送 `RUN_FINISHED`。这只证明 Hook 顺序，不证明耐久事务；耐久性必须由 ProductHistoryProvider 的数据库实现合同保证。Checkpoint 也不是已提交的 Product Message，不能把 Product Agent Run 置为成功。
4. **不能让 `@ag-ui/client` 的全历史和 `HistoryProvider` 同时进入模型。** 当前客户端每次默认发送自己的全部 `messages`；实测第二轮会出现 `q1,a1,q1,a1,q2`。因此需要一个很薄的服务端输入适配层：校验浏览器前缀，只把可信的新后缀交给 MAF。
5. **显式 `store=False` 还不够。** OpenAI Client 即使不返回 `conversation_id`，仍可能返回 `response_id`，当前 AG-UI 适配器会据此改写协议 Run ID。实测必须同时启用 `require_per_service_call_history_persistence=True` 和本地 `HistoryProvider`，才会抑制这些 Provider Response ID，并在工具循环的每次模型调用间保存/重载历史。
6. **第一阶段推荐一个 SQLite 物理部署、两个逻辑存储，不持久化 AG-UI Snapshot。** Product 表保存权威事实；接纳成功的 Product User Message 立即是 `committed/context_eligible`。HistoryProvider Checkpoint 表保存绑定 Product Run、幂等的模型调用历史：只在所属活动 Run 内供后续 Provider Call 使用，不自动成为用户可见 Product Message，也不自动进入新的 Run。页面刷新通过 REST 重建权威消息；等 Shared State、HITL 或断线续传出现明确需求，再增加独立、可重建的运行投影或 Workflow Checkpoint。

这些都是**候选结论**，不是已经批准的项目事实。尤其 D1、D3、D4 会决定 Schema 和运行包装器，用户批准前不得实现。

## 2. 研究问题、顺序与证据等级

### 2.1 研究问题

本文只回答 Session 持久化所需的 7 个问题：

1. 谁拥有可列表、可归档、可授权的产品会话？
2. 谁把历史投影成下一次模型调用的上下文？
3. 用户输入、Assistant 输出、工具状态分别何时提交？
4. 前端收到“成功”时，哪些事实必须已经可重启恢复？
5. 同一 Session 并发、重试、断连和进程崩溃如何解释？
6. MAF Session、AG-UI Thread/Snapshot 与产品对象如何映射？
7. 第一阶段需要哪种存储，而哪些能力应推迟？

### 2.2 严格研究顺序

研究按项目规则串行完成：

1. 先固定当前安装版 MAF 的文档、源码和运行探针结论。
2. 再读取 pi 与 nanobot 的 Session、历史投影、写入时机、失败恢复和并发实现。
3. 最后只加入用户批准的外部产品主参考 **LibreChat**，限定研究 Web Chat 产品对象、运行关联、持久化、失败和续传。
4. 在前 3 层事实固定后，才形成 D1-D6 的当前项目推导。

LibreChat 是当前唯一新增的正式外部项目。其未涉及的问题直接标记“未涉及”，不自动引入第二个项目。

### 2.3 证据等级

| 标记 | 含义 | 本文如何使用 |
|---|---|---|
| `MAF 官方文档事实` | Microsoft Learn 对公开概念、扩展点和安全边界的说明 | 说明框架公开合同，不单独证明当前锁定版本行为 |
| `MAF 安装源码事实` | 本项目 `.venv` 中正在运行的包源码 | 决定当前项目真实行为 |
| `当前依赖实测` | 在当前依赖组合上执行的最小探针 | 验证事件顺序、重复历史、错误传播和 ID 行为 |
| `MAF 参考仓库事实` | 本地 MAF 仓库的源码、测试和示例 | 补充设计意图；与安装版冲突时不能覆盖安装版 |
| `pi/nanobot 参考事实` | 两个本地参考项目的源码和测试 | 提炼产品/工程原则，不决定 MAF API |
| `LibreChat 参考事实` | 固定提交的源码、Schema 和测试 | 补充 Web Chat 产品经验，不决定 MAF 能力 |
| `本项目推导` | 由前述事实推导的 Chat 候选设计 | 必须说明优缺点、适用条件和未验证项 |
| `待审核决定` | 会改变状态所有权、Schema 或失败语义的选择 | 用户批准前不得实现 |

本文所称“当前依赖实测”目前是一次性本地探针结果：事件顺序、双历史和两次 Provider Call 工具循环的探针代码/日志**尚未固化为本仓库测试或 CI 证据**。因此它们足以支持候选设计，但不是长期回归保证；实现前必须先把探针转成可重复的仓库合同测试。

### 2.4 固定版本快照

| 对象 | 版本或提交 | 作用 |
|---|---|---|
| `agent-framework-core` | `1.11.0` | 当前后端核心运行版本 |
| `agent-framework-openai` | `1.10.1` | 当前 OpenAI 兼容 Client 实现 |
| `agent-framework-ag-ui` | `1.0.0rc8` | 当前 MAF 到 AG-UI 适配器 |
| `ag-ui-protocol` | `0.1.20.dev1784331058` | 当前 Python AG-UI 协议对象 |
| `@ag-ui/client` | `0.0.57` | 当前前端 HttpAgent 行为 |
| MAF 本地参考提交 | `9c4cd07899502157284b64a73f9a0adfb4594d96` | 本地源码、测试和示例参考 |
| pi 本地参考提交 | `2b00dade7cec918aefb025c8b7a4fa304a30acdd` | Session Tree、Context 投影和并发参考 |
| nanobot 本地参考提交 | `2c789767280482f38667044f8a3be5102c71dd26` | 保存顺序、Checkpoint 和恢复参考 |
| LibreChat 固定提交 | `8e5ef1fb31e9d63b735c089b21cbc82c50acce46` | 唯一外部产品主参考；提交时间 2026-07-16 |

具体 API 和兼容性以安装源码与实测优先。任何依赖升级后，本文中的事件顺序、ID 抑制和失败传播都必须重测。

## 3. 当前 Chat 的事实：连续对话仍由浏览器偶然维持

当前代码尚未实现服务端 Session 持久化：

1. `backend/app/agents.py` 创建真实 `Agent` 时没有 `context_providers`，也没有显式 `default_options={"store": False}` 和 `require_per_service_call_history_persistence=True`。
2. `backend/app/main.py` 直接注册 MAF AG-UI 端点，没有 Product Application Service、Repository、`AGUIThreadSnapshotStore` 或 Scope Resolver。
3. `frontend/src/use-chat-agent.ts` 在浏览器生成随机 `threadId`，`HttpAgent` 内存保存消息；“新对话”只是更换本地 ID 并清空投影。
4. 当前没有 Session、Message、Interaction、Agent Run、Trace、Snapshot 或 Workflow Checkpoint 的 Schema。

因此当前真实含义是：

1. Bootstrap Agent 只证明 MAF 到 AG-UI 的传输链路，不证明历史或恢复。
2. 真实模型的下一轮连续性依赖浏览器再次发送当前全部消息；刷新、换设备或服务重启后没有产品恢复能力。
3. OpenAI Client 默认又允许服务端历史，产品 ID、协议 ID 和 Provider ID 可能漂移。
4. 前端看到 `RUN_FINISHED` 并不意味着任何产品事实已经提交。

## 4. 必须先分开的 4 个对象

### 4.1 对象定义

| 对象 | 所有者 | 身份与生命周期 | 解决的问题 | 不能替代什么 |
|---|---|---|---|---|
| **Product Session** | 本项目产品层/Product DB | 服务端创建；从创建、打开到归档；受用户/租户 Scope 约束 | 标题、列表、权限、消息、Interaction、运行与 Trace 关联 | 不能用 MAF Session 或浏览器 Thread 代替 |
| **MAF AgentSession / Workflow Checkpoint** | MAF 运行层及其 Store | `AgentSession` 随 Agent 调用恢复 Provider/Context 状态；Workflow Checkpoint 在暂停/恢复点保存运行图状态 | 模型/Provider 上下文、Tool/Workflow/HITL 运行恢复 | 不是产品会话列表、权限或完整审计记录 |
| **AG-UI Thread** | AG-UI 协议层 | `threadId` 关联请求、实时事件、UI State、Interrupt 和可选 Snapshot | 前后端一次或多次 Agent 交互的协议相关性 | `threadId` 不是授权令牌，Snapshot 不是产品事实源 |
| **Product Agent Run** | 本项目产品层/Product DB | 一次被接纳的具体执行；有独立 ID、状态、输入版本、终态和错误语义 | 审核“这次执行发生了什么”，处理幂等、并发、失败和重启对账 | 不能用整个 Product Session 或临时流任务代替 |

`Interaction` 是产品语义上的一次用户意图/协作回合，可以经历 0..n 个 Product Agent Run；第一阶段通常 1:1，但不能因此永久合并。`Message` 是可见记录，`Trace Event` 是可观察事实；二者都不保存隐藏推理。

### 4.2 允许同值，不允许同职责

第一阶段可以采用以下映射：

```text
Product Session.id  ──同值映射──>  AG-UI threadId
        │                              │
        │ owns                         │ correlates
        v                              v
Product Message / Interaction    live AG-UI events
        │
        └── 0..n Product Agent Run
                   │
                   ├── agui_run_id（请求相关性/幂等键）
                   ├── provider_response_id（如存在，仅诊断映射）
                   └── maf runtime/checkpoint reference（未来按需）
```

这不表示两个对象合并：

1. Product Session 的所有权必须由认证 Scope 查询验证，不能因为调用者知道 `threadId` 就允许读取。
2. Product Agent Run 使用服务端 Product ID；客户端传入的 AG-UI `runId` 单独保存并验证请求摘要，不能直接成为数据库主键和授权依据。
3. Provider Response/Conversation ID 不得覆盖 Product Session 或 AG-UI ID。
4. Workflow Checkpoint 将来按 `run/checkpoint` 自己的键保存，不能把整个 Session 最新状态覆盖成一行不透明 JSON。

### 4.3 为什么必须有 Product Agent Run

只保存 Message 无法回答：

1. 同一个请求是否已经被接纳，重复请求应返回旧结果还是重新执行？
2. 用户消息已提交、模型尚未完成时，系统处于 `running`、`interrupted` 还是 `failed`？
3. 哪个 Run 生成了哪条 Assistant Message，哪次失败没有生成可见答案？
4. 进程重启后残留的 `running` 是否应该重跑？
5. 一个 Interaction 因审核/恢复产生多次 Run 时，如何保留全部事实？

MAF、pi、nanobot和LibreChat都没有替当前产品直接提供这张权威对象；它必须由本项目定义。

## 5. MAF：原生支持什么，不负责什么

### 5.1 `AgentSession` 与 Workflow Checkpoint

`MAF 官方文档事实`：`AgentSession` 是跨 Agent 调用携带会话状态的容器，应用可以序列化并自行保存；服务侧 Session ID 仍需应用建立所有权映射并鉴权。

`MAF 安装源码事实`：

1. `.venv/.../agent_framework/_sessions.py:913-985` 将 `AgentSession` 定义为带 `session_id`、`service_session_id` 和 `state` 的轻量容器。
2. `state` 由不同 Context/History Provider 按自己的 `source_id` 保存状态。
3. `to_dict()/from_dict()` 只提供序列化，不替应用提供数据库、事务、归档、列表或 Scope。
4. 当前 AG-UI 适配器在每次请求创建新的 `AgentSession(session_id=thread_id)`；见 `.venv/.../agent_framework_ag_ui/_agent_run.py:1818-1824`。

Workflow Checkpoint 的目标是恢复工作流执行位置、状态和 Interrupt，不是完整 Product Message 历史。当前第一阶段只有文本 Agent Run，没有 Workflow/HITL，不能为了“以后也许会用”先创建没有消费者的 Runtime 表。

**本项目含义**：第一阶段 Product DB 不能被 `AgentSession.to_dict()` 代替；第一阶段也不需要把请求级 `AgentSession` 持久化。未来真正引入 Provider State、Workflow 或 HITL 时，再为其建立独立运行时存储和引用关系。

### 5.2 `HistoryProvider` 是 MAF 的原生历史扩展点

`MAF 安装源码事实`：

1. `.venv/.../agent_framework/_sessions.py:426-547` 定义 `HistoryProvider.get_messages()`、`save_messages()`、`before_run()` 和 `after_run()`。
2. `before_run()` 在模型调用前加载消息；`after_run()` 可保存输入、其他 Provider 上下文和输出。
3. `InMemoryHistoryProvider` 把消息放入 `AgentSession.state`，只有应用同时保存并恢复 AgentSession 才能跨进程。
4. `FileHistoryProvider` 是实验能力，使用明文 JSONL，没有跨进程/跨主机锁，也不是完整 Session Snapshot。
5. `_agents.py:1137-1206` 的流式结果 Hook 会在流耗尽时生成最终 Response，并调用 Provider 的 `after_run()`。
6. `_types.py:3241-3262` 的 `ResponseStream` 在 `StopAsyncIteration` 时自动 Finalize，因此正常消费完整流是触发结果 Hook 的必要条件。

这意味着本项目可以实现数据库型 `ProductHistoryProvider`：加载时从 `committed/context_eligible` Product Message 投影上下文，并合并当前 Product Run 中 `save_messages()` 已成功返回的模型可见 Checkpoint；保存时按实现合同，用耐久数据库事务把每次模型服务调用产生的输入/输出写成绑定该 Product Run 的幂等 Checkpoint。接纳事务让当前 User 占用 `history_cutoff_revision`，当前 Run 第一次加载只取 `revision < history_cutoff_revision` 的历史，并再次按 `current_user_message_id` 排除；当前 User 已由请求 Delta 传入，不能再从 Product 表重复加载。第一次 Provider Call 后，该 User 可随本 Run Checkpoint 供同一 Run 后续 Provider Call 使用。Checkpoint 可以与 Product 表位于同一个 SQLite 文件，但必须使用独立表/Repository 和可见性规则，不能由 HistoryProvider 直接冒充已提交 Product Message。

MAF 不负责：

1. Product Session 标题、列表、归档和授权。
2. Product Agent Run 状态机、请求幂等和跨进程互斥。
3. 完整历史与有限模型上下文之间的产品裁剪政策。
4. Product Message、Interaction、Trace 与 Runtime Checkpoint 的事务关系。

### 5.3 实测一：`HistoryProvider` 可以在终态前形成保存失败门

`当前依赖实测`，使用当前安装版 MAF 和预包装 `AgentFrameworkAgent`：

```text
HistoryProvider.load
-> RUN_STARTED
-> TEXT_MESSAGE_START
-> TEXT_MESSAGE_CONTENT
-> HistoryProvider.save_messages(user, assistant)
-> TEXT_MESSAGE_END
-> MESSAGES_SNAPSHOT
-> RUN_FINISHED
```

把 `save_messages()` 注入异常后，HTTP 仍是 SSE 的 `200`，但事件变为：

```text
RUN_STARTED
-> TEXT_MESSAGE_START
-> TEXT_MESSAGE_CONTENT
-> RUN_ERROR(RuntimeError)
```

没有 `TEXT_MESSAGE_END`、`MESSAGES_SNAPSHOT` 和 `RUN_FINISHED`。

**已证实的边界**：

1. 探针证明 `save_messages()` 抛错可以阻止正常终态，不需要依赖 Snapshot Store 的回执。
2. 这只证明 Hook 成功返回发生在终态前；探针 Provider 不是本项目尚未实现的 SQLite 耐久 Store，因此不能据此声称 Checkpoint 已完成数据库事务。ProductHistoryProvider 必须自行保证“成功返回即耐久写入已提交”。
3. 它不自动创建 Product Message/Run，也不判断一次带工具的多服务调用何时算最终成功。
4. 探针中的 `save_messages(user, assistant)` 表示 MAF 传给 HistoryProvider 的模型历史载荷；实现只能为所属 Run 幂等写 Checkpoint，不能再次插入或降级接纳事务已经提交的 Product User。
5. 如果自定义消费者没有完整迭代 ResponseStream，结果 Hook 是否运行必须由调用方测试保证。
6. 该事件探针尚未进入本仓库测试；实现前必须固化正常顺序与异常顺序，之后依赖升级也要运行。

### 5.4 实测二：`store=False` + per-service 历史在工具循环中的行为

使用真实 `OpenAIChatClient` 子类、一个两次模型调用的工具循环，启用：

```python
Agent(
    ...,
    context_providers=[product_history_provider],
    default_options={"store": False},
    require_per_service_call_history_persistence=True,
)
```

`当前依赖实测`事件与历史 Hook 顺序：

```text
load
-> RUN_STARTED
-> tool-call 流
-> save(user, assistant/function_call)
-> tool result
-> load
-> final text 流
-> save(tool, assistant/final)
-> MESSAGES_SNAPSHOT
-> RUN_FINISHED
```

探针记录到的 Provider-visible 模型序列为：

```text
user
-> assistant function-call
-> tool result
-> assistant final
```

同时验证：

1. 两次 Provider 调用产生的 `response_id` 都被 MAF 抑制。
2. AG-UI `thread_id/run_id` 保持客户端传入的 Product/协议 ID，没有被 Provider ID 替换。
3. `_agents.py:532-560` 表明启用 per-service 后，由 per-service middleware 负责 HistoryProvider 持久化，once-per-run 的 `after_run` 会跳过 HistoryProvider，避免双写。
4. `_agents.py:879-906,1308-1327,1448-1462` 区分服务托管历史与本地历史；本地 `store=False` 路径加载 Provider，并抑制 Response ID。

**代价和限制**：

1. 每一次 `save_messages()` 是“所属活动 Run 下一次模型调用可见的历史 Checkpoint”，既不是 Product Message 已提交，也不是 Product Agent Run 已成功；Checkpoint 必须绑定 Product Run、幂等，并默认禁止跨入新的 Run。
2. Product Assistant Message 与 Product Run `succeeded` 只能由外层终态事务一起提交；不能由一次 per-service `save_messages()` 推断。
3. 如果工具执行完成后、下一次模型调用前进程中止，工具结果还没有进入下一次 per-service 保存。产品级 Tool Execution/Evidence 将来仍需独立、即时落库，不能只依赖 HistoryProvider。
4. 真实远端模型、真实工具异常、断连和取消尚未完成故障注入；见第 13 节。
5. 这次工具循环、Response ID 抑制和双调用顺序仍是一次性探针，尚未固化为本仓库合同测试。

### 5.5 为什么只有 `store=False` 仍不够

`MAF 安装源码事实`：

1. `agent_framework_openai/_chat_client.py:389-390` 声明 OpenAI Client 默认服务存储历史。
2. `:902-914` 显示 `store=False` 时不会把 Response/Conversation ID 作为 `conversation_id`。
3. 但 `:2622-2644,2828-2843,3180-3189` 仍会在 Response/Update 上保留 `response_id`。
4. `agent_framework_ag_ui/_agent_run.py:1920-1928` 会在第一个 Update 上用 `response_id` 替换事件 `run_id`，用 `conversation_id` 替换 `thread_id`。
5. 只有前述本地 per-service HistoryProvider 路径会通过 `_agents.py` 的 `suppress_response_id` 抑制 Provider Response ID。

因此当前候选不是“随手加 `store=False`”，而是一个成组合同：

```text
ProductHistoryProvider（唯一 load_messages=True；写模型可见 Checkpoint）
+ store=False
+ require_per_service_call_history_persistence=True
+ 服务端输入适配
+ Product Run 终态包装
```

缺少其中任何一项，都可能重新出现历史双加载、Provider ID 漂移或错误成功。

另一个 `当前依赖实测` 说明不能期待前端替后端自动修正映射：初始 `HttpAgent.threadId=client-thread`，服务端依次发送 `RUN_STARTED(threadId=server-thread)` 与 `RUN_FINISHED` 后，`@ag-ui/client 0.0.57` 的 `agent.threadId` 仍是 `client-thread`。所以 Provider/服务端改写事件 ID 不会自动成为下一轮客户端 ID，稳定映射必须由服务端合同保证；升级客户端后需重测。

### 5.6 当前 AG-UI Client 会发送全历史，双加载已实测

`当前依赖源码事实`：`frontend/node_modules/@ag-ui/client/dist/index.mjs` 中 `prepareRunAgentInput()` 会复制 `this.messages`、过滤 `activity`，然后把剩余全部消息放入请求。

`当前依赖实测`：

1. 第一轮探针 HistoryProvider 记录 `q1,a1`。
2. 第二轮客户端发送 `q1,a1,q2`。
3. 第二轮探针 HistoryProvider 又加载 `q1,a1`。
4. 模型实际收到 `q1,a1,q1,a1,q2`。

所以不能简单地“加一个数据库 HistoryProvider”。推荐的服务端输入适配职责只有 4 项：

1. 用认证 Scope 读取 Product Session 和权威历史。
2. 检查浏览器携带的历史前缀是否与服务端记录一致；浏览器 Assistant 消息永远不能覆盖服务端事实。
3. 识别并接纳可信的新 User/Resume 后缀；在短事务内把 Product User Message 写为 `committed/context_eligible` 并分配 Revision，创建 Interaction 和 Product Agent Run，并在 Run 上记录等于当前 User Revision 的 `history_cutoff_revision` 与 `current_user_message_id`。
4. 只把当前新后缀交给 MAF，由 ProductHistoryProvider 加载此前的模型上下文。

它不重写 MAF 的 Agent-to-AG-UI 事件转换，只做产品边界和输入去重。

#### 5.6.1 Product Run 身份如何安全传给 HistoryProvider 尚未验证

当前候选要求每条 History Checkpoint 绑定可信 `product_run_id`，但 MAF 的 HistoryProvider Hook 不替产品完成这个身份映射。客户端 `runId` 是外部输入，`AgentSession.session_id` 在当前 AG-UI 路径表示 Thread/Product Session；Provider **不得**仅凭二者之一猜测 Product Run，更不能把客户端 `runId` 直接当授权或数据库主键。

`实现前合同/Spike`建议由薄包装器在完成认证、幂等校验和接纳事务后建立可信 Run Context，再让 ProductHistoryProvider 读取。至少有 2 种待验证机制：

1. 显式、不可由客户端构造的 Run Context 对象，沿包装器与 Provider 的调用边界传递。
2. 请求作用域 `ContextVar`，以 Token 在 `try/finally` 中严格设置/重置；还必须证明 MAF 流式迭代、工具任务和并发请求不会串值。

当前不预先冻结其中一种。正式 Schema 前必须先做并发隔离 Spike：两个 Session 并发、同一 Session 的冲突请求、Provider 异常和流取消时，Checkpoint 都只能绑定接纳事务返回的 Product Run，且请求结束后上下文没有泄漏。这个传递合同未验证前，文中的 `product_run_id` 只是候选逻辑字段，不是已解决的实现事实。

本节的双历史探针同样尚未固化为仓库测试；输入裁剪与 History Load 的组合必须先转成可重复合同测试。

### 5.7 AG-UI Snapshot 的能力和失败边界

`MAF 安装源码事实`：

1. `_snapshots.py:33-50` 的 `AGUIThreadSnapshot` 只有 `messages`、`state` 和 `interrupt`。
2. 它不保存 Product Session 元数据、认证声明、原始事件、诊断、Trace、Provider 响应或 Product Agent Run。
3. Store 使用 `(scope, thread_id)` 保存 latest-only Snapshot；内置内存 Store 只适合开发/演示/测试。
4. `_endpoint.py:54-73` 要求配置持久 Snapshot Store 时必须同时配置 Scope Resolver，因为 `threadId` 不是授权。
5. `_agent_run.py:1699-1714` 会把 Snapshot 消息装入输入；若同时再用 ProductHistoryProvider 加载同一历史，就会形成另一个双加载源。
6. `_agent_run.py:1619-1646` 捕获 Snapshot 保存的全部异常，只记录日志并继续。
7. `_agent_run.py:2177-2193` 在尝试保存 Snapshot 后发送 `RUN_FINISHED`；保存失败不会自动改为 `RUN_ERROR`。

**结论**：Snapshot 适合恢复 UI Message/Shared State/Interrupt 投影，但不是产品提交门。第一阶段只有文本消息时，可以完全不持久化 Snapshot，页面通过 REST 读取 Product Message 重建；未来增加 Snapshot 时也必须能从产品/运行事实重建，并允许失败后丢弃。

### 5.8 MAF 对当前方案真正提供的基线

| 能力 | MAF 是否直接提供 | 当前项目还要做什么 |
|---|---|---|
| 模型历史加载/保存 Hook | 是，`HistoryProvider` | ProductHistoryProvider、上下文裁剪、绑定 Run 的幂等 Checkpoint；不能直接提交 Product Message |
| 工具循环每次模型调用间持久化 | 是，per-service 模式 | Product Tool Execution/Evidence 仍需独立记录 |
| Provider 历史关闭 | 是，`store=False` | 升级合同测试，避免默认值回归 |
| AG-UI 事件转换 | 是，`AgentFrameworkAgent` | 薄输入适配和终态提交门，不另建事件协议 |
| UI Snapshot | 是接口；内置持久实现否 | 第一阶段不持久；未来按需求实现投影 Store |
| Product Session/Message/Run | 否 | 本项目领域模型和 Repository |
| 鉴权、幂等和同 Session 互斥 | 否 | Product Application Service + DB 约束 |
| Workflow/HITL Checkpoint | MAF 有独立能力 | 当前未接入；到对应阶段另做设计和验证 |

## 6. pi：参考完整记录与模型上下文分离

### 6.1 它解决的问题

pi 是成熟的本地编码 Agent，需要保留完整工作过程、工具结果、模型/思考级别切换、Compaction、分支和扩展状态，同时不能把整个历史无界发送给下一次模型调用。

### 6.2 源码事实

1. `packages/agent/src/harness/types.ts:334-478` 定义类型化 Session Tree Entry，以及可替换的 `SessionStorage`、`SessionRepo`；Repository 负责 create/open/list/delete/fork。
2. `packages/agent/src/harness/session/session.ts:22-79` 的 `buildSessionContext()` 从持久化路径投影本轮消息、模型、思考级别和活动工具。
3. 同文件 `:127-266` 以 `id/parentId/timestamp` 的类型化 Entry 追加记录，通过 Leaf 移动表达分支。
4. `jsonl-storage.ts:8-15` 定义格式版本 3；`:201-269` 创建 Header 并追加 Entry；`:285-297` 从 Leaf 回溯活动路径。
5. `packages/coding-agent/src/core/session-manager.ts:780-790` 明确区分追加式完整 Tree 与 `buildSessionContext()` 生成的 LLM Context，并包含旧格式迁移。
6. `packages/agent/src/agent.ts:334-345` 拒绝第二个普通 Prompt；正在运行时只能使用定义明确的 `steer` 或 `followUp`。
7. `packages/coding-agent/test/agent-session-concurrent.test.ts:130-177,485-628` 验证普通并发拒绝、显式队列，以及异步扩展下 User、Assistant、Tool Result、Assistant 的保存顺序。

### 6.3 必须保留的限制

pi 的新 Harness Store 与成熟 Coding Agent SessionManager 写入时机不同：

1. `JsonlSessionStorage` 创建文件后立即追加 Entry。
2. Coding Agent 的 `SessionManager._persist()` 在新 Session 还没有 Assistant 消息时，先把 User Entry 留在内存；第一条 Assistant 到达后再整体写盘。

因此 pi 证明了完整 Session 恢复、类型化记录和 Context 投影，但 Coding Agent 路径**没有证明用户输入在模型前一定物理落盘**。它减少 CLI 空 Session 文件的取舍不适合直接复制到 Web 产品。

### 6.4 采用、改造和不采用

| 分类 | 内容 | 原因 |
|---|---|---|
| 采用 | 完整记录与 LLM Context 投影分离 | 对应“完整历史是证据，但不应无界进入上下文” |
| 采用 | 类型化、追加式记录和格式版本 | 为 Message、Tool、Compaction 与 Trace 演进留迁移路径 |
| 采用 | 同 Session 只允许一个普通运行 | 保护消息和工具顺序 |
| 改造 | `steer/followUp` | 第一阶段先返回 `SESSION_BUSY`；产品交互定义后再增加 |
| 不采用 | JSONL 作为 Web Chat 权威库 | 不适合多对象查询、事务、唯一约束与未来多进程 |
| 不采用 | 第一阶段实现分支、Label、Compaction 和 Extension Entry | 有价值但不是文本 Session 恢复前置 |
| 不采用 | 等 Assistant 出现再首次写盘 | 与“不丢已接纳用户输入”冲突 |

## 7. nanobot：参考模型前保存、Checkpoint 和故障恢复

### 7.1 它解决的问题

nanobot 是长期运行、多聊天通道的 Agent Loop。它直接面对外部消息已经到达，但模型、工具、进程或文件系统可能在回合中失败的问题。

### 7.2 Session 存储与 Context 投影

1. `nanobot/session/manager.py:124-153` 保存完整 Messages、Metadata、时间和 `last_consolidated`。
2. `:155-281` 的 `get_history()` 只投影未压缩尾部，按消息数和 Token 预算裁剪，从合法 User 边界开始，去掉孤立 Tool Result。
3. `:428-447` 用可逆 base64url 生成无碰撞存储键，迁移旧路径时核对文件内原始 Key。
4. `:525-617` 跳过损坏 JSONL 行并恢复有效记录。
5. `:629-674` 先写临时文件再 `os.replace`，可选 `fsync` 文件和目录；测试覆盖原子替换、损坏修复和优雅关机。

### 7.3 回合写入顺序与恢复

`nanobot/agent/loop.py:236-247` 的状态顺序为：

```text
RESTORE -> COMPACT -> COMMAND -> BUILD -> RUN -> SAVE -> RESPOND -> DONE
```

关键行为：

1. `:624-656` 在模型运行前保存 User 消息，设置 `pending_user_turn` 并立即保存 Session。
2. `:1507-1528` 下一轮开始先恢复 Checkpoint 或只有 User 的未完成回合。
3. `:1676-1716` 保存最终回合、清理 Pending/Checkpoint，然后才进入对外响应。
4. `nanobot/agent/runner.py:416-495` 在工具执行前保存 Assistant Tool Call 和 Pending Tool，完成后保存 Tool Result 并清理 Pending。
5. `loop.py:1888-1960` 恢复已完成工具结果，为未完成工具生成明确中断结果；User-only 崩溃也补明确的 Assistant 中断记录，避免两次 User 输入静默粘连。

### 7.4 并发语义

1. `loop.py:377-405` 为每个 Session 维护 Lock 和 Pending Queue，并用全局 Semaphore 限制跨 Session 并发。
2. `:1031-1090` 实现同 Session 串行、跨 Session 并发。
3. `:1197-1221` 回合结束时把剩余消息重新发布到 Bus，避免队列消息静默丢失。

### 7.5 采用、改造和不采用

| 分类 | 内容 | 原因 |
|---|---|---|
| 采用 | User 输入先耐久保存，再调用模型 | 失败后仍能解释用户输入已经被接纳 |
| 采用 | 未完成回合与恢复标记 | 重启后不把旧 `running` 当成功，也不盲目重跑 |
| 采用 | 同 Session 串行、跨 Session 并发 | 保护顺序且不阻塞无关会话 |
| 采用 | 完整历史与模型 Replay 分离 | 保持合法 Tool 边界和 Token 预算 |
| 后续采用 | 工具执行前后独立 Checkpoint/Evidence | 当前文本阶段无工具；进入工具阶段必须实现 |
| 改造 | 内存 Pending Queue | 第一阶段先拒绝；明确产品语义后再排队 |
| 不采用 | 整个 Session 重写 JSONL | 缺少 Web 产品所需多对象事务、查询和约束 |
| 不采用 | 只依赖进程内 Lock/Cache | 无法防止多 Worker 或重启竞争 |

## 8. LibreChat：唯一新增外部产品主参考

### 8.1 限定研究范围

固定源码：`/Users/xulater/Code/opc-os/LibreChat`，提交 `8e5ef1fb31e9d63b735c089b21cbc82c50acce46`。

只研究：

1. Conversation/Message 的产品权威性。
2. Generation Job、实时流与产品消息的关系。
3. 正常完成、断连、取消、错误和 HITL 的保存顺序。
4. 身份、租户 Scope、旧 Run 抢写和跨实例恢复。

不把 Node、MongoDB、Redis、LangGraph 或其私有 SSE 当成当前技术路线，也不把 LibreChat 当成 MAF 能力来源。

### 8.2 Product Conversation/Message 是权威事实

`LibreChat 参考事实`：

1. `packages/data-schemas/src/schema/convo.ts:5-61` 定义 Conversation，以 `(conversationId,user,tenantId)` 建唯一索引，并通过 `expiredAt` TTL 索引表达过期生命周期；归档字段不是在该文件内直接声明，而是由 `...conversationPreset` 引入，具体定义见 `packages/data-schemas/src/schema/defaults.ts:132-135,310-313` 的 `isArchived`。
2. `packages/data-schemas/src/schema/message.ts:4-198` 定义稳定 `messageId`、`conversationId`、`parentMessageId`、`unfinished`、`error`，并以 `(messageId,user,tenantId)` 建唯一约束。
3. 全量产品历史与模型上下文不是同一个数组；模型上下文会沿 Message `parentMessageId` 选择当前分支。
4. 本次研究实际覆盖的外部 Agent Job 路径会把 ID 与 User/Tenant Scope 一起校验：`api/server/routes/agents/index.js:53-57` 先安装 JWT 中间件；`:71-90` 的 `GET /chat/stream/:streamId`、`:192-220` 的 `GET /chat/status/:conversationId`、`:271-319` 的 `POST /chat/abort` 再检查 Job `userId` 与 Tenant。该证据只覆盖这 3 条 Route，不能外推到本次未阅读的其他路径；它仍足以支持“知道 ID 不等于授权”的采用原则。

LibreChat 没有提供可直接复用的持久 Product Interaction Schema，也没有一个长期保留的 Product Agent Run 表。这是它对当前 D2/D4 **未涉及**的部分。

### 8.3 Generation Job 是实时运行投影，不是长期 Product Run

`packages/api/src/stream/interfaces/IJobStore.ts:4-127` 定义状态：

```text
running | complete | error | aborted | requires_action
```

`GenerationJobManager.ts:702-789` 显示正常完成默认删除 Job；Redis/In-memory Job、Chunks 和 Publish 主要服务活动流、重连、跨实例关联及短期恢复，不是长期产品历史。

这证明了一个重要分层：

```text
Product Conversation/Message（长期事实）
!= Generation Job/Chunks（活动流投影）
!= HITL Checkpoint（暂停恢复状态）
```

但它也说明当前项目不能照搬 Generation Job 代替 Product Agent Run：Job 正常完成后可能被删除，无法支撑长期审计、幂等和重启对账。

### 8.4 正常成功顺序值得采用

`api/server/controllers/agents/request.js:684-806` 的正常可续传路径明确执行：

```text
保存 User Message
-> 保存 Assistant Message
-> 检查当前 Job 是否仍属于本次 generation
-> emit final
-> complete/delete Generation Job
```

源码注释直接说明：消息必须在 Final 前保存，避免客户端立即刷新/追问时读不到父消息；还用 `createdAt` 检查旧 Job 是否已被替换，阻止旧生成向新 Job 发送终态。

可借鉴的是：

1. 产品消息提交先于成功终态。
2. 终态前验证当前 Run 所有权/版本，防止旧 Run 抢写。
3. 活动流数据不是产品历史，完成后可以清理。

需要改造的是：本项目使用 Product Agent Run 的版本/CAS 和 SQLite 短事务，而不是 `streamId + createdAt` 的 Redis Job 检查。

### 8.5 断连、取消和 HITL 不是同一种失败

`LibreChat 参考事实`：

1. `request.js:280-350` 的可续传路径在浏览器断开后允许后台生成继续，并保存 `unfinished` 部分内容供重连；断连不等于用户取消。
2. `GenerationJobManager.ts:860-948` 的 Abort 会组装 `unfinished` Final 并先发到实时通道。
3. `api/server/routes/agents/index.js:353-408` 随后才尝试保存 Abort 的部分 Assistant Message；保存失败只记录错误，接口仍返回成功。
4. `packages/api/src/agents/checkpointer.ts` 将 HITL Checkpoint 与 Product Message/Generation Job 分开，并按独立 Checkpoint ID 避免同 Thread 并发覆盖。
5. `requires_action` 是非终态，不能按完成任务清理。

第 1、4 点值得借鉴；第 2、3 点暴露了当前项目不能复制的弱点：取消终态可能先于产品部分消息保存，而且保存失败仍返回成功。

当前第一阶段没有 LibreChat 的后台 Job/Redis 续传基础设施，因此不能宣称“断连后继续生成并可跨实例恢复”。第一阶段只应定义清楚：显式取消、网络断开、服务崩溃、模型失败、HITL 暂停是不同状态；未完成 Run 由启动对账标为 `interrupted` 或 `failed`，不得自动重放。

### 8.6 ID 复用是警示，不是模板

`api/server/controllers/agents/request.js:229-246` 显式令：

```text
streamId == conversationId
```

LangGraph 路径又把 `thread_id` 设为 Conversation ID；`api/server/controllers/agents/client.js` 多处把 `runId` 设为 `responseMessageId`。为防止这些同值对象之间的竞态，源码需要额外依赖 `createdAt`、Generation 身份和 Checkpoint ID 检查。

这是一种工程取舍，不适合当前项目继续扩大：

1. Product Session 与 AG-UI Thread 第一阶段可以同值，减少映射成本。
2. Product Agent Run、AG-UI Run、Provider Response、Message、Runtime Job 和 Workflow Checkpoint 必须分别保存语义和映射。
3. ID 只做定位，授权始终来自 User/Tenant Scope。

### 8.7 LibreChat 的采用、改造和拒绝清单

| 分类 | 内容 | 当前项目处理 |
|---|---|---|
| 采用 | Product Conversation/Message 是长期事实，流 Job 是短期投影 | Product DB 与实时 AG-UI Run 分层 |
| 采用 | 正常完成先保存消息再发 Final | D4 的成功提交门 |
| 采用 | User/Tenant Scope 与 ID 同时校验 | D2 的授权规则 |
| 采用 | 旧 Generation 在终态前做所有权/版本检查 | Product Run CAS/版本门 |
| 采用 | 断连、取消、失败、崩溃和 HITL 分开 | Product Run 状态与恢复语义分开 |
| 改造 | Mongo Conversation/Message | 改为 SQLite + Repository，不复制 Schema |
| 改造 | Redis/In-memory Generation Job | 第一阶段没有后台 Job；Product Agent Run 长期保留 |
| 改造 | HITL Checkpointer | 进入 MAF Workflow/HITL 阶段再独立设计 |
| 拒绝 | `streamId == conversationId == thread_id` 并复用 Message 为 Run ID | 四对象边界和独立映射优先 |
| 拒绝 | Redis Chunks/Job 作为产品历史 | 它们只能是可重建运行投影 |
| 拒绝 | 没有持久 Product Agent Run | 当前项目需要长期幂等、审计和重启对账 |
| 拒绝 | User Message 保存失败后捕获并继续模型调用 | 与“不丢已接纳输入”冲突；见 `BaseClient.js:623-677` |
| 拒绝 | Abort Final 先于部分 Product Message 保存，失败仍报成功 | 不符合当前产品失败规则 |

## 9. 四类证据放在一起

| 问题 | MAF | pi | nanobot | LibreChat | 当前项目推导 |
|---|---|---|---|---|---|
| Product Session/Message | 未提供完整产品模型 | CLI Session Repo | Channel Session + Metadata | 直接提供 Conversation/Message | 本项目 Product DB 权威 |
| 模型历史加载 | `HistoryProvider`、Provider 历史 | 从完整 Tree 投影活动路径 | 从完整 Session 裁剪合法 Replay | 沿 Message 分支组装 Context | ProductHistoryProvider 唯一加载，浏览器只交新后缀 |
| 模型前保存 User | 不替应用定义接纳事务 | Coding Agent 首回合不保证 | 明确先保存 | 部分路径异步保存失败后继续 | 本项目接纳事务必须成功后才调用 MAF |
| 最终答案提交 | HistoryProvider 保存异常阻止正常终态 | 完整 Entry 保存 | SAVE 后才 RESPOND | 正常路径 Message 后 Final | Product Message/Run 提交后才转发 `RUN_FINISHED` |
| 工具中间恢复 | per-service 历史可跨模型调用 | Tool Entry | 工具前后 Checkpoint | HITL Checkpoint + Job | Tool 阶段需独立 Execution/Evidence，不只靠历史 |
| UI 刷新/续传 | 可选 Snapshot | 未涉及 Web 协议 | WebUI 有额外投影 | Redis Job/Chunks 支持重连 | 第一阶段 REST 恢复；后台续传未实现 |
| 同 Session 并发 | 应用定义 | 拒绝普通并发，显式 steer/followUp | Lock + Queue | Generation/version 防旧写 | 第一阶段 `SESSION_BUSY` + DB 约束 |
| 跨进程一致性 | 取决于 Store | JSONL，不是产品事务 | 进程 Lock + 原子文件 | Mongo + Redis/CAS | SQLite 短事务起步；多 Worker 需实测 |

## 10. 从证据到候选架构的推导链

| 已确认事实 | 产品要求 | 推导结果 |
|---|---|---|
| MAF Session 不提供产品列表、权限和运行审计 | 产品必须拥有自己的生命周期 | Product Session/Message/Interaction/Agent Run/Trace 属于 Product DB |
| Snapshot 是 latest-only UI 投影且失败 fail-soft | 产品成功不能依赖 Snapshot | 第一文本阶段不持久化 Snapshot；未来投影可删可重建 |
| HistoryProvider 保存异常会变成 `RUN_ERROR` | MAF 只保证 `save_messages()` 成功返回或抛错发生在正常终态前；Checkpoint 耐久事务由 Provider 实现保证 | ProductHistoryProvider 成为唯一历史加载/Checkpoint 写入路径；不拥有 Product Message 终态 |
| 客户端默认发送全历史 | 禁止两个历史源进入模型 | 服务端校验前缀、只交可信新后缀 |
| `store=False` 仍可能暴露 `response_id` | Provider ID 不能覆盖 Product/AG-UI ID | 配合 per-service 历史抑制 Response ID，并做升级测试 |
| per-service 保存是每次 Provider Call Checkpoint | Checkpoint 不等于整个 Product Run 成功 | 外层终态包装器负责最终 Product Run CAS |
| pi/nanobot 分离完整记录和模型 Context | 完整证据不能无界进入模型 | Context Projector 从 Product Message 生成受限、合法历史 |
| nanobot 模型前保存 User | 已接纳输入不能随模型失败消失，而且失败不应抹掉用户已经表达的上下文事实 | 接纳短事务先写 `committed/context_eligible` User、Interaction 和 Run；当前 Run 首次加载单独排除该 User |
| LibreChat 正常路径 Message 后 Final | 成功必须可立即刷新恢复 | 最终 Assistant 与 Run 终态提交后才转发成功 |
| 三个项目都保护同 Session 顺序 | 不能让普通回合竞争改写历史 | 第一阶段同 Session 单活动 Run；跨 Session 并发 |

候选组件边界：

```text
REST Session API
    -> Product Application Service
        -> Product Repository / SQLite（权威事实表）

AG-UI request
    -> Scope + idempotency + DB-prefix validator
    -> acceptance transaction(User + Interaction + Product Agent Run)
    -> thin AgentFrameworkAgent wrapper
        -> MAF Agent
            -> ProductHistoryProvider(load/checkpoint)
                -> History Checkpoint Repository / 同一 SQLite 的独立表
            -> OpenAI Client(store=False, per-service history)
        -> terminal Product commit gate
    -> standard AG-UI SSE events
```

这仍复用 MAF 的 Agent-to-AG-UI 转换，不发明第二套 Agent 流协议。

## 11. D1-D6 决策卡

以下 6 项全部为`待审核决定`。

### D1：第一阶段物理存储 Product、MAF Runtime 和 AG-UI Snapshot 的方式

**为什么要决定**：旧方案把 Snapshot Store 放进同一 SQLite，并试图用 Snapshot 回执证明产品提交；当前 MAF 事实已经否定这个前提。必须重新决定第一阶段到底持久化什么。

**参考是否真正涉及**：

| 来源 | 是否涉及 | 能提供什么 | 不能决定什么 |
|---|---|---|---|
| MAF | 直接涉及逻辑 Store 边界 | Snapshot、History、AgentSession/Checkpoint 是不同扩展点 | 不替产品选择 SQLite 物理部署 |
| pi | 间接涉及 | 完整记录与 Context 投影分开 | 未涉及 AG-UI Snapshot |
| nanobot | 间接涉及 | 产品历史、Checkpoint、WebUI 投影可分层 | 未涉及 MAF/AG-UI Store |
| LibreChat | 直接涉及逻辑分层 | Mongo Product Fact、Redis Job/Chunks、HITL Checkpoint 分开 | 未涉及 SQLite 或 MAF Snapshot |

**可行选择**：

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 一个 SQLite 物理文件；Product 事实表与模型可见 History Checkpoint 表逻辑分开；不建 Snapshot/Workflow Store | 部署简单；Product User 可立即提交并用于未来上下文；per-service 工具循环有本 Run Checkpoint；避开 Snapshot fail-soft 和双加载 | 需要定义当前 User 的 History Cutoff Revision，以及 Checkpoint 的 Run 绑定、幂等、同 Run 可见性和清理；刷新必须走 REST；暂不支持 Shared State/Interrupt Hydrate |
| B. 在 A 上再建独立 Snapshot 投影表 | 部署仍简单；可用 MAF Hydrate | 又增加一个来源的一致性、清理和升级成本；Snapshot 仍不能决定产品成功 |
| C. Product SQLite + 独立 Redis/DB History/Snapshot Runtime Store | 适合未来多实例、后台任务和实时续传 | 第一阶段引入外部服务与运维，明显过度 |
| D. 只保存 Snapshot 或让 Snapshot 反写 Product | 表面代码少 | 丢失产品对象/审计；失败会假成功；违反状态所有权，排除 |

**当前建议**：A。一个 SQLite 只是物理部署选择，不表示两个逻辑 Store 合并：

1. Product 表由 Product Application Service 拥有，保存 Session、Message、Interaction、Agent Run 和 Trace；接纳事务成功后，Product User 立即是 `committed/context_eligible`，模型失败也不回滚或降级它。
2. 接纳事务为当前 Product User 分配 Revision；Product Agent Run 将该 Revision 记录为 `history_cutoff_revision`，同时保存 `current_user_message_id`。第一次 History Load 只取 `revision < history_cutoff_revision` 的合格历史，并按 Message ID 再次排除当前 User；它由请求 Delta 进入模型，避免重复。
3. History Checkpoint 表由 ProductHistoryProvider 使用，记录 `product_run_id`、模型调用序号、稳定消息/工具身份、同 Run 可见性和幂等信息。活动 Run 的 Checkpoint 可以进入该 Run 的下一次 Provider Call；Partial/Provisional Assistant，以及 Failed/Interrupted/历史 Run 的 Checkpoint 默认不进入新的 Run，也不是用户可见 Product Message。
4. `product_run_id` 必须来自包装器在认证和接纳后建立的可信 Run Context；如何传给 HistoryProvider 仍需实现前 Spike，不能从客户端 `runId` 或 `AgentSession.session_id` 猜测。该并发隔离合同在正式 Schema 前验证。
5. 外层终态事务从最终 Checkpoint/Response 物化 `committed/context_eligible` Product Assistant Message，并与 Product Run `succeeded` 原子提交。
6. 第一阶段 `MAF AgentSession` 请求级存在，Workflow Checkpoint 和 AG-UI Snapshot 不落库。

未来出现 Shared State、HITL 或后台续传时，可以在同一物理 SQLite 或独立服务中增加运行投影，但逻辑表和所有权必须分开。

**建议原因**：当前核心目标是可靠 Product Session/Message/Run，不是先实现断线续传。A 解决当前问题且不封死未来。

**信心**：高。

**未验证**：可信 Product Run Context 向 HistoryProvider 的传递和并发隔离；REST 恢复到 `HttpAgent` 后的完整前端体验；未来 Shared State/HITL 是否必须在第一阶段提前保留接口。

### D2：4 类 ID 如何映射与授权

**为什么要决定**：当前 MAF/AG-UI 会传播 `threadId/runId/response_id`；LibreChat 展示了过度复用 ID 后需要大量 Generation Guard 的代价。

**参考是否真正涉及**：

| 来源 | 是否涉及 | 结论 |
|---|---|---|
| MAF | 直接涉及 | `AgentSession`、AG-UI Thread/Run、Provider ID 各有语义；`threadId` 不是授权 |
| pi | 部分涉及 | Session/Entry/Run-like 执行身份分开，但无 AG-UI |
| nanobot | 部分涉及 | Channel Session Key 与 Turn/Checkpoint 分开，但无 AG-UI |
| LibreChat | 直接涉及且提供反例 | Conversation/stream/thread/run/message 多处同值，需要 createdAt/generation guard |

**可行选择**：

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. Product Session ID 与 AG-UI `threadId` 同值；Product Run、AG-UI `runId`、Provider ID、Checkpoint ID 分开 | 第一阶段少一次映射查询；概念边界仍清晰 | 团队必须持续避免把同值误当同对象 |
| B. 所有 ID 都分开并建映射 | 边界最严格，便于未来多通道 | 第一阶段增加映射表和调试成本，没有现实收益 |
| C. Session/Thread/Run/Message/Provider ID 全部复用 | 代码初期最少 | 幂等、授权、并发和恢复语义混乱，排除 |

**当前建议**：A，并增加 6 条约束：

1. Product Session ID 由服务端生成，AG-UI 请求只引用它。
2. 每次都用认证 User/Tenant Scope 查询 Session；ID 不授权。
3. Product Agent Run 使用服务端 UUID。
4. 客户端 AG-UI `runId` 保存为相关性/幂等键，并绑定请求摘要；同 ID 不同摘要返回冲突。
5. Provider Response/Conversation ID 如需诊断单独保存，绝不覆盖 Product/AG-UI ID；当前 per-service 路径应把它从协议事件中抑制。
6. HistoryProvider 绑定 Product Run 时只能接收认证和接纳之后的可信 Run Context；不得把客户端 `runId` 或 Session/Thread ID 猜成 `product_run_id`。传递机制在 Schema 前用并发 Spike 决定。

**信心**：高。

**未验证**：可信 Run Context 向 HistoryProvider 的传递和并发隔离；多通道接入上位 OPC-OS Chat 后是否要求外部 Session ID 映射；AG-UI Client 升级后 ID 更新行为。

### D3：模型历史由谁加载，如何避免双加载

**为什么要决定**：当前浏览器发送全历史；新增 HistoryProvider 后已实测重复。历史所有权不明确会直接改变模型输入。

**参考是否真正涉及**：

| 来源 | 是否涉及 | 结论 |
|---|---|---|
| MAF | 直接涉及并已实测 | HistoryProvider 是原生 Hook；同一调用只能有一个事实上的历史加载源 |
| pi | 直接涉及原则 | 从完整 Tree 构造受限 Session Context |
| nanobot | 直接涉及原则 | 从完整历史裁剪合法 Replay，处理 Tool 边界 |
| LibreChat | 部分涉及 | Product Message 是权威，模型 Context 沿分支构造；未涉及 MAF HistoryProvider 组合 |

**可行选择**：

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. ProductHistoryProvider 唯一 `load_messages=True`，输入适配器只转发可信新后缀 | MAF 原生；服务端权威；已实测工具循环和 ID 抑制 | 需要前缀校验、Context Projector、幂等 Provider 和升级测试 |
| B. 持久 AG-UI Snapshot 唯一加载历史 | Hydrate 原生 | Snapshot 变成模型历史主源；fail-soft；与 Product Message 一致性复杂 |
| C. 浏览器每次发送全部权威历史，不使用服务端加载 | 初期最少后端代码 | 浏览器不可成为权威；篡改、换设备、Token 和恢复问题明显 |
| D. Provider 托管历史 | 本地少重放 | Provider 锁定；服务 ID 映射；仍不解决 Product History/Run |
| E. ProductHistoryProvider + 未处理的客户端全历史 | 无额外适配代码 | 已实测重复，排除 |

**当前建议**：A，具体合同为：

1. 接纳事务把当前 Product User Message 立即写为 `committed/context_eligible` 并分配 Revision，同时创建 Interaction/Run；Run 把当前 User Revision 记录为 `history_cutoff_revision`，并保存 `current_user_message_id`。模型后来失败不撤销 User，它在未来新 Run 中仍可由 Context Projector 使用。
2. 输入适配器按 Product DB 校验浏览器前缀，只留下当前可信 User/Resume 后缀。
3. ProductHistoryProvider 第一次加载只查询 `revision < history_cutoff_revision` 的 `committed/context_eligible` Product Message，并再次按 `current_user_message_id` 排除当前 User；当前 User 只通过请求 Delta 出现一次。`history_cutoff_revision` 等于当前 User 自己占用的 Revision，统一使用严格小于关系，避免 off-by-one。
4. 显式 `store=False` 和 `require_per_service_call_history_persistence=True`。
5. 第一次 Provider Call 后，ProductHistoryProvider 按 `product_run_id + provider_call_sequence + message/tool identity` 幂等保存模型可见 Checkpoint；其中 `product_run_id` 只能来自薄包装器建立的可信 Run Context。后续 Provider Call 加载“接纳前 Product Context + 所属活动 Run Checkpoint”，因此当前 User 可由 Checkpoint 延续但不会与 Product 表重复。
6. Checkpoint 不创建已提交 Product Assistant Message，也不更新 Run 成功。只有活动 Run 自己可以消费其 Checkpoint；Partial/Provisional Assistant 以及 Failed/Interrupted/历史 Run Checkpoint 默认不进入新 Run。
7. 完整 Product History、活动 Run Checkpoint 与有 Token/边界限制的 Context Projection 分开；未来新 Run 会正常读取此前失败 Run 留下的 `committed/context_eligible` Product User，但不会读取其失败 Assistant 候选/Checkpoint。

**信心**：中高。文本与模拟工具循环已验证，方案与 MAF 当前实现对齐。

**未验证**：可信 Run Context 采用显式对象还是请求作用域 `ContextVar`，以及异步并发/异常/取消隔离；3 个一次性探针尚未固化为仓库测试；真实远端模型 + 真实工具异常；Compaction 策略；多模态/附件；Resume/Interrupt 输入；Provider 升级差异。

### D4：何时允许发送 `RUN_FINISHED`，失败后保留什么

**为什么要决定**：`RUN_FINISHED` 是用户看到成功的协议事实；Snapshot 失败却仍 Final，而 ProductHistoryProvider 可以阻止 Final。还需把每次模型调用 Checkpoint 与整个 Product Run 成功分开。

**参考是否真正涉及**：

| 来源 | 是否涉及 | 结论 |
|---|---|---|
| MAF | 直接涉及并实测 | History 保存失败 -> `RUN_ERROR`；Snapshot 保存失败 -> 仍 `RUN_FINISHED`；per-service Checkpoint 不等于 Run 成功 |
| pi | 部分涉及 | 记录顺序完整，但新 Session User 不一定模型前落盘 |
| nanobot | 直接涉及 | User 模型前保存，最终 SAVE 后 RESPOND，崩溃留恢复标记 |
| LibreChat | 直接涉及 | 正常 Message 后 Final 值得采用；Abort Final 后保存是明确反例 |

**可行选择**：

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. Product 提交门：User 先提交，Assistant/Run 成功提交后才转发 `RUN_FINISHED` | 用户成功语义严格，可立即刷新恢复 | 需要薄终态包装器、幂等/CAS 和失败注入测试 |
| B. 直接接受 MAF 默认终态，Product 异步落库 | 最少定制 | 可能先成功后丢答案，不符合产品规则 |
| C. 用 Snapshot Store 回执作为提交门 | 可以证明 UI 投影落盘 | 投影反向拥有产品事实；MAF 默认吞错，排除 |
| D. 每个 Token 都写 Product Message，再直接 Final | 崩溃时部分内容多 | 写放大、并发复杂；部分流不是已接受事实，不推荐 |

**当前建议**：A，候选顺序：

```text
T0 接纳短事务：Product User Message(committed/context_eligible, revision=history_cutoff_revision) + Interaction + Product Agent Run(running, history_cutoff_revision, current_user_message_id)
T1 MAF 运行并流式发送非终态事件
T2 ProductHistoryProvider 从包装器建立的可信 Run Context 取得 product_run_id，并用耐久事务幂等保存仅供该活动 Run 后续 Provider Call 使用的模型 Checkpoint
T3 薄包装器实际观察到 MAF RUN_FINISHED，先暂扣并核验它不是 interrupt outcome
T4 外层终态事务从最终 Response/Checkpoint 写 Product Assistant Message(committed/context_eligible)，CAS 当前 Run -> succeeded，写基础 Trace
T5 提交确认后才放行原标准 AG-UI RUN_FINISHED
```

`MAF 安装源码事实`：当前 `agent-framework-ag-ui 1.0.0rc8` 的正常 `RUN_FINISHED` 通常没有 `outcome` 字段；`_run_common.py:431-449` 只有在存在可规范化 Interrupt 时才写 `outcome.type == "interrupt"`。不存在一个需要匹配的 `outcome=success` 枚举。包装器必须把“无 Interrupt 的正常 `RUN_FINISHED`”与“带 Interrupt Outcome 的暂停”分开，不能仅看事件类型就提交 Product Run 成功。

在 T4 提交前，前端已经收到的 `TEXT_*`、Tool 流以及早于终态门出现的 `MESSAGES_SNAPSHOT` 都只是 Provisional UI 投影；如果随后是 `RUN_ERROR`，它们不能证明 Product Message 已提交。刷新后的权威显示始终来自 REST/Product DB。

错误语义：

1. T0 失败：不调用模型，返回产品错误。
2. 模型/HistoryProvider 失败：保留 `committed/context_eligible` Product User，Run 置 `failed`；没有已提交 Product Assistant 和 `RUN_FINISHED`。未来新 Run 的 Context Projector 仍可使用这条 User。
3. T4 失败：丢弃暂扣的成功终态，发送 `RUN_ERROR`；已写 Checkpoint 和 Provisional Assistant 保留为该失败 Run 的诊断/恢复事实，默认不进入后续新 Run；Product User 仍保持可进入未来上下文。
4. 显式取消：Run 置 `cancelled`；部分 Assistant 是否展示必须有明确标记，不能冒充成功答案。
5. 网络断开/进程死亡：可观测时置 `interrupted`；如果崩溃发生在 Checkpoint 后、终态门前，即使已经有 Final Assistant 候选，也只能视为 `interrupted/terminal_unknown`。启动时把超过阈值的陈旧 `running` 对账为中断/终态未知，不自动收敛为成功，也不自动重放。
6. 成功提交后客户端恰好断开：Product Run 仍是 `succeeded`，刷新 REST 可见完整结果。
7. `RUN_FINISHED.outcome.type == "interrupt"`：不得执行 T4 的 `succeeded` 提交。未来完整 HITL 设计应在持久化 Interrupt/Checkpoint 后转为 `awaiting_input/suspended`；第一文本切片尚不支持该状态，若意外出现必须走明确的 unsupported/error 分支，不能误判成功。LibreChat 的 `requires_action` 是相似产品语义参考，不是 rc8 的 AG-UI Outcome 枚举。

外层包装器只拦截终态并做 Product CAS，不重写 MAF 的内容、工具和状态事件转换。`agent_framework_ag_ui/_endpoint.py:81-142` 支持传入预包装 `AgentFrameworkAgent`，其公开 `run()` 又委托现有事件转换（`_agent.py:127-146`），因此这个薄扩展方式可行，但仍需合同测试。

**信心**：中高。正常文本、Provider 保存失败和模拟工具循环顺序已验证。

**未验证**：ASGI 客户端断连的取消传播；显式 Abort；终态事务故障注入；服务重启中点；HITL `requires_action`；跨实例后台续传。

### D5：同一 Product Session 的并发和幂等

**为什么要决定**：两个普通请求同时读取同一历史并追加答案，会产生错误顺序、父子关系和上下文；简单进程 Lock 不能覆盖重启或多 Worker。

**参考是否真正涉及**：

| 来源 | 是否涉及 | 结论 |
|---|---|---|
| MAF | 未涉及产品并发政策 | 由应用定义 |
| pi | 直接涉及 | 拒绝第二个普通 Prompt；steer/followUp 有专门语义 |
| nanobot | 直接涉及 | 同 Session Lock+Queue，跨 Session 并发 |
| LibreChat | 部分涉及 | Generation replacement、createdAt guard、steering；没有当前 Product Run 表 |

**可行选择**：

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 每 Session 一个活动普通 Run；第二个不同请求返回 `SESSION_BUSY` | 语义简单、可测试、不会静默排队 | 用户需要等待/取消后再发；暂不支持 steer/followUp |
| B. 服务端持久队列 | 用户输入不被拒绝 | 必须定义顺序、取消、重启、配额和 UI；第一阶段成本高 |
| C. 实现 steer/followUp | 交互能力强 | 需要 MAF 工具/流边界和产品语义，当前尚未定义 |
| D. 允许并行并自动分支 | 高并发 | 产品尚无分支 UI/模型，容易错写，排除 |

**当前建议**：A，同时把幂等与 Busy 分开：

1. 同 `agui_run_id + request_hash` 重复到达，返回/恢复同一个 Product Run，不执行第二次。
2. 同 `agui_run_id` 但 Hash 不同，返回冲突。
3. 不同 Run ID 且已有活动 Run，返回 `SESSION_BUSY`，不创建第二条 User Message。
4. 不同 Product Session 可并发。
5. 活动 Run 约束必须最终由数据库/CAS 支撑，进程 Lock 只作性能优化。

**信心**：高。

**未验证**：SQLite 下部分唯一索引/CAS 的并发行为；多 Worker；未来队列或 steer/followUp 产品体验。

### D6：SQLite 访问、迁移和事务技术

**为什么要决定**：需要 Session 列表、Message 顺序、Agent Run 幂等、活动 Run 约束、短事务和可升级 Schema；单纯 JSON 文件不能可靠承担这些关系。

**参考是否真正涉及**：

| 来源 | 是否涉及 | 结论 |
|---|---|---|
| MAF | 未涉及本项目数据库选型 | 只提供 Store/Provider 接口 |
| pi | 使用 JSONL | 提供格式版本和追加思想，不提供 Web 产品事务 |
| nanobot | 使用原子 JSONL | 提供崩溃恢复思想，不提供关系约束 |
| LibreChat | 使用 MongoDB + Redis | 证明产品事实/活动流分层，不决定 SQLite 技术 |

因此 D6 是**本项目工程推断**，没有参考项目直接给出同栈答案。

**可行选择**：

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. SQLAlchemy 2 + Alembic + `aiosqlite` | Repository/事务清晰；迁移成熟；未来切 PostgreSQL 成本较低；适配 FastAPI async | 新增依赖和 ORM 学习/调试成本；仍需理解 SQLite 锁 |
| B. 标准库 `sqlite3` + 手写迁移表/SQL | 依赖少、SQL 透明 | async 线程封装、迁移、映射和样板由项目长期维护 |
| C. 直接 PostgreSQL/Redis | 并发和多实例能力更强 | 第一阶段增加部署与运维，不符合当前单机验证范围 |
| D. JSONL/文件 | 实现小、便于观察 | 缺少查询、唯一约束、多对象事务和未来 Worker 一致性，排除 |

**当前建议**：A。使用 Repository 和短事务，不让 ORM 对象越过应用层；第一阶段单 SQLite 文件，后续根据部署数据决定是否迁移 PostgreSQL。正式 Schema 字段仍需 D1-D6 批准后设计。

**信心**：中高。

**未验证**：`aiosqlite` 在真实流式并发下的锁等待、WAL/`busy_timeout` 参数、备份恢复、多 Worker 上限和迁移回滚流程。

## 12. 当前建议能解决和不能解决什么

### 12.1 批准并实现 D1-D6 后，第一阶段应能解决

1. 服务端创建、列出、打开和归档 Product Session。
2. 刷新/重启后从 Product DB 恢复完整可见 Message。
3. 已接纳 User Message 立即 `committed/context_eligible`；模型失败后仍可解释、恢复并进入未来新 Run 的上下文投影。
4. 模型历史由服务端唯一投影，不被浏览器篡改或重复加载。
5. Assistant/Run 提交失败不发送假 `RUN_FINISHED`。
6. 同 Session 普通 Run 串行，重复请求具有明确幂等结果。
7. Provider ID、协议 ID、Product ID 和 Runtime ID 不再混用。

### 12.2 第一阶段明确不能宣称

1. 浏览器断线后后台生成继续、跨实例接管和实时流重放。
2. MAF Workflow/HITL Checkpoint 的持久暂停/恢复。
3. 工具执行前后的完整 Product Execution/Evidence Checkpoint。
4. 多 Worker 下已经验证的 SQLite 高并发能力。
5. 自动队列、steer/followUp、分支对话和 Compaction 产品体验。
6. AG-UI Shared State/Interrupt 的刷新 Hydrate。

这些不是“悄悄留给实现”的空白，而是需要分别触发后续设计和验收的边界。

## 13. 实现前与实现中的验证清单

用户批准 D1-D6 后，至少需要以下合同测试和故障注入：

1. **正式 Schema 前置 Spike**：比较显式 Run Context 与请求作用域 `ContextVar`，验证两个 Session 并发、同 Session 冲突、Provider 异常、流取消和请求结束清理；HistoryProvider 只能拿到接纳事务返回的 `product_run_id`，不能从客户端 `runId/session_id` 猜测。
2. 把当前一次性的事件顺序、双历史、工具循环和 Response ID 抑制探针固化为本仓库合同测试，并记录依赖版本；未完成前不能把本次探针当长期回归保证。
3. 当前 Run 首次加载：当前 User 的 Revision 等于 `history_cutoff_revision`，History 只加载严格小于 Cutoff 的消息并排除 `current_user_message_id`，模型只收到一次当前 User Delta。
4. 模型失败后的下一条新 Run：此前失败 Run 的 Product User 仍作为 `committed/context_eligible` 历史出现一次；其 Provisional Assistant 和失败 Run Checkpoint 均不出现。
5. 工具循环的第二次 Provider Call：当前 User 从所属活动 Run Checkpoint 延续且只出现一次，当前 Tool Result 作为新 Delta 出现一次。
6. 真实模型：`store=False + per-service` 下 AG-UI `threadId/runId` 不被 Provider ID 改写。
7. HistoryProvider 保存失败：只有 `RUN_ERROR`，Product Run 失败，无 `RUN_FINISHED`；Product User 仍 committed/context-eligible。另用真实 SQLite Provider 验证 `save_messages()` 只有在耐久事务提交后才成功返回。
8. 终态 Product 事务失败：包装器丢弃暂扣的 Final 并发送 `RUN_ERROR`；前端 Provisional `TEXT_*`/`MESSAGES_SNAPSHOT` 刷新后不冒充 Product Assistant。
9. `RUN_FINISHED` 无 Interrupt：完成 Product 终态事务后才放行；`outcome.type == "interrupt"`：绝不置 `succeeded`，首切片进入明确 unsupported/error 分支。
10. 客户端伪造/篡改历史前缀：服务端拒绝并要求 REST 重载。
11. 同 Run ID 同 Hash 重试：只执行一次；不同 Hash 冲突。
12. 同 Session 两个不同 Run：第二个 `SESSION_BUSY`，不多写 User。
13. 跨 Session 并发：互不阻塞或污染历史。
14. 服务在 User 提交后、模型前崩溃：Product User 保持 `committed/context_eligible`，Run 对账为 `interrupted/failed`，不自动重跑。
15. 服务在 Assistant Checkpoint（包括 Final Assistant 候选）后、终态门前崩溃：Run 对账为 `interrupted/terminal_unknown`，不自动成功；Checkpoint 不进入下一条新 Run，但 Product User 仍进入未来上下文。
16. 浏览器在成功提交前/后断开：分别验证中断语义和 REST 恢复。
17. SQLite 锁、超时、WAL、迁移和备份恢复。
18. 进入工具阶段前：真实工具故障、工具结果持久化、HITL 和 Workflow Checkpoint 单独审核。

## 14. 证据索引

### 14.1 MAF 官方文档

1. [MAF Session](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/session)
2. [MAF Memory & Persistence](https://learn.microsoft.com/en-us/agent-framework/get-started/memory)
3. [MAF AG-UI Integration](https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/)

### 14.2 当前安装源码

1. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework/_sessions.py`
2. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework/_agents.py`
3. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework/_types.py`
4. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework_openai/_chat_client.py`
5. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework_ag_ui/_snapshots.py`
6. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework_ag_ui/_endpoint.py`
7. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework_ag_ui/_agent.py`
8. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework_ag_ui/_agent_run.py`
9. `/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework_ag_ui/_run_common.py`
10. `/Users/xulater/Code/Chat/frontend/node_modules/@ag-ui/client/dist/index.mjs`

### 14.3 MAF 本地参考仓库

目录：`/Users/xulater/Code/opc-os/agent-framework/python/samples/02-agents/conversations/`

1. `suspend_resume_session.py`
2. `custom_history_provider.py`
3. `file_history_provider_conversation_persistence.py`
4. `cosmos_history_provider_conversation_persistence.py`
5. `redis_history_provider.py`

### 14.4 pi

1. `/Users/xulater/Code/opc-os/pi/packages/agent/src/harness/types.ts`
2. `/Users/xulater/Code/opc-os/pi/packages/agent/src/harness/session/session.ts`
3. `/Users/xulater/Code/opc-os/pi/packages/agent/src/harness/session/jsonl-storage.ts`
4. `/Users/xulater/Code/opc-os/pi/packages/agent/src/harness/session/jsonl-repo.ts`
5. `/Users/xulater/Code/opc-os/pi/packages/coding-agent/src/core/session-manager.ts`
6. `/Users/xulater/Code/opc-os/pi/packages/coding-agent/src/core/agent-session.ts`
7. `/Users/xulater/Code/opc-os/pi/packages/coding-agent/docs/session-format.md`
8. `/Users/xulater/Code/opc-os/pi/packages/coding-agent/docs/sessions.md`
9. `/Users/xulater/Code/opc-os/pi/packages/coding-agent/test/agent-session-concurrent.test.ts`

### 14.5 nanobot

1. `/Users/xulater/Code/opc-os/nanobot/nanobot/session/manager.py`
2. `/Users/xulater/Code/opc-os/nanobot/nanobot/agent/loop.py`
3. `/Users/xulater/Code/opc-os/nanobot/nanobot/agent/runner.py`
4. `/Users/xulater/Code/opc-os/nanobot/nanobot/session/webui_turns.py`
5. `/Users/xulater/Code/opc-os/nanobot/tests/agent/test_loop_save_turn.py`
6. `/Users/xulater/Code/opc-os/nanobot/tests/session/test_session_fsync.py`
7. `/Users/xulater/Code/opc-os/nanobot/tests/agent/test_session_atomic.py`
8. `/Users/xulater/Code/opc-os/nanobot/tests/agent/test_session_manager_history.py`

### 14.6 LibreChat

固定目录：`/Users/xulater/Code/opc-os/LibreChat`；固定提交：`8e5ef1fb31e9d63b735c089b21cbc82c50acce46`。

1. `packages/data-schemas/src/schema/convo.ts`
2. `packages/data-schemas/src/schema/defaults.ts`
3. `packages/data-schemas/src/schema/message.ts`
4. `packages/api/src/stream/interfaces/IJobStore.ts`
5. `packages/api/src/stream/GenerationJobManager.ts`
6. `packages/api/src/agents/checkpointer.ts`
7. `api/server/controllers/agents/request.js`
8. `api/server/controllers/agents/client.js`
9. `api/server/routes/agents/index.js`
10. `api/app/clients/BaseClient.js`
