# Chat 项目协作规则

## 1. 项目身份

本仓库实现 **Chat 独立产品**。它独立开发、独立运行、独立运营并持续演进，自己承担从对话到工作、执行、知识、证据、交付和治理的完整产品责任。

必须区分两个维度：

1. **产品身份**：本项目是完整、独立的 Chat 产品，不是适配器、薄通道或外部系统的附属实现。
2. **集成角色**：Chat 可以通过明确合同与 `OPC-OS Chat` 或其他外部系统互操作，也可以在某个集成拓扑中提供聊天通道能力；这不改变本项目的产品身份和责任边界。

不得再使用“只是一个通道”“不是完整上位系统”等措辞缩小项目定位。Adapter 只是外部集成模块中的技术角色，不能代表产品本身。

## 2. 项目目标

本项目以对话为交互入口，把用户输入转化为连续、可审核、可执行、可恢复的协作闭环：

```text
输入与上下文
-> 意图
-> 计划与人/AI行动
-> 执行请求与用户审核
-> Agent或Runtime执行
-> 结果、证据、交付与Trace
-> 工作状态和记忆更新
```

项目不以“做一个聊天页面”为完成标准，也不以使用某个 Agent 框架为产品价值。

## 3. 当前阶段

当前状态为 `TypeScript全栈与pi-agent目标方向已冻结，pi + pi-web双轨完整掌握材料及Workflow/HITL/Checkpoint源码事实研究已完成；Chat承载方案D1—D8待用户审核，现有MAF实现作为迁移参照保留`：

1. 产品问题、独立产品身份、核心目标和完整闭环已经形成审核基线。
2. 2026-08-05用户批准目标系统改为TypeScript全栈，并以`pi-agent-core`作为Agent核心基座。
3. 具体前端框架、HTTP服务框架、实时协议、Workflow/HITL/Checkpoint实现、Store与部署拓扑仍待研究和用户审核；2026-08-06用户已明确从pi源码事实进入Chat架构方案审核，当前审核材料是[pi承载Chat Workflow/HITL/Checkpoint架构候选](./docs/pi-workflow-hitl-checkpoint-architecture.md)D1—D8，不进入实现。
4. 现有Python、FastAPI、MAF、AG-UI和React/Vite代码已经形成大量产品语义与故障验证，冻结为迁移行为参照；不得把“目标替换”误写成可以无证据删除现有实现。
5. 产品领域状态继续与任何pi Session、Agent消息、运行事件或前端状态分开拥有；浏览器只保存交互投影。
6. [pi技术基线研究与重建决策计划](./docs/pi-native-replatform-plan.md)中的RP-01.0与RP-01.1已纳入`pi + pi-web`完整掌握成果；原RP-01.2—RP-01.6不再作为逐卡停顿顺序。上一轮越过源码事实研究的D1—D8已撤回；`native/partial/design-only/missing`证据矩阵完成后，2026-08-06已按用户要求重新从源码事实与pi设计哲学推导4种总体路线和新D1—D8。用户批准新D1—D8前不新增目标依赖、Schema、迁移或生产目录，也不提前进入Memory接入或实现。
7. 现有运行配置继续由用户维护在`backend/config.json`，该文件不得被读取到输出、文档或Git；目标TypeScript配置合同尚未批准，迁移前不得复制真实密钥或Base URL。

当前事实以 [PROJECT_STATE.md](./PROJECT_STATE.md) 为准。

## 4. 文档职责

| 文件 | 唯一职责 |
|---|---|
| `AGENTS.md` | AI与开发协作必须遵守的规则 |
| `PROJECT_LESSONS.md` | 每次项目回复前必读的经验、反例和决策检查 |
| `PROJECT_CONTEXT.md` | 稳定的产品定义、问题、目标、边界和核心模型 |
| `PROJECT_PLAN.md` | 分阶段路线、验收门与计划状态 |
| `PROJECT_STATE.md` | 当前时点已经确认、完成、阻塞和待审核的事实 |
| `docs/project-session-handoff.md` | 一般项目跨Session续接入口、当前审核门与新Session启动协议 |
| `概念空间/00-索引.md` | Chat共同语言、概念边界、别名和反例的发现入口 |
| `README.md` | 项目入口、简要定位和使用导航 |

同一事实只在拥有它的文件中完整维护，其他文件只做摘要和链接。

### 4.1 每次回复前的强制读取顺序

任何项目相关回复、方案、修改或审核开始前，必须按顺序读取：

1. `AGENTS.md`。
2. `PROJECT_LESSONS.md`。
3. `PROJECT_CONTEXT.md`。
4. `PROJECT_STATE.md`。
5. `PROJECT_PLAN.md`。
6. 从`概念空间/00-索引.md`按需读取与当前任务直接相关的概念簇；没有高风险概念时不通读全部资产。
7. 与当前任务直接相关的设计、研究和源码。

当用户说“继续Chat项目”“继续当前计划”“现在到哪了”或在新Session中要求恢复本项目时，完成上述读取后必须进入
[Chat项目跨Session续接入口](./docs/project-session-handoff.md)，以其中记录的当前审核门和唯一下一步为准。
不得仅凭旧聊天摘要推断项目阶段，也不得越过尚未获得用户批准的审核门。

当用户说“继续工作台参考界面”“继续前端交互设计”或“继续90%的Chat系统交互设计”时，完成上述读取后必须先进入
[Chat 90%交互设计跨Session续接入口](./docs/chat-interaction-design-handoff.md)，从其中记录的第一个未完成模块继续。
不得依赖旧聊天恢复任务，不得重做已批准模块，也不得在一个AI开发协作Session中无边界追加后续模块。

即使只是回答问题、上下文中似乎已经包含这些内容，也不能跳过。上下文压缩、任务切换或用户纠正后必须重新读取。用户指出会重复伤害项目的错误时，应先把它转化为`PROJECT_LESSONS.md`中的可执行反例和检查项，再继续方案工作。

### 4.2 概念空间使用规则

1. `Session`、`Run`、`Workflow`、`Context`、`Agent`、`Tool`、`Approval`和`Canvas`等高冲突词在可能歧义时必须带限定词。
2. 概念资产拥有名称、边界、关系、别名和反例；`PROJECT_CONTEXT.md`仍拥有稳定产品责任，`PROJECT_STATE.md`仍拥有实现事实，源码与测试仍拥有具体行为证据。
3. 新概念先标为候选并说明必要性、边界和相邻概念；用户确认前不能成为架构、UI或开发的稳定前提。
4. 面向用户首次实质使用重要概念时必须就地解释，不能只提供文档链接。
5. 概念状态与实现状态分开；“概念有效”不表示功能已实现，“代码存在”也不表示名称和边界已获产品批准。

## 5. 产品规则

1. 用户必须能看见系统理解到的意图、采用的上下文和准备执行的内容。
2. 模型输出只是候选，不自动成为已接受记忆、活动工作或完成事实。
3. 用户可以修正意图、计划、上下文和执行请求。
4. 高影响动作必须在执行前确认；批准必须绑定当前版本和当前请求内容。
5. 对话、工作、执行、证据、记忆和Trace必须能够关联和恢复。
6. 失败不能产生假成功、半写长期状态或无记录自动重试。
7. Trace记录可观察事件、状态和证据，不保存或展示模型隐藏推理。
8. 完整历史是证据来源，不应无边界地成为每轮默认模型上下文。
9. Chat必须提供受严格授权与审计的超级管理员运营看护能力，使超级管理员能够查看谁登录、使用情况、Project/Work进度、Artifact/Evidence状态和需要关注的异常；普通用户个人主页与Workflow执行看护不能替代该能力。
10. 登录会话时长、浏览器前台活跃时长、有效协作活动和Run/Provider/Tool耗时是不同指标，必须分别记录来源、计算口径、数据新鲜度和未知状态，不能用Token、请求耗时或Worker心跳冒充用户使用时长。

## 6. 架构规则

1. 前端负责交互和后端状态投影，不拥有权威业务状态。
2. 后端应用层负责流程编排、权限门、状态转换和失败语义。
3. `pi-agent-core`负责目标系统中的Agent loop、模型、Tool、Session和运行事件能力；它不自动拥有Product Session、Project/Work、Approval、Accepted Memory、Evidence或产品完成事实。
4. 目标前后端实时协议尚未冻结。AG-UI是现有实现的行为基线；选择保留、适配或替换它时，必须证明流式消息、Tool事件、中断/恢复、游标重连和前端投影没有退化，且不得形成两套竞争协议。
5. 必须区分Product Session、pi Runtime Session、前端实时Thread/Connection、Workflow Checkpoint、Product Run和Run Attempt；即使ID暂时同值，也不能合并职责或用作授权。
6. 产品资源、实时Run交互、Product DB、pi运行状态和浏览器投影必须保持不同所有权；具体REST/协议/Store实现待总体架构审核，任何Runtime Snapshot都不能成为产品事实源。
7. Chat通过明确合同与OPC-OS Chat或其他外部系统互操作；集成不能形成双重事实源，也不能让外部系统身份反向缩小本项目的产品责任。
8. Runtime、模型、工具、记忆和存储必须可替换，不能散落在UI或路由代码中。
9. 外部调用必须有超时、结构校验、错误脱敏、幂等或明确的重复执行语义。
10. 后端运行配置、密钥和路径从私有`backend/config.json`注入；真实密钥不得进入源码、文档、Trace、浏览器响应或Git。
11. 超级管理员是Identity授权的Principal角色；Identity拥有认证会话与授权事实，超级管理员运营模块拥有用户活动记录、使用聚合和管理员访问审计，Product Harness与Evidence分别继续拥有Work和Artifact事实。
12. 超级管理员运营看护台通过专用REST查询与投影读取各模块权威事实，不直接读写数据库、不经AG-UI管理产品资源、不复制Project/Work/Artifact状态，也不能因为角色高权限而绕过敏感内容访问审计。

## 7. 代码与目录规则

当前MAF实现目录职责；目标TypeScript目录必须等技术基线与总体架构获批后再定义：

| 目录 | 职责 |
|---|---|
| `frontend/` | React交互层、AG-UI Client状态投影和页面状态 |
| `backend/app/` | FastAPI协议入口、配置和MAF Agent创建 |
| `backend/tests/` | 后端合同与集成测试 |
| `scripts/` | 可重复执行的本地工程验证 |

后续领域能力应继续区分：

1. 前端交互层。
2. HTTP或流式协议层。
3. 产品应用与领域层。
4. Agent Runtime和Workflow层。
5. 存储与外部Runtime适配层。
6. 测试、文档和运行配置。

禁止：

1. 把全部逻辑堆入单个前端组件或单个后端入口文件。
2. 让API路由直接修改持久化状态。
3. 让前端拼接完整权威历史后替代服务端上下文管理。
4. 把旧项目的`.env`、数据库、历史会话、构建产物或缓存复制进本仓库。
5. 复制旧项目的框架绑定和临时兼容代码，却没有明确复用理由与新测试证据。

### 7.1 模块设计与代码质量

详细执行标准见[工程编码与模块设计规范](./docs/engineering-standards.md)。以下规则属于开发强制门：

1. 模块按业务能力、状态所有权、事务边界和变化原因拆分；行数只触发审查，不允许机械按行切文件。
2. HTTP Router、AG-UI入口和React页面不拥有产品事务或权威业务状态；Application Coordinator是一个用例的唯一事务所有者。
3. 被提取的规则、查询、投影和适配器不得擅自开启或提交调用方事务。需要参与原子提交的协作者必须显式接收现有Session/Unit of Work。
4. 禁止Repository-per-table、Service-per-method、万能`utils/helpers`和没有真实替换/测试价值的接口；少量局部重复优于错误抽象。
5. Python/TypeScript模块超过800行、React组件或Hook超过500行、函数超过80行时必须审查职责；可以保留，但必须在审计或代码邻近处说明不可拆的不变量和测试边界。
6. 注释解释不变量、事务所有权、失败/恢复语义、兼容原因和安全边界，不复述语法；公开应用合同和非显然状态机使用Docstring/JSDoc。
7. 结构化日志只放在请求/命令入口、关键状态转换、外部调用、重试/接管/对账和失败边界；携带稳定关联ID和结果，不记录密钥、完整Prompt、Provider Payload或隐藏推理。
8. 前端按Feature与运行责任拆分；页面、Workbench和重型编辑器使用真实加载边界做生产代码分割，不为追求Chunk数量拆成微型模块。
9. 无行为重构必须先固定不变量或指纹，并通过架构依赖、合同、状态机、生产构建和相关端到端场景证明没有改变Schema、Workflow节点、审批Hash、AG-UI事件或用户语义。
10. 新规范必须对应已经发生的风险或明确产品保证，并尽量自动验证；不得以“产品级”为由预建尚无用途的平台层和样板代码。

## 8. 源码查询与参考项目规则

开发本项目时，禁止只凭模型记忆猜测pi API、现有MAF行为或Agent产品架构。以下本地仓库是强制参考源：

| 参考源 | 路径 | 主要用途 |
|---|---|---|
| Microsoft Agent Framework源码 | `/Users/xulater/Code/opc-os/agent-framework` | 解释现有实现、固定迁移行为预言机以及核对MAF时期的Session、Workflow、HITL、Checkpoint和AG-UI语义；不再决定目标Runtime |
| nanobot | `/Users/xulater/Code/opc-os/nanobot` | 参考小型Agent loop、Provider、Channel、MessageBus、Session、Memory、Tool和长期运行边界 |
| pi | `/Users/xulater/Code/opc-os/pi` | 目标Agent核心基座；研究模型抽象、Agent loop、Tool、事件、Session、Harness、Server、扩展、编码执行和工程规则 |
| QwenPaw | `/Users/xulater/Code/reference-agent-sources/QwenPaw` | 参考Web Console、外部消息Channel Adapter、统一队列、Workspace/Runtime、多Agent、治理和插件的真实入口拓扑 |

执行规则：

1. 涉及目标Agent Runtime时，先查询固定提交的pi源码、类型、测试、示例和本地实跑，不得靠README、Stars或模型记忆猜接口。
2. pi结论必须记录目标提交、包版本、工作树状态和验证命令；本地源码、发布包和`pi-web`依赖版本不一致时分别记录，不能互相背书。
3. pi查询优先级是：固定提交源码与测试 > 对应版本官方文档 > `agent_knowledge`笔记 > 模型记忆。涉及现有MAF迁移语义时仍以当前安装版合同测试和现有实跑为准。
4. 设计Agent loop、Provider、Channel、Session、Memory、Tool、事件流、扩展点、进程管理和长期运行能力时，先研究pi；只有pi未覆盖的明确问题才按本计划读取nanobot、QwenPaw、LibreChat或申请新增候选，不能再次泛读全部参考集。
5. 参考不等于复制。不得机械照搬目录、状态模型或临时兼容代码；必须结合本项目6个问题、产品闭环和MAF/AG-UI边界做取舍。
6. 进入任一参考仓库阅读或验证前，先读取该仓库及目标子目录的`AGENTS.md`；不得修改这些仓库，除非用户明确授权对应修改。
7. 形成重要架构结论时，应在代码、测试或文档中留下可定位的本地路径、版本或提交证据，不能只写“参考了某项目”。

### 8.1 Kimi Code CLI开发工具

1. 用户说“使用Kimi Code CLI工具”“让Kimi看一下/实现”时，必须使用个人Skill
   `/Users/xulater/.codex/skills/kimi-code-cli/SKILL.md`，不得重新猜测命令、权限或协议。
2. 默认通过该Skill的只读Agent包装器让Kimi审查代码或界面；Kimi给出建议后，仍由当前开发者核对源码、修改和验证。
3. Kimi需要亲自修改时只能使用可交互权限模式，逐项审查操作；禁止用`kimi -p`、`--prompt`、`--auto`或`--yolo`执行无人值守修改。
4. 把Kimi接入Chat产品Runtime时使用ACP承载Session、事件和Tool权限；ACP不自动提供完整Provider Payload可见性，不能冒充现有逐次ModelCallDraft治理。
5. 已验证版本、源码提交、调用方式和安全边界维护在
   [Kimi Code CLI开发工具手册](./docs/kimi-code-cli-tool.md)与
   `/Users/xulater/Code/opc-os/agent_knowledge/project-studies/kimi-code/README.md`。
6. Kimi或pi承担有界实现任务前，从[执行层经验手册](./docs/execution-layer-experience.md)按本次风险选择
   相关经验卡；经验必须包含真实反例、期望结果和验证方法，不能只传递抽象口号，也不能把全部经验
   无界堆入Prompt。硬不变量约束结果，命名、局部抽象和具体实现方案仍由执行层自主判断。

### 8.2 Session及其他核心能力的设计顺序

设计Session持久化、上下文、记忆、工具、工作流等核心能力时，必须严格按以下顺序执行：

1. **先研究pi**：按[pi技术基线研究与重建决策计划](./docs/pi-native-replatform-plan.md)固定提交，分别核对`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-server`和`pi-web`，形成“原生提供、需要封装、明确缺失、版本风险”的事实结论。
2. **再对照现有Chat行为**：把当前Python/MAF实现、数据库、合同测试、浏览器场景和故障语义作为迁移预言机，判断目标方案是否保留产品保证；MAF只为现有行为背书，不再决定目标模块。
3. **有缺口才读取其他参考**：只针对pi未覆盖的Session恢复、Web/Channel、Workflow/HITL、Worker或产品持久化问题有界读取nanobot、QwenPaw、LibreChat；新增Mastra等候选必须先把限定问题、收益和研究成本提交用户审核。
4. **最后形成项目方案**：结合Chat的6个问题、完整闭环、产品不变量和pi事实形成候选设计，逐项列出采用、改造、补建、不采用及原因。
4. **先审核、后实现**：候选设计必须明确标记为“待用户审核”。用户批准前，不得创建正式Schema、迁移、持久化服务或兼容层，也不得把候选对象写成已经冻结的项目事实。
5. **证据分层**：设计文档必须分别标记pi源码/测试/实跑事实、现有Chat/MAF行为事实、其他参考项目事实、本项目推断和待审核决定。
6. **知识同步**：研究中形成可复用的pi知识时同步检查并更新`agent_knowledge/project-studies/pi/`；只有经过版本核对和源码或运行验证的内容才可写入。
7. **审核材料自包含**：不得假设用户已经掌握框架背景或参考项目实现。提交决策点前，必须先说明问题背景、当前项目事实、源码证据、各方案能解决与不能解决的内容、推导链和代价；不能只给结论或让用户自行反查“参考了什么”。
8. **决策卡完整性**：每个待审核决定必须逐项写明决策原因、现有参考源是否真正涉及、全部可行选择、各自优缺点、当前建议、建议原因、信心与未验证项。参考源未涉及时必须明确写“未涉及”；可以提出新的开源候选，但用户批准加入前只能做相关性筛选，不得先研究后倒逼用户接受，也不得把候选写成既有证据。

#### 8.2.1 Session总体规划门

Session工作必须先完成总体目标，再讨论某一阶段的持久化实现：

1. 先维护[Session能力全集](./docs/session-capability-catalog.md)，完整说明会话生命周期、消息与分支、上下文、Run控制、断线续传、进程恢复、Tool/Workflow/HITL恢复、跨通道、治理及明确非目标。
2. 必须把“重新打开已完成会话、恢复失败回合、接回仍在运行的流、Worker退出恢复、Tool副作用恢复、Workflow Checkpoint恢复和HITL恢复”分开定义，不能用一个`resume`或“保存历史”笼统替代。
3. 再维护[Session交付路线](./docs/session-delivery-roadmap.md)，按优先级和依赖拆阶段；每个任务至少说明方案级做法、目标、依赖、参考覆盖和完成后的用户场景。
4. 阶段拆分只表达顺序，不能把未在当前阶段实现的能力从总体规划中省略，也不能假设用户已掌握未来阶段会做什么。
5. 总体能力和路线经用户审核后，才允许进入详细设计；详细设计经审核后，才允许开发、Schema、迁移或正式兼容层。
6. 现有Session持久化D1-D6只是Phase 1的子设计，必须在总体规划获批后结合树兼容、Run Attempt演进和后续Checkpoint关联重新审核，不能作为完整Session方案的总体入口。
7. 任一阶段完成时必须明确“本阶段已经满足什么恢复保证、仍不保证什么”，禁止把R0历史恢复外推为活动Run、Worker、Tool或Workflow恢复。

#### 8.2.2 总体架构审核门

涉及总体架构、模块边界、状态所有权或部署拆分时，必须遵守：

1. 先从本项目6个问题、完整产品闭环和完整用户场景推导目标保证，再检查pi、现有MAF行为预言机及按缺口批准的参考覆盖；不得按pi仓库目录反向拼装架构。
2. 研究过程必须记录固定版本、检索问题、源码/测试路径、运行证据、得到的结论和未覆盖项；可复用的pi与外部项目知识同步到`agent_knowledge`，不能只留在当前对话。
3. 总体架构候选统一维护在[总体架构候选](./docs/overall-architecture-proposal.md)，证据与推导维护在[总体架构研究](./docs/overall-architecture-research.md)。两者都必须明确“待用户审核”，不能提前写成已批准事实。
4. 模块划分必须逐项说明用户价值、负责与不负责、内部组件、状态所有者、入站与出站合同、依赖方向、不变量、失败恢复、技术落点、测试要求和能够满足的用户场景；禁止用模块名清单或“分层解耦”一类口号代替设计。
5. 参考项目只对其真实覆盖范围背书。Intent、Work、Approval、Evidence等若主要来自本项目需求，必须标记为项目推导；不得借pi或参考项目名义包装成框架原生能力。
6. 用户批准总体架构前，不按候选批量创建正式目录、Schema、Repository、Worker或兼容层。批准后，各模块仍须按计划进入自己的详细设计审核，不能把总体架构批准外推为全部实现细节获批。
7. 后续详细设计如果发现参考知识不足，只能先提交新增参考项目的限定主题、预期收益、重叠和研究成本给用户决定；未批准前不得自动扩大正式参考集。
8. 总体架构必须先完整定义目标系统，再在文档最后拆交付阶段。交付阶段只决定启用顺序和验收范围，不得以“初期、第一版、早期、当前规模”为理由删减目标模块、场景或质量保证。
9. 产品身份与外部集成角色必须分开。本项目始终按独立完整Chat产品设计；OPC-OS Chat只作为外部集成关系，不得画成决定本项目边界的上位层级。
10. 每个核心场景必须穿透到前端组件、后端模块、运行时、合同、权威状态、失败分支、恢复路径和用户可见结果。场景不能只写概念性流程。
11. 总体架构提交审核前，必须按`PROJECT_LESSONS.md`的4类读者标准自检：架构师能继续出方案，项目经理能排计划，开发能实施，产品负责人能审查依据与场景覆盖。
12. 总体架构必须提供面向第一次接触项目读者的对象级导读：分别展开前端View、网络DTO、内部Envelope、产品领域对象和pi/Worker运行对象；说明每个核心对象的创建者、所有者、存储、生命周期和可见性，并把Agent展开为内部部件及外部控制边界。模块名和箭头不能替代这份心智模型。
13. 新手导读必须从用户一次具体点击开始，按时间顺序穿透前端函数、目标网络入口、应用协调、数据库读写、pi Runtime/Workflow、Tool治理、Provider请求、响应解码、产品提交和前端渲染；每一步说明输入、处理、输出、Store和用户可见变化，并分别标明当前MAF代码事实与待审核目标架构。对象词典不能替代这条运行链。

### 8.3 外部产品参考的收敛与成本控制

pi是目标技术基线；MAF是现有行为参照，nanobot和QwenPaw只按明确缺口读取。除此之外，外部Web产品参考当前只保留 **1个正式主参考**，不设置会被自动触发的条件候补，不得把多个相似平台同时加入日常必查链路：

| 状态 | 项目 | 唯一参考范围 | 不参考的内容 |
|---|---|---|---|
| 正式外部主参考 | [LibreChat](https://github.com/danny-avila/LibreChat)，本地只读检出`/Users/xulater/Code/opc-os/LibreChat` | Web Chat的App Shell与Feature边界、产品查询与资源API、Product Session、Message、Agent Run/Generation Job、服务端权威持久化、失败语义、流式续传和跨实例运行关联 | 不复制Node、MongoDB、Redis、历史双后端、多套前端状态或其私有SSE实现，不把它当MAF能力来源 |

以下项目不进入当前常规参考集：

1. Flowise不作为条件候补；将来真的出现Workflow、HITL或Checkpoint产品表达缺口时，只能先提交新增理由和限定研究范围给用户审核。
2. Open WebUI与LibreChat在Chat持久化问题上重叠；只在出现明确的Python/FastAPI实现缺口时重新申请。
3. LobeHub只在复杂Web Agent交互专题出现且现有前端参考不足时重新申请。
4. Dify只在出现分布式Worker、工作流调度和平台运营问题时重新申请。
5. 此前筛选的AI Agent Service Toolkit、DataFoundry、Trend Micro ADK AGUI Middleware等项目不再是当前审核前置项，也不进入强制参考清单。

外部参考执行规则：

1. 每个设计问题默认最多研究LibreChat这1个外部项目；其明确未涉及时，直接记录“未涉及”，不得自动研究第二个项目。
2. 研究前先写清具体问题和触发原因，只读取直接相关的文档、源码和测试目录，不做整仓库泛读。
3. 研究结论必须分别写明采用、改造和不采用项；技术栈、框架或存储不同的实现不能直接复制。
4. 外部产品只能补充产品与工程经验；MAF API、生命周期、Session、Checkpoint和AG-UI适配行为仍以匹配版本的MAF源码、测试和实测为准。
5. 新增、替换或临时启用任何其他外部参考项仍需用户审核，不能因为某项目Stars高或LibreChat未覆盖就自动加入。

## 9. `agent_knowledge`维护规则

`/Users/xulater/Code/opc-os/agent_knowledge`是 **面向Later学习和复用的Agent知识库**，不是AI内部草稿、项目临时日志或材料堆积目录。

本项目开发过程中，由AI持续维护该知识库：

1. 当MAF使用方式、关键概念、版本差异、已验证示例、常见错误或设计判断出现可长期复用的新事实时，必须检查并更新对应笔记。
2. MAF升级、API变更、源码与旧笔记冲突、真实运行推翻原结论时，必须主动修正旧内容，不能只在当前对话中说明。
3. 内容以中文、面向学习者编写，先解释概念和使用场景，再给最小示例、边界、失败方式和验证方法；不能只堆API清单。
4. 重要MAF笔记至少记录：更新日期、项目安装版本、参考源码提交或路径、适用范围、代码示例、已知限制和验证证据。
5. 明确区分MAF官方或源码事实、当前项目实测事实、nanobot/pi/QwenPaw参考设计和本项目推断；不得把推断写成框架保证。
6. 知识库与源码冲突时，先核对版本，再以匹配版本的源码和测试为准，并更新过期笔记。
7. 不写入API Key、完整`.env`、用户私密数据、会话内容或其他不可公开信息。
8. 每次完成涉及MAF的代码任务前，检查本次发现是否需要同步知识库；无新增长期知识时无需为了留痕制造空洞更新。
9. 经用户批准研究的外部项目，如果形成了可复用的源码知识，也必须同步到`agent_knowledge/project-studies/<project>/`；至少记录固定提交、限定范围、核心对象、关键链路、采用/改造/拒绝项、证据路径和未验证项。不得只把结论留在当前项目设计文档或对话中。
10. LibreChat当前知识入口为`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/librechat/README.md`；其中Session/流式持久化、Conversation生命周期/分支和Web Chat总体架构是3个有界主题，不能为LibreChat未研究能力背书。
11. MAF总体架构位置与边界维护在`/Users/xulater/Code/opc-os/agent_knowledge/MAF/02-Agent应用架构中的位置与边界.md`；必须同时保留目标项目安装版本和本地参考源码提交，不能把源码主分支能力冒充安装版保证。
12. `pi + pi-web`当前完整知识入口为`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/pi-agent/README.md`，`project-studies/pi/README.md`只保留为兼容路由；nanobot入口为`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/nanobot/README.md`。形成Chat模块决策时必须引用真实模块、固定版本与明确缺口，不能只写项目名。
13. QwenPaw知识入口为`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/qwenpaw/README.md`，固定源码位于`/Users/xulater/Code/reference-agent-sources/QwenPaw`；设计Web、Telegram等Channel与后端关系时必须先读取其Web/Channel入口拓扑，不能把最终聊天平台直接画到产品核心。
14. Kimi Code CLI知识入口为`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/kimi-code/README.md`；它只为Kimi命令、权限、ACP和开发辅助边界背书，不自动进入Chat总体架构参考集。
15. TencentDB Agent Memory知识入口为`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/tencentdb-agent-memory/README.md`。用户询问该项目怎样采集会话、使用JSON/Markdown/数据库保存、维护L0-L3/Skill、治理Asset/ACL/Binding、编译Loadout或对Chat有什么启发时，先按该README的问题路由读取既有固定提交研究；研究已于2026-08-01收口，默认只读复用，不重跑实验、不自动升级为Chat正式参考或采用决定。
16. MemOS与memmy-agent总入口为`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/Agent-Memory-MemOS-memmy-agent-总入口.md`，跨项目结论在`MemOS与memmy-agent-对Chat的S7迁移结论.md`。MemOS固定提交`027dc89`，覆盖Local v2的Agent Hook->Episode->L1->L2/L3/Skill->召回链；memmy-agent固定提交`211d521`，覆盖Agent Hook->公共HTTP->SQLite事务->Worker->L2/L3/Skill/Trial->召回链。用户询问会话后管理、经验记忆分层、原始观察与派生资产分离、同步最小提交+异步语义深化、Recall血缘、EpisodeProjection或Chat经验学习环怎样设计时，先按总入口的问题路由读取既有固定提交研究；两项目研究已于2026-08-01收口，默认只读复用，不重跑实验、不自动升级为Chat正式参考或采用决定。Chat候选吸收链、建议采用/改造/拒绝项和已知缺口在总入口第3-7节；任何Chat实现仍须回到Chat的`AGENTS.md`、`PROJECT_CONTEXT.md`、`PROJECT_STATE.md`、`PROJECT_PLAN.md`和相应工作包详细设计门。

## 10. 验证规则

每个能力必须按风险选择证据，不能只凭文档或Mock宣称完成：

1. 领域状态机和合同测试。
2. API、失败、并发与恢复测试。
3. 前端类型检查和生产构建。
4. 真实MAF Agent或真实模型运行。
5. 浏览器端到端、响应式和可访问性检查。
6. 用户对理解成本、控制感和产品价值的体验审核。

测试通过只能证明对应快照，不代表长期稳定或完整产品价值。

## 11. 变更规则

1. 修改产品定位、核心对象、技术路线或状态所有权前，先更新对应治理文档并说明原因。
2. 新增依赖、外部服务、工具权限或不可逆操作前，必须说明必要性和风险。
3. 修改代码后同步更新相关测试和`PROJECT_STATE.md`。
4. 保留用户已有改动；不擅自删除、覆盖或重置不属于当前任务的内容。
5. 默认使用中文沟通，先给结论，再给必要证据，尽量用数字表达状态。
