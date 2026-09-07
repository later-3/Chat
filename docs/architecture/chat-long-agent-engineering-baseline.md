# Long Agent 实施前约束、验证与场景依赖

## 1. 文档地位

2026-09-07：在[机制收口](./chat-long-agent-mechanism-contract.md)之后，用户要求先核实NanoClaw与Chat现有结构，明确代码质量、测试、场景覆盖及实施依赖，再准备工程管理与详细设计。用户已认可本基线并要求落盘；它是已确认的设计阶段输入，不是已下发业务实现任务书，也不代表授权迁移或部署。

本轮证据来自当前工作区源码与文档的静态核查。工作区包含既有未提交实现；下文“已有”表示存在代码与相应测试入口；实际验证范围见[本轮审核记录](./reviews/2026-09-07-agent-development-readiness.md)，不代表已部署。当前配置语法仍以[系统配置](../configuration.md)为准。

不再重复讨论已确认的产品方向：NanoClaw承载长期身份映射、Channel、调度与耐久通信；Chat Backend接管产品配置、Project、Pi执行和原生Chat Session；Web是Backend客户端。独立Agent、统一Chat模型、共享概览、按日Daily、业务Session连续性与并发继续成立。

## 2. 原生能力、现有接入与改造位置

| 能力 | 当前证据 | 对接方式与缺口 |
|---|---|---|
| Agent Group、Workspace、身份与Memory | Nano已有Group与目录初始化；Chat已有Profile/OKF Memory管理桥接 | 复用Group及Memory领域能力；将Chat管理的身份、Prompt等收敛到独立文件配置，Nano保留运行投影 |
| Channel、路由、Inbox、Delivery/Ack | Chat fork已有实例级chat-pi、耐久HTTP事件和反向投递 | 扩展现有版本化接口，保持真实发送者、来源、目标、关联和幂等；富消息另按Channel能力适配 |
| 原生运行时Skill | Nano已有共享容器Skill、组私有模板Skill及启动时装配 | 接入Chat统一Catalog/Resolver和Pi装配；不能依赖已关闭的原生容器启动来发现Skill |
| 安装/运维Skill、模板与Plugin | Nano支持安装配方；模板可带人格、Skill、MCP、任务 | 安装配方走维护/安装流程；模板按能力项导入统一配置，保留来源、本地修改和依赖诊断 |
| 一次性/周期任务、脚本检查、退避与暂停 | Nano已有scheduling模块及任务系列日志；Chat非Channel唤醒缺合同 | 保留可复用的时间计算、调度与通信；Chat管理定义/Project/执行，新增任务触发及执行结果合同 |
| Agent间消息与跨会话信息 | Nano已有agent-to-agent路由、目的地授权与同一对话的线程间信息传递 | 复用可信消息/目的地能力；Chat增加Project、工作/Session、参与者关系，不以Nano信箱历史替代Pi历史 |
| Docker、MCP、依赖与文件环境 | Nano原生容器机制存在；chat-pi当前明确跳过原生Session Runtime | 解耦复用环境能力，只承载授权工具/脚本/MCP/开发；不恢复Nano Provider Loop或模型配置 |
| 公共Pi装配、Workflow、CustomEntry | Chat已有统一工厂、委派子Session、Context Transform及Long Agent Turn元数据 | 在现有入口扩展资源与关系，不再实现一套Agent、消息或Workflow执行器 |
| Web配置与资源管理 | 已有Long Agent配置、Group和Memory的API与浏览器Parser | 扩展同源配置、有效资源和状态视图；当前唯一主Session与身份拆分页面需随合同迁移 |
| 共享进度、Social、长期职责与自由活动 | Chat已有Project查询/Memory等基础，完整目标链尚未接通 | 由已有Project/活动/任务/资源机制组合；Nano没有完整Chat产品语义，不能仅开启原生功能代替 |

### 2.1 可定位的源码证据

- [公共Pi装配](../../src/agents/pi-agent-session.ts)：createChatPiAgentSession、DefaultResourceLoader.reload及实际Tool注册。
- [Long Agent执行](../../src/long-agents/runtime.ts)：调用公共装配，每Turn取得Group快照，使用Session操作锁。
- [Long Agent Turn元数据](../../src/long-agents/session-turn.ts)：已有chat.long_agent_turn schemaVersion 2及兼容读取。
- [Chat Skill目录](../../src/resources/skills.ts)、[Project Skill发布](../../src/resources/project-management-skill.ts)：已有目录读取、版本信息、启动安装与用户修改保护。
- [Nano Group初始化](../../nanoclaw/src/group-init.ts)、[原生Skill装配](../../nanoclaw/src/container-runner.ts)、[模板Skill适配](../../nanoclaw/src/group-skills.ts)：共享Skill启动时链接，私有模板Skill按Provider适配。
- [Nano资源接口](../../nanoclaw/src/modules/chat-integration/agent-group-resources.ts)：当前Profile包含身份与核心Memory，没有完整Skill目录/包读取合同。
- [chat-pi唤醒](../../nanoclaw/src/modules/chat-integration/execution-driver.ts)、[恢复](../../nanoclaw/src/modules/chat-integration/recovery.ts)：无Channel待处理事件的非inbound唤醒返回失败；无messagingGroup的Session不进入当前恢复路径。
- [原生Runtime启动边界](../../nanoclaw/src/agent-execution-startup.ts)：外部执行模式返回后不初始化原生Session Runtime。
- [Nano调度](../../nanoclaw/src/modules/scheduling/create.ts)、[周期处理](../../nanoclaw/src/modules/scheduling/recurrence.ts)、[Agent路由](../../nanoclaw/src/modules/agent-to-agent/agent-route.ts)：原生可复用部分，仍需适配Chat执行与来源合同。
- [Web配置合同](../../frontend/lib/long-agents-browser.ts)、[Group/Memory合同](../../frontend/lib/long-agent-group-browser.ts)：已有运行时Parser与保存版本。

原生Skill语义以[Nano Skills Model](../../nanoclaw/docs/skills-model.md)和[模板说明](../../nanoclaw/docs/templates.md)为准。源码中的当前路径及启动条件优先于概括性目录介绍，不能认为所有原生Skill都已在groups/<folder>/skills下或在chat-pi中自动可用。

## 3. 架构与代码质量约束

完整编码要求继承[Backend规范](../development/backend.md)、[编码规范](../development/coding-standards.md)及各Submodule规则；以下是Long Agent相关的评审门槛。

| 编号 | 约束 | 必须提交的证明 |
|---|---|---|
| C1 | 所有需要模型的入口走createChatPiAgentSession；Workflow仅薄包装；Nano不直接调用另一套Provider | Web、Channel、任务与Agent消息的实际入口图及装配测试 |
| C2 | Chat文件配置是受管身份、模型、Prompt、资源、职责和任务定义的唯一写入源；Nano的受管投影不独立改写 | 每字段归属、写入API、revision、同步与失败状态；旧入口迁移方式 |
| C3 | Chat/Nano只通过窄接口协作，不跨仓库直接读取对方DB，不暴露全权限CLI Socket | Management/Resource/Event/Delivery合同及调用方向 |
| C4 | Project/Agent/Session身份由服务端绑定，路径经统一Resolver；工作归属固定，共享概览不扩大详情/执行权限 | 正确目标、伪造目标、失效绑定和路径边界测试 |
| C5 | Pi保存原生消息，CustomEntry保存版本化关系/状态及消息引用；展示和上下文转换与持久事实分开 | 原始JSONL、有效模型输入与Web读模型三者对照 |
| C6 | Frontend、管理Tool与执行使用同一领域解析；不在页面维护另一份Skill/Tool清单或配置继承 | HTTP运行时校验、有效配置预览与实际执行版本对照 |
| C7 | 网络、文件、插件和持久化入口从unknown做运行时校验；状态用明确类型，错误不吞掉 | 成功/非法结构/版本冲突/部分失败的公共接口测试 |
| C8 | 并发控制落到Session和实际冲突资源；写入原子化或有冲突保护；等待可恢复且不占住整个Agent | 同Agent独立工作并行、共享写冲突、互相追问和重启测试 |
| C9 | Nano改动集中在现有接缝及窄适配；新业务用配置、Skill、Tool、Workflow和领域模块接入 | 改动点清单及每个接入点的回归测试；不设空泛代码行数指标 |
| C10 | 文档、配置Schema、迁移、实际运行与Web合同同一交付完成；旧数据保留稳定身份和来源 | 迁移重试/恢复、前后版本兼容及对应文档 |

模块应先说明所属领域、输入输出、状态所有权与失败方式，再选择目录。复用代码不等于复制实现；当原生实现依赖另一套Session/Provider或容器生命周期时，抽取适配点，不把它连同运行时一起搬回Chat。

新增工具、原生Skill接入与模板导入都应检查最终注册的Tool和模型协议Schema；资源声明或TypeScript类型通过不代表模型能调用。保持有限输入、明确错误、来源及实际执行证据，沿用已有系统Tool注册与审计路径。

## 4. Skill合同：来源、发现、选择、生效

### 4.1 先区分来源及用途

| 来源/用途 | 当前来源示例 | 目标接入 |
|---|---|---|
| Chat公共运行时Skill | `<CHAT_HOME>/agent/skills`；产品发布的project-management | 共享资源来源，保留产品/用户所有权及版本 |
| Project运行时Skill | 当前Project的.chat/skills | 当前项目或显式授权来源，不递归扫描父/子项目 |
| Agent自有运行时Skill | 目标独立Agent根的skills | 按稳定longAgentId管理，经过同一Catalog及Pi装配 |
| Nano共享运行时Skill | nanoclaw/container/skills，原生启动时按选择链接 | 通过来源适配和完整包读取进入Chat；保留来源，不伪装为用户私有资源 |
| Nano模板/Plugin运行时Skill | 原生私有模板store、groups/<folder>/plugins及关联文件 | 导入/解析为Agent拥有或引用的资源；迁移后只有一个可写事实位置 |
| Nano安装、Provider或运维配方 | add-channel、add-provider、setup等Skill | 维护能力，不自动作为运行时Skill执行；chat-pi不启用原生Provider |

“应用”可能包含Skill、MCP、模板、任务或安装动作，详细设计须按组成项分类。目录名或SKILL.md存在不能代替兼容性判断；依赖原生ncl、特定Provider、/app路径或容器工具的技能须显式适配，不承诺所有Nano技能原样可用。

Skill包必须保留正文、references、脚本和相对资源关系。包版本应覆盖执行/读取所需文件；不能只复制SKILL.md后让引用失效。宿主路径、容器路径与逻辑资源地址分开，Agent通过目录和Tool查询，不靠猜测~/.pi、~/.claude或数据目录。

### 4.2 管理状态必须可解释

统一表达：可发现 → 已选择 → 依赖/权限可用 → 已装配到本轮 → 实际读取/调用。未选择、缺Tool、依赖缺失、运行位置不支持、版本冲突和已停用都应给出原因。Skill“装配成功”不意味着它在每次任务中必然被模型选用。

资源身份包含Owner/来源、稳定ID与revision。同名资源不按扫描顺序覆盖；既有覆盖行为需明确适配或迁移。检查页与执行要使用相同解析器和相同版本。资源管理权限与任务执行能力分别表达。

### 4.3 中途新增或更新的默认合同（待实施）

1. 保存/安装完成后更新Catalog版本；文件外部变更通过扫描或变更检测在下一次解析被发现。Watcher是及时刷新优化，不能是唯一正确性来源。
2. **默认下一轮生效**：已有Session无需重建身份或清空历史，下一轮重新解析。inherit在已授权来源按原策略纳入新运行时Skill；explicit仍只装配所选资源，新条目可以查询但不静默启用。
3. 公共管理知识作为可审查的产品基础资源保持可发现；它只提供管理入口，不借此启用未选业务能力。新增可执行Tool、依赖或权限继续按现有策略处理。
4. 在途执行保持冻结的资源内容版本，不能仅保留路径然后读到被替换的新正文。需要立即采用新版时，进入明确的安全执行边界重新装配，保留原Session和操作记录。
5. 已撤回权限在后续动作执行时重新校验；旧快照不是继续越权的授权。删除资源要处理在途引用与后续缺失，不损坏既有执行证据。
6. 空闲Agent不因普通Skill新增就必须调用模型“学习”；再次交互/唤醒可发现更新。UI或受控事件可提示能力变化。

当前公共工厂每次创建时调用ResourceLoader.reload，提供下一轮刷新的复用点；当前实现尚不满足上述完整的Agent私有/Nano来源、包版本固定与状态解释合同。安装、目录刷新、显式选择与实际使用须分别验收。

## 5. Session定制复用已有方式

优先使用现有SessionManager、CustomEntry、Context Transform和Session读模型。当前Workflow已记录调用/子Session/真实委派来源；Long Agent已有chat.long_agent_turn。新增关联字段先扩展这些所属领域的版本化元数据，不先修改Pi文件格式。

详细设计必须给出三个对照用例：

1. 用户与同一Agent在Web/微信续接：原始消息只有对应事实，入口与来源可追踪。
2. A向B请教，B向A澄清：双方工作与消息关系可追踪；A仍能回应用户，不因等待锁死。
3. 用户与多个Agent共同讨论：真实参与者身份可显示；其他Agent的内容进入当前模型时通过合法上下文投影，不回写篡改持久角色。

CustomEntry不承载真实发言的唯一正文。Pi协议角色与真实发起者身份不能混为一谈，已有子Workflow的委派来源是参考；多方投影需要按[Session架构](./chat-session-architecture.md)验证消息/工具调用配对、分支、压缩、恢复与导出。新元数据需声明版本、旧格式读取、缺失/未知版本处理及索引重建，不只增加写入函数。

## 6. 调度对接的已认可方向与待细化责任

建议保持Nano的时间计算、唤醒与耐久投递能力；Chat负责任务/职责定义、Project解析、执行与产品Run。三类通信分别定义，避免用Channel文本伪装定时或Agent事件：

- 定义管理：Chat保存revision，Nano应用调度投影并报告状态；CLI或模板不能独立修改Chat受管定义。
- 到期/事件：Nano提交带稳定任务/发生次序身份的事件；Chat耐久接收后才确认，重发仍对应同一次工作。
- 结果反馈：Chat保存执行结果，将调度需要的结果反馈Nano；下一次安排及暂停/退避的唯一负责方必须明确。

HTTP投递重试、工作执行重试、下次周期和对用户通知重试分别处理。不能让双方各自重跑同一次任务。前置脚本经授权环境执行；Chat已接收事件不等于脚本、模型或Delivery已完成。

具体状态机、发生次序标识、反馈失败恢复，以及原生任务模型中可直接保留的字段，需由技术方案确定。采用窄接口适配即可，不预设新增消息中间件或第二个调度服务。这个边界是需在设计前评审的重点。

## 7. 基础场景的实施依赖

以下是能力依赖和验收顺序，不是团队排期或已下发任务。每步均须包含对应配置、API/Tool、实际入口、Web投影和文档；UI在每步同步交付，不能最后补齐。

| 编号 | 先实现并证明的基础场景 | 依赖 | 后续复用 |
|---|---|---|---|
| B0 | 固定当前回归基线；明确受管字段迁移、资源包/路径合同、消息投影、异步等待和调度责任 | 现有源码与本文件 | 避免后面同时改错边界；高风险接缝先有验证方案 |
| B1 | 先跑通一个Agent的自有配置与对话，再用同一入口创建第二个，验证共用Chat模型目录且Daily独立；Web与Channel一致 | B0 | 所有后续场景的身份、权限、装配与配置基础 |
| B2 | 接入一个Chat Skill和一个Nano运行时Skill；新增、更新、选择、缺依赖可见，并证明实际读取/调用 | B1 | 所有技能、工具、模板及自我管理 |
| B3 | 道德经与另一Project切换、隔天继续；Coder能查共享概览；同Agent独立Session可并行 | B1、B2 | 学习、项目工作、历史、日记和跨入口连续性 |
| B4a | Skill调用脚本/工具在Docker中执行，输入与产物可定位；独立工作环境隔离 | B1、B2 | 开发、素材处理、MCP与脚本检查；可与B3并行建设 |
| B4b | 一个确定性提醒、一次需要模型的到期工作、一个事件触发，各自正确归属与恢复 | B1、B3 | 定时任务、订阅、长期职责的推进机会；不依赖完整业务流程 |
| B5a | 旅游检查无变化不唤醒模型，有变化分析并通知；按活动生成日记，Social更新触发可见订阅 | B3、B4b；脚本检查另依赖B4a | 监控、共享动态、日记和后续内容事件 |
| B5b | A请教B、B澄清、用户同时问A；用户进入共同讨论；晚到结果与取消范围正确 | B3、B4b的可信事件/等待合同 | 多Agent讨论、分工、审核与社交；可与B5a并行建设 |
| B6 | Ziji开发审核、Content Lab持续运营、自由活动，用已完成机制组合 | B2～B5中各业务实际需要的部分 | 验证新增业务主要落在配置/资源/Workflow，而非核心改造 |

多Agent共同消息投影与等待是高风险接缝，应在B0先审合同与最小验证方案，不能直到B5b才发现Pi上下文无法表达。两Agent隔离从B1就验；并发与可恢复状态不是最后的性能优化。

Content Lab单Agent持续工作不必等待完整多方UI；需要协作时再依赖B5b。纯文本自由阅读不依赖Docker脚本，也不必等待内容运营。表中依赖指实际能力，不人为制造所有功能完全串行的大版本。

## 8. 测试与场景覆盖要求

### 8.1 测试层级

| 层级 | 证明内容 | 关键方式 |
|---|---|---|
| T1 领域与合同 | 配置/资源/消息Schema、revision、路径、状态转换和兼容 | 测公共边界；使用临时CHAT_HOME和项目，不依赖真实用户数据 |
| T2 实际Pi装配 | 生效模型/Prompt/Skill/Tool、原生消息和CustomEntry、冻结版本 | 本地假模型记录收到的输入并触发真实Tool；断言结果及Session证据 |
| T3 Chat↔Nano桥接 | 双方Parser、鉴权、接收后崩溃、重发、结果/投递反馈 | 真实HTTP合同与隔离Nano数据；不能双方都只用同一个手写stub假装兼容 |
| T4 构建与用户入口 | 生产/Nitro开发链、实际页面编辑、刷新、续聊与等待状态 | 父仓库verify及适用Frontend浏览器路径；API测试不代替页面路径 |
| T5 环境与长流程 | Docker输入产物、并发资源、跨日、重启、多个入口和组合业务 | 可控时钟、故障注入、持久状态恢复；必要真实容器测试 |

自动化模型与外部服务默认使用可控替身，不产生费用或外部副作用。模拟的是外部依赖，不能把被验证的装配、持久化、桥接或工具本身全部mock掉。模型“答应会使用技能”不算生效证据；必须观察读取、调用和结果。

### 8.2 每个实现必须覆盖的组合

按改动适用范围选择测试，至少把以下高风险边界分配到具体用例，不做所有维度的机械笛卡尔积：

| 边界 | 最小需要证明的行为 |
|---|---|
| 多身份与Project | 两Agent各自Daily/资源隔离；共享概览可读；完整详情和写操作仍按范围处理 |
| 能力变化 | 新增/更新/移除、inherit/explicit、缺Tool/脚本、同名冲突；运行中改版与下一轮生效 |
| 消息与Session | 原生发言、CustomEntry关系、压缩/恢复、跨Channel续接、按日轮换及业务跨日 |
| 并发与等待 | 独立任务并行、共享写冲突、同Session有序、A等待B时仍可处理澄清和用户消息 |
| 失败恢复 | 接收前后崩溃、重复触发、旧revision、结果不确定、投递失败单独重试 |
| 运行边界 | chat-pi不启动原生模型Runtime；Docker缺失不回退无边界宿主执行 |
| 前端事实 | 查看、编辑、冲突保留草稿、刷新/重连后同源恢复；显示实际生效与待应用差异 |
| 扩展性 | 至少加入一个不在原演练里的普通业务需求，记录其E1～E4接入级别和是否改核心 |

基础验收编号继续使用[LA-S/LA-X](./chat-long-agent-scenarios.md)，共享认知与自主工作的草案使用[LA-A](./chat-long-agent-awareness-and-autonomy.md)。新增用例需映射到机制K1～K6、约束C1～C10、基础场景B和对应入口；不能仅以测试数量或行覆盖率宣称架构成立。

70%～80%衡量普通新需求通过配置/资源/适配接入的比例；已支持主干及数据/隔离/恢复约束不能因此只要求70%的通过率。

### 8.3 现有命令与缺口

父仓库当前package.json的verify包含Backend/Frontend测试、类型检查、生产构建、built服务和Nitro开发链；**不包含NanoClaw自身完整测试**。涉及Nano源码还须按其仓库运行Host测试与构建；涉及原生容器代码时按其规则追加对应检查。不能以父仓库绿灯代替Nano桥接或真实Docker验证。

实际命令以[测试指南](../testing.md)、[Nano规则](../../nanoclaw/AGENTS.md)和[Frontend规则](../../frontend/AGENTS.md)为准。Workflow/公共装配/可达资源修改必须覆盖Builder转换、开发Step bundle、生产与实际Runtime；使用既有pnpm test:dev门禁，不另造相邻链路替代。

本轮只检查文档和证据位置，不执行上述产品验收。后续技术方案应把尚缺的跨进程/浏览器/容器门禁写清楚，不能把计划中的测试称为已有测试。

## 9. 已认可的设计输入与待细化合同

总体架构已清晰；以下是接口与演进策略，不需要重新讨论全部业务：

| 决策 | 已认可基线 | 技术方案须细化的边界 |
|---|---|---|
| D1 Nano生态的接入范围 | 保留原生Host/Channel/调度/Memory与可用Skill/模板，统一Chat配置和Pi装配 | 运行时兼容优先；安装配方和原生Provider不当作直接运行时能力 |
| D2 Skill动态生效 | 自动发现，按inherit/explicit选择；默认下一轮生效，在途保持版本 | 是否确有必须在同一未结束Turn强制热切换的业务；当前场景无此必要 |
| D3 调度责任 | Nano产生到期事件，Chat管理定义和Run执行，通过结果反馈维护调度投影 | 具体退避/下一次时间/补跑由谁写，不能双写双重试 |
| D4 Session扩展 | 复用CustomEntry、原生消息、Context Transform与读模型 | 多方真实身份及工具配对的具体投影需最小证据，不能直接把全部Agent消息当用户 |
| D5 配置/目录迁移 | 保留Agent/Group/Project/Session ID，受管字段只有一份可写定义 | Nano资源服务对新根的寻址/可访问合同，以及旧入口关闭写入顺序 |
| D6 交付粒度 | 按基础场景分批贯通，每批有配置、Tool、运行、Web与验证 | 不按“后端先全做完、前端以后补”的方式验收 |

2026-09-07 用户认可以上机制与工程方向。D2采用下一轮生效的默认合同；D3的写入/重试归属、D4的消息投影和D5的迁移接口仍须技术方案与验证证据。认可方向不等于认可尚未提出的Schema、算法或实现。

## 10. 后续工程动作的前置输入

本基线已收口；沿用[Agent贡献工作方法](../development/agent-contribution.md)形成决策记录、需求/约束/测试对应表、分批任务书和验收证据。每份技术方案至少提交：现有复用点、状态/字段所有权、接口与Schema、路径/资源版本、消息投影、失败/并发/迁移、Web合同、场景测试及依赖。

架构师审核边界和证据，执行Agent提出具体方案并实施。未定的消息/调度接缝先完成设计证明；已明确模块可按依赖准备，不因低优先级展示细节阻塞全部设计。本轮不创建项目管理条目、不分派实现、不修改生产配置。
