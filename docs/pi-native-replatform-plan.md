# Chat pi原生技术基线研究与重建决策计划

> 日期：2026-08-05
>
> 状态：原计划已转为研究历史与证据边界；RP-01.0/1.1已纳入`pi + pi-web`完整掌握成果，原RP-01.2—1.6逐卡停顿顺序已被用户修订
>
> 计划编号：RP-01
>
> 本计划只决定怎样研究、验证和形成下一轮技术决策，不授权产品代码重建、依赖安装、Schema、迁移、部署、删除旧实现或真实付费模型调用。

## 1. 已冻结的上游决定

本计划不再讨论以下方向是否成立：

1. Chat目标系统采用TypeScript全栈。
2. `pi-agent-core`是目标Agent核心基座，`pi-ai`和`pi-coding-agent`进入同一技术体系。
3. 前端围绕Chat产品合同建设，不直接拥有pi运行状态；具体TypeScript前端框架仍待选择。
4. `pi-web`是连接方式、Session呈现和交互工程的参考，不自动成为Chat产品底座。
5. 当前Python/FastAPI/MAF/AG-UI系统停止作为目标架构继续扩张，保留为行为预言机、迁移输入和回归证据。
6. 新系统按目标纵向链重建，不逐行翻译现有Python。
7. Chat继续唯一拥有Product Session、Project/Work、Approval、Accepted Memory、Product Run、Evidence、Artifact、Delivery和Trace等产品事实。

## 2. 本计划要回答的问题

研究结束时必须回答8个问题：

1. pi的Package、对象、事件和调用链究竟怎样工作，哪些API可以稳定依赖？
2. `pi-agent-core`能够直接承担哪些Agent Runtime责任，哪些需要Chat封装或补建？
3. `pi-ai`能否支持Chat要求的Provider目录、规范请求、流式响应、最终Payload审核和多Provider切换？
4. pi的Tool Hook、执行顺序、取消、steer、follow-up和结果语义能否承载Chat的逐次审批与副作用治理？
5. pi的Session、JSONL/SQLite后端、分支、压缩和恢复分别保证什么，不保证什么？
6. `pi-server`和`pi-web`能为前后端连接、进程生命周期、实时事件和Session呈现提供什么，哪些仍是实验能力？
7. Chat应自建还是引入额外组件来承担持久Workflow、HITL、Checkpoint、Worker恢复和事件重连？
8. 哪些现有前端、产品合同、Schema和测试可以复用，哪些应重写，怎样切换而不制造两套长期事实源？

## 3. 明确不做

本计划期间不做以下事情：

1. 不创建目标TypeScript生产目录或数据库Schema。
2. 不迁移、删除或重写现有Python/MAF代码。
3. 不决定Memory最终实现；先保留现有研究证据，等pi技术基线完成后重新评分。
4. 不研究或集成BMAD；它在后续项目管理方法计划中单独处理。
5. 不默认引入Mastra或其他Workflow框架。只有pi缺口被源码和实验确认后，才提交一个限定主题的候选研究申请。
6. 不因pi、pi-web或外部框架已有某个对象，就直接采用其目录、Session、数据库或产品状态模型。
7. 不使用Stars、README功能名称或演示效果替代源码、测试和运行证据。

## 4. 固定研究对象

| 对象 | 当前固定点 | 研究范围 | 不用于证明 |
|---|---|---|---|
| pi | `10e99ae9914cd34f622633fac42f9a90714e9cf4` | `pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-server`、存储Package、测试和示例 | Chat产品对象、权限、持久Workflow天然存在 |
| pi-web | `82cb76a36b379a050e93ee7d726f2cf591e5f942` | Web连接、事件流、Session呈现、配置、文件与响应式交互 | Product Store、项目管理和生产恢复 |
| 当前Chat | 本计划开始时的工作树与现有测试 | 产品语义、合同、失败语义、数据库对象和用户场景预言机 | 目标TypeScript目录与框架选择 |
| 当前MAF实现 | 当前安装版、源码与已验证链路 | 逐次审批、Checkpoint/HITL、AG-UI和失败恢复的行为基线 | 目标Runtime必须继续使用MAF |

固定点如发生变化，当前批次停止扩张；先记录差异，再由用户决定继续固定旧提交还是升级研究基线。

## 5. 七个逐步审核批次

修订说明（2026-08-05）：用户要求先一次性吃透`pi + pi-web`，并同时形成AI可复用工作区与Later用户学习课程。因此，下列七批保留为原计划、历史问题清单和证据来源，不再是当前逐卡停顿顺序。RP-01.0和RP-01.1已纳入完整掌握成果；RP-01.2—RP-01.6中与Workflow直接相关的问题将在下一份Workflow架构计划中重组，不再强制先形成7张孤立决策卡。

每批只提交该批的事实、结论、未知项和下一批输入。前一批未审核，不进入依赖它的下一批。

### RP-01.0 基线与验收预言机

目标：冻结研究环境和“迁移后不能丢”的产品保证。

工作：

1. 记录pi、pi-web、Chat的Commit、Package版本、工作树状态和可运行入口。
2. 从现有Chat测试与文档提取迁移硬不变量，不把全部旧实现都列为必须复制。
3. 建立最小预言机场景：普通回答、Provider请求审批、Tool调用、HITL暂停、进程重启恢复、结果提交。
4. 为每个场景记录输入、权威状态、用户可见结果、失败分支和现有证据位置。

交付：固定版本表、Package地图、6条行为预言机和缺口清单。

完成门：任何后续技术结论都能回到固定源码或至少1条Chat产品保证；没有“感觉应该可以”的无证据结论。

### RP-01.1 pi整体心智模型

目标：先完整理解pi怎样从用户输入走到模型、Tool、Session和事件订阅者。

工作：

1. 还原组合入口、Package依赖和核心对象生命周期。
2. 沿一条无Tool回合和一条有Tool回合跟踪真实函数、输入、输出和事件顺序。
3. 区分`AgentMessage`、LLM Message、Session记录、UI事件和Chat领域对象。
4. 说明Agent、AgentHarness、Session Backend、Coding Agent与Server之间的边界。

交付：对象词典、两条源码调用链、一张Package关系图和“pi明确不拥有”清单。

完成门：第一次接触pi的开发者能复述调用链，并能指出哪些状态只活在进程或Session中。

### RP-01.2 Provider、上下文与审批可行性

目标：验证Chat能否在pi体系中继续做到“用户批准的请求等于实际发送的请求”。

工作：

1. 跟踪`pi-ai`模型目录、Provider注册、请求编译、流式传输和响应解码。
2. 验证`transformContext`、`convertToLlm`、Provider Payload Hook等修改发生的精确顺序。
3. 用确定性Provider或拦截器验证最终请求Body、Hash、修改失效和零发送拒绝。
4. 识别SDK、Provider或自动Tool loop可能发生的二次改写。

交付：Provider调用时序、最终Payload控制点、Chat治理适配方案候选和失败清单。

完成门：能够证明审批对象、Hash对象和发送对象是否可保持同一；不能证明时必须判为目标缺口。

### RP-01.3 Tool、运行控制与Session

目标：验证Agent loop与运行状态是否足以支撑受治理执行。

工作：

1. 验证Tool参数校验、`beforeToolCall`、`afterToolCall`、并行/串行、终止、异常和取消语义。
2. 验证steer、follow-up、abort、continue和事件订阅者的并发边界。
3. 对比内存、JSONL、SQLite Session后端的写入时机、分支、压缩、损坏和恢复语义。
4. 把pi Session与Product Session、Product Run、Run Attempt和Tool Execution逐项分开。

交付：Tool/控制状态机、Session能力矩阵、故障语义和需要Chat补建的Ledger/Worker责任。

完成门：明确回答进程退出前后分别能恢复什么，结果未知时是否可能盲目重放Tool。

### RP-01.4 Server、Web与进程拓扑

目标：判断pi-server和pi-web哪些能力可以采用，哪些只能参考。

工作：

1. 还原pi-server的实例、进程、Session、状态存储、启动、停止和重启链。
2. 还原pi-web从浏览器动作到服务端、Agent事件再到页面渲染的完整链路。
3. 核对多用户、认证、权限、活动Run重连、多实例、背压和事件保留是否存在。
4. 分别比较复用代码、借鉴模式和完全不采用三种方式。

交付：当前拓扑图、Web/Server采用—改造—拒绝表，以及前端/HTTP框架的选择要求。

完成门：不能把实验性Server或进程内Session冒充Chat生产Runtime；每项采用都有失败和退出方案。

### RP-01.5 六条纵向可行性实验

目标：用最小代码证明关键能力，而不是搭建目标产品。

实验：

1. `E1`：文本输入、模型流式事件和前端消费。
2. `E2`：最终Provider Payload捕获、修改、Hash、批准和拒绝零发送。
3. `E3`：Tool提议、审批、执行、结果回注和第二次模型调用。
4. `E4`：Session保存、进程退出、重新打开已完成会话。
5. `E5`：HITL暂停后重启恢复；若pi无法原生完成，记录最小缺口，不用临时代码伪装通过。
6. `E6`：pi-coding-agent执行一个隔离、无外部副作用的受控任务并返回结构化结果。

约束：优先使用已有依赖、确定性Provider、临时目录和测试替身；安装依赖、修改pi源码、真实模型或付费调用必须另行说明并获得授权。

交付：每个实验的命令、输入、事件、Store变化、结果、清理方式和通过/失败判断。

完成门：6项全部有证据，其中失败是允许结果；不得用Mock成功把未覆盖的恢复或副作用语义标为通过。

### RP-01.6 技术基线决策包

目标：把研究转成可供用户逐项审核的目标技术基线。

必须形成7张决策卡：

1. 前端框架与应用形态。
2. TypeScript HTTP服务框架和进程组合根。
3. 前后端实时协议：保留AG-UI Adapter、采用pi事件协议或其他候选。
4. 持久Workflow、HITL与Checkpoint：Chat自建边界还是申请研究一个外部组件。
5. Product Store、pi Session Store和Runtime Event Store的逻辑/物理关系。
6. pi-coding-agent与通用pi Agent的统一和隔离方式。
7. 重建仓库拓扑、旧系统冻结方式、数据/合同迁移和切换门。

每张卡必须写明：问题、全部可行选择、pi证据、Chat预言机、推荐、理由、代价、失败边界、验证方式、信心和未验证项。

完成门：用户可以逐卡批准、修改或拒绝；未批准项不能被总体架构当成稳定前提。

## 6. 研究产物与唯一职责

计划获批并执行后，产物按以下责任组织：

| 产物 | 唯一职责 |
|---|---|
| 本文 | 执行顺序、范围、审核门和完成门 |
| `docs/research/pi-native-technical-baseline.md` | Chat侧源码证据、实验和差距矩阵 |
| `agent_knowledge/project-studies/pi/` | 可跨项目复用的pi源码知识；不保存Chat产品决定 |
| `docs/pi-native-technical-decisions.md` | RP-01.6七张待审核决策卡 |
| `PROJECT_STATE.md` | 已经完成、验证和获批的事实 |
| `PROJECT_PLAN.md` | 计划状态及后续工作包顺序 |

不为每个批次创建一套重复总览；批次证据进入同一研究正文的独立章节。

## 7. 整体退出条件

RP-01原计划的退出条件如下，现保留作为历史质量参考，不再作为当前顺序的完成门：

1. 7个批次全部完成并逐批留有审核结果。
2. 6条可行性实验全部有可重复证据。
3. pi原生能力、Chat补建能力和外部候选能力已经分开。
4. 7张技术决策卡全部得到用户决定。
5. 现有MAF能力没有因“准备替换”而被误写成目标系统已具备。
6. 未创建未经批准的生产依赖、Schema、迁移或目标目录。

当前取代顺序是：`pi + pi-web`完整掌握审核 -> pi对Workflow/HITL/Checkpoint的原生支持研究审核 -> Chat利用/补足这些能力的架构取舍 -> Memory重新选型与接入设计 -> BMAD方法研究与总体架构修订。

## 8. 计划审核结果与当前审核点

2026-08-05用户批准以下4点：

1. 接受7个批次及其顺序。
2. 接受每批完成后先提交审核、再进入下一批。
3. 接受本计划期间不修改产品代码、不安装新依赖、不调用真实付费模型。
4. 接受RP-01完成后先重新审核Memory，再进入BMAD和总体架构。

2026-08-05用户已审核并批准[RP-01.0技术基线](./research/pi-native-technical-baseline.md)中的固定版本、Package地图、6条迁移行为预言机和8项缺口。同日用户修订工作方式，要求将RP-01.0/1.1作为已完成子集，连续完成`pi + pi-web`双轨完整掌握后一次性审核。该材料已获用户通过。后续一度误将“研究pi支持”写成Chat架构D1—D8，该审核已撤回；Workflow/HITL/Checkpoint的`native/partial/design-only/missing`源码支持矩阵现已完成，当前待用户审核研究是否充分。仍未授权产品代码重建、依赖安装、Schema、迁移、部署或真实付费模型调用。
