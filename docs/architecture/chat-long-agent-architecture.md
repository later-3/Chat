# Chat Long Agent 架构

## 1. 状态与文档职责

状态：2026-09-07 已确认的目标架构，等待实施。本文定义运行、数据与恢复机制；配置能力以[定义与配置模型](./chat-long-agent-capability-model.md)为准，使用要求以[场景与验收](./chat-long-agent-scenarios.md)为准。

[当前集成基线](./chat-nanoclaw-pi-integration.md)保留旧接口与实现证据，[实施状态](./chat-long-agent-roadmap.md)明确差距。不能把目标目录、Daily 轮换、历史 Tool、定时执行或 Docker 写成已经可用。

新增场景按[机制与扩展合同](./chat-long-agent-mechanism-contract.md)归类：工作意图与触发来源分开，业务通过配置、资源、Workflow和适配接入；只有核心归属、生命周期或信任边界改变时升级架构评审。

## 2. 系统边界

~~~mermaid
flowchart TD
  Web[Chat Web] --> Backend[Chat Backend：配置、Project、Session、执行协调]
  Channel[微信 / Telegram / 其他 Channel] --> Nano[NanoClaw：身份映射、路由、调度、耐久消息、投递]
  Nano --> Backend
  Backend --> Assembly[公共 Agent 装配]
  Assembly --> Pi[Pi AgentSession]
  Pi --> Service[受控配置 / Project / Memory / Workflow Tool]
  Pi --> Sandbox[Docker：文件、命令、脚本、MCP、开发环境]
  Pi --> Sessions[Project 下的 Pi Session]
  Sessions --> Activity[活动索引、历史入口与日记视图]
  Backend --> Nano
~~~

Chat 统一管理产品配置、Project、会话选择、Pi 执行和前端合同。NanoClaw 保留长期身份映射、Channel、调度触发、Inbox、Destination、投递与生态能力。Docker 是受管执行环境，不能恢复另一套 NanoClaw AgentProvider Loop、模型配置和会话事实。

默认一个 Host 对应多个 Long Agent；Agent Group 表示一个长期身份，不是 Team。多个实例只用于明确的机器、信任域或故障边界。Docker 环境管理的具体承载模块与窄 API 是实施设计项，必须与已禁用的 Nano 原生 Session Runtime 解耦。

## 3. 核心对象

| 对象 | 职责 | 生命周期 |
|---|---|---|
| Long Agent | 身份、自有配置与资源、工作连续性 | 长期 |
| Project | 工作数据、上下文、资源和授权边界 | 长期 |
| Agent 的 Daily Project | 无更具体归属时的独立默认项目 | 长期稳定，不按日新建 |
| Agent/Project 参与关系 | 参与状态、权限、相关 Session 入口 | 长期；不内嵌第二份 Agent Definition |
| Chat Session | 某一 Project 内的具体工作过程 | 按主题延续；Daily 日常主 Session 按日轮换 |
| Pi AgentSession | 一次 Turn 或执行阶段的运行对象 | 临时，可恢复持久 Session |
| 长期职责 | Agent 持续承担的工作范围及自主安排约束，关联明确 Project | 长期；一项工作完成不终止职责 |
| Task | 一项具体工作定义及触发策略，可关联长期职责 | 一次性、周期或事件驱动 |
| Run | 一次检查/执行实例，关联具体任务或其他可信触发来源 | 从触发到终态 |
| Delivery | 结果向指定目的地的投递及回执 | 独立重试 |
| Nano Channel Session | Messaging Group/Thread/Mailbox 路由坐标 | 由 Channel 管理；不是 Pi Session |
| Docker 环境 | 授权执行范围、依赖和隔离资源 | 可复用、停止、重建 |
| 日记卡片 | 某 Agent 某日活动和自我回顾的视图 | 可修订，引用原始来源 |

Task/Run 不替代已有 Workflow Run；任务调用 Workflow 时保存其 ID、Session 和状态关联，执行状态仍由 Workflow Runtime 提供。

## 4. Project-first 与会话选择

### 4.1 进入与查询

进入业务 Project 工作，必须创建或续接该 Project 内合适的 Session。仅从 Daily 查询另一个项目的进度，可以显式检索目标而不切换；跨项目访问仍需授权。系统可提供按可见范围解析的项目概览集合，使尚未参与项目的 Agent 也能发现公开名称、用途与进度。共享配置持续生效，不要求用户逐 Agent 口述或每次批准；详情和执行另按目标校验。

一个 Project 可以有多个与同一 Long Agent 关联的 Session。再次进入时优先续接明确指定或已选中的工作；存在多个候选而语义不清时，应列出候选，不能把“最近更新”当作永远正确的选择。

Project 页面和 Long Agent 页面引用同一条 Session。Daily 通过活动关联知道发生了什么，不复制业务项目对话。当前 primarySessionId 的永久唯一约束需要迁移为 Session 集合及显式选择。

### 4.2 每日 Daily Session

按 Agent 日历时区，为新日常交互原子创建或选择当天的日常主 Session。创建可在当天首次交互时发生，无需午夜为全部空闲 Agent 制造空会话。独立任务可在同一 Daily Project 内使用额外 Session。

正在进行的 Turn、Workflow 或任务跨午夜时留在原 Session。新的一天读取交接和任务状态；昨天的业务工作可以继续原业务 Session，昨天的日常事项默认带来源进入今天 Daily。显式打开旧历史只读查看，不自动启动执行。

唯一性约束只应用于“Agent + 日历日期的默认日常主 Session”，不限制同日独立任务或业务项目的会话数量。时区变更不重写历史日期、Session 或既有 Run。

### 4.3 Channel 与当前焦点

在鉴权之后，由后端按明确意图解析：

1. 显式打开的 Web Session，或有效的通知回复关联。
2. 本次明确选择的 Project/Session。
3. Channel/Thread 固定绑定。
4. 可信同一用户私聊的已选工作焦点。
5. 该 Long Agent 的当日 Daily Session。

任何目标失效都保留关联并报告错误，不能静默落到 Daily。不同受众或身份之间不共享隐式焦点；用户私聊焦点与群聊固定绑定分开。

后台工作不修改用户的交互焦点。平台支持回复 ID/Thread 时使用稳定关联；不支持时通过可识别工作入口或澄清完成续接，不能猜测“继续”指向哪条通知。

## 5. 不失忆的连续性机制

连续性由三层共同提供：

| 层 | 内容 | 事实规则 |
|---|---|---|
| 原始工作 | Pi Session、任务/Workflow 状态、产物、Memory 修订 | 各自领域的事实源 |
| 活动索引与查询 | Agent、日期、Project、Session、Run、状态、来源引用 | 由系统自动记录基础关联，可从来源恢复 |
| 摘要、交接与 Memory | 近期工作、开放事项、稳定事实和可检索知识 | 有来源、版本、修正与删除规则 |

Session 创建、消息活动、任务终态和产物关联不能依赖 Agent 记得主动“记一笔”。任务实际状态由系统提供；语义进展与总结由 Agent 补充，不能仅凭它说“完成”覆盖失败的执行记录。

每轮加载有预算的身份、核心 Memory、近期历史、未完成事项和当前 Project 入口，再按需要查询指定日期、Project、Session、消息和产物。索引也受权限约束，不能先把受限项目的摘要泄露到公共上下文。

历史连续性之外，还需发现自己未参与过的可见项目与活动。Project、工作状态、语义进展和 Social 提供统一查询视图，公共装配提供有预算的概览与查询入口；变化来自领域事实和版本更新，不通过每位 Agent 维护一份公共 Memory 实现。具体机制建议及 Coder 场景见[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)。

Pi Compaction 解决当前 Session 的上下文窗口；历史查询解决跨 Session 定位；每日整理处理交接与记忆维护。三者不能互相冒充，也不把所有过去的原始内容塞进新 Session。

## 6. Memory、每日整理与 Social

Agent Memory 保存该 Agent 的长期事实与协作知识；Personal Memory 保存授权的用户级共享事实；Project Memory 保存项目事实。共享范围通过持久配置或具体授权表达；查询共享概览不要求复制到各自 Memory，整理任务不自动扩大范围。

每日整理 Task 属于该 Agent 的 Daily Project，读取它在授权范围内的当日活动，使用独立整理 Session，输出：

- 完成事项、进行中事项、待用户决定与明日计划。
- 有来源的简短回顾。
- 对开放事项和自身 Memory 的授权维护。
- 需要更新 Project/共享资源时遵守对应 Policy 的操作或建议。

整理具有覆盖日期、截止点、来源清单和 revision。重复执行不能重复晋升同一事实；迟到结果可以进入新 revision。失败不阻止新 Daily Session 创建，旧交接和活动查询仍可用。

Social 以“Agent + 日期”为卡片身份，提供时间流与日历、全部 Agent 或单 Agent 视图。当天没有 Daily 聊天但做了项目工作，也可有卡片。无总结时显示实际活动和缺失状态，不伪造回顾。

卡片链接到原 Session、Run、文档和 Memory 变更。Agent 管理自己的日记，其他 Agent 可发现并读取面向它们开放的卡片内容；共享卡片不同时开放完整 Daily、原 Session 或私有 Memory。可见更新支持按订阅触发查看或交流，具体事件处理见共享认知设计。内部 Social 不等同于向微信等外部 Channel 自动发布。

纠正、删除或撤销来源权限时，索引、派生摘要、缓存和卡片需要失效、重算或遮蔽；不能靠复制摘要保留已经不可访问的内容。只保留必要的无正文审计标记，具体保留期由数据生命周期 Policy 定义。

## 7. 主动工作与调度

长期职责（灵魂模式）、自由活动和具体任务表达不同的动机与自主空间；时间、事件和资源机会表达触发来源。长期职责须有持久定义和可恢复的推进机会，不能仅靠 Prompt 描述；自由活动允许没有交付目标。它们共用公共 Pi 装配与工作事实，不建立互斥的 Agent 模式或另一套 Runtime。

长期职责定义由 Chat 配置服务管理，实际计划、在制内容与结果保留在所属 Project。任务可关联职责，单项 Run 结束不表示职责结束。灵魂模式的配置领域、Content Lab 跨日场景、具体提醒及 Social 事件见[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)；具体 Schema 与调度策略待评审。

### 7.1 Task 定义

任务定义进入 Chat 文件配置合同，每条有稳定 Task ID、负责人和固定 Project。NanoClaw 调度投影记录配置 revision 与应用状态。

需要表达的字段领域：名称/目标、负责人、Project、可选职责关联、一次性/周期/事件触发及过滤条件、时区、输入、可选前置检查、Session 策略、能力或 Workflow 引用、通知目的地、通知条件、重试/补跑/重叠策略、预算和启停状态。字段名称与 HTTP/Tool Schema 待详细设计。自由活动不必为满足 Task 的目标字段而制造交付任务。

基础 Session 策略为：

1. 续接指定 Session。
2. 解析触发当天该 Agent 的 Daily Session，仅适用于其 Daily Project。
3. 在固定 Project 中为本次执行创建 Session。

领域策略如“续接未完成课程，否则开下一章”在明确 Project 内解析并记录结果，不能变成跟随用户当前聊天位置的隐式规则。

### 7.2 一次运行

~~~text
耐久触发
→ 校验 Task revision、Agent/Project 状态及权限
→ 建立稳定 Run，执行可选检查
→ 无需模型：记录检查/确定性动作结果
→ 需要模型：解析并固定 Session，冻结 Agent/资源/环境配置
→ 公共 Pi 装配，或调用已有 Workflow 执行入口
→ 保存 Session、结果和活动关联
→ 按策略建立 Delivery，NanoClaw 投递并保存回执
~~~

调度任务、Webhook、Channel 和其他主动事件可以共用触发入口，但不得把定时任务伪装成人类聊天。来源身份由服务端固定；Agent 参数不能伪造 Project、Session 或调用者权限。

没有调用模型的检查仍有 Project 和 Run，不强制创建空 Pi Session。前置脚本在授权 Docker 环境运行；超时、错误或无效输出表示检查失败，不表示“无变化”。

### 7.3 管理与可靠性

用户和 Agent 应能查看、创建、更新、暂停、恢复、取消、删除任务及立即执行一次，并查看历史、下一次时间与应用状态。手动运行不隐式恢复周期计划。

Task、Run、模型执行和 Delivery 状态分开。投递重试不重新执行模型；重复触发通过稳定标识去重；已执行外部动作结果不确定时先核实，不能承诺所有第三方动作天然 exactly-once。

同一任务默认不重叠，同一 Session 顺序执行，不同 Session 受 Agent 和机器预算控制。错过时间按显式 skip/coalesce/catch-up 策略处理，恢复后不能无限补跑。重试、次数、超时和暂停阈值必须可查。

同一个 Long Agent 可以同时与用户、其他 Agent 进行不同交互，不能用一个身份级 busy 状态阻止全部新工作。消息可以持续接收；同一 Session 的模型推进和历史写入必须有序，不同 Session 的独立执行允许并发。共同会话中的参与者和发言安排仍需从场景另行确定。

并发控制落到实际冲突资源：同一配置或 Memory 文件的写入需要版本冲突保护或短时串行；相同可写工作副本、浏览器页面、设备等按资源能力互斥；只读快照与互不冲突的工作可以并行。正在执行的轮次保留其配置快照，后续轮次读取新版本。等待另一 Agent 或用户回复时，不得持有阻塞整个身份或对方响应所需资源的锁。

消息队列可以作为调度与恢复机制，但是否使用、分区和公平性策略仍待详细设计；不能把所有发给某个 Agent 的消息强制塞入单一串行执行通道。交互来源、顺序、关联与重复处理要可追溯，后台工作也需要避免长期饥饿。

自由活动与正式工作可以并行；收到正式任务不自动中断全部自由活动。只有资源冲突、优先级或预算需要时才等待、暂停或让出资源。自由活动的完整产品场景仍在讨论。

定义变更从后续执行生效；取消/停用/权限收回的在途影响必须明确反馈。重要待办、超时和不可恢复失败不能只留在无提示的日志中。

### 7.4 投递与回复

Destination 是结构化、经过授权的配置，不只写在自然语言 Prompt。运行归属、消息来源、发送身份、投递地址和回复关联分别记录。

收到通知后，用户可以打开或续接原工作；通知不能把用户当前其他 Project 的 Session 改成该任务的工作位置。富消息、附件、卡片与选择题按 Channel 能力协商；不支持的能力提供文本或 Chat Web 入口，不能丢失来源与回复关系。

## 8. Docker 隔离执行

已确认引入 Docker，基础职责是承载文件/命令工具、检查脚本、MCP 与开发环境。统一 Pi 装配与会话管理保留在 Chat；将整个 Pi Worker 移入容器不属于本次已确认范围，也不能未经设计启动原生 Nano Agent Runtime。

逻辑环境配置属于 Agent，实际容器按 Agent、Project 和 Run 的隔离需要分配。不同 Agent 默认不共享可写容器；同 Agent 跨 Project 不得通过长驻容器同时暴露全部项目。并行开发任务使用独立工作副本和明确产物交付。

环境合同至少包含镜像/依赖 revision、授权挂载、网络与 Credential 引用、CPU/内存、超时、并发、工作副本、持久卷及回收策略。源文件、依赖和产物如何进入/离开环境必须可追溯。

文件读写、命令、脚本和可执行 MCP 都必须遵守执行位置，不能只把 Bash 放进容器而保留无边界宿主文件工具。可执行 Extension/Plugin 的加载位置也必须审核；无法满足隔离的执行路径应报告不支持，不能偷偷回到宿主执行。Docker Socket、整个 Chat Home 和全部 Agent 目录不能作为默认挂载。

重建环境不能删除身份、配置、Memory、Session、任务或已提交产物。失败和资源不足有可恢复状态；配置更新区分下一次运行使用新镜像与明确中断当前运行。工具环境管理可复用 NanoClaw 生态代码，但必须通过窄合同接入。

## 9. 前端与管理流程

Frontend 只消费 Backend：Agent 详情、配置编辑、有效 Prompt、资源目录、Memory、参与项目、Session、任务与 Run、Channel/Delivery、环境状态、Social 和审计均从领域事实恢复。

配置的保存/应用、模型完成/投递完成、Agent 暂停/容器停止分别展示。Session 可从 Project、Agent、Task 或日记入口打开，仍只有一份历史。

创建 Agent 时完成独立配置根、稳定 Group 映射、自己的 Daily Project、默认能力与公共管理知识；模板可提供初始配置和任务，授权与 Credential 单独处理。归档/删除前展示任务、Channel、Memory 和历史关联的影响，不能静默级联删除其他项目的工作证据。

## 10. 恢复与迁移要求

配置迁移、Daily 分区、Session 集合、Agent Memory 目录和 Docker 接入采用有标记、可恢复、可重试的步骤。既有 Session 保持 ID 与原 Project；不得通过改写 JSONL 把混合旧 Daily 历史伪造成多个 Agent 的独立历史。

会话选择、Daily 首次创建和绑定变化必须有并发保护；执行入口先耐久记录目标与幂等身份。Chat、NanoClaw、容器任一侧重启都不应产生重复模型执行或丢失已接收任务。索引可重建，不能替代原始事实。

## 11. 多 Agent 机制与实现边界

具体过程、并发与异常分支见[交互场景收敛与模拟（评审稿）](./chat-long-agent-interaction-simulations.md)；它是待评审的产品经历，不是已确定的会话拓扑。

已确认需要独立Agent、可追溯协作与并发；参与者、工作和对话关系分别表达，具体边界见机制合同K5。学习、旅游、开发和日常场景用于验证行为，不按行业建立协作系统。复用workflow_call是底层实现参考；不预先创建第二套协作Runtime。

单次委派、Agent 双向交互、多个 Agent 与用户共同参与是不同场景。是否全部用新 Session、是否需要共同会话、参与者与 Pi 消息角色如何映射、谁在何时发言，以及 A2A 兼容是否有实际价值，将另行评审。当前场景中的协调者和工作会话只是演练，不锁定最终拓扑。
