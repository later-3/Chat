# Chat 项目上下文

## 1. 文档目的

本文固定 Chat 的稳定产品定义、用户问题、目标、边界、产品闭环、核心对象和已经批准的技术路线。

Chat 是一个**独立开发、独立运行、独立运营、持续演进的完整产品**。它以对话为主要入口，但自己承担用户协作、工作推进、受控执行、知识沉淀、证据追溯、结果交付和运行治理的完整责任。

## 2. 产品边界与外部关系

```text
用户
  |
  v
Chat Web 应用
  |
  v
Web/API Adapter（REST + AG-UI）
  |
  v
Interaction Ingress
  |
  v
Chat 独立产品核心
├── 对话、上下文与意图
├── 工作、计划与审核
├── Agent / Workflow / Tool 执行
├── 会话、知识、证据与Trace
└── 结果交付与运行治理

外部终端平台（如Telegram）
  <-> 具体Channel Adapter <-> Channel Adapter Host <-> Interaction Ingress

OPC-OS Chat外部系统
  <-> OPC-OS Bridge Adapter <-> Channel Adapter Host <-> Interaction Ingress

Chat产品核心
  <-> 模型、工具、知识源与业务系统

超级管理员
  -> Super Admin Console
  -> 受鉴权的运营查询API
  -> 身份、使用活动、Project/Work、Artifact/Evidence和运行状态投影
```

OPC-OS Chat 是一个可与本项目互操作的外部系统。在特定集成拓扑中，本项目可以提供聊天通道能力，也可以消费其共享能力；这是**系统之间的合同关系**，不是本项目的产品身份或层级归属。

Chat Web是本产品自带客户端，通过Web/API Adapter访问后端。Telegram等外部终端平台与OPC-OS Chat都不能直接调用Conversation、Run、MAF或数据库：终端平台必须经过对应Channel Adapter，OPC-OS Chat必须经过系统间Bridge Adapter；这些Adapter转换成统一内部Interaction合同后才能进入产品核心。

本项目不能依赖外部系统替自己承担 Product Session、Work、Run、Approval、Evidence、Delivery、Memory 或 Trace 的事实源责任。跨系统协作必须明确状态归属、版本、权限、幂等、证据和失效传播，不能形成双重事实源。

## 3. 要解决的 6 个问题

1. 用户的 Prompt、AI 回答和关键结论被困在单次会话中。
2. 用户说“继续”“按刚才那个来”时，系统缺乏稳定的任务上下文。
3. 意图、计划、待办和执行结果没有统一生命周期。
4. AI 可能在用户没看清最终请求前就开始执行。
5. 模型提出的任务、记忆和结论容易被错误地当成正式事实。
6. 失败、重启、上下文变更和来源删除后，状态难以恢复与追溯。

本项目要回答的核心问题是：

> 如何让用户通过 Chat 持续推进学习和工作，同时始终知道系统理解了什么、准备做什么、使用什么上下文、由谁执行，以及执行后留下了什么事实和证据。

## 4. 产品定位

Chat 是本地优先、用户可介入、可持续工作的 AI 协作产品。

“本地优先”是一种部署与数据控制策略，不表示能力只面向简单或短期场景。Chat 的目标能力覆盖长期会话、多事项推进、受控外部执行、断线和进程恢复、知识与证据治理，以及通过明确合同进行的跨系统协作。

项目价值不止是消息收发。系统需要把自然语言输入转化为可查看的上下文、意图、计划、人/AI 行动、执行请求、运行状态、结果、证据、记忆和可恢复产品状态。

### 4.1 用户眼中的最终产品

Chat 是用户持续管理和推进自己学习、工作与想法的统一协作入口，而不是按项目分散的聊天记录集合。

用户可以只说自然语言，例如“继续昨天的贪吃蛇”“我有哪些项目”“把这条经验记下来”“下周继续复习概率论”。系统负责：

1. 保存原始表达，不因为后续理解变化而丢失证据。
2. 识别这句话属于简单问答、既有事项、新事项、学习、研究、记录、周期工作或多个意图。
3. 从用户已经确认的 Project、Work、Plan、Note、Memory、规则、历史重点和资源引用中渐进召回相关内容。
4. 把准备采用的目标、背景、约束、经验、文件和规则以可读方式展示给用户；用户可以增删、锁定或排除。
5. 在需要时帮助澄清、拆解、执行和验证；低风险步骤可自动推进，关键决策由用户控制。
6. 把被接受的结果、进度、笔记、证据和下一行动写回对应事项，使用户隔天、跨会话或切换入口后仍能继续。

用户最小可感知价值是：**想法能留下，事项有状态，工作可继续，执行可看护，结果有证据。**

Chat自身也是这套能力必须能够承载的普通软件Project。用户应能用同一套Harness、主Workflow、受治理执行层和Evidence完成“Chat开发Chat”，并跨天继续；这不建立特殊`SelfProject`或绕过产品提交门，而是用真实Dogfood证明系统能够认识目标、准备工作、隔离执行、验证结果和持续维护状态。

Product Session只是服务端交互、恢复和访问控制容器，不是Project边界，也不是目标界面的主要导航单位。同一Project可以跨多个Product Session持续推进；同一Product Session也可以讨论多个事项。同一Principal/Scope下的多个Product Session共享同一套Harness权威事实，可以并行推进不同Project、同一Project的不同Work，或在可见冲突治理下推进同一资源。Project代码仓库或物理目录只是Harness资源，不是另起Chat部署或切断用户全局知识的边界。

用户主要通过连续对话流、Conversation Day和协作日历找回历史；这些界面不改变Product Session、Message和Run的来源关系，也不把完整历史无边界装入模型Context。跨Session并发不依赖跨模型或Tool调用的全局长锁：产品修改绑定读取revision、写集合、来源Session/Interaction/Run和CAS提交门；相关事实已被其他Session推进时，系统刷新无冲突Context，或向用户展示Diff并重新规划、合并、保留产物但不提交状态或停止当前Run。用户选择的上下文面板是Product Harness已有信息的友好投影，不另建第二套知识源。

### 4.2 设计者眼中的系统

Chat 是一个以自然语言为入口、以产品事实为底座、以受治理Workflow为协调器、以Agent/Runtime为执行能力的持续协作系统：

```text
用户原话
-> 权威事实与候选Context召回
-> 意图、目标和协议选择
-> 用户可见的Context与计划
-> 可编辑ExecutionDraft
-> 不可变RunSpec和步骤级执行输入
-> Agent / Tool / Runtime执行
-> 验证、Evidence和结果审核
-> Product事实提交、TurnSummary和索引更新
```

它不依赖“大模型自己记住一切”。确定性代码负责身份、查询、状态机、版本、权限、事务、路由和校验；Agent负责无法可靠写成规则的理解、生成、规划和语义检查；Tool负责真实能力；Workflow负责把这些角色按可恢复控制流连接起来。

系统允许项目、任务、学习、研究、笔记和周期工作采用不同的协作方法，但这些方法都复用同一组核心产品对象和提交规则，不为每个场景复制一套事实模型。

### 4.3 Chat Harness与MAF运行能力

完整Chat系统由两类核心能力共同构成：

1. **Chat Harness**拥有产品语义、权威事实、协作协议、Context选择、执行治理、结果沉淀和三方投影。
2. **Chat AI Runtime**以MAF为运行基线，负责Agent、Workflow、Executor、模型、Tool和Checkpoint语义。

前端是两类能力的共同交互面，不是第三个事实源。Execution Worker、Tool Gateway、pi、Validator和
Reconciler属于完整Chat系统的执行层，但必须处在独立权限、恢复和副作用边界内。

Chat Harness不是大Prompt、MAF的Harness Agent、万能Service或前端面板。它在内部继续按
Conversation、Work、Knowledge、Protocol、Context、Governance、Evidence和Delivery的状态所有权、
事务边界与失败语义拆分；Schedule独立拥有业务时间，Memory、Run、Tool、Identity与Admin继续拥有
各自事实。2026-07-30批准的正式目标架构共14个逻辑状态所有者、3个应用组件和3类运行责任；
Projection只组合Read Model与候选写回，不成为第15个事实模块。完整边界见
[Chat系统与Chat Harness](./概念空间/Chat/Chat系统与Harness.md)。

### 4.4 超级管理员眼中的产品

Chat作为独立运营的产品，必须提供单独的超级管理员运营看护能力。超级管理员经过真实身份认证和
角色授权后，可以按用户、时间和事项查看：

1. 哪些用户登录过、认证会话何时开始/结束、最后一次可信活动是什么时候。
2. 登录会话时长、浏览器前台活跃时长、有效协作活动以及Run/Provider/Tool耗时；这些指标分别
   计算和展示，不能互相冒充。
3. 每个用户的Project、Work、Plan和Action当前状态、最近推进、阻塞、下一行动和更新时间。
4. Artifact/Evidence的创建、版本、验证、有效性和交付状态，以及需要人工关注的失败或长期停滞。
5. 指标来源、数据新鲜度、缺失或未知原因；超级管理员的敏感查看和后续管理动作本身也必须留有审计。

超级管理员运营看护台是权威事实的受控查询投影，不是另一套Project进度、Artifact状态或用户身份
数据库。个人主页用于用户回顾自己的工作，Workflow Run View用于用户看护自己的执行，两者都不能
替代超级管理员跨用户运营视角。完整概念边界见
[超级管理员与运营看护](./概念空间/Chat/超级管理员与运营看护.md)。

## 5. 核心目标

### 5.1 会话连续

用户不需要反复复述背景；系统能从已确认记忆、相关历史和当前工作状态继续推进。

### 5.2 意图可见

系统展示自己理解到的一个或多个意图、依据与不确定性；理解错误时用户可以修正。

### 5.3 工作可推进

对话中的长期事项形成统一 WorkItem，并明确区分用户检查点和 AI 下一责任。

### 5.4 执行可控制

用户可以在执行前检查和编辑输入、上下文、Agent 或 Runtime、模型、工具、权限、限制及最终请求。

### 5.5 状态可恢复

会话、任务、运行、工具副作用、工作流检查点、失败和 Trace 在相应恢复保证下可重新接续；结果未知时不盲目重试。

### 5.6 事实可追溯

执行结果对应 Evidence、Delivery、来源和 Trace；原始来源删除、失效或权限撤销时，派生结果能够正确降级。

## 6. 完整产品闭环

```text
用户自然语言输入
-> 建立一次Interaction并保存输入事实
-> 自动装配相关上下文
-> 用户查看、增删或纠正上下文
-> 识别一个或多个意图
-> 必要时请求用户确认
-> 形成工作计划和人/AI行动
-> 生成版本化ExecutionDraft
-> HITL策略逐项判断需要人工确认、条件暂停、自动推进还是禁止
-> 用户修订或确认需要介入的内容；自动推进也保存决定依据
-> 编译绑定上下文、能力、策略和验证要求的不可变RunSpec
-> 创建Run并由Agent、Workflow或Runtime执行
-> 持续投影运行事件和中断点
-> 保存结果、Evidence、Delivery与Trace
-> 更新Work状态并提出Memory候选
-> 用户或明确规则确认长期状态
-> 下一次Interaction继续推进
```

低风险、意图清楚且符合策略的步骤可以自动推进；存在歧义、成本、外部副作用、权限提升或不可逆影响时，系统必须暂停并让用户确认。

## 7. 核心领域对象

| 对象 | 责任 |
|---|---|
| Principal | 用户、服务或外部主体的稳定身份与授权上下文 |
| Role / Grant | Principal被授予的角色和权限范围；超级管理员能力必须由服务端可信授权产生 |
| Authentication Session | 一次真实登录凭据的签发、活跃、过期、撤销和结束生命周期；不是Product Session |
| User Activity Window | 依据前台心跳和有意义产品事件形成、带计算口径与置信度的使用活动时间段 |
| Super Admin Audit Event | 超级管理员查询敏感元数据、查看受限内容或执行管理动作的不可抵赖审计记录 |
| Channel | 交互入口的能力、来源身份和协议边界 |
| Channel Binding | 外部会话、来源身份与 Product Session 之间可撤销、可授权的映射 |
| Product Session | 用户可创建、打开、归档和恢复的协作容器 |
| Interaction | 用户与系统的一次完整交互，可能触发零到多个 Run |
| Message | 用户、Assistant、Agent 或工具产生的产品可见消息 |
| ContextPackage | 本轮纳入、排除、裁剪和引用的版本化上下文快照 |
| Intent | 系统观察到的一个用户目标、依据、不确定性、约束和期望结果 |
| Intent Set | 一次Interaction中按顺序组织的Intent revision、依赖、组合策略和精确版本接受状态 |
| Project | 组织长期目标、范围、状态、Work、知识、协议、资源和结果的稳定事项容器；不是Product Session或物理目录 |
| WorkItem | 需要跨回合持续推进的工作或学习事项 |
| ActionItem | 明确由用户或 AI 负责的下一行动 |
| TaskPlan | 为完成目标形成的节点、顺序、依赖和检查点 |
| Note / Note Revision | 用户或系统保存的来源化知识、决定、研究记录、规则或Idea及其不可变修订；不是Accepted Memory |
| Collaboration Protocol / Binding | 一类工作怎样理解、推进、验证和回写的版本化方法，以及它与用户、Project、Work或场景的作用域绑定 |
| ExecutionDraft | 产品准备“怎样完成这项工作”的可编辑、版本化执行草稿；不是某一次Provider请求 |
| HITL Policy | 决定某类决策点必须人工、条件暂停、自动推进或禁止的版本化策略 |
| RunSpec | 从已接受ExecutionDraft、Context、权限和有效策略编译出的不可变执行合同 |
| Approval | 用户或策略对特定版本、请求 Hash、权限范围和后果的授权或驳回记录 |
| Product Run | 一次具体 Agent、Workflow 或 Runtime 执行的长期产品事实 |
| Run Attempt | Product Run 的一次实际执行尝试、Worker 所有权和恢复血缘 |
| Tool Execution | 一次工具调用的请求、权限、幂等键、副作用和对账状态 |
| Evidence | 对结果、状态或操作的可验证证据及其来源关系 |
| Artifact | 文件、代码、报告、白板或其他可保存、版本化、验证和交付的作品/产物 |
| Schedule / Schedule Revision | 周期工作、复习、提醒或维护的业务时间、时区、重复规则、例外、暂停和漏跑策略；不是Scheduler进程或Worker心跳 |
| Delivery | 结果向用户或下游交付的状态、回执和重试语义 |
| Memory | 经候选门确认后可跨会话使用的信息及来源、版本和有效性 |
| Trace | 可观察步骤、状态变化、错误、关联关系和审计记录 |

这些对象是产品语言，不等同于某个 MAF 类、数据库表、AG-UI 事件或前端组件。字段级 Schema 和状态机需要在对应模块详细设计中审核。

### 7.1 四个必须区分的对象

| 对象 | 所属层与所有者 | 责任 | 明确不是什么 |
|---|---|---|---|
| Product Session | 产品领域层、Product DB | 用户可创建、打开、归档和恢复的协作容器，关联消息、Interaction、Work、Run、Evidence和访问边界 | 不是 MAF 对象，也不是 AG-UI Thread |
| MAF AgentSession / Workflow Checkpoint | MAF 运行时层 | 保存模型上下文、Context Provider 状态和 Workflow 恢复点 | 不是产品会话、用户授权边界或产品历史数据库 |
| AG-UI Thread | AG-UI 协议层 | 用 `threadId` 关联前端请求、实时事件、消息与 State 投影以及 Hydrate | 不是用户身份、权限凭据或产品事实源 |
| Product Run | 产品执行层 | 一次具体 Agent、Workflow 或 Runtime 执行；产品侧记录长期生命周期，AG-UI 投影其实时事件 | 不是整段 Session，也不等于一次 Interaction |

`MAF AgentSession`和`Workflow Checkpoint`不是同一个 MAF 类型；上表只把它们归入“MAF 运行时状态”，代码和存储中仍需分别建模。

`Interaction`与`Product Run`不能合并：一次 Interaction 可以不触发 Agent，也可以触发多个 Run。

`Product Run`与`Run Attempt / Runtime Job`也不能合并：前者表达用户长期可见的一次执行及最终状态，后者表达第几次实际尝试、哪个 Worker 拥有执行权、如何续租和恢复。Attempt 或 Job 可以过期、接管或清理，不能因此删除 Product Run 事实。

Product Session ID、MAF Session ID、AG-UI `threadId`、Product Run ID 和 Attempt ID 都只标识各自对象，不自动构成权限。映射必须可追踪、可校验且由服务端可信上下文建立。

### 7.2 Chat概念空间

Chat使用[概念资产索引](./概念空间/00-索引.md)维护人、AI、产品、协议和运行时共同使用的语言边界。它不是另一套领域模型、数据库Schema或页面导航，而是把高风险名称的定义、反定义、关系、别名、使用方式和反例接入单一事实源。

概念信息按责任分开：

1. 本文拥有稳定产品定义、核心对象和责任。
2. 概念资产拥有术语边界、相邻概念关系、别名和反例；与本文冲突时必须修正概念正文。
3. `PROJECT_STATE.md`拥有当前实现、验证、缺口和风险。
4. MAF、AG-UI、Provider、源码和测试拥有各自技术行为事实。

概念状态使用“候选、有效、修订中、已停用”；实现状态使用“未实现、局部实现、已实现、已验证”及说明。两者不能互相替代。`Session`、`Run`、`Workflow`、`Agent`、`Context`、`Tool`、`Approval`和`Canvas`在存在多种含义时必须使用限定名。

## 8. 产品原则

1. 对话是入口，不是唯一事实。
2. 默认自动推进，关键节点允许用户随时介入。
3. 完整历史保留证据；每轮模型上下文应最小、相关、可查看。
4. 先理解意图，再形成计划，最后准备和执行具体请求。
5. 多 Agent 用于分工判断、规划、检视和执行，不用于制造内部聊天噪音。
6. 模型只能提出长期候选，用户或明确规则决定其是否生效。
7. 执行前可审核，执行中可观察，执行后可验证，失败后可恢复。
8. 不把隐藏推理当成 Trace，不把`prepared`冒充成用户已收到或认可。
9. Product DB 是产品事实权威；运行时、协议投影和浏览器缓存不能替代它。
10. 外部集成是对等合同，不改变 Chat 的产品身份，也不产生第二个产品事实源。
11. 发给模型的Tool定义必须来自服务端已注册的真实执行能力或Provider明确支持的原生能力；模型提出Tool Call不等于获得执行授权，未绑定执行器的Tool不得进入Provider请求。
12. Project、Work、Plan、Note、Memory、规则和资源引用共同组成Product Harness；前端上下文选择器只是这些权威资产的检索与采用界面，不复制事实。
13. 用户、Chat与执行层遵守同一协作语义，但接收不同投影：用户拥有目标、选择和接受权；Chat拥有流程、治理和产品提交；执行层只拥有当前步骤所需输入和能力。
14. 系统必须区分权威产品事实、用户决定、模型候选和外部证据。只有满足相应提交门的内容才能改变长期状态。
15. 摘要和检索索引是可重建派生物。原始Message、已接受产品事实和来源关系不能被摘要覆盖，也不能因索引失败而丢失。
16. 超级管理员可以运营看护全体用户和作品，但其权限必须显式授予、最小披露并全程审计；高权限不等于默认读取全部对话正文、Prompt、密钥或隐藏推理。
17. 运营聚合和看护视图是可重建投影。登录事实由Identity拥有，Project/Work事实由Product Harness拥有，Artifact/Evidence事实由Evidence模块拥有，任何运营页面都不能成为第二写者。
18. Web、Obsidian、文件目录、移动端和第三方前端可以用不同方式呈现同一组权威事实；稳定Read Model、来源revision、新鲜度和权限由服务端合同提供，外部编辑只能形成候选差异并经过CAS、HITL、Validation和Evidence写回，不能让投影成为第二事实源。

## 9. 完整产品能力范围

Chat 的目标能力至少包括：

1. Web Chat 交互、无障碍和响应式体验。
2. 会话、消息、分支、搜索、归档、导入导出和生命周期管理。
3. 上下文选择、来源展示、裁剪、版本和失效传播。
4. 多意图识别、澄清、修正和用户确认。
5. WorkItem、ActionItem、TaskPlan 及人/AI 责任闭环。
6. ExecutionDraft、RunSpec、HITL Policy、Approval、权限策略、版本与 Hash 绑定。
7. Agent、Workflow、Tool 与其他 Runtime 的受控执行。
8. 完成历史恢复、活动流重连、Worker 接管、Tool 对账、Workflow Checkpoint 与 HITL 恢复。
9. Memory 候选、接受、纠正、删除、来源与有效性治理。
10. Evidence、Delivery、Trace、审计、可观测性和故障处置。
11. 模型、工具、知识源和外部业务系统集成。
12. 通过具体Channel Adapter接入Telegram等终端平台，并通过独立Bridge Adapter与OPC-OS Chat互操作，实现授权映射和跨入口连续性。
13. 真实Principal、Role/Grant和Authentication Session，以及超级管理员运营看护台：跨用户查看登录、使用时长、Project/Work/Artifact进度、阻塞、异常和数据新鲜度，并审计敏感访问。
14. 把Chat自身作为普通软件Project进行真实Dogfood：关联版本化Repository资源，在隔离工作区由受治理执行层修改和验证，以Artifact/Evidence和用户决定完成结果与状态提交。
15. 为Web、Obsidian、文件目录和未来第三方前端提供稳定、受权限控制、可版本化的查询与投影合同；不同界面共享同一Product Store事实，受控编辑经候选、冲突检查和产品提交门写回。

这些能力最终至少要覆盖以下用户体验：

1. 明确查询已有Project、Work、Note和学习进度，不为查询误建事项。
2. 从一句简短表达继续唯一匹配的既有事项，并能看见采用的目标与上下文。
3. 存在同名、跨项目或低置信候选时让用户直接选择、补充或排除。
4. 创建并推进软件项目、一般项目、独立任务和包含用户行动的计划。
5. 跨天学习、练习、复习、切换项目后再回到原学习目标。
6. 记录笔记、决定、经验和可执行规则，并处理修订、冲突与来源失效。
7. 处理周期资讯、提醒和交付失败，不依赖Agent“自己记得下次运行”。
8. 把复杂工作拆成步骤交给pi等执行层，逐步授权、观察、纠正和验证。
9. 在一句话包含多个意图时分别建立Context和结果，不互相污染，也允许部分成功。
10. 在断线、进程退出、并发修改、Provider或Tool结果未知时恢复或请求人工处置，不制造假成功。
11. 超级管理员能够确定谁登录、使用了多久、正在推进哪些Project/Work、产生了哪些Artifact、进度依据是什么，以及哪些用户、作品或运行需要人工关注。
12. 用户能够让Chat持续开发Chat自身，并看见它采用的项目事实、仓库基线、执行步骤、Tool副作用、验证证据、代码合入和后续状态；当前运行环境不会被未审核改动直接污染。
13. 用户能够在Web查看Project Dossier、看板、Calendar和学习队列，也能在Obsidian或第三方前端以目录/Markdown等方式阅读同一事实；任一界面的修改都不会静默覆盖较新的revision或绕过用户决定与Evidence。

上述是目标能力全集，不代表一次性交付。实现顺序、依赖和每个阶段的可承诺保证只由`PROJECT_PLAN.md`及专项路线维护，不能反向修改本节产品范围。

以下内容不是产品承诺：

1. 展示或持久化模型隐藏推理。
2. 对任意不可控外部副作用提供通用 Exactly-once 保证；系统提供幂等、回执、对账、补偿与人工处置语义。
3. 未经权限和风险设计即开放任意 Shell、文件或外部系统操作。
4. 用某个框架 Session、协议 Snapshot 或浏览器缓存替代产品领域状态。

Session 的完整目标和恢复分级由[Session 能力全集](./docs/session-capability-catalog.md)维护；交付依赖由[Session 交付路线](./docs/session-delivery-roadmap.md)维护。

## 10. 已批准技术路线

2026-07-21 用户批准以下技术路线：

1. 后端使用 Python、Microsoft Agent Framework（MAF）和 FastAPI。
2. 前后端 Agent 交互协议使用 AG-UI，主要传输为 HTTP 请求和 SSE 事件流。
3. 前端使用 React 19、TypeScript 和 Vite。
4. 前端通过`@ag-ui/client`连接 MAF AG-UI 端点。
5. UI 采用自研产品组件，以 Tailwind CSS、Radix UI 和 Lucide React 为基础。
6. Zustand 只管理导航、弹窗、筛选和布局等页面状态；Agent 消息和运行状态由 AG-UI Client 投影。
7. MAF 运行状态与产品领域状态分开拥有；SQLite 是已批准的产品数据库实现起点，但不能改变逻辑状态边界，完整运行拓扑所需存储能力仍须按架构保证验证。
8. 产品保持Web与Channel入口、产品资源、Interaction协调、Run执行和外部集成边界清晰；领域模型不能由 UI 组件、AG-UI 临时状态或 MAF Session 代替。
9. 每次Provider模型调用都必须生成独立ModelCallDraft、Hash和授权判断：MAF原生Workflow承载控制流，自定义确定性Executor编译并发送请求；产品默认发送前暂停人工审批，HITL策略可在系统不可放宽下限内配置有界自动推进，自动决定同样留痕。`store=False`且不使用Continuation保证本次完整显式上下文可见，自动Tool循环关闭。Provider与模型来自服务端能力目录并联动选择；可读视图使用不可改名的Key和按值类型选择的文字、数字、布尔或枚举控件，Provider JSON只作为高级视图，两者编辑同一请求草稿。任一字段或Provider路由修改都会生成新版本、Hash并重新授权，旧决定失效；放弃不产生发送Attempt，并把原输入返回输入框供继续修改或清空。
10. 后端运行与模型配置只从私有`backend/config.json`启动快照读取；Provider按数组扩展、每个Provider维护自己的模型目录。仓库只提交脱敏的`backend/config.example.json`，密钥和Base URL不进入浏览器响应或Git。

### 10.1 协议、运行时与状态所有权

| 边界 | 负责 | 不负责 |
|---|---|---|
| REST API | Session CRUD、标题、归档、历史分页、附件，以及 Work、Evidence、Memory、Trace 等产品资源 | 不承载 Agent 实时事件状态机 |
| AG-UI over HTTP/SSE | 单次 Agent Run 的生命周期、流式 Message、Tool Call、Interrupt/Resume 和实时 State 投影 | 不负责用户、权限、Session CRUD、数据库 Schema 或产品持久化 |
| Product DB | 用户可见且需要恢复、审核和追溯的产品事实 | 不把 AG-UI Snapshot JSON 或浏览器状态直接当成领域模型 |
| MAF 运行时及其 Store | AgentSession、Context、Tool、Workflow 和 Checkpoint 语义 | 不拥有标题、归档、访问控制、Work、Evidence 和 Memory 等产品对象 |
| 前端 | 展示和操作服务端状态投影，保存短期页面交互状态 | 不拥有权威历史、产品事实、授权或运行终态 |
| 外部集成合同 | 身份映射、能力声明、命令/事件交换、版本、幂等、权限和交付回执 | 不直接读写其他系统私有状态，不合并双方事实源 |

架构总则：**REST 管理产品资源，AG-UI 管理一次 Agent Run 的实时交互，Product DB 保存权威产品事实，MAF 管理 Agent 运行时语义。** 物理存储可以复用，逻辑所有权不能合并；AG-UI Snapshot 可以作为运行或 UI 投影，但不能替代 Product Session 与产品历史。

Session 目标包括完成历史恢复、活动流重连、Worker 恢复、Tool 副作用恢复、Workflow/HITL 恢复和跨入口连续性。交付路线只能决定这些保证的启用顺序，不能把 AG-UI Snapshot、MAF Session、Workflow Checkpoint 或 Product Session 合并成一个对象。
