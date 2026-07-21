# Chat 总体架构研究与证据

> 状态：`研究修订完成，供总体架构候选审核`
>
> 日期：2026-07-21
>
> 研究对象：独立运行和持续运营的完整 Chat 产品
>
> 方案入口：[Chat 总体架构候选](./overall-architecture-proposal.md)

## 1. 修订说明：上一份推导哪里错了

上一份研究采集到的多数源码事实仍有效，但从事实到架构的推导犯了两个错误：

1. 用“当前是单用户、本地运行、只有 Hello World”决定架构应该考虑多少能力，把交付进度偷换成目标架构范围。
2. 因为 Chat 能与 OPC-OS Chat 互操作，就把它写成从属于某个“上位系统”的通道，混淆了产品身份和外部集成角色。

由此产生的“同进程执行、以后再抽 Worker”“Outcome 暂时合并”“未来才考虑可靠运行”等表述，会让关键组件只成为可选占位，而不是完整用户场景必需的系统能力。

本次修订保留经过版本和源码核对的证据，废止上述推导方式。新的研究顺序是：

```text
完整用户场景
-> 用户需要的产品保证
-> 状态、故障域和一致性边界
-> 逻辑模块与进程角色
-> 用MAF/pi/nanobot/LibreChat验证边界和代价
-> 形成目标架构
-> 最后才讨论交付顺序
```

这次反例与强制检查已经写入根目录`PROJECT_LESSONS.md`。

## 2. 研究问题

研究不再问“现在最少要做什么”，而问完整 Chat 产品必须长期回答什么：

1. Product Session、工作、知识和证据由谁长期拥有？
2. 用户说“继续”时，如何确定继续哪个 Work、使用哪些仍有效的上下文？
3. 多意图、澄清、计划和人/AI责任如何跨回合持续存在？
4. 如何保证用户批准的是实际要执行的版本、能力、权限和请求内容？
5. 浏览器连接、Product Run、Run Attempt、Runtime Job、MAF Session 和 Workflow Checkpoint如何区分？
6. 浏览器断线、API重启、Worker失联后，活动 Run 如何重连、接管或安全终止？
7. Tool 已可能产生外部副作用但结果未知时，如何避免盲目重试？
8. 产品成功、证据成立和结果送达如何分别确认？
9. 来源删除、权限撤销和版本变化如何传播到 Evidence、Memory 和 Context？
10. Web、OPC-OS Chat 或其他入口如何共享同一产品核心而不越权、不双写事实？
11. MAF 应承担哪一层，哪些产品责任必须由 Chat 自己拥有？
12. 逻辑模块应该如何映射为进程角色，才能同时满足事务、故障隔离和可运营性？

## 3. 固定来源、版本和证据等级

### 3.1 固定来源

| 来源 | 本地路径 | 固定版本或提交 | 用途 |
|---|---|---|---|
| Chat 项目 | `/Users/xulater/Code/Chat` | 当前工作树；本方案待审核 | 6 个问题、完整闭环、技术路线、Session 能力全集 |
| MAF 安装版 | Chat 项目`.venv`与`uv.lock` | core `1.11.0`；openai `1.10.1`；ag-ui `1.0.0rc8` | 当前可运行 API 与事件合同 |
| MAF 源码 | `/Users/xulater/Code/opc-os/agent-framework` | `9c4cd07899502157284b64a73f9a0adfb4594d96` | Agent、Session、Middleware、Tool、Workflow、AG-UI、Durable Task、Telemetry |
| pi | `/Users/xulater/Code/opc-os/pi` | `2b00dade7cec918aefb025c8b7a4fa304a30acdd` | Agent Core、产品协调层、组合根、Session、Tool、运行模式和恢复诚实性 |
| nanobot | `/Users/xulater/Code/opc-os/nanobot` | `2c789767280482f38667044f8a3be5102c71dd26` | Channel、MessageBus、Loop、Runner、Session、Memory、Goal、Gateway及可靠性边界 |
| LibreChat | `/Users/xulater/Code/opc-os/LibreChat` | `8e5ef1fb31e9d63b735c089b21cbc82c50acce46` | Web Feature、产品 API、Conversation/Message、Generation Job、Event Transport和终态提交 |

### 3.2 证据等级

1. `[项目事实]`：用户已经确认并写入`PROJECT_CONTEXT.md`的产品和技术事实。
2. `[安装版实测]`：Chat 当前依赖上实际运行或合同测试得到的行为。
3. `[源码事实]`：固定提交中可以按路径或符号定位的实现。
4. `[参考评价]`：基于源码结构、边界和失败行为得到的工程经验，不代表参考项目官方承诺。
5. `[项目推导]`：由本项目完整用户场景推出的架构决定，仍需用户审核。

任何参考项目都只能为其真实覆盖的范围背书。Intent、Work、ExecutionDraft、产品 Approval、Evidence、Provenance 和完整 Delivery 语义没有一个参考项目完整实现，它们主要是本项目需求推导。

## 4. 研究过程与证据记录

| 步骤 | 要回答的问题 | 动作与证据 | 结论或未覆盖项 |
|---|---|---|---|
| 1 | 产品究竟是什么 | 重新读取`AGENTS.md`、`PROJECT_LESSONS.md`、`PROJECT_CONTEXT.md`、Session全集 | Chat 是独立完整产品；外部通道是集成角色 |
| 2 | 完整场景需要什么保证 | 把“继续、多意图、外部写入、断线、Worker失联、来源删除、跨入口”逐项拆为状态和失败 | 得到权威性、连续性、可控性、持久性、可追溯、无假成功、可替换、可运营 8 个保证 |
| 3 | MAF 负责什么 | 核对安装版；阅读`_agents.py`、`_sessions.py`、Middleware、Workflow、AG-UI、Durable Task、Observability | MAF 是 Runtime；不拥有产品 Session、Work、Approval、Run、Evidence、Delivery |
| 4 | 产品核心和入口如何分开 | 复核 pi 的`pi-ai`、`pi-agent-core`、`pi-coding-agent`、运行模式、组合根和 Orchestrator | 多入口共享核心；协调器必要但不能吞并领域；进程记录不能冒充可恢复计算 |
| 5 | 状态时间尺度和长期运行如何分开 | 复核 nanobot 的 Channel -> Bus -> AgentLoop -> Runner -> Outbound，Session/Memory/Goal/Gateway | Channel、运行、Session、Memory、Delivery 要分层；轻量 Bus/Gateway 不提供 durable ack/outbox/tool exactly-once |
| 6 | Web 产品和活动流如何分开 | 复核 LibreChat App/Route/Data Provider/Server/Agent Route/Generation Job/Event Transport/Final | 产品 Query/API 与活动运行分开；HTTP、Job、订阅是不同生命周期；正常路径先持久化消息再 Final |
| 7 | 参考覆盖够不够 | 对 12 个研究问题建立覆盖矩阵 | 足够确定总体边界；不足以冻结多个本项目特有领域状态机 |
| 8 | 逻辑边界如何推导 | 先按状态所有权和不变量划 12 个产品模块，再按生命周期/故障域划 API、Execution、Delivery、Reconciler | 领域模块不等于服务；执行与交付需要持久平面和进程角色 |
| 9 | 方案是否真的覆盖场景 | 用 7 个场景逐步穿透组件、合同、状态、失败和用户结果 | 暴露了 Job、Tool Ledger、Outbox、Provenance、Run Graph和Projection Reconciler都不能省略 |
| 10 | 当前未知是否被隐藏 | 对 MAF 版本错位、Checkpoint 接合、Store 选型、外部合同逐项列出 | 总体边界可审核；具体 API/Schema/产品选型仍需详细设计和实测 |

可复用源码知识已经分别维护在：

1. `/Users/xulater/Code/opc-os/agent_knowledge/MAF/02-Agent应用架构中的位置与边界.md`
2. `/Users/xulater/Code/opc-os/agent_knowledge/project-studies/librechat/Web-Chat整体架构与模块边界源码研究.md`
3. pi、nanobot 的既有研究入口由`AGENTS.md`限定维护，本次没有伪造未读能力。

## 5. 从完整场景推导架构保证

### 5.1 “继续”不是加载聊天记录

仅保存 Message 不能判断：

- 用户要继续哪个长期事项；
- 当前计划到了哪里；
- 哪些记忆已被用户接受；
- 哪些 Evidence 仍有效；
- 这次模型真正应该看到什么。

因此必须同时存在 Product Session、Message Branch、Work/Plan、Memory、Evidence 和本轮不可变 ContextPackage。Context 只读这些模块的公开 Projection，不能成为它们的事实源。

### 5.2 “执行前确认”不是 Prompt 里问一句

用户真正批准的是一组稳定事实：目标、上下文版本、计划节点版本、Agent/模型/Tool能力、权限、限制、风险和规范化请求 Hash。任何绑定项变化，旧批准都必须失效。

因此需要独立 ExecutionDraft、Approval 和 RunSpec，且产品 Approval 与 MAF Tool Approval/Interrupt 是双层关系：前者是长期产品事实，后者是运行时交互机制。

### 5.3 “任务还在跑”不是 SSE 还连着

浏览器订阅、API 请求、Product Run、Attempt、Job 和 Worker Lease 有不同生命周期。要支持刷新、网络中断和 Worker 接管，必须有：

1. 长期 Product Run。
2. 每次实际尝试的 Attempt。
3. 持久 Job、Lease、Heartbeat 和 Control Inbox。
4. 有限 Event Journal 和 Cursor。
5. Reconciler 与恢复决定。

这些是完整场景要求，不由部署规模决定。

### 5.4 “Checkpoint 可恢复”不等于副作用可重放

Workflow Checkpoint 能恢复控制流和 Executor 状态，但不能证明外部 Tool 是否已执行。工具请求发送后连接超时可能处于`result_unknown`，自动重试可能产生第二次副作用。

因此 Tool Operations 必须有独立 Ledger、幂等键、外部引用、对账能力声明和人工处置路径。Checkpoint 只能帮助定位安全点，不能替代 Tool Evidence。

### 5.5 “Run 成功”不等于用户已收到

模型或 Workflow 完成、产品结果提交、Evidence 验证、外部 Delivery 成功是 4 个不同事实。必须分别记录，并通过 Transactional Outbox 在产品事务与外部交付之间建立可靠交接。

### 5.6 “来源被删”不是删除一条消息

一个来源可能被 Context、Run、Evidence、Memory 和 Work 完成结论引用。需要 Provenance Graph 和失效传播，使 Evidence 降级、Memory 进入复核、后续 Context 排除失效事实，同时保留历史 Trace。

## 6. MAF：提供运行时，不提供产品架构

### 6.1 源码事实

| 能力 | 证据路径或符号 | 能说明什么 | 不能说明什么 |
|---|---|---|---|
| Agent 组合 | `python/packages/core/agent_framework/_agents.py`的`BaseAgent`、`RawAgent`、`Agent` | 模型、Tool、Context、Middleware和Telemetry的运行组合 | 产品 Session、Work、Approval、Delivery |
| Session/History | `_sessions.py`的`ContextProvider`、`HistoryProvider`、`AgentSession` | 模型上下文和 Provider 状态 | 标题、归档、权限、Product Run |
| Middleware | `_middleware.py`及 Tool Approval 示例 | Agent/Chat/Function 调用上的策略钩子 | 持久产品批准事实和版本失效规则 |
| Workflow Checkpoint | `_workflows/_checkpoint.py`、`_runner.py`、`_executor.py` | 图签名、迭代、共享状态、Executor 状态和恢复 | Tool 副作用、产品终态、Delivery |
| AG-UI | `python/packages/ag-ui/agent_framework_ag_ui/_agent.py`、`_workflow.py`、`_endpoint.py`、`_snapshots.py` | Agent/Workflow事件、FastAPI/SSE、Snapshot、resume | Product CRUD、授权、产品事实源 |
| Durable Task | `docs/features/durable-agents/README.md`、`python/packages/durabletask/` | MAF可运行在持久 Task Hub/Worker 宿主 | 产品 Job、Outbox、Evidence 和 Tool exactly-once |
| Observability | `observability.py` | OpenTelemetry 与敏感内容默认关闭 | 用户可见 Trace 和产品审计策略 |

### 6.2 安装版实测与版本边界

当前安装版本与参考源码提交不是同一发布快照。已经实测：

1. `HistoryProvider`成功保存发生在 AG-UI `RUN_FINISHED`前。
2. History 保存异常会产生`RUN_ERROR`且不产生`RUN_FINISHED`。
3. `require_per_service_call_history_persistence=True`与`store=False`可以在两次模型调用 Tool Loop 中保存中间历史并抑制 Provider 响应 ID 混入协议 ID。
4. AG-UI Client 发送客户端消息全集，若 Product History、AG-UI Snapshot 和 MAF History同时装配，存在双历史风险。

这些事实支持“唯一历史装配器”和“产品终态提交门”，但不证明 Product DB 提交失败时当前 RC 已有可直接复用的扩展点；这仍需合同 Spike。

### 6.3 对 Chat 的采用、改造和拒绝

- 采用：Agent、Context/History Provider、Middleware、Tool、Workflow、Checkpoint、HITL、AG-UI和Telemetry。
- 改造：全部封装在 Runtime Adapter；Product Approval 映射 Interrupt；Product Run 映射 MAF Session/Checkpoint；AG-UI Snapshot 只作协议投影。
- 拒绝：Route 直连 MAF 后把框架结束当产品成功；用 MAF Session/Thread/Checkpoint保存所有产品状态。

## 7. pi：共享核心、组合根与协调器风险

### 7.1 实际覆盖

pi 把 Provider、Agent Core、Coding Product 和运行模式分开：

1. `pi-ai`统一 Provider 与协议。
2. `pi-agent-core`拥有 Agent 状态、模型-Tool 循环、事件、steering/follow-up。
3. `pi-coding-agent`组合 Settings、Resource、Session、Tool 和产品交互。
4. Interactive、Print、JSON、RPC 共享同一 AgentSession，不为入口复制核心规则。
5. 组合根负责装配；Orchestrator 重启时把遗留记录收敛为 stopped，不虚构计算仍可继续。

### 7.2 给 Chat 的经验

- Web、REST、AG-UI 和外部入口应共享同一 Application/Domain 核心。
- Provider/Agent Core 与 Product Session/Work 分开。
- 组合根集中装配配置、Repository、Runtime、Tool 和 Adapter。
- 进程记录、Session 文件或事件存在都不等于执行可恢复，必须有安全点和恢复合同。

### 7.3 不能照搬

pi 的大 `AgentSession`同时协调事件、持久化、模型、资源、Tool、命令、分支、压缩和扩展，换来多模式一致，但变化原因过多。Chat 仍需要 Application Coordinator，但只能负责用例和事务；Conversation、Work、Approval、Run、Tool、Memory 和 Evidence 各自保留状态机。

pi 不提供本项目所需的 Web Product API、外部 Delivery、产品 Approval 和完整 Evidence 模型，因此只为层次与协调器边界背书。

## 8. nanobot：时间尺度分离与可靠性反例

### 8.1 实际覆盖

```text
Channel / WebUI / API
-> MessageBus
-> AgentLoop（Session、锁、Context、Turn）
-> AgentRunner（模型与Tool循环）
-> OutboundMessage / Channel
```

Session、Memory、Goal/Cron/Trigger 和 Gateway 分别处理不同时间尺度。既有源码研究还表明：

1. Session Key用于隔离和锁，不是规范身份。
2. Session保存不等于消息送达。
3. MessageBus没有 durable ingress/ack，Channel retry不是 Transactional Outbox。
4. Checkpoint可以标记未知 Tool，但不保证外部副作用 exactly-once。
5. Gateway 长驻不等于可靠任务队列、租约接管或多副本容灾。

### 8.2 给 Chat 的经验

- Identity/Channel、Application Turn、Agent Runner 和 Delivery 分层。
- Conversation、Work/Goal 和 Memory 属于不同时间尺度，不能合并。
- Tool Ledger、Outbox/Receipt、Job/Lease 必须是独立组件，不能靠 Bus、Gateway 或 Checkpoint补齐。
- 逻辑边界可以共进程，但能力和故障语义不能消失。

### 8.3 不能照搬

nanobot 的轻量 MessageBus适合模块通信，但没有提供目标场景需要的可靠接纳、跨进程消费和送达保证。Chat 不应为了“解耦”建设通用总线；本地同步流程直接调用模块，需要跨事务/进程时使用用途明确的 Job 或 Outbox。

## 9. LibreChat：Web 产品资源、活动 Job 与实时订阅分离

### 9.1 实际覆盖和证据

| 结论 | 证据路径 |
|---|---|
| App、Router、Root Shell、ChatRoute 分层 | `client/src/App.jsx`、`client/src/routes/index.tsx`、`Root.tsx`、`ChatRoute.tsx` |
| 产品查询合同集中，React Query 管理服务端状态 | `packages/data-provider/src/api-endpoints.ts`、`data-service.ts`、`react-query/react-query-service.ts` |
| 后端挂载 Conversation、Message、Project、File、Memory、Agent 等产品 Route | `api/server/index.js` |
| Agent 入口先过 resume、PII、moderation、Agent/资源/Conversation访问 | `api/server/routes/agents/chat.js` |
| HTTP 接纳、Generation Job 和 SSE 订阅是不同生命周期 | `api/server/controllers/agents/request.js`的`ResumableAgentController` |
| Job Store/Event Transport 可用内存或 Redis 实现 | `packages/api/src/stream/interfaces/IJobStore.ts`及 InMemory/Redis 实现 |
| 正常路径先保存 User/Assistant Message，再校验 Job 所有权并发 Final | `request.js`正常完成段 |

完整限定研究在：

`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/librechat/Web-Chat整体架构与模块边界源码研究.md`

### 9.2 给 Chat 的经验

- 前端按 App Shell 和 Feature 组织，协议 Client 不是前端架构本身。
- Product Query/REST 与 Agent实时协议分开；浏览器 Store 不拥有产品事实。
- 接纳请求、活动执行和当前订阅分开。
- 先提交 Product Message，再暴露成功 Final。
- Job Store 与 Event Transport 是可替换基础设施。

### 9.3 必须改造和不能照搬

LibreChat 没有独立持久 Product Run，其 Generation Job 可以过期/删除；Chat 必须增加长期 Run/Attempt 和恢复决定。技术上也不复制 MongoDB、Redis、Express、私有 SSE、历史双后端、多套前端 Store 或 ID 复用。

LibreChat 没有替本项目决定 Intent、Work、Approval、Evidence、Provenance、Tool对账或 MAF Checkpoint 接合。

## 10. 参考覆盖矩阵

| 架构主题 | MAF | pi | nanobot | LibreChat | 本项目是否必须自建 |
|---|---|---|---|---|---|
| Agent/模型/Tool Loop | 强 | 强 | 强 | 部分 | 封装和策略需自建 |
| Runtime Context/History | 强 | 强 | 强 | 部分 | Product Context需自建 |
| Workflow/Checkpoint/HITL | 强 | 弱/部分 | 部分 | 部分、非MAF | Product映射和恢复门需自建 |
| Web App Shell/Feature | 不涉及 | 不涉及Web | 部分 | 强 | 迁移到React/AG-UI |
| Conversation/Message | 不负责 | Coding Session | Session | 强 | 产品模型需自建 |
| Product Run vs Job | 不负责Product Run | 部分 | 部分 | Job强、长期Run缺 | 是 |
| Intent/Clarification | 不负责 | 部分 | 弱 | 弱 | 是，参考未完整涉及 |
| Work/Plan/Action | 不负责 | 部分 | Goal部分 | Project部分 | 是，参考未完整涉及 |
| ExecutionDraft/Approval | Runtime机制 | Tool/Extension部分 | 权限部分 | HITL部分 | 是，参考未完整涉及 |
| Worker/Lease/Reconcile | Durable宿主部分 | Orchestrator部分 | Gateway反例 | Job/Event部分 | 是，需组合完整语义 |
| Tool副作用对账 | Tool机制 | Tool部分 | 未知状态反例 | 部分 | 是 |
| Evidence/Provenance | Telemetry部分 | 输出部分 | 弱 | Message/File部分 | 是 |
| Delivery/Outbox/Receipt | 不负责 | 不涉及 | 明确缺口 | 流/消息部分 | 是 |
| Identity/Scope/Binding | 钩子/Scope要求 | trust部分 | 明确缺口 | Web权限部分 | 是 |
| Trace/Audit/Operations | Telemetry | 事件 | 日志 | 部分 | 产品Trace需自建 |

结论：4 个来源足以确认总体边界、常见反例和技术接合点，不足的地方恰好是 Chat 的差异化产品能力。此时增加另一个大型参考项目不会替代产品设计；如果进入具体模块状态机设计后出现明确知识缺口，应按单一主题向用户申请。

## 11. 架构选择比较

### 11.1 选择 A：Web Route 直接调用 MAF

**优点**：实现短、依赖少、可快速验证流式回合。

**缺点**：没有 Work、Approval、Run恢复、Tool对账、Evidence、Delivery 和运营所有者；Route/MAF状态会被迫成为产品事实。

**参考覆盖**：MAF 示例只证明 Runtime；没有参考项目用这种结构承载完整目标场景。

**结论**：只适合作为协议 Spike，不可作为目标架构。

### 11.2 选择 B：模块化产品核心，执行和交付仍绑定 API 请求

**优点**：产品领域和事务边界清楚。

**缺点**：浏览器断线、API重启、Worker失联和外部送达仍无持久生命周期；完整恢复场景无法成立。

**参考覆盖**：pi/nanobot支持模块化核心，但 LibreChat Job/Event 和 MAF Workflow 表明活动运行需要独立状态。

**结论**：领域方向正确，但目标拓扑不完整。

### 11.3 选择 C：模块化产品核心 + 持久执行平面 + 可靠交付平面

**优点**：产品事务、活动运行、外部副作用和送达分别有所有者；覆盖完整场景；进程角色可按故障域运行。

**缺点**：需要设计 Job、Lease、Event、Outbox、Tool Ledger 和对账；测试矩阵明显增加。

**参考覆盖**：4 个来源分别为 Runtime、共享核心、状态分层和活动 Job 提供证据；完整组合是本项目推导。

**结论**：推荐目标架构。

### 11.4 选择 D：每个领域模块独立微服务 + 通用事件总线

**优点**：每个模块可独立部署和扩缩。

**缺点**：Conversation、Approval、Run接纳和Outbox之间出现分布式一致性；大量网络合同、运维和Schema演进并没有用户场景依据。

**参考覆盖**：没有参考源证明 Chat 的每个领域边界需要独立服务。MAF Durable Task只说明执行宿主可分离，不说明领域微服务化。

**结论**：不推荐按模块名拆服务；只按执行、交付等真实生命周期和故障域形成进程角色。

## 12. 目标架构推导链

```text
6个产品问题 + 完整用户场景
-> 产品事实、候选门、批准门、恢复、证据、交付和失效传播
-> Conversation/Work/Approval/Run/Tool/Evidence/Delivery不能压进一个Session或MAF
-> 按状态所有权划产品模块
-> 按同步事务、持久执行、外部交付划运行平面
-> REST负责产品资源，AG-UI负责活动Run投影
-> Product Store、Runtime Store、MAF Store、Artifact、Index逻辑分离
-> API、Execution Worker、Reconciler、Delivery Worker、Projector按生命周期和故障域运行
-> 用四个参考源验证边界、采用机制并识别不能照搬的缺口
-> 得到“模块化产品核心 + 持久执行平面 + 可靠交付平面”
```

这条推导没有使用项目年龄、当前代码量或团队规模决定目标能力。它们只会影响最终交付计划、部署配置和验证成本。

## 13. 从研究到 12 个模块

| 模块 | 直接来源 | 参考项目帮助 | 参考项目未提供 |
|---|---|---|---|
| Identity & Access | 跨入口不越权 | MAF Scope要求、nanobot身份缺口、LibreChat权限链 | Chat完整Principal/Binding/撤销模型 |
| Conversation | 会话连续 | pi/nanobot Session、LibreChat Conversation/Message树 | 与Work/Run/Evidence完整关联 |
| Context | “继续”与上下文透明 | MAF Provider、pi/nanobot上下文 | 产品ContextPackage审阅/失效 |
| Intent & Understanding | 多意图和纠错 | 参考只部分涉及 | 完整候选、澄清、修正模型 |
| Work & Planning | 跨回合推进 | pi计划/队列、nanobot Goal | Work/Plan/Action生命周期 |
| Execution Governance | 执行前可控制 | MAF Tool Approval、LibreChat HITL部分 | Draft/Hash/版本化产品Approval |
| Run Control & Recovery | 故障和重启可恢复 | LibreChat Job、pi恢复诚实性、MAF Checkpoint | 长期Run/Attempt/Lease/Finalization组合 |
| Tool Operations | 副作用结果未知 | MAF Tool机制、nanobot反例 | Ledger/幂等/对账/人工处置完整语义 |
| Knowledge & Memory | 候选不能冒充事实 | nanobot Memory、LibreChat Memory部分 | 来源有效性和用户确认门 |
| Evidence & Provenance | 结果可验证、来源失效 | 各项目仅部分 | 完整Evidence/派生/失效图 |
| Delivery & Integration | Run成功不等于送达 | nanobot缺口、LibreChat流/消息 | Outbox/Receipt/外部Binding完整合同 |
| Trace & Audit | 可观察、可运营 | MAF Telemetry、pi/nanobot事件 | 用户Trace、审计、恢复处置投影 |

## 14. 当前未知和后续验证

1. MAF 安装版与本地源码提交不一致；具体 Runtime Adapter、Middleware和事件序列要用安装版合同测试固定。
2. 当前 AG-UI RC 如何与持久 Workflow `checkpoint_id`、Product Approval 和跨进程 Resume 接合，尚未通过 E2E。
3. Product Finalization Gate 如何阻止过早标准`RUN_FINISHED`，需要比较框架扩展点、Adapter包装和上游升级影响。
4. Runtime Job/Event Store、Lease 和多 Worker 的具体存储实现尚未选型；SQLite能力必须按目标保证压测，不能凭偏好决定。
5. Product Store 与 Artifact Store 的一致提交、孤儿回收和备份恢复点尚未详细设计。
6. OPC-OS Chat 的正式身份、能力声明、版本、权限、命令、事件和回执合同尚未取得外部规范。
7. Intent、Work、Approval、Tool、Evidence、Delivery 和 Trace 的字段级聚合与状态机仍需逐模块审核。
8. 外部 Tool 没有通用 exactly-once；每个 Adapter 必须声明幂等、查询、补偿和人工处置能力。
9. 安全、容量、SLO、数据保留和灾难恢复目标需要产品级非功能指标，当前只有架构责任，没有批准数值。

这些未知不阻止审核目标边界，但禁止把候选写成已经实现或已经验证的保证。

## 15. 研究结论

1. Chat 必须按独立完整产品设计，OPC-OS Chat 只是一种外部集成关系。
2. MAF 是 Agent/Workflow Runtime，不是产品应用层或事实源。
3. 12 个产品模块来自完整场景中的状态所有权和不变量，不来自参考仓库目录。
4. 持久 Job、Lease/Event、Tool Ledger、Outbox/Receipt 和 Provenance 都是目标场景必需能力，不是以后可能增加的占位符。
5. 推荐目标架构是“模块化产品核心 + 持久执行平面 + 可靠交付平面”；领域模块保持代码边界，进程按生命周期和故障域拆分。
6. MAF、pi、nanobot、LibreChat 已足以支持总体边界判断；详细领域状态机仍由本项目设计并分别审核。
