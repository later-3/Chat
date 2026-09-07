# Chat Long Agent与多入口架构

## 1. 文档地位与范围

本文定义Chat中的Long Agent、NanoClaw运行时、多Agent、Daily Project、Chat Web、IM Channel、主动任务和Chat能力桥接。它受[Chat Agent第一性原理与架构约束](./chat-agent-first-principles.md)、[Chat需求分析](./chat-requirements.md)、[Chat Project架构](./chat-project-framework.md)和[Chat Session架构](./chat-session-architecture.md)约束。

本文同时记录产品需求和当前落地状态；[Chat、NanoClaw与Pi统一集成设计](./chat-nanoclaw-pi-integration.md)进一步定义目标执行边界、内部合同和各场景数据流，[Chat Long Agent能力与NanoClaw Agent Group模型](./chat-long-agent-capability-model.md)定义长期身份、Workspace、Agent Memory和生态能力。Chat使用Pi作为架构级唯一Agent Runtime；NanoClaw以Instance为单位进入`chat-pi`模式，不能为不同Long Agent选择不同运行时。NanoClaw `Agent Group`是一个Long Agent的长期身份与资源边界，不是多个Agent组成的Team。

## 2. 已确认的产品原则

1. Long Agent和Workflow都是Chat能力，不是互相替代的两套产品。
2. Long Agent提供长期身份、长期在线、IM、主动与定时工作；当前长期事实读写使用Chat Personal/Project Mem0 Tool，独立Agent Memory和Agent-to-Agent是后续能力。
3. Workflow组织一次任务的Node、Agent、Stage、能力和执行证据；Long Agent可以调用Workflow。
4. 所有Long Agent会话、主动任务和Workflow调用都必须属于Project；没有更具体归属的新交互进入Daily Project。
5. Daily是用户的个人日常Project，不另建“个人模式”或无Project模式。Daily Project下面可以有很多Chat Session，不存在一条自动吞并所有日常交互的“Daily总会话”。
6. Chat Web是统一浏览器入口和完整会话观察面；IM是可选输入与投递入口。入口变化不改变Project和Chat Session身份。
7. Long Agent独立存在，但执行时必须挂载到一个Project；未挂载Long Agent的Project仍可只使用普通Session和Workflow。
8. 每个`projectId + longAgentId`只有一个专属主Session。Long Agent跨Project时各自拥有独立主Session；Workflow、定时任务和Agent-to-Agent可以创建可追溯Child Session，但不能制造第二条并列主会话。
9. 普通Project Session不能通过切换选择器被Long Agent接管；需要Long Agent继续处理时使用显式Handoff，并把来源Session作为证据关联到专属主Session。

## 3. Workflow Agent与Long Agent的生命周期

必须区分两个名字相似但生命周期不同的对象：

| 对象 | 产品职责 | 运行承载 | 生命周期 |
|---|---|---|---|
| Workflow Agent定义 | 某个Workflow Stage所需的模型、Prompt、Tool和资源 | Chat配置与Pi | 长期定义 |
| Pi AgentSession | Workflow或Long Agent的实际执行对象 | Chat统一Pi Runtime | 一个Stage或Turn |
| Long Agent | 用户可管理的长期助手身份 | Chat `LongAgent` + NanoClaw Agent Group | 长期存在 |
| Project Long Agent | Long Agent在一个Project中的启停状态和唯一专属主Session | Chat运行状态与Session索引 | 随Project长期存在 |
| NanoClaw Channel Session | Channel、Messaging Group、Thread与Mailbox的路由坐标，不是Agent Runtime Session | NanoClaw Host与Mailbox | 跨多轮持续 |

Long Agent身份长期存在，但每次执行仍由Chat通过同一个公共Pi装配入口创建或恢复AgentSession。NanoClaw Channel Session不拥有Agent配置、模型或对话事实，也不对应NanoClaw Session Runtime。Long Agent调用Workflow时，目标Workflow按Chat既有规则创建本轮Pi AgentSession和必要的Child Session。

## 4. 多Agent默认部署拓扑

多Long Agent默认由一个NanoClaw Host管理，不按Agent启动多个NanoClaw进程：

```text
NanoClaw Host（单进程）
  ├── Telegram Bot A → Agent Group A → Nano Session A1
  ├── Telegram Bot B → Agent Group B → Nano Session B1
  ├── Scheduler / Durable Inbox / Outbound Delivery
  └── chat-pi Execution Driver
                         │
                         ▼
Chat LongAgent Runtime
  ├── Project A + Long Agent A → 专属主Session S1 → Pi AgentSession
  ├── Project B + Long Agent A → 专属主Session S2 → Pi AgentSession
  ├── Project A + Long Agent B → 专属主Session S3 → Pi AgentSession
  └── Workflow / Personal与Project Mem0 Tool
```

对象映射：

```text
一个NanoClaw Instance → 多个Chat LongAgent
一个Chat LongAgent    → 一个NanoClaw Agent Group
一个Agent Group       → 一个Long Agent的NanoClaw身份、Workspace、Memory与Channel边界
一个Project LongAgent → 一个专属主Chat Session
多个NanoClaw Session  → 可以绑定同一个Project LongAgent
一个专属主Session     → 由Chat直接装配和运行Pi AgentSession
```

NanoClaw Host负责路由、Channel、调度、Mailbox和投递；Chat负责Pi执行。`chat-pi`实例启动时不初始化NanoClaw Session Runtime，不探测Docker、不接管或监听容器，也不维护Docker网络。NanoClaw独立版的Session容器与Provider机制不进入Chat Long Agent主执行链。只有出现以下边界时才增加NanoClaw实例：

1. 不同系统用户或不同Chat租户。
2. 互不信任的安全域，不能共享Host数据库和宿主权限。
3. 独立机器、独立升级节奏或独立故障域。
4. 单机容量需要拆分，且已经有可观测的性能证据。

“用户有多个Long Agent”“一个Long Agent挂载到多个Project”或“每个Agent使用不同Telegram Bot”本身都不要求多个Host进程。

## 5. Project Long Agent与专属主会话

推荐结构：

```text
Project
├── 普通Session S1、S2……
│   ├── 直接聊天
│   └── Workflow
├── Project Long Agent A
│   └── 专属主Session LA1
│       ├── Chat Web
│       ├── Telegram / IM
│       ├── Scheduler / 主动消息
│       └── Workflow Child Session
└── Project Long Agent B
    └── 专属主Session LB1
```

Project是Long Agent工作的数据、安全和资源边界。Long Agent定义属于Personal；用户在Project中首次启动它时创建`ProjectLongAgent`和唯一专属主Session。Daily遵守相同规则，只是在IM没有更具体Project归属时作为默认Project。专属主Session不是Daily总会话，也不是普通Session；停用Long Agent只停止新执行，历史和Session继续保留。

Chat Web在同一Project上下文中把侧边栏划分为互斥的“会话 / 长期同事”导航面板，默认显示“会话”。“会话”面板完整保留旧有普通Session布局、列表信息和新建入口，不为Long Agent预留占位；“长期同事”面板只展示同事在当前Project中的唯一专属主Session入口与设置操作。单击同事后直接打开专属主Session，尚未启动时原地创建后打开；专属主Session不进入普通Session列表。

面板只控制侧边栏导航内容，用户手动在“会话 / 长期同事”之间切换时，中央区已打开的会话保持不变。打开普通Session或新建普通Session会自动切回“会话”；打开Long Agent或页面刷新后当`session.owner.type === "long-agent"`时会自动切到“长期同事”。这一导航切换不改变Project、Session身份或执行者。

Session列表项和Session详情都必须返回同一份服务端`session.owner`归属事实：

```ts
type ChatSessionOwner =
  | { type: "ordinary" }
  | { type: "long-agent"; longAgentId: string; projectLongAgentId: string };
```

`session.owner`同时决定侧边栏导航面板和发送链路：`ordinary`进入Workflow发送，`long-agent`按服务端给出的`longAgentId/projectLongAgentId`发送。Frontend不得等待Long Agent列表后用`primarySessionId`异步反推归属，不得从消息内容或消息来源猜测，也不得另存第二份Session到Long Agent映射。`owner`缺失、非法或无法解析时必须阻止发送并重新加载/告警，不得fail-open成普通Workflow。

### 5.1 Personal定义与Project挂载

`LongAgent`定义是Personal事实，保存身份、Personal全局启停、默认Project以及Model、Thinking Level、Prompt、Tools和Resources。从任意Project侧边栏的“长期同事”设置入口打开的都是这份Personal定义，保存后对该Agent的所有Project挂载生效。

`ProjectLongAgent`只保存当前Project的`active/paused`状态和唯一`primarySessionId`，不复制LongAgent Definition，也不保存Project级Model、Prompt、Tool或Resource覆盖。Personal全局停用与Project挂载暂停是两个不同状态，管理页和API不得混合它们。

### 5.2 唯一性与创建规则

1. `projectId + longAgentId`唯一确定一个`ProjectLongAgent`。
2. `ProjectLongAgent.primarySessionId`创建后保持稳定；Chat Web、Telegram、Scheduler和主动事件都解析到它。
3. 用户可以完全不启动Long Agent，只新建普通Project Session。
4. 用户从Project侧栏的长期同事区域打开Long Agent时，Chat打开或创建它的专属主Session，而不是把普通Session改造成Long Agent Session。
5. Long Agent调用Workflow时创建Child Session；Child完成后把结果回写主Session，不成为第二条Long Agent主会话。
6. Long Agent跨Project使用时，每个Project独立创建`ProjectLongAgent`和主Session，Session、Project Memory与资源默认隔离。

### 5.3 Telegram发起，Chat Web观察

1. 已验证用户从Telegram私聊发送消息。
2. NanoClaw按Messaging Group和Agent Group创建或恢复NanoClaw Session。
3. `chat-pi` Driver在执行前向Chat解析`ProjectLongAgent`；不存在时在该Long Agent的默认Project创建专属主Session。
4. NanoClaw持久化Inbound Envelope，Chat以稳定外部消息ID去重后运行Pi。
5. Pi把User、Assistant、Tool、Usage和Compaction原生写入同一Chat Session。
6. Chat提交Session后向NanoClaw发Delivery Envelope；NanoClaw负责Telegram投递和重试。

### 5.4 Chat Web继续专属主会话

1. 用户在Project的Long Agent区域打开该Agent唯一的专属主Session。
2. Chat Backend直接恢复该Chat Session并调用LongAgent Runtime中的Pi AgentSession。
3. 本轮`replyTo=chat-web`，结果直接返回Web，不创建Telegram Delivery Envelope。
4. Channel Binding保持原NanoClaw Session不变；Chat不创建第二个产品Session。
5. 本轮默认只回复Chat Web，不重复推送Telegram；完整消息由Pi写入Chat Session。

用户随后从Telegram继续发送时，NanoClaw通过Binding提交到同一个`chatSessionId`，因此Pi能够看到Web阶段上下文。Telegram客户端本身不会自动补显示只发生在Web的消息，这不影响Chat完整历史。

### 5.5 普通Session与Handoff

“新建会话”始终创建普通Project Session，不创建第二条Long Agent主会话。用户要让Long Agent继续某段普通会话时，使用显式Handoff：Chat把来源`sessionId`、选定消息Entry和摘要写入专属主Session，然后由Long Agent决定处理方式。Handoff保留两个Session的独立身份和可追溯关系，不复制整份历史，也不改变来源Session的执行者。

## 6. 回复与主动消息投递

默认投递策略是“回复本轮来源，Chat始终记录”：

| 触发来源 | 默认回复目标 | Chat Session |
|---|---|---|
| Telegram | Telegram原会话 | 同步用户消息和每条Agent回复 |
| Chat Web | 当前Chat Web Session | 直接记录和展示，不广播Telegram |
| Long Agent主动事件 | 事件绑定的会话与主要端点 | 始终记录 |
| 定时任务 | 任务创建时明确的Delivery Binding | 始终记录 |

Agent可以一次产生多条不同消息；每条消息按稳定ID分别记录一次。“只出现一次”是幂等要求，不是限制Agent只能回复一条。

NanoClaw定时任务保留独立系统触发身份。Chat保存任务所属`projectId`、目标Chat Session和Delivery Binding；到期后NanoClaw只发出唤醒Envelope，Chat运行Pi Child Session并先提交结果，再决定是否通过NanoClaw通知IM。

## 7. 身份、参与者与Daily安全边界

Daily是个人日常Project而不是Project之外的个人模式，因此它与其他Project使用同一套“会话 / 长期同事”导航和数据合同。Daily通常包含个人信息，只有确认属于用户本人的私有入口可以默认进入Daily：

1. 已与Chat用户完成绑定的Telegram私聊可以默认进入Daily。
2. 未验证身份不能创建或查看Daily Chat Session。
3. 包含其他参与者的群聊、频道和公共Thread不能自动绑定Daily，必须由用户显式选择Project和Long Agent。
4. 不同参与者或不同保密边界默认使用不同NanoClaw Agent Group，防止共享Long Agent上下文，以及未来引入独立Agent Memory后造成信息泄露。
5. 一个Messaging Group同时连接多个Agent时，Conversation Binding必须包含`agentGroupId + sessionId`；不能假设一个IM群只产生一个Agent会话。

同一个Long Agent可以服务多个Project的前提是这些Project处于同一用户和信任域。跨参与者边界时，新建独立Long Agent比复用同一Agent Group更安全。

## 8. Chat与NanoClaw事实所有权

| 系统 | 拥有的事实 |
|---|---|
| Chat | Project、LongAgent运行策略、ProjectLongAgent、专属主Session、用户可见原生消息、Channel Binding、入口偏好、Workflow与共享Memory调用记录 |
| NanoClaw | Agent Group身份、Workspace、Markdown Agent Memory、Standing Instructions、Skill与Template、Channel实例、Messaging Group、Wiring、Channel Session坐标、Mailbox、调度、Destination、权限和投递状态 |
| Pi | Workflow与Long Agent共同使用的Agent循环、ResourceLoader、Tool、Model和Session算法 |

Chat Session是用户可见完整会话和Long Agent上下文的事实源；NanoClaw Channel Session只是通道路由与可靠收发坐标。Chat不直接读写NanoClaw数据库，NanoClaw也不直接写Chat Session文件。双方通过版本化Envelope、Binding Revision和稳定幂等ID通信。

Chat先建立Project层身份，再把外部Channel绑定到它：

```ts
interface ProjectLongAgent {
  id: string;
  projectId: string;
  longAgentId: string;
  enabled: boolean;
  primarySessionId: string;
  createdAt: string;
  updatedAt: string;
}

interface LongAgentChannelBinding {
  id: string;
  projectLongAgentId: string;
  nanoclawInstanceId: string;
  nanoclawAgentGroupId: string;
  nanoclawSessionId: string | null;
  primaryMessagingGroupId: string | null;
  source: {
    channelType: string;
    instance: string;
    platformId: string;
    threadId: string | null;
  };
}
```

`Agent Group`通过Long Agent映射和Channel Binding稳定引用。当前实现主要复用Router、Mailbox和Wiring；目标还要通过版本化Context Snapshot装配其身份、Workspace、Markdown Agent Memory与生态资源。Frontend可以在高级管理页展示Agent Group事实，但不能把它误解为一组Agent或暴露NanoClaw数据库。所有Channel Binding通过`projectLongAgentId`解析同一个`primarySessionId`，不能各自保存第二个产品Session事实。

消息幂等键至少包含`nanoclawInstanceId + nanoclawSessionId + direction + nanoclawMessageId`。消息正文、时间戳或数组位置不能作为去重依据。

## 9. Long Agent需要理解和调用的Chat能力

Long Agent不通过复制Chat配置文件、挂载整个`~/.chat`或读取数据库来“知道Chat”。Chat通过上下文绑定、系统说明和受控Tool提供事实。

每个Long Agent Turn至少获得以下可信上下文：

```text
Chat User
Project ID、名称和类型
Chat Session ID
Long Agent ID
当前入口与Conversation Binding
允许访问的Chat Tool目录
```

第一阶段Chat Tool能力：

| Tool组 | 能力 | 边界 |
|---|---|---|
| Context | 读取当前Project、Session和入口绑定 | 身份由Host注入，Agent不能伪造 |
| Project | 查询Project说明、配置来源和可用状态 | 不返回Credential或未授权路径 |
| Workflow | list、describe、start、wait、cancel | 默认继承当前Project；跨Project显式授权 |
| Memory | `memory_search`、`memory_record` | 使用Chat Personal/Project Mem0 Target；当前没有独立Agent Memory运行时 |
| Resource | 查询当前Project可用Rule、Skill和Tool | 发现不等于启用或修改 |
| Session | 查询当前会话和Child Workflow关系 | 不直接编辑Pi JSONL |

需要修改Project配置、跨Project操作、删除、发布或其他高影响动作时，仍由Chat Backend执行校验并要求相应确认；Prompt不能替代门禁。

### 9.1 Chat Tool装配

推荐调用链：

```text
Chat LongAgent Runtime
  ↓ createChatPiAgentSession()
Pi AgentSession
  ↓ Custom Tool
Project / Workflow / Memory / Session公共服务
```

Long Agent与Workflow使用同一个Pi Tool装配入口。可信`projectId/chatSessionId/longAgentId`由Chat Host注入Tool Context，Agent参数不能覆盖这些身份。服务凭据不进入Prompt、Session消息、Project文件、NanoClaw Envelope或Channel配置。

## 10. Chat Web与NanoClaw桥接

本节记录当前实现。Web直接运行Chat Pi；NanoClaw实例以`chat-pi`模式在耐久Inbox与事件落盘后把所有Long Agent执行委派给Chat。Agent Group不再决定运行时；当前只接入其路由事实，身份、Workspace、Agent Memory和生态资源按能力模型继续接入Chat Web与Pi装配。

NanoClaw侧当前实现：

1. `chat_integration_events`是耐久HTTP Outbox，使用稳定`eventId`、逐事件接收结果和指数退避断线补齐；同ID不同payload直接报冲突。
2. `chat-pi` Execution Driver以Instance为单位接管全部Channel Session，在`requestWake()`处刷新待提交HTTP事件；NanoClaw Session Runtime、容器接管、Docker事件监听和容器存活恢复逻辑全部禁用。
3. NanoClaw只向Chat Backend的`POST /api/internal/channel/v1/events`提交版本化事件；不再提供Chat pull接口，也不把全权限`ncl.sock`暴露成HTTP。
4. NanoClaw窄Gateway的`deliveries`把Chat Pi结果以稳定Delivery ID写入原Session Outbox，`acks`只在Chat Session和Outbox都持久化后把Inbound标为完成。
5. Delivery Hook继续记录实际Channel投递事件，为回执和诊断保留证据。

Chat侧当前实现：

1. `<CHAT_HOME>/long-agents.json`保存Long Agent、唯一Pi Agent Definition、默认Project和NanoClaw内部路由映射；Pi是固定运行时，不在单个Agent上配置Driver。
2. `<CHAT_HOME>/runtime/long-agent-state.json`保存ProjectLongAgent、Channel Binding、耐久Ingress待处理事件、退避状态和有限幂等账本；同一Project与Long Agent只能有一个专属主Session。
3. `createChatPiAgentSession()`是Workflow与Long Agent共用的Model、ResourceLoader、Tool和Pi Session装配入口。
4. Chat Web POST创建或恢复Binding并同步完成一个Pi Turn；Pi原生写消息，`chat.long_agent_turn`只保存来源、幂等ID和终态。
5. Backend对HTTP Event先耐久保存再返回`202`，独立恢复Worker消费并退避重试；普通Session读取不触发同步，同一`eventId`和payload hash只产生一个逻辑Turn。Pi失败后从同一User/ToolResult节点建立append-only重试分支，完成后的重放不再调用模型。
6. IM执行完成后Chat先写Nano Outbox，再确认Inbound；Chat Web不依赖Nano在线状态。

### 10.1 Long Agent配置管理

“长期同事”导航面板同时提供同事的设置入口。配置页编辑的是Personal `LongAgent`定义，而不是当前Project的定义副本；可编辑显示名称与描述、Personal全局启停、默认Project、Model、Thinking Level、System Prompt/自定义Prompt、Tools和Resources。`ProjectLongAgent`只管理当前Project的启停与唯一主Session。

1. `GET /api/long-agents/:id/config`返回`schemaVersion: 1`、不透明`revision`、可编辑Agent Definition和只读Channel Gateway摘要。
2. `PUT /api/long-agents/:id/config`接受完整可编辑值与`expectedRevision`；Backend校验Project、Model认证、Tool和Agent Definition后，串行化并原子替换`<CHAT_HOME>/long-agents.json`。
3. revision不一致返回`409`；Frontend必须重新读取，不得静默覆盖他人或另一窗口的更新。
4. Telegram adapter、Channel instance和NanoClaw Host均为只读运行摘要；API不返回Gateway地址、Credential、Bot Token、模型密钥或任何可反推凭据的值。

Chat与NanoClaw通过双向窄HTTP合同联动：NanoClaw调用Chat Event Ingress；Chat调用NanoClaw Health、Delivery和Ack。两端使用至少32字符的服务Credential，本机允许loopback HTTP，远程必须HTTPS。Frontend永远不会看到Gateway地址、Telegram身份、Token或NanoClaw数据库；NanoClaw的`ncl.sock`和`cli.sock`只保留为本地运维入口。

## 11. Telegram与多Agent策略

NanoClaw一个Host可以同时运行多个Telegram Bot实例，也可以让一个Bot连接多个Agent Group。Chat默认采用以下产品策略：

1. 第一只Telegram Bot绑定一个面向用户的主Long Agent和它在Daily中的Inbox。
2. 其他专家Long Agent优先由主Agent通过Agent-to-Agent调用，或由用户在Chat Web直接打开。
3. 只有专家Agent需要独立公开身份、独立通知入口或独立参与者边界时，才为它配置第二只Telegram Bot。
4. 同一群聊连接多个Agent时必须使用明确触发规则并在UI显示实际响应者；个人私聊默认只连接一个面向用户的Long Agent。
5. 不同Bot实例仍由同一个NanoClaw Host管理，不因为Token不同启动多个NanoClaw进程。

## 12. NanoClaw原生能力与Chat利用方式

NanoClaw独立发行版是一套Long Agent系统；Chat保留其Agent Group、Workspace、Memory、Channel、调度、权限、Destination和生态能力，只把Agent Loop、Model执行和用户可见Session统一到Chat与Pi。各能力的当前状态和目标合同见[Chat Long Agent能力与NanoClaw Agent Group模型](./chat-long-agent-capability-model.md)。

| NanoClaw原生能力 | 原生形态 | Chat中的利用方式 |
|---|---|---|
| 多Channel接入 | Telegram、WhatsApp、Discord、Slack、Teams、iMessage、Matrix、Google Chat、Webex、GitHub、Linear、WeChat和邮件等Adapter | Channel作为Chat Session的输入/投递端点；第一阶段启用Telegram，后续沿用同一Binding模型扩展 |
| 多Agent与多入口路由 | 一个Host包含多个Agent Group；Channel、Messaging Group与Agent Group通过Wiring连接 | 一个Chat LongAgent映射一个Agent Group；不按Bot或Agent重复启动Host进程 |
| 多会话策略 | 每个Agent可使用共享会话、按Thread会话或独立Messaging Group会话 | 多个Nano Session只作为Channel坐标；同一Project Long Agent全部归入一个专属主Chat Session |
| 长期工作区与Markdown Memory | 每个Agent Group拥有Workspace、Standing Instructions与Open Knowledge Format记忆文件 | Agent Group身份与Core Memory已通过Context Snapshot进入Pi主链，并提供`agent_memory_search/read/write` Tool；它与Personal/Project Mem0并存，完整Workspace与Skill快照继续扩展 |
| 容器隔离执行 | 独立版Session按需进入隔离容器 | 不进入当前Chat主执行链；未来需要隔离时由Chat Pi执行层统一提供，不能复制Agent配置 |
| 定时与主动任务 | System Session、一次性/周期任务、主动Outbound与Destination | 任务必须绑定Project和目标Chat Session；输出既可投递IM，也必须进入Chat会话历史 |
| Agent-to-Agent | Agent间消息、策略、审批和投递 | 主Long Agent可调用专家Agent；Chat记录发起Agent、目标Agent、Child Session和结果 |
| 身份与权限 | Pairing、成员、角色、未知发送者策略、人工审批、每Agent凭据策略与限流 | Chat管理LongAgent可见性和Project授权；NanoClaw继续执行Channel身份与运行权限门禁 |
| 多Provider | 独立版支持Claude、Codex及可安装Provider | Chat不消费这层能力；Agent Runtime固定为Pi，Model Provider由Pi配置 |
| Tool与运行时扩展 | MCP、包安装、Skill、Template与经过审批的自修改/重启流程 | 保留NanoClaw生态定义与审批语义；转为固定Revision的Pi Resource Snapshot和Chat Tool授权，不启动第二个容器Agent Runtime |
| 富消息与交互 | 多条消息、回复、编辑、Reaction、按钮、卡片和问题（取决于Channel） | Chat消息模型保留一轮多消息与外部消息ID，不把一次Agent Turn压成一条文本 |
| 运维与可观测性 | `ncl`管理CLI、任务/会话/投递/审批查询，可选Dashboard和macOS状态栏 | Chat管理页提供用户级配置与健康状态；底层诊断保留`ncl`，不让Frontend读取NanoClaw数据库 |

这些能力在Chat中的优先利用顺序是：

1. 常驻Host、Telegram和多Agent Group。
2. Chat Session双向同步、稳定消息幂等和断线重放。
3. Long Agent调用Chat Project、Workflow与Memory。
4. 主动任务、定时任务与统一投递管理。
5. Agent-to-Agent、审批、Rich Message和更多Channel。

## 13. 落地顺序与验收

### 13.1 顺序

1. 已完成：实现Daily Project，消除全新请求用`process.cwd()`推断默认Project。
2. 已完成：初始化单个NanoClaw Host、临时Codex验证链、6个Telegram Adapter和6个Long Agent Group，并验证真实收发链路。
3. 已完成：实现LongAgent、ProjectLongAgent唯一主Session、Channel Binding和消息幂等存储；旧逐入口Binding状态会原子迁移，Chat Web伪Binding被移除，历史Session不改写。
4. 已完成：实现NanoClaw Chat Integration Hook、`chat-web` Adapter和断线重放。
5. 已完成：抽取Chat公共Pi Agent装配入口，在Chat内实现LongAgent Runtime。
6. 已完成：为NanoClaw增加Instance级`chat-pi` Execution Driver和带服务认证的HTTP Channel Gateway，把Telegram耐久事件主动提交给Chat Backend，并在该模式完全禁用NanoClaw Agent Session Runtime。
7. 部分完成：Workflow与Personal/Project Mem0已使用Pi原生Custom Tool；Agent Group OKF Memory已提供上下文注入和`agent_memory_*` Tool，继续补定时/主动Trigger、完整Workspace/Skill快照和Agent-to-Agent。
8. 部分完成：Nexus已迁移并通过Web、Telegram真实收发、稳定Delivery ID与NanoClaw重启验收；Channel Router消息已有执行Envelope，NanoClaw定时任务等非Router触发尚未投影成Chat可消费事件，需补统一Trigger Envelope后再验收主动任务和断线恢复。
9. 已完成：NanoClaw Instance整体切换为Chat Pi Channel Gateway，全部Long Agent删除单Agent Driver选择；Channel入站统一执行Chat Pi，失败时保留耐久Inbox且不回退容器。每次外部执行唤醒都会扫描待确认Inbox并补建缺失HTTP Event，关闭两份SQLite事实之间的崩溃窗口。
10. 部分完成：Chat Web已在同一Project下提供互斥的“会话 / 长期同事”导航面板，保留旧Session面板布局，并在同事面板提供唯一主Session的一键启动/打开入口和设置入口；Personal LongAgent的GET/PUT配置、乐观revision与原子写已落地。单Bot健康、任务和投递偏好继续补充。

### 13.2 核心验收场景

1. Telegram首次私聊在Daily创建唯一ProjectLongAgent和专属主Session；Chat Web再次打开时复用同一个`primarySessionId`。
2. Telegram的一问一答由Pi原生写入Chat Session，刷新后能完整恢复且不重复。
3. Web打开IM主会话发送消息，回复只进Web；之后Telegram继续时Agent保留Web阶段上下文。
4. Web默认显示“会话”面板，旧Session布局不受Long Agent占位影响；打开/新建普通Session会切回该面板，打开Long Agent或刷新读取到`session.owner.type === "long-agent"`会切到“长期同事”，手动切面板不改变中央已打开会话。
5. Long Agent主动发送多条消息时，Chat逐条记录一次，并按配置投递。
6. 定时任务由NanoClaw触发、Chat Pi Child Session执行，输出进入绑定的Daily Chat Session。
7. Long Agent可以读取当前Daily Project信息、搜索/记录Chat Memory并调用一个Chat Workflow。
8. 群聊未经明确Project和Agent授权时不能访问Daily。
9. 两个Long Agent的专属主Session保持隔离，并按授权使用对应Personal/Project Mem0 Target；同一个NanoClaw Host故障恢复后绑定不漂移。
10. Chat或NanoClaw暂时离线后通过稳定消息ID重放，不重复用户消息和Agent回复。
11. `chat-pi` Host在Docker不可用时仍可启动和收发Channel消息；启动与周期Sweep不执行Docker命令、不启动`docker events`，也不使用容器存活状态重置Chat正在处理的消息。
