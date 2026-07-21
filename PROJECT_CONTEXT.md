# OPC-OS 自研 Chat 通道：项目上下文

## 1. 文档目的

本文固定本项目稳定的产品定义、问题、目标、边界和核心模型。

本项目是 **OPC-OS Chat 体系中的一个自研 Chat 通道**。它是独立开发和运行的项目，但不是完整的 OPC-OS Chat 上位系统。

## 2. 系统层级

```text
OPC-OS Chat（上位系统）
├── 自研 Chat 通道（本项目）
├── Telegram等其他聊天通道
├── 其他可交互入口
├── 通道适配与协议层
└── 可共享的编排、执行、记忆和证据能力
```

本项目负责提供一个完整、可用、可持续演进的自研Chat体验，并通过明确边界与上位系统协作。

## 3. 要解决的6个问题

1. 用户的Prompt、AI回答和关键结论被困在单次会话中。
2. 用户说“继续”“按刚才那个来”时，系统缺乏稳定的任务上下文。
3. 意图、计划、待办和执行结果没有统一生命周期。
4. AI可能在用户没看清最终请求前就开始执行。
5. 模型提出的任务、记忆和结论容易被错误地当成正式事实。
6. 失败、重启、上下文变更和来源删除后，状态难以恢复与追溯。

本项目要回答的核心问题是：

> 如何让用户通过一个自研Chat通道，持续推进学习和工作，同时始终知道系统理解了什么、准备做什么、使用什么上下文、由谁执行，以及执行后留下了什么事实和证据。

## 4. 产品定位

本项目是一个本地优先、用户可介入的AI协作Chat通道。

Chat是主要交互方式，但项目价值不止是消息收发。系统需要把自然语言输入转化为上下文、意图、计划、人/AI行动、执行请求、结果、证据、记忆和可恢复状态。

## 5. 核心目标

### 5.1 会话连续

用户不需要反复复述背景；系统能从核心记忆、近期会话和当前工作状态继续推进。

### 5.2 意图可见

系统展示自己理解到的一个或多个意图、依据与不确定性；理解错误时用户可以修正。

### 5.3 工作可推进

对话中的长期事项形成统一WorkItem，并明确区分用户检查点和AI下一责任。

### 5.4 执行可控制

用户可以在执行前检查和编辑输入、上下文、Agent或Runtime、模型、工具、权限、限制及最终请求。

### 5.5 状态可恢复

会话、任务、运行结果、失败和Trace在重启后仍存在；结果未知时不盲目重试。

### 5.6 事实可追溯

执行结果对应Evidence、Delivery、来源和Trace；原始来源删除或失效时，派生结果也要正确降级。

## 6. 完整产品闭环

```text
用户自然语言输入
-> 自动装配上下文
-> 用户查看、增删上下文
-> 识别一个或多个意图
-> 必要时请求用户确认
-> 形成工作计划和人/AI行动
-> 生成最终执行请求
-> 用户审核Agent、Runtime、工具、权限、版本与Hash
-> Agent团队或Runtime执行
-> 返回结果
-> 保存Evidence、Delivery与Trace
-> 更新任务和记忆候选
-> 用户确认长期状态
-> 下一轮继续推进
```

低风险、意图清楚的步骤可以自动推进；存在歧义、成本、外部副作用或不可逆影响时必须暂停并让用户确认。

## 7. 核心领域对象

| 对象 | 责任 |
|---|---|
| Channel | 当前交互通道及其能力、身份和协议边界 |
| Session | 用户可创建、打开、归档和恢复的一段产品会话 |
| Interaction | 用户与系统的一次完整交互 |
| Message | 用户、Assistant、Agent或工具产生的消息 |
| ContextPackage | 本轮纳入、排除和引用的上下文快照 |
| Intent | 系统观察到的一个或多个用户意图 |
| WorkItem | 需要跨回合持续推进的工作或学习事项 |
| ActionItem | 明确由用户或AI负责的下一行动 |
| TaskPlan | 为完成目标形成的节点、顺序和依赖 |
| ExecutionDraft | 尚未执行、可编辑和审核的最终请求 |
| Approval | 用户对特定版本和请求内容的批准或驳回 |
| Run | 一次具体Agent、Workflow或Runtime执行生命周期 |
| Evidence | 对结果、状态或操作的可验证证据 |
| Delivery | 结果向用户或下游交付的状态 |
| Memory | 经候选门确认后可跨会话使用的信息 |
| Trace | 可观察步骤、状态变化、错误和关联关系 |

这些对象是产品语言，不等同于某个MAF类、数据库表或前端组件。

### 7.1 产品对象、协议对象与运行时对象的边界

以下4个对象必须始终分开理解，即使第一阶段为了降低映射成本而暂时复用某些UUID值，也不能合并其职责：

| 对象 | 所属层与所有者 | 责任 | 明确不是什么 |
|---|---|---|---|
| Product Session | 产品领域层、Product DB | 用户可创建、打开、归档和恢复的协作容器，拥有标题、产品可见消息、Interaction、Run、Trace和访问边界 | 不是MAF对象，也不是AG-UI Thread |
| MAF AgentSession / Workflow Checkpoint | MAF运行时层 | 保存模型上下文、Context Provider状态和Workflow恢复点 | 不是Product Session、用户授权边界或产品历史数据库 |
| AG-UI Thread | AG-UI协议层 | 用`threadId`关联前端请求、SSE事件、消息与State投影以及Hydrate | 不是用户身份、权限凭据或产品事实源 |
| Agent Run | 产品执行层与MAF运行时 | 一次具体Agent、Workflow或Runtime执行；产品侧记录生命周期，AG-UI投影其实时事件 | 不是整段Session，也不等于一次用户Interaction |

`MAF AgentSession`和`Workflow Checkpoint`不是同一个MAF类型；上表只把它们归入同一个“MAF运行时状态”层，代码和存储中仍需分别建模。

`Interaction`表示一次用户与系统的完整交互；一次Interaction可以不触发Agent，也可以触发一个或多个Agent Run。第一阶段可以暂时形成1:1关系，但不能把它写成长期不变量。

Product Session ID、MAF Session ID、AG-UI `threadId`和Agent `runId`都只标识各自对象，不自动构成权限。具体ID是否同值、如何映射以及何时持久化属于待审核实现决定。

## 8. 产品原则

1. 对话是入口，不是唯一事实。
2. 默认自动推进，关键节点允许用户随时介入。
3. 完整历史保留证据；每轮模型上下文应最小、相关、可查看。
4. 先理解意图，再形成计划，最后准备和执行具体请求。
5. 多Agent用于分工判断、规划、检视和执行，不用于制造内部聊天噪音。
6. 模型只能提出长期候选，用户或明确规则决定其是否生效。
7. 执行前可审核，执行中可观察，执行后可验证，失败后可恢复。
8. 不把隐藏推理当成Trace，不把`prepared`冒充成用户已收到或认可。

## 9. 项目范围

第一阶段聚焦：

1. 单用户、自研Web Chat通道。
2. 会话、历史和上下文恢复。
3. MAF Agent运行和结构化结果。
4. 意图、执行前审核和基础Trace。
5. 项目本地持久化与重启恢复。

后续逐步增加：

1. TaskPlan与节点级执行。
2. 完整人/AI待办闭环。
3. 记忆候选和长期上下文。
4. 受控工具与副作用确认。
5. 多Agent编排和更多Runtime。
6. 图片、附件、知识和跨通道协作。

当前非目标：

1. 多租户、计费和企业权限后台。
2. 插件市场和完整团队空间。
3. 未经设计即开放任意Shell、文件或外部系统操作。
4. 一开始就拆分成多个网络微服务。
5. 把本项目冒充为完整OPC-OS Chat上位系统。

## 10. 已批准技术路线

2026-07-21用户批准以下技术路线：

1. 后端使用Python、Microsoft Agent Framework（MAF）和FastAPI。
2. 前后端Agent交互协议使用AG-UI，主要传输为HTTP请求和SSE事件流。
3. 前端使用React 19、TypeScript和Vite。
4. 前端通过`@ag-ui/client`的`HttpAgent`连接MAF AG-UI端点。
5. UI采用自研产品组件，以Tailwind CSS、Radix UI和Lucide React为基础。
6. Zustand只管理导航、弹窗、筛选和布局等页面状态；Agent消息和运行状态由AG-UI Client投影。
7. MAF运行存储拥有Agent Session、上下文和Workflow checkpoint；初始SQLite产品数据库拥有用户可见领域状态。
8. 项目保持前后端清晰分层，产品领域模型不能由UI组件、AG-UI临时状态或MAF Session代替。

### 10.1 协议、运行时与状态所有权

| 边界 | 负责 | 不负责 |
|---|---|---|
| REST API | Session CRUD、标题、归档、历史分页、附件，以及Work、Evidence、Memory、Trace等产品资源 | 不承载Agent实时事件状态机 |
| AG-UI over HTTP/SSE | 单次Agent Run的生命周期、流式Message、Tool Call、Interrupt/Resume和实时State投影 | 不负责用户、权限、Session CRUD、数据库Schema或产品持久化 |
| Product DB | 用户可见且需要恢复、审核和追溯的产品事实 | 不把AG-UI Snapshot JSON或浏览器状态直接当成领域模型 |
| MAF运行时及其Store | AgentSession、Context、Tool、Workflow和Checkpoint语义 | 不拥有标题、归档、访问控制、Work、Evidence和Memory等产品对象 |
| 前端 | 展示和操作后端状态投影 | 不拥有权威历史、产品事实或运行终态 |

架构总则：**REST管理产品资源，AG-UI管理一次Agent Run的实时交互，Product DB保存权威产品事实，MAF管理Agent运行时语义。** 物理上可以共用一个数据库，逻辑所有权不得合并；AG-UI Snapshot可以作为运行或UI投影，但不能替代Product Session与产品历史。

第一阶段先验证单Agent文本流、Product Session与产品消息恢复、AG-UI Thread实时投影、Agent Run状态和失败路径；产品历史通过REST还是AG-UI Hydrate恢复、是否持久化AG-UI Snapshot，属于Session候选设计的待审核决定。MAF Workflow Checkpoint恢复不在这一切片，同时不展开工具、多Agent和全部长期领域对象。
