# 模块边界、变更传播与连接

这是跨模块的导航和合同检查入口。具体 Schema 留在各模块及[配置文档](../configuration/README.md)。下表的“当前”来自本仓库源码；“目标”是后续设计约束，不表示已实现通用通知系统。

## 分层与所有权

```text
Web ──HTTP / Run NDJSON──→ Chat Backend
Chat CLI（复用 Pi UI 组件）──同一 HTTP / Run NDJSON──→ Chat Backend
IM → NanoClaw ──认证 Event / Management HTTP──↔ Chat Backend
                           Workflow / Long Agent 生命周期
                                      ↓
                           createChatPiAgentSession
                                      ↓
                        Pi ResourceLoader / AgentSession / SessionManager
```

| 模块 | 拥有的事实与职责 | 消费者使用的边界 |
|---|---|---|
| Frontend | 草稿、导航、临时交互状态；展示和校验 Backend 响应 | `frontend/lib/*-browser.ts`；不拥有配置或 Session 的另一份事实 |
| Workflow CLI | 终端交互、目标服务地址；复用 Pi 原生显示组件 | 同一 Run API 与 v1 transcript/fork 投影；不装配 Agent、不写服务端 Session，见 [TUI 合同](../modules/tui/chat-workflow-tui.md) |
| Chat 配置、Project、资源服务 | Chat Home、稳定 Project 身份、配置解析、Catalog、授权及资源选择 | HTTP 与受控 Tool 使用同一服务；模型配置来自 Chat，不读 `~/.pi` |
| Workflow / Long Agent 生命周期 | 一次 Workflow 执行；长期身份关联、入站事件、执行关联与恢复 | 分别包装公共 Pi 装配；不再实现 Agent Loop |
| 公共 Agent 装配 | 把已解析的模型、Prompt、Skill、Tool、Extension 和 Session 装入 Pi | `src/agents/pi-agent-session.ts`；检查和运行遵守同一解析合同 |
| Pi | Agent Loop、资源加载、原生消息和 Session 文件 | 公开 SDK；产品关联用 CustomEntry/读模型扩展 |
| NanoClaw | Group、Workspace、Agent Markdown Memory、Channel、Inbox、调度触发、Delivery/Ack | 认证的版本化 Event 与 Management/Resource API；Chat 不读 Nano 数据库 |
| Memory | Chat Personal/Project Catalog+Mem0；Nano Group Markdown 各自持久化 | 两种作用域明确的接口/Tool；不能复制一份冒充另一类 Memory |

Long Agent 独立配置根、每人 Daily、跨 Session 历史、资源包版本和工具执行 Docker 是[已确认目标](../modules/long-agents/chat-long-agent-mechanism-contract.md)。当前旧配置分属 Chat 与 Nano；迁移前不能用“唯一事实源”的目标描述掩盖现有分工，也不能继续新增双写字段。

Frontend和TUI是并列客户端，互不承载对方的执行；TUI当前仅接普通Workflow。TUI无监听端口，Pi UI组件在终端进程中渲染，Pi AgentSession在Backend执行链中运行。NanoClaw是独立Host，通过Long Agent生命周期接入Backend，普通Web/TUI Workflow不依赖它。启动与停止只管理明确归属的进程，参见[调试环境](../development/debugging/environment.md)。

## A 改了，B 怎样知道

先判断改变的是**数据、合同还是语义**。自动感知成立的条件是消费者已经理解该合同。

| 变化例 | 传播机制 | B 是否需要改代码 |
|---|---|---|
| 新增已支持格式的旅行 Skill、Tool 条目 | 后端 Catalog 重新发现，返回来源/选择/可用状态；通用列表重新查询 | 通常无需逐项改清单；实际 Tool 仍须注册、授权和依赖就绪 |
| 修改 Skill 内容或 Agent 模型 | 下一轮解析新版本，在途固定；检查页和运行显示对应版本 | 不改资源清单；完整包版本固定/通知机制待实施 |
| 新增 API 字段、枚举或资源类型 | 修改 Schema、运行时解析器及合同测试；分析兼容窗口 | 可能需要，尤其当前严格拒绝未知字段的合同；不能承诺“新增字段必兼容” |
| 新增多参与者 Session、改变调度重试所有权 | 先设计身份、排序、耐久状态与恢复，再更新提供方和消费者 | 需要联合设计，不能靠广播一句消息完成 |

当前已有 Backend Catalog、部分 revision/CAS、装配时 `ResourceLoader.reload()`、页面操作后重读和 Workflow Run 流。**尚无覆盖所有配置/Skill/Memory 的统一失效通知合同**。自动刷新按以下目标设计：

1. 写入通过唯一管理入口提交，校验和耐久保存完成后才确认成功；生成作用域内的 revision。
2. 变更通知只传对象身份、作用域和版本等必要信息，驱动消费者失效并重新查询权威读模型；不在前端拼另一套资源表。
3. 文件编辑等外部写入通过受限目录扫描/重新解析发现；通知丢失、断线重连、页面聚焦或新一轮开始时可重新同步。具体 watcher、轮询或传输方式由技术方案选择。
4. 去重、乱序和权限变更按身份/版本处理；未知版本或冲突显式报错。新一轮资源解析和在途快照互不混淆。

这套失效与重读机制应复用于资源、配置、进度等已有读模型；不要求每个模块维护全系统事件状态。通知能加速展示，不能承担唯一持久化或授权职责。

## 长连接与恢复的当前事实

Workflow 通过 `POST /runs` 得到稳定 Run 引用，再由 `GET /runs/:runId/events?startIndex=...` 读取 `application/x-ndjson`。它是 HTTP 流，不是 WebSocket 或 SSE。来源：[事件路由](../../src/routes/runs/%5BrunId%5D/events.get.ts)、[事件发布](../../src/workflows/chat-run-events.ts)、[浏览器消费](../../frontend/lib/chat-workflow-browser.ts)。

页面通过 `resumeChatWorkflowRun()` 重新附着，恢复入口使用 `startIndex=-1`；Run 状态与 Pi Session 重新读取用于恢复事实。不能声称浏览器已持有逐条 ACK 游标或断线后完整重放所有 UI 增量。取消浏览器读取与取消服务端执行是不同操作，显式取消使用 Run API。Long Agent Web 的 P4 turns 入口已在耐久接受后订阅公共 Pi 增量，旧 messages 入口仍同步兼容；精确范围见下文 Friend P4 合同，不能把单轮事件流当成全局通知通道。

Web 状态行消费同一条 Pi 事件投影（含 `turn_start`、重试与压缩），并使用已有 Run 轮询的最近确认时间。Run 终态优先于事件流关闭，完成后有界排空并重读 Session；可选 `workflowOutcome` 从最后一轮 Run 恢复 completed/failed/cancelled 与错误说明，不新增前端持久账本。取消 API 同时调用本实例按 Runtime runId 登记的 Pi `abort()`；该表仅保存取消句柄，不拥有执行状态。

当前单实例 Local World 中，Backend 新 worker 在处理首个请求前检查原生 Run/Step：仅将开始于本 worker 之前、且仍为 running 的旧 Step 所属 Run，通过 World 的原子 `run_failed` 事件收尾。原因记录为 `CHAT_LOCAL_EXECUTION_INTERRUPTED`，不自动重放 Agent/Tool。新 worker 的慢执行/断点暂停、queued Step 和没有运行 Step 的持久审核均不据此判失败；非 Local World 不执行此恢复策略。Session、Web/TUI 与子调用随后读取同一 Runtime 终态。该保障依赖 Local World 的单实例数据目录边界，不能用于共享目录的多个 Backend。

Nano 入站在 Chat 返回 `202` 前耐久保存；出站通过 Gateway Delivery/Ack 关联。连接断开、推送超时和 Agent 执行失败必须分别定位。重试使用稳定事件/执行/投递标识，不靠正文去重。[集成基线](../modules/long-agents/chat-nanoclaw-pi-integration.md)维护精确职责。

## 系统生命周期

完整实例的启动、就绪、停止接收新工作、收尾和恢复由[系统生命周期合同](./chat-system-lifecycle.md)统一定义。进程管理复用原生服务管理者，任务状态仍归已有Workflow/Long Agent/Pi；不要让脚本、Web和Nano各自定义“整个系统已停止”。当前独立服务未完成该协同。

## 修改合同的审核证据

每次跨模块变更列出：事实拥有者、实际消费者、读写接口、作用域/身份、版本与生效点、失败/并发/重连、持久化及兼容迁移。验证至少包含生产者响应→浏览器解析、检查→装配、触发→Run→Session 中本次受影响的完整链。详见[工作方法](../development/agent-contribution.md)、[测试指南](../development/testing.md)及[诊断记录](../development/diagnostics.md)。

### Chat Web：Long Agent 运行状态读取

`GET /api/sessions/:sessionId?projectId=...` 对 Long Agent Session 增加 `longAgentActivity`：`schemaVersion: 1`，`status: idle | running | completed | failed | cancelled | interrupted`，`turnId/startedAt/error: string | null`。状态由原生 `chat.long_agent_turn` 记录与当前 Backend 的 Session 操作锁投影，前端不持久化另一套执行事实。存在当前操作锁即为 running；仅遗留 running 记录而无当前操作则为 interrupted，不假称任务仍在运行或已经完成。历史分支查询不改变此 Session 的当前执行状态。

Web 通过同一 Session 响应的 `friendExecution` 恢复稳定执行引用，使用下文 P4 订阅合同；`longAgentActivity` 继续提供原生历史兼容读投影。空闲轮询用于发现其他入口的新请求，活跃文字与工具增量来自过程流。导航只断开观察，不撤销 Backend 已接受的工作；用户点击“停止”才调用执行取消。浏览器待核实输入只保存未确认的草稿，不替代服务端耐久队列。


### Chat Web：同事状态读投影

`GET /api/long-agents/presence` 为只读合同，返回 `{schemaVersion:1, observedAt:ISO8601, agents:[{id,status:ready|working|disabled}]}`，禁止缓存。提供方 `src/long-agents/presence.ts` 读取原有 Registry 与 Session 操作锁；Long Agent 生命周期在取得现有锁时附带 `longAgentId`，释放时清理，队列中的工作及跨日旧 Session 均保留归属。没有独立运行表、心跳进程或新的执行器。锁的语义是处理中（包括排队），不是模型正在生成 Token。

工作中优先于停用：停用不冒充撤销已接受的执行。无工作且启用表示就绪，只说明后端已确认配置状态，不能证明下一次模型调用成功。单轮失败仍属于该 Session 的轮次结果，不永久改写 Agent 可用性。NanoClaw 通道连接由原列表合同单独展示，不能因 IM 离线把 Web Agent 标为不可用。此投影沿用单 Backend 实例边界，不用于共享 Chat Home 的多进程汇总。

消费者 `lib/long-agent-presence.ts` 校验版本、时间、身份唯一性和枚举；轮询失败/超时/隐藏转为未知，重新可见时重读。不支持没有明确记录的离开或待用户确认状态。读投影不落盘，不替代 Pi Session 终态及权限事实。

### Chat Web：轮次统计的时间来源

原生 `compactionSummary` / `branchSummary` 经公共读模型转换为已有 `custom` 消息（compaction / branch-summary），保留摘要和元数据；Pi 原记录不变。Session 详情及 context 响应的 `context.entryTimes` 是与 `messages/entryIds` 同长度的只读数组，元素为原生 Pi Entry 的入库 Unix 毫秒或 null。分支、压缩与审核插入沿用 `projectSessionContext` 的选择结果，不能把其他分支时间混入；不新增时间数据库或执行状态。Frontend 检查长度/数值，旧服务缺字段时不展示耗时。结尾用量从可见轮次的模型 usage 和工具调用身份汇总，用时为输入至末条回复/工具结果入库的跨度，包含等待，不冒充 CPU/模型推理净时长。

## 统一请求、执行反馈与入口适配（P1–P4）

公共装配输入见 [Context §15](./chat-context-resource-model.md#15-公共-agent-装配合同p12026-09-19)。Frontend/TUI/Nano 只能提交意图，Backend 负责解析身份、目标和每日 Session；不引入另一套模型 Runtime。

### 请求接受与来源

Friend Web 先接受并返回执行引用，再订阅事件。请求包含 schemaVersion、requestId、消息/附件、明确的 contextProjectId（项目 ID 或 null）；旧 projectId/sessionId 作为兼容定位输入，不能授权改变归属。服务端派生 actor、longAgentId、SessionRef、turnId、acceptedAt、日内序号、源渠道及受控回复目的地；校验正文/附件和模型能力，不保留“IM 支持图片但 Web 无条件禁用”的人为差异。

Nano 保持既有认证 Event/Delivery/Ack API，由薄适配把事件映射到同一接受服务。去重键是可信来源＋requestId/eventId，重复且内容一致返回同一引用，冲突返回 409。耐久接受前失败可重试；接受后页面不通过重新 POST 猜测进度，按稳定引用查询。已接受正文保存在现有耐久 pending envelope，执行时幂等写入原生消息，完成后按保留策略清理 envelope；它不是永久的第二份聊天历史。

执行失败、需要人工核实的中断、投递失败分别表达。重启后仅有 running 但无可恢复执行句柄时标记 interrupted；不能承诺任意外部工具 exactly-once，也不能自动重放结果未知的写操作。已提交终态和已保存原生回复可恢复，Nano Delivery 失败只重试投递。

### 公共反馈与恢复

统一的是 Pi payload、消费器和状态/渲染核心。Friend Agent envelope 带 schemaVersion、执行身份、单次执行递增 seq、时间及 event；status/reset 传递耐久状态与显示快照。Workflow 保留原生 Runtime 流协议和 stage/review 附加信息，不强造 Friend Workflow Stage，也不为格式一致改写 Workflow 的运行事实。

运行状态为 queued/running/waiting/completed/failed/cancelled/interrupted；浏览器连接状态另列 connected/reconnecting/detached，不能覆盖后端终态。公开响应必须运行时校验；未知版本提示升级，不按成功解析。

Frontend 共用聊天 reducer/render 和订阅恢复接口，各适配器只提供接受、读取状态、订阅和操作能力。现有 Workflow Runtime 流保留其运行事实；Friend 在现有生命周期中发同构事件，不另外启动 Workflow 来包裹 Friend。

重连先取原生 Session＋执行快照及其事件边界，再从该边界接流；用 executionId/seq/entryId/toolCallId 去重，快照替换当前未完成投影而非重复 append。无法补齐增量时明确 reset 后重读，不能拼接两个不同快照。流结束不等于完成；terminal 必须在持久终态确认后发出，随后核对原生历史。重启可保留中断前原生消息，但不承诺尚未落盘的每个 Token 都可重放。

### 操作能力与一致性

- 页面离开/停止等待仅断开观察，后台继续；显式取消按执行引用调用实际 Pi abort 和子 Workflow 取消路径，持久终态后反馈。已结束的取消幂等。
- 后续消息作为下一独立请求耐久接受，各自冻结项目和回复目的地；取消当前轮不隐式删除已接受后续消息，队列支持明确取消。
- 引导使用 Pi 原生 steer，仅当前活跃 Agent、同一可信发起者/回复目的地、同一冻结项目及权限可用；跨项目或跨来源引导拒绝并提供后续消息路径，不能半途替换装配。Workflow 人工审核/确定性阶段不能冒充可引导 Agent。
- 请求接受、排队、引导生效和模型完成是不同状态；追加原生用户记录与请求 ID 幂等关联。接受了引导但运行先结束时转为明确排队后续，不能悄悄丢消息。
- 模型图片能力、取消/引导/压缩等 capability 由 Backend 投影；共用控件按能力呈现并解释原因。P4 的实际差异见下方能力表；不能以永久隐藏全部控件代替实现，新增入口须核对实际执行能力。

精确路由与序列化以以下 P4 合同及前后端 Parser 为准；上面的来源、顺序和恢复原则同时适用于两个入口。

### Friend P3 接受与日历投影

P3 已在现有 Long Agent 状态中实现耐久接受信封、顺序 Worker、原生 Session 执行和日终恢复；Web messages 请求增加可选 requestId，成功响应仍为整轮结果。Friend 配置增加可选 timeZone；每日状态 GET/POST 的精确字段、操作、迁移与私聊边界以 [Long Agent §4.2.1](../modules/long-agents/chat-long-agent-architecture.md#421-p3-实现合同2026-09-19) 为单一合同。P4 的 Web 接受与订阅接入同一队列，不能由前端另维护队列事实。


### Friend P4 实时与控制合同

| API | 行为 |
|---|---|
| `POST /api/long-agents/:id/turns` | 严格解析 `{schemaVersion:1,requestId,sessionId?,contextProjectId,text,images?,sessionMemory?:"on"|"off"}`；校验并耐久接受后返回 HTTP 202 与执行引用 |
| `GET /api/long-agents/:id/turns/:turnId` | `{execution,snapshot}`；归属不匹配拒绝；snapshot 含 seq/messages/partial/phase |
| `GET .../turns/:turnId/events?after=N` | NDJSON Agent event/status/reset；只在耐久终态确认后关闭 |
| `DELETE .../turns/:turnId` | queued 取消或活跃 Pi abort；已结束幂等；装配中没有句柄时明确拒绝，不假报取消 |
| `POST .../turns/:turnId/steer` | `{requestId,text,contextProjectId}`；耐久接受、原生 Pi steer 或降为 follow-up；返回 delivery 和执行引用 |
| `GET /api/long-agents/:id/capabilities` | schema 1、longAgentId、images/manualCompaction/followUp；图片由有效模型解析，接受时再次校验 |

执行引用为 schema 1：kind=friend、id、longAgentId、存储 projectId、sessionId、协作 contextProjectId、status、error、acceptedAt、capabilities。Session 详情通过可选 friendExecution 提供同一结构。原 `/messages` 同步 API 保留兼容，当前 Web 不再使用。

`src/agents/session-events.ts` 是唯一 Pi 显示投影；`live-turn.ts` 只保留当前进程 Pi 句柄、瞬时显示状态和最近 256 条事件，不是耐久事件数据库。快照与 seq 同步捕获；过期游标返回 reset。前端按执行身份与 seq 去重，丢段重取快照，15 秒无流数据则重连；只执行 GET，不自动重发 POST。流关闭不能推导 completed。最后重读原生 Pi 历史；重启未落盘 Token 允许丢失，原生已落盘消息及中断结果保留。

引导用原生 `sendCustomMessage(deliverAs:steer)`，可展示的 `chat.friend-steering.v1` 保存请求 ID、父轮 ID 和冻结项目。只有 Web 来源且项目相同时可用。已进入原生队列的引导不能单独撤回，可以停止父轮；未被消费的耐久请求作为后续消息执行。Worker 用原生 CustomMessage 身份确认已消费，不靠文字去重，也不把已消费引导再次 prompt。父轮异常时已消费引导标 interrupted，保留历史供核实。

| 能力 | 普通 Workflow Session | Friend |
|---|---|---|
| 文字/工具/自动重试/自动压缩显示 | 共用 Pi 事件、reducer、组件 | 同左 |
| 完成/失败/取消/恢复 | Workflow Run 为事实源，原生 Session 为历史 | 耐久 Turn 为事实源，同一原生历史投影 |
| 显式停止 | 取消 Run 及子执行 | Pi abort；原有 workflow_call signal 取消子 Run |
| 引导、后续消息 | 当前 Workflow 未提供运行中追加合同；保留草稿，结束后发送 | 同项目原生 steer、耐久 follow-up；新项目只能 follow-up |
| 图片 | 现有 Workflow 接受合同 | 有效 Friend 模型能力；后端再次校验 |
| 手动压缩 | 既有入口尚未提供执行合同 | capability=false；自动压缩照常展示 |
| 阶段、人工审核 | 保留 Workflow 附加信息 | 不制造假 Workflow Stage |

普通 Workflow 原来显示但调用后仅报“不支持”的引导/后续按钮不再伪装可用；输入草稿仍保留。没有删除已实现的执行能力。P5 已完成旧数据副本迁移与本地全链验收；Nano 真实外部收发仍待验收，不能以本地验证替代，见[P5 记录](../history/reviews/2026-09-20-agent-unification-p5.md)。


### LA0 后续工作与会话边界

Friend 任务/群聊目标沿用本文件的模块分工，详见[机制 §9](../modules/long-agents/chat-long-agent-mechanism-contract.md#9-la0交互任务与调度的实施合同)与[Session §11](../modules/sessions/chat-session-architecture.md#11-la0独立工作与群聊的原生-session-合同)。Chat 拥有任务定义、执行绑定、原生历史及受权投影；Nano 拥有触发投影、耐久传输及 Delivery。LA0 不新增 HTTP/Tool Schema、不修改现有状态版本；LA1/LA2/LA5 新增字段须同时升级生产者、运行时校验和所有消费者，不借兼容字段透传未经验证的群/任务身份。

## LA1 后台工作边界

Frontend 的 `FriendWorkPanel` 通过 v1 work API 管理执行入口，正文和实时状态继续由共用 Session/turns/events 投影。`friend_work` 与 HTTP 调用同一 `work.ts` 服务；归属、固定项目、状态迁移、结果交付由 Long Agent 生命周期负责，公共装配和 Pi 不变。Schema 与取消/恢复合同见 [LA1](../modules/long-agents/chat-long-agent-architecture.md#la1独立后台工作实现合同)。Frontend 只持有未确认提交草稿；不能把轮询缓存或导航项目写成运行事实。

LA2 的 Task API v2、Nano 调度投影 v1、可信触发 202 和旧任务所有权迁移已进入实现，合同与兼容性统一见 [Friend 任务](../modules/long-agents/tasks.md)。执行仍引用 LA1 work/turn，不另建模型运行时。

LA4 的产物闭环（产物身份与幂等、内容冻结与提交校验、笔记落盘/站内发布状态、受众与来源、恢复）实现在 `src/long-agents/artifacts/`，配置经任务的 `deliverable` 字段，同源入口为 `/api/long-agents/:id/artifacts` 与 `artifact_manage` Tool，合同见 [Friend 产物闭环](../modules/long-agents/deliverables.md)。产物不新增调度器：发生与执行仍来自 LA2/LA1。

LA3 的职责领域（目标代号与并发版本分离、锁内 CAS、报告绑定、进度与证据、推进前置检查、回执与预算计量）实现于 `src/long-agents/duties/`，同源入口为 `/api/long-agents/:id/duties` 与 `duty_manage` Tool，合同见 [Friend 长期职责](../modules/long-agents/duties.md)。职责不复制执行状态机：推进仍由 LA2 任务/发生记录与 LA1 work/turn 承载。


### 主题 Session 创建与阶段反馈

主题是原生 Session 的业务身份与关联，不是另一套聊天运行时。`topic_manage.request_topic`、`POST /api/long-agents/:id/topics/creations` 与旧 integrations POST 的新请求都调用 `startTopicSessionCreation`。准备 Session/Run 存于发起 Friend home；来源由 Backend 解析；批准前没有目标 Session。旧 integrations 仅对已有 work 请求保留重放和旧响应形状；新请求返回审核 Run 引用，其 GET 状态返回 `kind:workflow` 与同一创建读投影。

原 `ChatSessionRunBinding` 的可选 `topicCreation` 仅保存 requestId/sourceSessionId/requestFingerprint，旧绑定仍可读；不复制审核内容或运行状态。`GET .../topics/creations?sourceSessionId=…` 联合已有绑定、Runtime、审核状态和图产物形成只读列表。身份一致的启动重试返回既有 Run；改变内容或来源拒绝。该保障不声称跨 Runtime 和文件系统的任意崩溃窗口具有 exactly-once 事务。

Frontend 的日常聊天和主题导航共用该读模型与共享审核卡片；修改/批准仍经公共 Run review API，取消仍经公共 Run cancel API。断线和刷新只 GET 既有引用，不能重启创建或重发正文。批准版本、草稿与最终创建共用服务端结构化事实源。

Friend 节点轮次在已有 live snapshot/Agent envelope 增加可选 `roundPhase:work|remember`；序列号和取消句柄贯穿两段。它是当前生命周期的显示阶段，不是伪造 Workflow Run/Step。终态仍从耐久 Turn 确认；未完成或已取消的记忆阶段不生成完成锚点。
