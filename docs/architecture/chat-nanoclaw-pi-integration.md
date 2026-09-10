# Chat、NanoClaw与Pi当前集成基线

## 1. 文档状态

本文保留迁移前的 Chat Pi 集成边界、代码位置、HTTP 合同和验证要求。2026-09-07 用户确认的完整目标以[定义与配置模型](./chat-long-agent-capability-model.md)、[Long Agent 架构](./chat-long-agent-architecture.md)和[场景验收](./chat-long-agent-scenarios.md)为准；实现差距见[实施状态](./chat-long-agent-roadmap.md)。

下文的共享 daily、唯一 primarySessionId、分散身份配置及 Docker-free 启动是当前实现合同，不再约束目标设计。文中沿用的“目标”“必须”和代码示例，仅适用于这套迁移前接入方案。新目标保留 Pi 唯一 Runtime、Project 固有归属与耐久消息机制，增加独立 Daily、业务多 Session 和受控 Docker 工具环境；不能通过改配置恢复 Nano 原生 Agent Runtime 来冒充完成迁移。

公共 Pi 装配、Chat Web 原生 Long Agent 执行、服务认证、耐久 Channel Event、可靠 Delivery/Ack 及 Group/OKF Memory 已接入；调度等非 Channel 触发和其他完整能力尚未接入。本轮只更新文档，不改当前运行行为。

## 2. 当前集成约束

Chat中的目标关系固定为：

```text
Chat Web ─────────────────────────────┐
                                     │
Telegram / IM → NanoClaw Channel Gateway ├→ Chat LongAgent Runtime → Pi AgentSession
                                     │
NanoClaw Scheduler / Proactive Event ┘
```

1. Pi是Chat唯一Agent Runtime，不允许Long Agent再选择Claude SDK、Codex CLI、OpenCode或其他Agent Harness。
2. Model Provider仍由Pi管理。OpenAI、Anthropic、DeepSeek、Kimi或Qwen是Pi的Model Provider，不是NanoClaw的Agent Provider。
3. Chat拥有Project、Pi运行策略、Chat Session、Agent装配、Workflow、Mem0和用户可见历史。
4. NanoClaw拥有Agent Group长期身份、Workspace、Markdown Agent Memory、Standing Instructions、Skill与Template生态、IM Channel、外部身份校验、入口路由、Channel Session坐标、持久收件箱、调度触发、Destination、主动投递和投递回执；Channel Session不是Agent Runtime Session。
5. Chat Web和NanoClaw都是Chat Backend客户端。Web使用浏览器HTTP/流式合同，NanoClaw使用耐久异步Channel Event合同；入口不同不能产生不同的Agent配置、Session语义或Memory体系。
6. 一个NanoClaw Host管理多个Long Agent，不按Bot、Agent或Project启动多个Host进程。
7. NanoClaw `Agent Group`对应一个Long Agent的NanoClaw侧长期实体，不是多个Agent组成的Team。它不拥有Pi Model和Chat Session，但拥有长期身份、Workspace、Agent Memory和NanoClaw生态资源；这些能力通过版本化Management与Resource合同进入Chat Pi装配。
8. Chat Pi不可用时，NanoClaw保留耐久Inbox并重试；禁止回退到容器、Codex或其他Agent Runtime。
9. Daily是用户的个人日常Project，与其他Project使用同一套Session、Long Agent与侧边栏导航合同；不另建个人模式。

## 3. 当前Pi部署选择与原生容器边界

NanoClaw当前的`AgentProvider`扩展点位于Session容器内，因此技术上可以增加一个直接调用Pi SDK的Provider。但对Chat产品而言，这不是最优边界：

1. Chat必须把Model、Credential、Project Context、Rule、Skill、Tool和Extension快照复制到容器。
2. NanoClaw会产生一份Provider运行Session，Chat还需要一份用户可见Project Session。
3. Chat Web操作Session时必须与另一个进程协调写入、分支、重命名、压缩和删除。
4. Workflow和Mem0 Tool仍要从容器反向调用Chat，形成额外的Remote Tool层。
5. Pi版本、Agent装配和资源解析很容易在Chat与NanoClaw两边漂移。

因此，Chat管理的Long Agent不走NanoClaw容器内`AgentProvider`。NanoClaw在路由完成后把已鉴权的Inbound Envelope交给Chat；Chat在自己的LongAgent Runtime中直接调用Pi SDK。NanoClaw独立使用时仍可保留Provider机制；同一个Host一旦配置为Chat Channel Gateway，`chat-pi` Driver接管该Instance的全部Session，不提供逐Agent混合模式。

这样既是“直接使用Pi SDK”，又保证与Chat Workflow使用同一个Pi底座，而不是仅仅在两个位置分别安装同一个SDK。

## 4. NanoClaw现有运行链与接入位置

当前NanoClaw真实链路是：

```text
Channel Adapter
  → routeInbound()
  → resolveSession()
  → writeSessionMessage() / inbound.db
  → requestWake()
  → container-runner
  → AgentProvider.query()
  → outbound.db
  → delivery poll
  → Channel Adapter.deliver()
```

关键源码位置：

| 环节 | NanoClaw源码 | 现有职责 |
|---|---|---|
| 入口标准化 | `src/channels/adapter.ts`、`src/channels/telegram.ts` | 把平台消息转为`InboundEvent` |
| 身份与路由 | `src/router.ts#routeInbound` | Messaging Group、Agent Group、权限、Thread与Session解析 |
| Session映射 | `src/session-manager.ts#resolveSession` | `agentGroup + messagingGroup + thread`映射Nano Session |
| 持久收件箱 | `src/session-manager.ts#writeSessionMessage` | 把消息写入Session Mailbox后再唤醒执行 |
| 执行唤醒 | `src/request-wake.ts`、`src/container-runner.ts` | 当前默认启动Session容器 |
| 容器Agent循环 | `container/agent-runner/src/poll-loop.ts` | 消费Inbox、调用Provider、写Outbound |
| 外部投递 | `src/delivery.ts` | 重试、去重、文件处理和Channel投递 |
| Chat Channel Gateway | `src/modules/chat-integration/` | 把Inbound/Outbound写入HTTP Outbox并提供窄Delivery/Ack接口 |

正确接入点位于`writeSessionMessage()`持久化之后、`requestWake()`之前。需要增加一个显式的`ExecutionDriver`：

```ts
interface ExecutionDriver {
  readonly kind: string;
  wake(input: LongAgentWakeEnvelope): Promise<void>;
  stop?(sessionId: string): Promise<void>;
}
```

NanoClaw默认独立模式仍可使用`container` Driver；Chat Channel Gateway模式使用Instance级`chat-pi` Driver接管整个Instance。该模式启动时不创建NanoClaw Session Driver，不探测Docker、不接管或监听容器、不启动OneCLI Agent审批订阅，也不维护Docker Egress网络。容器配置表的数据迁移仍可作为普通Host数据维护执行，因为调度时区暂时复用该表；它不能触发Runtime或Docker。`chat-pi`缺少`CHAT_BACKEND_URL`、`CHAT_CHANNEL_GATEWAY_TOKEN`或execution mode非法时启动必须失败，不能静默选择默认Docker Driver。Router不感知Pi，Chat也不读取NanoClaw数据库。逐Agent Group allowlist只允许作为一次性迁移门禁，完成真实canary后必须删除，不能进入长期配置和管理页面。

切换模式是部署迁移而不是运行时回退：已有独立NanoClaw Host及Agent容器必须在启用`chat-pi`前停止。启用后Chat不可用只会让耐久Inbox保留并重试，NanoClaw不能为了“恢复服务”重新初始化容器Runtime。

## 5. Chat内部Pi装配统一

当前Chat的`createWorkflowAgentSession()`同时包含公共Pi装配和Workflow包装。目标是抽出公共工厂：

```text
createChatPiAgentSession()
  ├── createWorkflowAgentSession()
  └── createLongAgentSession()
```

公共工厂统一处理：

1. 固定Pi SDK版本。
2. `SessionManager`与Project Session目录。
3. `DefaultResourceLoader`及Context文件边界。
4. Model与Thinking Level。
5. System Prompt、自定义Prompt、Rule、Skill、Extension和Plugin。
6. Chat System Tool注册和授权。
7. 事件、Usage、Tool Call、Compaction和错误记录。

两个上层包装只增加各自领域能力：

| 包装 | 只负责的差异 |
|---|---|
| Workflow | Stage、Node、Child Workflow、Review和Run状态 |
| Long Agent | Channel来源、Delivery Binding、主动事件、Agent Group Context Snapshot和长期身份；Chat Mem0 与 Nano Markdown Agent Memory 已通过受控 Tool 和 Group Snapshot 接入 |

Long Agent每轮创建新的Pi `AgentSession`执行对象，但必须绑定同一个`ProjectLongAgent.primarySessionId`和Pi `SessionManager`。新执行对象会恢复原生Session分支、消息、Tool、Usage与Compaction状态；它不是新建产品会话。Turn完成后释放执行对象可以避免常驻模型连接和进程内状态泄漏，不影响Long Agent的持续上下文。

前端和NanoClaw都不能自行拼装Agent Definition。

### 5.1 Long Agent配置合同

`LongAgent`是Personal定义，统一保存身份、Personal全局启停、`defaultProjectId`、Model、Thinking Level、System Prompt/自定义Prompt、Tools和Resources。`ProjectLongAgent`不是第二层Agent Definition；它只保存当前Project的`active/paused`状态和唯一`primarySessionId`。

Chat Web从当前Project侧边栏切换到“长期同事”导航面板，再通过同事条目的设置操作进入配置页；页面必须标明其编辑的是Personal配置。数据合同是：

1. `GET /api/long-agents/:id/config`返回`schemaVersion: 1`、`revision`、可编辑Agent Definition和只读Channel/Host摘要。
2. `PUT /api/long-agents/:id/config`使用`expectedRevision`做乐观并发控制，校验通过后对`<CHAT_HOME>/long-agents.json`串行化原子替换；冲突返回`409`。
3. Telegram adapter、Channel instance和NanoClaw Host是只读运行信息，不通过该`PUT`修改。GET和PUT响应都不返回Gateway地址、Credential、Bot Token、模型密钥或凭据摘要。

## 6. 当前身份与绑定合同

产品会话身份始终是`chatSessionId`。NanoClaw的Session只是通道路由身份，不成为用户可见会话事实。Long Agent在Project中的产品身份由`ProjectLongAgent`表示：

```ts
interface ProjectLongAgent {
  id: string;
  projectId: string;
  longAgentId: string;
  status: "active" | "paused";
  primarySessionId: string;
}

interface LongAgentChannelBinding {
  bindingId: string;
  projectLongAgentId: string;
  nanoclawInstanceId: string;
  nanoclawAgentGroupId: string;
  nanoclawSessionId: string;
  source: ChannelAddress;
  defaultDelivery: ChannelAddress;
  revision: number;
}
```

约束：

1. 一个`projectId + longAgentId`只能有一个`ProjectLongAgent`和一个`primarySessionId`。
2. 同一个Long Agent可以挂载到多个Project，但每个Project的主Session、Project Memory和资源隔离。
3. 多个NanoClaw Session和Channel可以绑定同一个ProjectLongAgent，不能各自创建Chat主Session。
4. 普通Project Session不绑定Long Agent；从Project长期同事区域打开Long Agent时进入专属主Session，不能改变来源Session的执行者。
5. Project切换必须创建或选择明确的ProjectLongAgent，不能修改消息上的`projectId`伪造跨Project访问。
6. ProjectLongAgent创建和Channel Binding更新必须串行化，防止Web与IM并发创建两条主Session。

## 7. 内部数据合同

### 7.1 NanoClaw到Chat的Channel Event

```ts
interface ChannelEventRequest {
  schemaVersion: 1;
  instanceId: string;
  events: NanoClawIntegrationEvent[];
}
```

NanoClaw调用`POST /api/internal/channel/v1/events`，使用独立于网页登录Cookie的Bearer服务认证。`eventId`由`nanoclawInstanceId + nanoSessionId + direction + messageId`生成；请求只能携带Channel、Session、Agent Group和消息事实，不能指定Chat `projectId`、Prompt、Model或Credential。Chat校验请求中的Instance与Agent Group已登记，再解析Long Agent与Binding，原子写入耐久Ingress后返回逐事件`accepted/duplicate`结果和HTTP `202`。同ID不同payload hash返回`409`。

入站图片随事件`images`字段传递，格式为Pi `ImageContent`（`{ type: "image", data, mimeType }`，base64，一条消息最多10张、单张解码后不超过10MB）。纯图片消息允许空`text`。Chat在Pi装配后用生效模型的`input`能力检查图片输入：不支持图片的模型不调用Provider，而是生成一条友好的Assistant回复经Delivery返回渠道，Turn按完成归档，不进入退避重试。

### 7.2 Chat到NanoClaw的Delivery Envelope

```ts
interface LongAgentDeliveryEnvelope {
  schemaVersion: 1;
  agentGroupId: string;
  nanoSessionId: string;
  messageId: string;
  chatSessionId: string;
  destination: ChannelAddress;
  text: string;
  /** 可选：本轮产生的图片（base64），文件名带与MIME一致的扩展名 */
  files?: { filename: string; data: string }[];
}
```

Chat调用NanoClaw `/webhook/chat-backend/v1/deliveries`，NanoClaw只负责把Envelope持久化到Outbound Mailbox并投递。Delivery成功持久化后，Chat再调用独立的`/acks`确认Inbound；重试不能再次运行Pi，也不能在Chat中追加第二条Assistant Message。NanoClaw对Chat只开放`/health`、`/deliveries`、`/acks`、`/agent-messages`和版本化的`/agent-groups/*`身份/OKF Memory资源合同，不能扩展成通用CLI command dispatcher；这些接口均使用同一服务认证且不能直接暴露给浏览器。`/agent-messages`承载Long Agent的主动联系：目的地必须是该Agent Group已接线的Messaging Group（NanoClaw侧强制校验），由Chat按可信Agent身份从Registry绑定解析，模型不能指定接收方。

### 7.3 Chat内部Long Agent执行请求

```ts
interface LongAgentTurnRequest {
  projectId: string;
  chatSessionId: string;
  longAgentId: string;
  bindingId: string;
  inboundEventId: string;
  replyTo: ChannelAddress;
  content: MessageContent[];
}
```

Chat根据这些稳定身份解析LongAgent Definition，并在Turn开始前冻结资源Revision。请求不得携带Model密钥、任意系统路径或可以覆盖身份的Prompt字段。

## 8. 各场景的数据流

### 8.1 Chat Web启动或打开Project Long Agent

```text
Frontend
  → Chat解析ProjectLongAgent
  → 不存在时创建唯一专属主Session
  → Chat调用LongAgent Runtime
  → Pi把User Message写入同一Chat Session
  → Pi执行并写入完整Assistant/Tool/Usage Entry
  → 回复直接返回Frontend
```

Web入口不需要经过NanoClaw Router。Frontend在同一Project侧边栏提供互斥的“会话 / 长期同事”导航面板，默认是完整保留旧布局与信息的“会话”，不为Long Agent预留占位。“长期同事”面板展示当前Project的专属主Session入口与设置；用户单击同事条目就打开已有专属主Session，尚未启动时由同一次动作创建并打开。

手动切换导航面板只更换侧边栏内容，不改变中央区已打开的会话。打开或新建普通Session时自动切回“会话”；打开Long Agent或页面刷新读取到`session.owner.type === "long-agent"`时自动切到“长期同事”。“新建会话”继续只创建普通Project Session；Long Agent入口只打开或创建它的专属主Session。只有用户绑定IM或回复需要投递到IM时，Chat才向NanoClaw创建或更新Channel Binding。

### 8.2 Telegram首次私聊

```text
Telegram
  → NanoClaw验证Bot实例和发送者
  → Router解析Long Agent与Nano Session
  → chat-pi Driver向Chat请求Binding
  → Chat在Daily Project创建或恢复ProjectLongAgent专属主Session
  → NanoClaw持久化Inbound Envelope
  → Chat LongAgent Runtime调用Pi
  → Chat原生Pi Session记录完整Turn
  → Chat发送Delivery Envelope
  → NanoClaw写Outbound并投递Telegram
```

ProjectLongAgent和Channel Binding必须在Pi执行前确定。Web与IM并发首次启动时也只能提交一个`primarySessionId`。

### 8.3 Chat Web继续Telegram Inbox

```text
Frontend打开已绑定Chat Session
  → Chat直接调用相同LongAgent Runtime和Pi Session
  → 本轮replyTo=chat-web
  → Pi输出只返回Web
  → 不创建Telegram Delivery Envelope
```

后续Telegram消息仍进入同一个`chatSessionId`，因此Pi上下文包含Web阶段的对话。Telegram客户端不会补显示仅在Web发生的消息，这是入口显示差异，不是Session分叉。

### 8.4 Telegram继续会话

NanoClaw通过既有`nanoSessionId → channelBindingId → projectLongAgentId → primarySessionId`映射提交消息。Chat以`inboundEventId`去重后继续同一个Pi Session，回复默认投递原Telegram地址。

### 8.5 Agent一次发送多条消息

Pi可以产生多条用户可见消息。每条消息拥有独立`deliveryId`和独立Pi Session Entry：

1. Chat中每条只记录一次。
2. NanoClaw对每个Delivery分别重试和记录回执。
3. 某一条投递失败不会重跑整个Agent Turn。
4. “只出现一次”是幂等要求，不是限制Agent只能回复一条。

### 8.6 定时任务与主动消息

创建任务时必须固定：

```text
longAgentId + projectId + targetChatSessionId + deliveryBinding
```

到期后NanoClaw只发出`ScheduledWakeEnvelope`。Chat创建一个属于目标Session的Pi Child Session运行任务，将Run摘要和最终消息写入目标Chat Session，再按Delivery Binding决定是否通知Telegram。任务重试复用同一个`runId`，不能重复创建Chat消息。

### 8.7 Long Agent调用Workflow

Pi装配Chat原生`workflow_call` Tool：

1. Tool Context由Host注入当前`projectId/chatSessionId/longAgentId`。
2. Workflow创建Pi Child Session并记录父子关系。
3. Workflow执行结果作为Tool Result返回Long Agent Pi Session。
4. Long Agent决定怎样向用户总结或继续处理。
5. NanoClaw看不到Workflow内部Node、Credential或Project路径。

### 8.8 Memory

Memory分为两个互补Target。Chat Catalog与Mem0保存Personal/Project共享事实，Pi通过`memory_search`和`memory_record`访问授权Target；NanoClaw Agent Group的Open Knowledge Format Markdown保存该Long Agent自己的身份、关系史、经验、开放事项与工作方法。

两类Memory均已进入`chat-pi`主链。NanoClaw Agent Group Markdown保持唯一事实源，通过版本化Context Snapshot、Group作用域的`agent_memory_search/read/write` Tool和网页登录后的Backend管理API进入Pi与Chat Web；Chat不复制其内容到Mem0。Snapshot只保存在`<CHAT_HOME>/runtime/long-agents/<longAgentId>/agent-group-snapshot.json`作为原子更新的派生缓存，Nano离线时标记stale。两个Tool体系使用不同名称和Target；模型不能传入`agentGroupId`。

### 8.9 多Long Agent协作

Agent-to-Agent调用必须通过Chat LongAgent Registry解析目标：

```text
Agent A Pi Tool
  → Chat校验Project、权限与目标LongAgent
  → 创建或选择Agent B在当前Project中的专属主Session
  → 调用Agent B的Pi AgentSession
  → 结果返回Agent A Tool Result
```

如果Agent B需要Telegram通知，Chat再单独发Delivery Envelope给NanoClaw。NanoClaw不根据自然语言自行猜测Project和目标Session。

### 8.10 普通Session Handoff与Project切换

普通Session不能原地切换为Long Agent Session。显式Handoff只把来源Session ID、选定Entry与摘要关联到目标ProjectLongAgent主Session，两个Session继续独立。Chat Web通过Project选择器确定目标；Telegram没有天然Project UI，因此默认进入Daily。切换到具体Project必须使用显式命令、按钮或Chat Web生成的绑定动作，并解析另一个ProjectLongAgent，不能移动或改名Daily主Session。

## 9. 一致性、失败与恢复

目标状态机：

```text
accepted → bound → persisted → running → completed
                                      └→ failed
completed → delivery_pending → delivered
                             └→ delivery_failed
```

1. NanoClaw接受消息后先持久化，再通知Chat执行。
2. Chat以`inboundEventId`保证User Message和Pi Turn只执行一次。
3. Chat完成Pi Turn后先提交Session，再创建Delivery Envelope。
4. NanoClaw投递重试不重新执行Pi Turn。
5. Chat不可用时，Inbound留在NanoClaw Mailbox，按退避策略重试；若Inbox已写入但Event Outbox写入失败，后续唤醒先从待确认Inbox确定性补建Event。
6. Pi瞬时失败保留失败Marker，并从同一个原生User或最近ToolResult建立新分支重试；用户消息只落一次，完成结果继续按`turnId`幂等恢复。
6. NanoClaw不可用时，Chat Web仍能使用Long Agent；需要IM投递的消息保持`delivery_pending`。
7. 两边通过耐久HTTP Outbox/Ingress、幂等ID和payload hash恢复，不按消息文本、时间戳或数组位置去重。
8. Credential只保存在Chat Credential Store或NanoClaw Channel Credential Store，不进入Envelope、Pi Session、Prompt或日志。

## 10. 当前实现状态

| 项目 | 当前实现 | 后续收敛 |
|---|---|---|
| Agent Runtime | Pi是Chat唯一Agent Runtime；NanoClaw Instance整体使用`chat-pi`模式并完全跳过自身Session Runtime | 移除Codex主链兼容代码 |
| Web消息 | Chat直接运行Pi并返回原生Session事实 | 增加与Workflow一致的流式事件体验 |
| Telegram消息 | Nano Router先持久化HTTP Outbox事件，再主动POST到Chat耐久Ingress；Chat恢复Worker执行同一Pi Runtime | 将首次Binding解析提升为独立请求/响应合同 |
| 定时与非Router触发 | NanoClaw保留任务和Mailbox事实；当前直接写Mailbox的触发尚未生成Chat Integration Event | 建立统一Trigger Envelope后再启用Chat Pi定时/主动执行 |
| Chat Session | Pi直接写User、Assistant、Tool、Usage与Compaction；ProjectLongAgent固定唯一主Session | 增加Handoff和主动任务Child Session摘要 |
| Agent配置 | `<CHAT_HOME>/long-agents.json`中的`definition`是Chat唯一Pi能力定义；Project侧边栏设置页已通过GET/PUT API编辑Personal定义，使用revision防冲突 | 补全更多运维摘要，不扩大Credential暴露面 |
| Model | Chat公共Pi Model Runtime决定；配置页可修改Long Agent级Model和Thinking Level | 持续与公共Model Catalog和认证校验保持一致 |
| Workflow与Memory | 默认Long Agent Definition已装配`workflow_call`、`memory_search`、`memory_record`与`agent_memory_search/read/write`；Agent Group身份和Core OKF Memory按Revision注入 | 补Agent-to-Agent Tool、完整Workspace/Skill快照与统一Trigger |
| 投递可靠性 | Chat先幂等写Nano Outbox、触发即时Drain，再确认Inbound；重复Delivery ID被忽略，周期Poll负责恢复 | 把Delivery回执投影为Chat Session状态 |

## 11. 实施顺序

1. 已完成：抽取`createChatPiAgentSession()`，Workflow继续通过薄包装使用。
2. 已完成：Chat `LongAgentRuntime`使Chat Web直接运行Pi并写原生Session。
3. 已完成：Binding、Turn、HTTP Event、Delivery和Ack使用版本化稳定身份、服务认证与运行时校验。
4. 已完成：NanoClaw增加`ExecutionDriver`注册表与Instance级`chat-pi` Driver，在`requestWake()`刷新HTTP Event Outbox；实例级Driver存在时启动与Sweep都不初始化或依赖NanoClaw Session Runtime。
5. 已完成：Telegram来信先进入耐久Inbox和HTTP Event Outbox；外部执行唤醒会从待确认Inbox补建缺失Event；Chat在返回`202`前写入耐久Ingress，执行前解析Binding，两端失败分别退避重试。
6. 已完成：NanoClaw Outbound持久化和Inbound确认分离，Delivery重试不重跑Pi。
7. 部分完成：Workflow与Personal/Project Mem0 Tool已进入默认装配；Agent Group OKF Memory已进入上下文和Tool主链，Agent-to-Agent、完整Workspace/Skill快照与统一Trigger继续实现。
8. 已完成：Nexus灰度canary通过Chat Web、Telegram真实收发与NanoClaw重启验收。
9. 已完成：Instance整体迁移到Pi；旧逐入口Session Binding自动迁移为ProjectLongAgent唯一主Session，历史Session保持原样。
10. 已完成基础入口与配置：Chat Web在同一Project侧边栏提供互斥的“会话 / 长期同事”导航面板，旧Session面板不受Long Agent占位影响；同事面板提供唯一专属主Session和设置入口，配置页管理Personal LongAgent定义。GET/PUT配置API、乐观revision和原子写已落地。单Bot健康、任务与投递偏好继续迭代。

## 12. 验收条件

1. 同一Nexus会话在Chat Web与Telegram交叉输入时只有一个`chatSessionId`。
2. User、Assistant、Thinking、Tool、Usage与Compaction均由Pi原生写入Session。
3. Web来源默认只回复Web，Telegram来源默认只回复Telegram。
4. 同一外部消息重放10次只执行一个Pi Turn。
5. Telegram投递失败重试不会产生第二条Assistant Session Entry。
6. Chat重启后可从NanoClaw Inbox恢复未处理消息；NanoClaw重启后可恢复待投递消息。
7. Long Agent调用Workflow时使用同一Project并生成可追溯Child Session。
8. Long Agent可通过`memory_search`与`memory_record`访问授权的Personal/Project Mem0；独立Agent Memory不在当前验收范围。
9. 一个NanoClaw Host同时承载多个Bot和Long Agent，Agent配置只来自Chat。
10. NanoClaw容器或配置中不存在Chat Model Credential、完整`CHAT_HOME`或未授权Project路径。
11. `chat-pi`模式在Docker不可用时仍能启动；NanoClaw不运行Agent容器、`docker events`或Docker网络维护，也不根据容器心跳处理外部Pi Turn。
