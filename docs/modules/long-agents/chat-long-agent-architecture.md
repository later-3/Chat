# Chat Long Agent 架构

## 1. 状态与文档职责

状态：目标架构；2026-09-19 P1 将直接交流收敛为每 Friend 每日唯一 Session，并明确本轮项目上下文。P2 公共装配与本轮冻结项目已实现（Context §15.6），P3 每日索引/总结及 P4 统一实时交互已实现；P5 已完成旧数据兼容与本地全链验收，真实 Telegram 外部收发及最终审核待完成。2026-09-28 统一项目合同生效：每轮执行项目按入口唯一确定并受理冻结，LA6-A 的 per-Friend 关联已移除（见[机制合同 §10](./chat-long-agent-mechanism-contract.md#10-已退役la6-afriend-协作项目关联--统一项目合同)）。本文定义运行、数据与恢复机制；配置能力以[定义与配置模型](./chat-long-agent-capability-model.md)为准，使用要求以[场景与验收](./chat-long-agent-scenarios.md)为准。

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
| Agent Home 容器（旧称 Daily Project） | 专属空间和每日 Session 的内部存储归属，不是用户项目 | 长期稳定，不按日新建 |
| Agent/Project 协作关系 | 参与权限和各轮次工作目标 | 不内嵌第二份 Agent Definition，不另建 Friend 项目会话 |
| Chat Session | 原生交流历史，固定存储归属 | Friend 每日默认与额外独立直接会话；独立任务/群参与目标见 LA0 合同；普通项目会话按用户创建规则延续 |
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

### 2026-09-30：每日默认与额外直接会话（本批实施合同）

用户确认“每日默认不等于每日唯一”。本节替代下文旧 P1 中对所有直接会话的唯一性限制。架构审核：归属仍由 Chat 持久绑定，消息仍由 Pi 保存，公共 Workflow/装配和每 Session 队列不变；没有新增运行时或前端事实源。

- `dailySessions` 只保存 `(longAgentId,date)` 的默认引用；状态 schema 7 新增 `additionalSessions`，保存额外会话的 owner、Session ID、创建日期/时区、时间和创建 requestId。v6 升级仅添加空数组，既有 ID/历史/默认指针不改；旧版本状态解析仍受支持。
- `POST /api/long-agents/:id/start` 新增 `mode:"new",requestId`，可带有效 `date`；缺省继续幂等打开日期默认会话。相同 owner/requestId 返回同一额外会话，显式日期冲突拒绝；不执行模型。原生 `chat.long-agent-direct.v1` 标记先 flush，再提交绑定，重试/恢复据标记补索引。重复或损坏绑定报错，不合并历史。
- 新建与显式继续额外会话均不更新 primary 默认指针；归属检查、工作来源、回传使用固定 Session ID。默认项被移除时沿用明确的已移除错误，恢复原项或另建额外会话；不偷偷新建替代默认项。已移除的额外请求重试也不创建替代项。
- 日历活动日期仍来自实际消息；额外空会话以 `creationDate` 出现在日期会话列表，不点亮活动格。跨日继续保持原 Session 和请求来源；日档案与总结按实际活动日期汇总。
- 用户委派工作向真实来源直接会话追加现有隐藏回执，即使跨日也不改投默认会话；来源移除时保留工作结果，不复活来源。定时工作的通知策略不在本批重定。

验收：同日默认+两条额外会话、创建重试/索引恢复、非法归属、跨日继续、独立队列、真实来源回传和日档案聚合，均走既有 API/公共装配；浏览器验证创建、刷新与默认入口不变。

### 4.1 项目是每轮冻结的执行上下文

Friend 的直接交流使用自己的每日默认或用户选择的额外直接 Session。业务项目通过本轮冻结的项目上下文进入公共装配：2026-10-01 起项目归属会话执行项目 = 会话归属，每日/额外直接会话在 Agent 容器执行（历史合同：Web 私聊曾取顶栏"项目"选择，群聊取会话 storageProjectId）；不因此新建项目 Friend Session。查询其他项目的概览也不自动切换执行项目。Session 存储不迁移、原项目授权不扩大。

项目展示与 Agent Home 分开；旧 API 的 projectId 兼容表示存储归属，新消费者明确使用 SessionRef 与本轮冻结的 `contextProjectId`，精确字段以[公共装配合同](../../architecture/chat-context-resource-model.md#15-公共-agent-装配合同p12026-09-19)为准。项目页只列普通项目 Session；Friend 的项目活动可引用相关轮次，不复制私有每日对话或授权其他参与者读取整天历史。

2026-10-01 已确认目标合同（实施完成，见[评审记录](../../history/reviews/2026-10-01-la-project-session-tree.md)）：Web 端入口重构为 Long Agent → Project → Session 三级导航。Long Agent 通过有序 `boundProjectIds` 显式绑定多个项目（增删走配置 API，Workspace 固定首位不可解绑，解绑不删 Session）；从绑定项目新建的会话 storageProjectId 为该项目，执行项目 = 会话归属；每日默认、额外直接会话、定时与 IM 轮次仍归 Agent Home，Session 不迁移。多 Agent 进入同一项目的身份区分复用现有机制：SessionRef owner 归属校验、各 LA 独立配置根冻结的身份区/当前项目区、导航路径标注，不新增运行时。顶栏项目选择器在 coworker 模式退役；主题模式本期只在项目下展示现有图，跨项目来源放宽后置。

### 日历历史入口（2026-09-27 实现）

Friend 列表每行的日历按钮打开历史阅读器：全年格子按周排列，Agent Home 的原生 Session 在当天有消息才显示绿色。只有文件头/配置的空 Session 不点亮；不能把每日绑定存在当作已有历史。Home 中日常、后台工作、主题和其他原生 Session 都沿用现有存储与归属。点击任意日期直接进入该日工作区：中央打开日常 Session，侧栏按所选日期列出会话和后台工作，不再弹出第二层会话选择；每个 Session 沿用自己的权限和公共 ChatWindow，已有历史可以继续会话；打开已有会话不创建替代品。空日期可点击，通过既有 `POST /api/long-agents/:id/start` 的可选 `date: YYYY-MM-DD` 幂等打开或创建该日直接交流 Session。只创建不会调用模型，也不是定时任务。

`GET /api/long-agents/:id/daily?year=YYYY` 保留 `days` 生命周期记录，另返回 `sessions: [{sessionId,projectId,title,kind,dates,createdAt}]` 只读投影供历史入口使用。年份允许 1970–9999；不传年份时保留状态面板最近 60 天合同。会话发现复用公共 `listActiveSessionFiles`，日期从同一次 stat 校验的 Pi 分支消息读取，按 Agent 时区计算；跨日会话只出现在真正有消息的日期，不填满创建至修改之间的空闲日。过去分支/压缩前全文继续通过公共历史入口查看。此版本范围是 Agent Home，不递归扫描其他项目中的委派子会话。无新存储、调度或模型调用，日历读取不加入联系人切换的关键路径。侧栏在主聊天打开后异步读取投影，后台工作按创建日或当日实际消息归入；同名定时任务每次执行按 work/Session 身份区分，并显示实际开始时间。

用户选择的日期只是 Session 的日历归属；接受时间、消息时间与模型所见今天仍使用真实当前时间。继续旧日不改变默认联系人今天的会话；旧日总结已完成时重新置为待总结，按新 cutoff 更新，收尾正在占用会话时仍使用既有冲突提示。日历后续可以投影现有 Task/Occurrence/Duty，但本批只提供 Session 导航和创建，未把任务定义或跳过记录当成已有会话。

后续已确认方向：按每天真实 Token 消耗映射绿色深浅（多则深、少则浅），当前只记录实现注释，未启用强度。届时应读取原生 assistant usage，明确缓存 Token 口径与 fork 继承去重；不能以会话数量或文件大小代替用量，也不新建会话事实源。

回归：`test/long-agents/daily-lifecycle.test.mjs` 覆盖超过 60 条/闰日/空年、空绑定、多会话、跨日、移除、作用域和只读查询；`frontend/lib/friend-calendar.test.mjs` 覆盖日期布局与同日多会话；`scripts/session-memory-switch-browser.test.mjs` 覆盖空日期不点亮、选择两个不同历史会话、实际消息可见、在原历史续聊及读取旧上下文、空日期幂等创建而不执行模型、刷新和默认今日目标不变。

### 4.2 默认入口唯一性、日期与排队（P1 实施决策及 2026-09-30 修订）

2026-09-20 LA0 补充：以下描述现有每日入口。目标将独立任务/群参与分离到各自 Session，“每日唯一”仅适用于直接交流；不能继续将新后台任务默认送入日常主会话。目标合同见[机制 §9](./chat-long-agent-mechanism-contract.md#9-la0交互任务与调度的实施合同)，LA1 已扩展明确后台工作绑定；每日唯一性现仅约束默认直接入口，额外直接会话和工作均按各自 Session 排队。

- 唯一键为 `(longAgentId, localDate)`，不含业务 projectId、Channel 或浏览器 ID。默认日期由 Backend 耐久接受时间及 Agent 的持久 IANA timeZone 计算；迟到渠道消息保留原发送时间，但新接受请求进入接受日。2026-09-27 用户明确选择日历日期或已有 Session 时例外：Backend 验证日期/归属后定位该 Session，不改变消息时间和模型所见当前时间。
- 老配置首次迁移时把 Backend 的有效 IANA 时区持久固定，并在检查中展示；以后不随服务器时区漂移。改时区从下一轮接受生效，历史不改；遇到同一日期复用原 Session，不能因时区更名再建一个。同一执行保存其 timeZone revision。
- 同日直接消息和内部维护进入每日原生 Session，有序执行；LA2 任务触发通过 LA1 独立工作 Session 执行（[任务合同](./tasks.md)）；接收与模型执行分离，使用现有 Long Agent 耐久待处理记录扩展请求序号/状态，不新增通用任务引擎。多个 Friend 可并行；独立 Workflow 委派仍按自身合同并行。
- 本轮接受时选定日期/项目/资源；午夜不迁移已接受或执行中的轮次。旧日队列仍写旧 Session，新日任务使用新 Session，缺少最终交接时携带“旧日仍在执行”的可查引用；不得假称昨日已全部总结。
- Backend 恢复 Worker 启动时、每 60 秒及接受消息前检查换日和待总结记录；空闲日不制造空 Session。首条新日工作按唯一键创建。2026-09-27 按用户修正的产品要求，显式打开旧日可以在原 Session 继续；默认点 Friend 仍进入今天。已完成总结会随新轮次重新进入待总结，不能悄悄转投今日。
- 新日初始化按唯一键幂等，不因先打开页面或进程重建丢失交接。交接 readiness/revision 独立记录，每轮从记录恢复；后来完成的旧日总结从下一轮进入，不改已接受轮次。

### 4.2.1 P3 实现合同（2026-09-19）

所有直接入口复用 `acceptLongAgentTurn → drainLongAgentTurns → executeAcceptedLongAgentTurn → createChatPiAgentSession`。Nano Event API 在返回 202 前冻结模型输入并保存事件；P4 Web 已使用 turns API 在耐久接受后返回 202，再按引用订阅公共 Pi 事件；旧 messages API 保留同步兼容。精确路由、恢复边界和能力差异见[模块合同](../../architecture/chat-module-contracts.md#friend-p4-实时与控制合同)。

- `project-agent.ts` 按 Friend＋日期定位 Home 原生 Session，兼容输入的业务 projectId 不再创建另一条 Friend 主会话。显式旧 Home 日常 Session ID 可以继续原历史；点 Friend 的“开始聊天”仍进入今天。经过旧迁移的 Home 历史须有精确迁移回执；原生 header 保留，公共打开入口只在原 cwd 与迁移来源 Registry 一致时允许从当前 Home 续聊。仍在旧业务 Project 的迁移档案不自动接管。
- 时区首次读取配置、打开会话或 Worker 恢复时固定进 Registry；保存配置可修改 `timeZone`。每个请求记录接受时的日期和时区，改配置不重写历史。当前日期因改时区再次出现时复用原 Session；若该日正在收尾则明确要求稍后重试，完成后追加工作会重新标记待总结。
- `runtime/long-agent-state.json` schema 4 增加 dailySessions 和 turns。turns 是执行信封/收据：保存 requestId、可信来源、全局接受序号、日历归属、项目、Nano revision、公共装配 seed、正文/图片和状态；不是第二套聊天。完成/取消后清除正文、图片、seed，消息事实始终在 Pi JSONL。失败/不明中断保留原输入供检查。
- Web 使用稳定 requestId；同来源/Friend/requestId 且正文、项目、附件一致即复用，不同则 409。Turn ID 带来源和 Friend 前缀，避免不同入口身份碰撞。一个 Friend 的 Worker 串行处理接受序号，不同 Friend 可并行；当前采用单 Backend 进程的原子状态写队列，不支持多个 Backend 同写一个 Chat Home。
- 接受在临时 Pi Session 中通过公共装配做预解析，只保留装配元数据，不复制消息。执行时将 seed 安装到真实每日 Session。已加载资源在本进程保留版本；重启后规则正文仍冻结，Skill/Extension 按 P2 恢复校验，不可恢复的版本明确失败，不能换成新资源偷偷执行。
- Worker 在启动、每 60 秒和注册后的消息入口检查；重建既有 Home 日历索引但不分配空闲日 Session。日期标记与首次 Session flush 一起持久化，索引提交前崩溃可据标记恢复；同日多个候选报冲突，不合并正文。
- queued 在重启后继续；running 仅有同轮原生终态/完整 stop 回复时恢复 completed，否则 interrupted，保留历史且不自动重放不明工具副作用。取消排队不会调用模型；失败可显式重试，但已有后续执行或日期已收尾时拒绝回退历史，改为当前会话发新消息。
- Nano 私聊必须匹配已配置 inbox 或已有可信私聊绑定；群聊、未绑定地址不共享每日私有历史。第二渠道不能仅凭 Agent Group ID 自动获得旧对话。回复始终使用原 event 目的地；完成后的 Delivery/Ack 重试不创建新日 Session、不重新装配模型，停用 Friend 也不丢已完成回复的待投递收据。

`GET /api/long-agents/:id/daily` schema 1 提供时区、今天、最近 60 日总结状态及最近 100 个请求的安全投影，不返回冻结 Prompt、附件或 Credential。`POST` 同路径接受 `retry-summary + date`、`retry-request + turnId`、`cancel-request + turnId`，拒绝未知字段及不适用状态。Friend 设置 → 日常记录 → 会话与交接提供历史、失败原因与对应操作；P4 运行中取消/引导/事件订阅复用同一执行队列和原生 Pi 句柄，合同见上述链接。

旧 schema 1–3 转换前保留 `runtime/migrations/long-agent-daily-v4/source.json`，转换完成写 `complete.json`。只自动收录可唯一识别的 Home 日期和新原生标记；其他旧业务项目 Session 不挪动、不拼接，P5 的旧 URL、映射、冲突和恢复规则见[升级手册](../../operations/friend-migration.md)。

### 4.3 各入口的上下文与受众

Web 每次发送显式提供项目 ID 或 null，刷新恢复该窗口选择。Nano 消息使用可信通道绑定的项目上下文；没有绑定即 null，不继承另一个 Web 窗口的最近项目。定时触发使用任务冻结的目标，不跟随界面。

自然语言“去项目 B”通过同一受控项目上下文服务解析已授权对象并更新入口绑定；当前轮次保持快照，切换后的下一轮生效。若要立即继续，以有来源的后续轮次推进，而不是热替换正在执行的工具。重名、无授权和不存在需要明确处理，不能从模型正文或相对目录猜 projectId。

仅已识别为同一用户的私有入口复用同一 Friend 每日历史。未知发送者、多用户群聊不能被自动接入这个私有上下文；保留当前拒绝/显式配置边界，多人共享另行设计。回复目的地由原始可信请求固定，Web 回复不默认广播到 IM。通知回复引用旧任务只作为关联，不改变本轮每日 Session。

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

每日整理属于该 Agent 的内部维护轮次，读取其旧日 Session 和授权活动，在该旧日唯一 Session 中通过公共装配执行，不再创建独立整理 Session，输出：

- 完成事项、进行中事项、待用户决定与明日计划。
- 有来源的简短回顾。
- 对开放事项和自身 Memory 的授权维护。
- 需要更新 Project/共享资源时遵守对应 Policy 的操作或建议。

2026-09-30 起，日终整理改为可管理的独立 Task，通过 Nano 触发 → Occurrence → Work → Workflow / 公共 Pi 执行。默认次日 00:10 总结前一天，覆盖日期在受理时冻结。来源覆盖该 Agent 的日会话、独立工作、任务、职责和当前授权群活动；跨项目历史仍按原权限读取。完整合同见[每日工作与归档](./daily-archive.md)。

总结保存为 `long-agents/<id>/days/<date>/summary.md`，包含覆盖日期、来源目录和 revision；这是独立记忆文件，不向用户聊天追加 assistant 消息、不自动发帖或投递。旧原生维护记录保留审计，但普通聊天隐藏其输出。`daily-maintenance.ts` 只恢复队列和同步任务，不再直接运行日终模型。旧 `summaries/<date>.json` 只读兼容。

新日默认加载昨天的总结，更早资料由 `summary_manage` 按日期读取。缺失总结明确标记，任务失败不阻断交流；用户可核对任务执行记录后补写。原生执行是否结束和总结文件是否保存是两项独立事实，不能仅据模型答复宣称归档完成。

日常活动卡片按“Agent + 日期”聚合，提供时间流与日历、全部 Agent 或单 Agent 视图；Social 帖子使用独立 postId，同日允许多条，不能将日卡身份当成发帖唯一性。当天没有 Daily 聊天但做了项目工作，也可有卡片。无总结时显示实际活动和缺失状态，不伪造回顾。

卡片链接到原 Session、Run、文档和 Memory 变更。Agent 管理自己的日记，其他 Agent 可发现并读取面向它们开放的卡片内容；共享卡片不同时开放完整 Daily、原 Session 或私有 Memory。可见更新支持按订阅触发查看或交流，具体事件处理见共享认知设计。内部 Social 不等同于向微信等外部 Channel 自动发布。

纠正、删除或撤销来源权限时，索引、派生摘要、缓存和卡片需要失效、重算或遮蔽；不能靠复制摘要保留已经不可访问的内容。只保留必要的无正文审计标记，具体保留期由数据生命周期 Policy 定义。

## 7. 主动工作与调度

长期职责（灵魂模式）、自由活动和具体任务表达不同的动机与自主空间；时间、事件和资源机会表达触发来源。长期职责须有持久定义和可恢复的推进机会，不能仅靠 Prompt 描述；自由活动允许没有交付目标。它们共用公共 Pi 装配与工作事实，不建立互斥的 Agent 模式或另一套 Runtime。

长期职责定义由 Chat 配置服务管理，实际计划、在制内容与结果保留在所属 Project。任务可关联职责，单项 Run 结束不表示职责结束。灵魂模式的配置领域、Content Lab 跨日场景、具体提醒及 Social 事件见[共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md)；具体 Schema 与调度策略待评审。

### 7.1 Task 定义

任务定义进入 Chat 文件配置合同，每条有稳定 Task ID、负责人和固定 Project。NanoClaw 调度投影记录配置 revision 与应用状态。

需要表达的字段领域：名称/目标、负责人、Project、可选职责关联、一次性/周期/事件触发及过滤条件、时区、输入、可选前置检查、Session 策略、能力或 Workflow 引用、通知目的地、通知条件、重试/补跑/重叠策略、预算和启停状态。字段名称与 HTTP/Tool Schema 待详细设计。自由活动不必为满足 Task 的目标字段而制造交付任务。

现有 Nano 定时消息仍进入接受日唯一 Session；LA1 显式后台工作进入独立 Session；没有模型的确定性检查不创建 Session。显式委派 Workflow 的子 Session 属于 Workflow，不接管 Friend 主交流。旧策略中的“指定业务 Session/每次独立 Friend Session”不作为本轮实现输入。任务仍持有工作项目和来源，不能隐式跟随用户页面。

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

同一个 Friend 可持续接收不同入口消息；同日模型推进和历史写入按唯一 Session 有序。等待不阻止耐久接收；需要交互的暂停点释放运行操作锁，恢复使用明确版本。不同 Friend 和显式子 Workflow 可按各自合同并行；共同会话参与者协议不在本轮开放。

并发控制落到实际冲突资源：同一配置或 Memory 文件的写入需要版本冲突保护或短时串行；相同可写工作副本、浏览器页面、设备等按资源能力互斥；只读快照与互不冲突的工作可以并行。正在执行的轮次保留其配置快照，后续轮次读取新版本。等待另一 Agent 或用户回复时，不得持有阻塞整个身份或对方响应所需资源的锁。

Friend 同日直接交流使用现有待处理记录的接受序号，不能并发写同一 Pi 分支；后台维护排在其截止范围的已接受消息之后。跨日后仍可显式在旧日 Session 接受新用户轮次；总结按已有 cutoff 与会话锁收尾，完成后若有新轮次则更新总结。默认新消息仍进入今天。未来多 Agent 协作不能用新增隐藏 Friend Session 绕过此合同。

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

## LA1：独立后台工作实现合同

入口为 Friend 侧栏“后台工作”和 `friend_work` Tool，两者调用 `src/long-agents/work.ts`。仅本人日常 Session 可发起自己的工作，不允许伪造另一个 Friend 或递归派生。创建需完整任务说明，不复制主聊历史。后台沿已有 Long Agent Resolver、接受快照与公共 Pi 工厂执行，不创建同名临时 Agent，也不改变普通 Workflow Agent。复杂阶段仍可由现有 `workflow_call` 组织；周期定义/Occurrence/长期职责属于 LA2–LA3。

- `FriendWork` 是执行绑定，保存在 `long-agent-state.json` v5 的 `works`。ID 由 Friend 与 requestId 决定，同键异载荷拒绝；保存原生工作 Session、origin Session/Entry、标题与固定协作 Project。原生 `chat.friend-work.v1` CustomEntry 用于绑定恢复；Pi header 保留 parentSession。
- LA1 工作存储 Project 固定为该 Friend Home，和日常历史一样属于本人私有范围；业务 Project 仅为冻结的工作目标，不把它误作 Home。工作下一轮可重新装配能力，但不能改投另一个项目；新项目另开工作。
- 运行状态仍来自既有 `AcceptedTurn`（新增可选 workId），不复制第二套 Run 状态。接受时冻结定义、资源和项目，按原生 Session 串行；不同工作与主聊并行。每 Friend 当前最多 4 条活跃后台 Session，主聊不占此容量；此值为 LA1 固定上限，预算/配置管理后续接入。
- Web 复用原 turns、events、Session 详情与聊天组件。侧栏每 3 秒刷新工作状态；打开后走相同的流式事件。取消只针对对应执行，queued 直接取消，running 持久化 cancelRequested 并中止 Pi；装配窗口在调用模型前检查。已发生的外部动作不回滚。
- 终态 AcceptedTurn 是耐久返回源。`chat.friend-work-return.v1` 隐藏原生 CustomMessage 只写状态/来源引用，不复制答案，不伪造旧 Tool Result，不自动唤醒主聊。交付先取得来源 Session 锁并重开，按 turnId 去重，只接受当前最新尝试；旧日已关闭或来源删除时保留工作结果入口，不重开旧日。刷新不重执行模型。
- 重启延续 queued；无法证明完成的 running 标 interrupted，保留历史并由用户检查后发新消息，禁止自动重放未知工具副作用。新尝试结果不能引用旧尝试答案。
- `write/edit` 在规范化目标路径上短时互斥，edit 的读取、匹配、写入在同一锁内；既有 Memory/配置服务保留自己的冲突控制。此保障限单 Backend 与受控文件工具，Bash、任意扩展和外部进程不受文件锁约束；涉及它们的同文件并行写应使用独立工作副本，不能宣称已有 OS 沙箱或跨进程事务。

HTTP v1：`GET/POST /api/long-agents/:id/work`。POST 为 `{schemaVersion:1,requestId,originSessionId,contextProjectId,title,text}`，202 返回 `{schemaVersion:1,work,execution}`；GET 返回 `{schemaVersion:1,works:[{work,execution}]}`，未完成接受的绑定 execution 为 null。取消和过程订阅使用现有 turns API。`friend_work` 支持 start/list/get/cancel，身份与来源由可信工具上下文提供；cancel 需 workId 与 expectedTurnId，防止过期操作取消后续执行。

创建失败或网络丢回执时，页面保留原请求在本标签页 sessionStorage，提供明确“确认上次提交”入口；不会自动重发、生成新 ID 或把未确认当作运行成功。工作输入和实际结果始终由 Backend/原生 Pi 保存。来源、日常列表和工作列表分离，日历不把后台工作当作当天主聊。

### 2026-09-30：统一 Workflow 执行配置合同

用户确认的 A6 修复采用现有 Workflow 配置服务：Long Agent Home 是 Session 的配置归属，执行项目只决定本轮工作上下文，不复制模型设置。`definition.json` 保留长期身份提示词；模型、思考等级、工具及资源迁到 Home 的 `workflows/minimal-pi-coding-agent/agents/pi-coding-agent.json`。迁移留存不可变原件，已有 Workflow 字段优先，缺失字段从旧定义补齐；重试不覆盖迁移后编辑。旧配置 API 仅作为同一持久配置的兼容投影，不再保存第二份执行字段。

Web、IM、定时工作均在受理时读取 Home 的默认/显式 Workflow，经公共 Resolver 冻结全部节点及 Session 选择；执行和记忆节点消费同一调用快照。检查与设置复用普通项目的 Workflow API。长期身份作为工作节点的附加上下文；记忆维护节点不继承身份职责、日报指引或项目上下文文件。旧已受理轮次继续使用原冻结快照。


## 交互 Harness 注入（2026-10-05）

交互 harness 是与用户协作开发的规则集合（飞轮、概念空间、正反案例、每日记录与四个规范），
它是**与 Agent 的 prompt 相关**的能力，因此复用 Chat 既有的“规则 / 自定义指令”装配路径，不新建注入机制。

| 来源 | 生效范围 | 路径 |
|---|---|---|
| 通用规范 | 所有 Long Agent | `<chatHome>/interaction-harness/standards/{需求规范,前端规范,开发规范,维护规范}.md` |
| 项目专属规范 | 仅该 Long Agent 在该 project 下 | `<chatHome>/long-agents/<agentId>/projects/<projectId>/project-guidance.md` |

实现：`src/long-agents/interaction-harness.ts` 读取上述文件，`prepareLongAgentAssembly` 在装配时把它们
作为一条 `<interaction_harness revision="sha256:…">` 自定义指令注入，因此每轮装配都冻结了“本轮遵守的是
哪一版规范”。文件不存在时不注入（既有环境不受影响），完整资产（案例、每日记录）保留在目录中按需读取，
不重复写进 prompt。

回归：`test/long-agents/interaction-harness.test.mjs`（通用 + 专属隔离、装配注入）。
