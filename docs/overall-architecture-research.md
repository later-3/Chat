# 总体架构研究与证据记录

> 状态：`研究完成，供总体架构候选审核`
> 日期：2026-07-21
> 范围：总体架构风格、前后端边界、产品模块、MAF运行时位置、状态所有权、运行与恢复演进。
> 不包含：数据库表字段、API路径、类名、队列产品选型和详细部署参数。

## 1. 结论摘要

本项目的目标架构不应是“React聊天页直接连MAF”，也不应从第一天拆微服务。研究后建议：

> 采用**领域模块化单体 + 可分离的Run Executor/Worker + REST产品资源API + AG-UI实时Agent协议 + Product DB与MAF运行状态逻辑分离**。

4个参考源已经足够支持总体架构判断，不需要再增加开源参考项目：

1. **MAF**回答Agent、Context、History、Middleware、Tool、Workflow、Checkpoint、HITL、AG-UI和Telemetry如何承载。
2. **pi**回答底层Agent Core、产品协调层、运行模式、Session、Tool和组合根如何分开，并给出大协调器膨胀的现实代价。
3. **nanobot**回答Channel、MessageBus、AgentLoop、AgentRunner、Session、Memory、Goal、Gateway和长期运行如何分工，同时暴露身份、durable ingress、outbox和副作用恢复缺口。
4. **LibreChat**回答Web App Shell、Feature Route、产品查询、产品资源API、Agent入口、Generation Job、Event Transport和产品提交门如何分层。

Intent、Work、ExecutionDraft、Approval、Evidence和Delivery的完整领域语义在参考项目中没有现成答案。它们不是研究遗漏，而是本项目6个产品问题直接要求的差异化能力；本次只确定模块所有者，详细模型仍需后续审核。

## 2. 研究问题

本轮用7个问题约束研究，避免按仓库目录拼架构：

1. 用户重开会话和说“继续”时，谁拥有长期事实和上下文装配？
2. 意图、计划、待办、执行和结果跨回合推进时，哪些产品模块负责？
3. 用户批准前如何阻止执行，批准后如何绑定正确版本？
4. MAF应该直接面对Route和数据库，还是被产品应用层封装？
5. REST、AG-UI、Product DB、MAF Session/Checkpoint和浏览器状态各自负责什么？
6. 浏览器断连、API重启、Worker退出、Tool副作用未知和Workflow恢复如何逐步演进？
7. 在本地优先、单用户、早期项目中，如何保留未来可靠性而不提前承担微服务成本？

## 3. 研究过程与版本证据

### 3.1 固定来源

| 来源 | 本地路径 | 固定版本或提交 | 本轮用途 |
|---|---|---|---|
| Chat项目 | `/Users/xulater/Code/Chat` | 当前工作树；候选文档尚未提交 | 产品问题、闭环、技术约束和Session全集 |
| MAF安装版 | Chat项目`.venv`与`uv.lock` | core `1.11.0`；openai `1.10.1`；ag-ui `1.0.0rc8` | 当前真实依赖边界 |
| MAF源码 | `/Users/xulater/Code/opc-os/agent-framework` | `9c4cd07899502157284b64a73f9a0adfb4594d96` | 总体运行时能力和源码证据 |
| pi | `/Users/xulater/Code/opc-os/pi` | `2b00dade7cec918aefb025c8b7a4fa304a30acdd` | Agent Core、产品层、组合根、Session与模式 |
| nanobot | `/Users/xulater/Code/opc-os/nanobot` | `2c789767280482f38667044f8a3be5102c71dd26` | 通道、Loop/Runner、长期状态和可靠性边界 |
| LibreChat | `/Users/xulater/Code/opc-os/LibreChat` | `8e5ef1fb31e9d63b735c089b21cbc82c50acce46` | Web产品、资源API、活动运行与流恢复 |

### 3.2 执行过程

| 步骤 | 动作 | 结果 | 记录位置 |
|---|---|---|---|
| 1 | 读取本项目`AGENTS.md`、Context、Plan、State、Session能力全集和路线 | 固定6个问题、产品闭环、4类ID对象和R0-R6恢复目标 | 本文第4节 |
| 2 | 审计现有pi、nanobot、LibreChat和MAF知识是否覆盖总体架构 | pi/nanobot已足够；MAF总体位置和LibreChat Web分层存在缺口 | 本文第5节 |
| 3 | 核对MAF安装版本与本地源码提交 | 发现3个安装包版本不完全相同；具体行为仍需安装版合同测试 | `agent_knowledge/MAF/02-*` |
| 4 | 定向阅读MAF官方仓库功能文档以及Agent、Session、Middleware、Workflow、AG-UI、Durable Task与Observability源码 | 确定MAF是Runtime，不是产品应用层；Durable Task可由多种兼容宿主承载，但仍只是可选运行基础设施 | `agent_knowledge/MAF/02-*` |
| 5 | 复核pi整体五包、Coding Agent组合根、AgentSession和Orchestrator恢复 | 确定共享核心、薄入口和协调器边界；识别God coordinator风险 | 本文第6节 |
| 6 | 复核nanobot九层心智模型和OPS-OS宿主专项 | 确定Channel/Loop/Runner/Session/Memory/Delivery分工及身份、outbox、Tool ledger缺口 | 本文第7节 |
| 7 | 定向阅读LibreChat App/Router/Data Provider/Server/Agent Route/Generation Job | 补齐Web前端、产品API与活动运行基础设施分层 | `agent_knowledge/project-studies/librechat/Web-Chat*` |
| 8 | 按“采用、改造、拒绝”交叉推导架构 | 得到模块化单体、状态所有权、协议拆分和Worker演进建议 | 本文第9至11节 |

### 3.3 证据等级

本文使用4种标签：

1. `[项目事实]`：已经写入并批准的项目定义或技术路线。
2. `[源码事实]`：固定提交中可定位的实现、类型、测试或本地版本信息。
3. `[参考评价]`：从源码结构和失败行为得到的工程评价，不代表参考项目官方承诺。
4. `[项目推导]`：结合6个产品问题形成的候选设计，必须经用户审核。

## 4. 从用户场景反推必须存在的架构保证

| 用户问题或场景 | 不能只靠什么 | 必须存在的架构保证 | 建议所有者 |
|---|---|---|---|
| Prompt、回答和结论困在单次会话 | 浏览器Message数组 | 服务端Product Session、Message树和生命周期 | Conversation模块 + Product DB |
| 用户说“继续刚才那个” | 把全部历史重新发给模型 | Work状态、活动上下文路径、ContextPackage和唯一历史装配器 | Work + Context模块 |
| 意图、计划、待办和结果断裂 | 一段Assistant文本 | 分开的Intent、WorkItem、TaskPlan、ActionItem和状态转换 | Understanding + Work模块 |
| 用户没看清请求就开始执行 | Prompt中的一句“请确认” | 版本化ExecutionDraft、Approval、Hash、权限和执行门 | Execution Governance模块 |
| 模型建议被当成正式事实 | 自动写Memory或Todo | Candidate → Accepted/Rejected/Corrected状态门 | Knowledge + Work模块 |
| 失败、重启和来源删除后无法解释 | 普通日志或AG-UI Snapshot | Run/Attempt、Checkpoint、Evidence、Provenance、Trace和对账 | Run + Outcome模块 |
| 浏览器断线但后台仍运行 | HTTP连接生命周期 | Runtime Job、事件游标、独立订阅和产品事实回退 | Run Runtime模块 |
| 模型完成但用户没收到 | Run成功状态 | Product commit与Delivery/Outbox分别记录 | Outcome/Delivery模块 |

这张表是架构模块的主要来源。参考项目用于验证边界和代价，不替代产品需求。

## 5. 参考覆盖审计

| 主题 | MAF | pi | nanobot | LibreChat | 覆盖判断 |
|---|---|---|---|---|---|
| Agent/模型/工具循环 | 强 | 强 | 强 | 部分 | 足够 |
| Context与运行历史 | 强 | 强 | 强 | 部分 | 足够 |
| Workflow/Checkpoint/HITL | 强 | 弱/部分 | 部分 | 部分，非MAF | 足够确定边界，具体接合待实测 |
| Web App Shell与产品查询 | 不涉及 | 不涉及Web | 部分WebUI | 强 | 本轮补齐后足够 |
| 产品Conversation/Message | 不负责 | Coding Session | Session | 强 | 足够 |
| Product Run与活动Job分层 | 不负责产品Run | 部分 | 部分 | Generation Job强、长期Run缺 | 足够推导自建Product Run |
| Channel与长期进程 | 不涉及产品Channel | RPC模式 | 强 | Web入口 | 足够 |
| 身份、权限和Scope | 只提供钩子 | trust部分 | 明确缺口 | Web权限部分 | 足够证明必须由应用拥有，不足以照搬实现 |
| Intent/Work/Plan | 不负责 | 部分计划/队列 | Goal部分 | Project部分 | 不足以给出详细领域模型；总体模块来自项目需求 |
| ExecutionDraft/产品Approval | Tool/HITL机制 | Extension/工具机制 | 局部权限 | HITL部分 | 不足以给出产品模型；可确定框架机制与产品事实分开 |
| Evidence/Delivery/Provenance | Telemetry部分 | 输出/事件部分 | 明确指出outbox缺口 | Message/Stream部分 | 不足以照搬，足够证明需独立产品模块 |
| 微服务与规模化部署 | Durable Task兼容宿主可选 | 本地进程/RPC | Gateway | Redis/多实例部分 | 足够判断当前不应先拆微服务 |

结论：**总体架构知识已足够；详细领域设计知识仍有缺口。** 当前不增加外部参考项目，原因是：

1. 现在只审核模块所有权和依赖方向，不审核Intent/Work/Evidence字段和状态机。
2. 增加大型项目会显著扩大研究成本，却不会改变“这些事实必须由本项目产品层拥有”的结论。
3. 进入对应详细设计时，如果现有来源仍不足，应先向用户提交新候选项目、预期只参考的主题和成本，再决定是否加入。

## 6. pi给出的架构经验

### 6.1 源码和既有研究事实

pi按职责拆为`pi-ai`、`pi-agent-core`、`pi-tui`、`pi-coding-agent`和实验性`pi-orchestrator`：

1. `pi-ai`统一Provider和协议，不知道Coding产品。
2. `pi-agent-core`拥有Agent状态、模型-Tool循环、事件、steering/follow-up，不知道UI和产品Session细节。
3. `pi-coding-agent`是产品组合与协调层，装配Settings、Resource、Session、Tool和运行模式。
4. Interactive、Print、JSON和RPC共享同一个AgentSession，而不是复制4套核心。
5. `main()`承担组合根，入口只决定模式和连接组件。
6. Orchestrator通过RPC公共合同管理子进程；重启时把遗留运行记录降级为stopped，并不虚构自动恢复。

### 6.2 对本项目的采用

1. 前端、REST、AG-UI和未来Channel入口应共享同一后端应用核心，不各自实现Session或Run规则。
2. Provider/模型抽象、Agent loop和产品Session/Work必须分层。
3. 项目需要明确组合根，统一创建配置、Repository、MAF Agent、Tool、Workflow和接口Adapter。
4. Tool并发策略要按风险和顺序约束，不默认所有Tool并行。
5. 进程记录存在不等于计算可恢复；恢复能力必须按安全点逐级验收。

### 6.3 不照搬与代价

pi的`AgentSession`超过3,000行，同时协调事件、持久化、模型、资源、Tool、命令、分支、压缩和Extension。它的收益是所有模式共享一致产品行为；代价是变化原因过多。

本项目因此需要一个Run/Interaction协调器，但要限制它只做用例编排和事务边界。Conversation、Work、Approval、Run、Memory和Evidence规则留在各自模块，不能形成新的“万能SessionService”。

## 7. nanobot给出的架构经验

### 7.1 源码和既有研究事实

nanobot把一个Turn拆为：

```text
Channel / WebUI / API
-> MessageBus
-> AgentLoop（Session、锁、Context、Turn生命周期）
-> AgentRunner（模型与Tool循环）
-> OutboundMessage / Channel
```

Session、Memory、Goal/Cron/Trigger和Gateway分别处理不同时间尺度。现有研究还明确指出：

1. Session key用于隔离和锁，不是规范身份。
2. Session保存不等于消息送达；MessageBus没有durable ack，Channel retry也不是Outbox。
3. Checkpoint可标记未知Tool，但不保证外部副作用exactly-once。
4. Gateway长驻不等于可靠任务队列或多副本容灾。
5. 能插入Channel、Tool、Skill或MCP不等于已有版本化ABI、权限声明和来源信任。

### 7.2 对本项目的采用

1. Channel适配、应用Turn/Run协调、MAF Runner和Delivery必须分层。
2. Session、Memory和Work/Goal不能合并；它们的生命周期和事实确认门不同。
3. 规范Principal/Scope、Channel Binding和Session ID必须分开。
4. Tool Execution Ledger、Outbox/Receipt和Worker Lease是高级恢复阶段的独立能力，不能靠Checkpoint补齐。
5. 一个Python进程可以承载多层；逻辑分层不等于立刻拆进程。

### 7.3 不照搬与代价

nanobot的MessageBus适合轻量解耦，但在没有durable ingress、ack和outbox时不能承担产品级可靠消息。目标项目第一版不需要为了“看起来解耦”而引入通用进程内总线；应用用例可以直接调用模块，只有需要跨事务/进程的动作才写Outbox或Runtime Job。

## 8. LibreChat给出的架构经验

本轮定向补充后的事实是：

1. App、Router、Root Shell和ChatRoute分层；Chat只是多个产品Feature之一。
2. React Query和Data Provider承担产品资源查询、缓存和合同，页面Store不应成为服务端事实源。
3. Server组合根挂载Conversation、Message、Search、Project、File、Memory、Agent等独立Route。
4. Agent Chat Route先经过resume上下文、PII、moderation、Agent/资源/Conversation访问和Endpoint装配。
5. Resumable Controller把接纳HTTP请求、活动Generation和SSE订阅拆成不同生命周期。
6. Job Store与Event Transport有内存和Redis实现，说明活动运行基础设施可以替换。
7. 正常路径先保存Product Message，再检查Job所有权并发送Final。

采用的是“前端Feature + 产品API + 活动运行”分层；不采用其MongoDB/Redis/Express技术选型、旧JS/新TS双后端历史结构、多套前端状态和多类ID复用。

完整过程和证据已同步到：

`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/librechat/Web-Chat整体架构与模块边界源码研究.md`

## 9. MAF给出的架构位置

本轮新增MAF总体研究确认：

1. `Agent`组合模型Client、Tool、Context Provider、Middleware和Telemetry。
2. `AgentSession`与`HistoryProvider`负责运行时会话和模型历史，不包含产品生命周期。
3. Agent/Chat/Function Middleware适合运行策略、Trace采集和Tool防线，不应独占产品规则。
4. Tool Approval与AG-UI interrupt/resume提供交互机制，产品Approval仍需持久事实。
5. Workflow Checkpoint保存图和Executor状态，但不证明Tool副作用、产品终态或Delivery。
6. AG-UI包提供Agent/Workflow、FastAPI、SSE、Snapshot和resume适配；源码明确Thread ID不是授权边界。
7. Durable Task扩展支持Console、Azure Functions和其他兼容宿主，但需要独立Task Hub/Worker与持久化，仍只是未来Worker宿主候选之一。

因此MAF放在**Runtime Adapter**后面。Route和领域模块不能直接把MAF Session或事件当成产品事实。

完整过程和证据已同步到：

`/Users/xulater/Code/opc-os/agent_knowledge/MAF/02-Agent应用架构中的位置与边界.md`

## 10. 跨项目采用、改造与拒绝

### 10.1 采用

1. 共享一个产品应用核心，多个入口只做适配。依据：pi多模式、nanobot多入口、LibreChat多Route。
2. Agent Runtime与产品领域分开。依据：MAF边界、pi Core/Product分层、LibreChat Product/Generation分层。
3. Product Session、运行历史、活动Job、协议Thread和Product Run分开。依据：4个来源共同结论。
4. 先提交产品事实，再发布成功终态。依据：LibreChat正常路径；本项目一致性目标。
5. Session/Memory/Work/Delivery分开。依据：nanobot状态时间尺度与其可靠性反例。
6. 用组合根装配Repository、MAF、Tool、Policy和Interface。依据：pi `main()`和LibreChat Server入口。
7. 后台执行通过端口可分离，先同进程，后独立Worker。依据：pi RPC/Orchestrator、LibreChat Job Store、MAF Durable Task可选性。

### 10.2 改造后采用

1. LibreChat共享Data Provider改成Python OpenAPI/Schema合同与AG-UI标准类型。
2. pi的AgentSession协调中心改成多个领域模块上的薄Application Coordinator。
3. nanobot MessageBus只保留“入口与执行解耦”原则；跨事务时使用明确Outbox/Job，不先建万能总线。
4. MAF Tool Approval改成“产品Approval事实 + MAF运行时中断”的双层模型。
5. 活动流Job从Redis实现抽象成端口；初期实现不预设Redis。

### 10.3 拒绝

1. React组件或浏览器Store拥有权威Session历史。
2. FastAPI Route直接修改领域表或把MAF结束事件当产品成功。
3. 一个`SessionService`吞并Context、Work、Run、Memory和Delivery。
4. AG-UI Thread、MAF Session、Product Session和Run ID长期混用。
5. 只靠日志提供Trace，或为了Trace从第一版采用全量Event Sourcing。
6. 从第一天拆微服务、Redis、Kafka或云Durable Runtime。
7. 把Checkpoint解释为Tool副作用exactly-once或用户已经收到结果。

## 11. 候选架构的推导链

```text
6个产品问题
-> 需要长期产品事实、执行门、候选门、恢复和交付证据
-> 产品模块必须独立于MAF与浏览器
-> REST负责产品资源，AG-UI负责实时Agent Run
-> MAF作为可替换Runtime Adapter
-> Product DB、MAF Store、Runtime Job/Event、Browser Projection逻辑分层
-> 早期强事务需求高、规模和团队尚小
-> 选择领域模块化单体
-> 为断线、Worker和Workflow阶段预留Executor/Store端口
-> 需求出现后再抽独立Worker，不先拆微服务
```

具体候选、模块和用户场景见[总体架构候选](./overall-architecture-proposal.md)。

## 12. 当前未知与后续验证

1. MAF当前安装版与本地源码提交存在版本错位，所有具体API和事件顺序要有安装版合同测试。
2. MAF AG-UI当前RC与持久Workflow Checkpoint的完整resume接合尚未通过跨重启E2E。
3. Product commit gate如何包住MAF标准AG-UI成功终态，需要在详细设计中比较薄包装、扩展点和版本升级3种方式。
4. SQLite在活动事件、产品写入和未来Worker并发下的边界尚未压测；本次不预设何时迁PostgreSQL。
5. OPC-OS Chat上位系统的正式Channel/Identity/Permission合同尚未定义。
6. Intent、Work、Approval、Evidence和Delivery的详细聚合、状态机和事务仍待分模块设计。
7. Tool外部副作用没有通用exactly-once方案；后续必须按Tool能力分类。

这些未知项不阻止总体模块审核，但禁止把候选写成已实现保证。
