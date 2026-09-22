# Friend 群聊与多 Friend 协作合同（LA5）

状态：**本地单 Backend 群聊实现已验收**（2026-09-20 起）。2026-09-21 的最终实测结果和验收范围见[验收记录](../../history/reviews/2026-09-21-long-agent-la5-acceptance.md)，实现进度以 §9 为准；未完成项不得写成已发布能力。本文是 LA5 的唯一模块合同，对象与 Session 的权威语义在[机制 §9](./chat-long-agent-mechanism-contract.md#9-la0交互任务与调度的实施合同)与 [Session §11](../sessions/chat-session-architecture.md#11-la0独立工作与群聊的原生-session-合同)，发布路径在 [Workflow 返回](../workflows/chat-subworkflow-design.md)，本文件不复制它们，只给出群聊特有的对象、字段、存储、状态机、入口与验证映射。

## 1. 范围

实现：用户与多个现有 Friend 组成群；指定/@、圆桌、并行、主持、自由讨论与一次 A→B 请教；群内研究任务；群管理（成员、协作项目、策略、预算、启动/停止/归档）；公共实时展示与受权历史；撤权/退群/重置的授权期语义。

不做：第二套 Agent Runtime、模型客户端、调度器或聊天前端；不复制 Friend 身份（群成员是同一 Friend 的独立参与 Session）；不把 NanoClaw Agent Group 当群；LA5 不做外部平台真实群投递与 24h 运行（LA6）。

## 2. 场景 → 对象 → 状态转移（短设计）

| 场景 | 主要对象 | 状态转移要点 | 调用链 | 验证 |
|---|---|---|---|---|
| S1 建群 + @A | Conversation、Participation(A/B)、SpeechAttempt(A) | conversation: active；attempt(A): queued→running→published；B 无 attempt | Web→API→Workflow(指定策略)→A 参与 Session→发布 | V1,V2,V7 |
| S2 同 Friend 四处并行 | Participation × N、Work、Daily Session | 各 Session 独立 owner；容量超限 → attempt: queued(reason=capacity) | 同一 Resolver/工厂，不同 SessionRef | V2,V8 |
| S3 圆桌 A→B→A | Discussion、round plan | round=n 冻结输入 cutoff；每人只读已提交公共引用 | Workflow 顺序 stage | V4 |
| S4 并行 | Discussion(parallel round)、共同 cutoff | 每个 attempt 独立终态；按提交顺序发布；汇总只读已提交 | Workflow 并行 stage | V4 |
| S5 主持/自由 | Discussion(policy=moderator/free)、预算 | 选择决策计入预算；非法选择被服务拒绝；允许无人响应并终止 | 主持 Friend 参与 Session 产出选择 → 服务校验 → 下一 attempt | V4 |
| S6 无人观看继续 | Discussion、Run | 达到预算/轮数/无进展即结束；刷新恢复游标 | 同上，无额外触发源 | V6,V8 |
| S7 A 请教 B | Delegation、Participation(B) | A→B→A 链深有限；B 独立 Session；返回引用不伪造工具结果 | A 的工具创建 Delegation→B 参与 Session→返回发布 | V5 |
| S8 群内研究任务 | FriendWork(来源=群/Entry) | 任务等待不持群写锁；完成只发布授权结果引用 | work 独立 Session→完成后按群来源发布 | V5,V8 |
| S9 改配置/停止/归档 | Conversation revision、Authorization 期 | 旧 run 用旧 revision；停止不再派发；退群产生新授权期 | API/Tool CAS→运行前校验 | V7,V10,V11 |

## 3. 对象与存储

存储归属：Conversation 的公共记录归其**固定存储 Project**（用户 Project，或用户未指定时的普通 Daily Project）；参与 Session 归同一存储 Project；成员资格只授权**公共投影**，不继承 Project 文件、其他参与 Session 或私有 Memory。

| 对象 | 关键字段 | 存储 |
|---|---|---|
| Conversation | `conversationId`（`conv-<hash(创建 requestId)>`）、`title`、`storageProjectId`、`collaborationProjectId`（冻结协作目标，默认 `null`，**不等于存储 Project**）、`publicSessionId`、`lifecycle`(active/archived)、`members[]`、`authorizationRevision`、`policy`、`budget`、`createdAt/updatedAt` | `CHAT_HOME/projects/<storageProjectId>/conversations.json`（注册表，文件锁 + 原子写） |
| Participation | `conversationId`、`longAgentId`、`authorizationEpoch`（加入次数）、`sessionId`、`joinedAt`、`revokedAt` | 上表 `members[]` 内；Session 文件在 `projects/<storageProjectId>/sessions/` |
| Discussion / Run | `discussionId`、`conversationId`、`policy`、`round`、`inputCutoffEntryId`、`budgetSnapshot`、`status`(planned/running/waiting/completed/stopped/failed/interrupted)、`stopReason`、`workflowRunId` | `CHAT_HOME/projects/<storageProjectId>/conversations/<conversationId>/discussions.json` |
| SpeechAttempt | `attemptId`、`discussionId`、`round`、`speakerLongAgentId`、`participationEpoch`、`inputCutoffEntryId`、`replyToEntryId`、`causationId`、`definitionRevision`、`authorizationRevision`、`status`(queued/running/published/failed/skipped/cancelled)、`reason`、`publicationId` | 同上（`discussions.json` 内嵌） |
| Publication | `publicationId`（由 attempt + 源 Entry 推导）、`conversationId`、`publicEntryId`、`sourceSessionId`、`sourceEntryId`、`contentHash`、`audience`、`publicSeq`、`postedAt` | 公共根 Session 原生 Entry（`chat.group-publication.v1`）+ 可重建索引 `publication-index.json` |
| Delegation | `delegationId`、`conversationId`、`fromLongAgentId`、`toLongAgentId`、`originEntryId`、`returnTarget`(conversation/entry 或 work)、`depth`、`budgetRemaining`、`status` | `discussions.json` 内嵌（父 discussion） |

公共消息不是第二份文本日志：公共根 Session 保存原生 `user` 消息（真实发送者）与每位参与者公开块的**引用 Entry**；参与者 Session 保存自己的输入、原生 assistant/toolCall/toolResult 与压缩。派生索引只保存指针与摘要，可重建。

## 4. 权限与模型输入

1. **Scope 由服务端解析**：每轮执行冻结 `LongAgentScope`（`kind`=direct/background/conversation、`conversationId`、`storageProjectId`、`collaborationProjectId`、允许/禁止项、`excludedCapabilities[]`、`revision`）。浏览器与 Agent 不能通过 `sessionId`/`projectId`/`author` 伪造绑定。
2. **默认拒绝**（group scope）：不注入日终交接、不注入 Agent Group/Standing Instructions、不注入 Personal/Project 上下文文件与 Personal Prompt 资源（Extension/Skill/Prompt 模板整类不加载）、不注册任何 Tool——包括 Chat 系统 Tool（`social_manage`、`project_read`、`project_search`、Memory、`workflow_call`、`friend_work`、`channel_send` 等）、原生 Pi Tool（`read`/`bash`/…）与 Extension/MCP Tool。能力只能由会话记录里的显式授权放宽；放宽后仍在注册处过滤，并在创建后校验“实际注册集 ⊆ 授权集”，越权即中止本轮。
   - **硬拒绝**：没有群范围校验的能力即使显式授权也不注册，并在授权写入时直接拒绝（`assertConversationGrantsAllowed`）。原生 Tool 仅允许 `read/write/edit/ls/find/grep`（已按本轮项目/自身工作空间裁剪）；Extension/MCP Tool 与 `bash` 等可在本地执行任意命令、可能访问私有 owner API/其他群/私有 Session 的能力一律不可授权。Chat 系统 Tool 当前允许集为空，包括只读的 `conversation_manage`（它跨该 Friend 的多个群，只作私聊能力）。
3. **裁剪发生在读取/注册/装配之前**：`resolveChatAssemblyContext` 冻结 scope 并据此过滤 contextFiles、资源目录、系统 Tool 地址；被排除项进入 `excludedCapabilities` 并可在能力检查页说明原因。
4. **公共投影统一受权**：公共历史、实时流、引用详情、搜索、完整历史、分支、附件都走同一投影函数；无授权不返回正文；源缺失/损坏显示不可用引用，不回退读私有 Session。
5. **数据不是指令**：他人文本进入参与 Session 时是带来源的 `custom_message`，保留原作者与公共 Entry 引用，不提升为 system/工具回执/人类批准。
6. **撤权生效点**：派发前、工具注册前、公开提交前三次校验当前 `authorizationRevision` 与参与期；迟到结果保留受限审计、不补发到旧群；历史保留不等于撤权后可读。

## 5. 发言策略与预算

策略都是同一 Workflow 编排入口的不同配置，不各写 Agent loop。

| 策略 | 选择方式 | 终止条件 |
|---|---|---|
| `mention` 指定/@ | 用户显式指定；未指定时按会话 `defaultPolicy` | 目标全部终态 |
| `round-robin` 圆桌 | 冻结顺序，每轮每成员一次 | 达 `maxRounds` 或全部 skipped |
| `parallel` 并行 | 同一 `inputCutoffEntryId` 冻结输入快照，分别执行 | 全部终态后汇总 |
| `moderator` 主持 | 指定 Friend 产出下一位选择（计入预算） | 选择非法重试有限次；达预算/轮数 |
| `free` 自由 | 有界选人决策，允许沉默 | 达 `maxRounds`/无进展/预算 |
| `consult` 请教 | 由可信来源创建 Delegation（A→B） | 链深、预算或返回完成 |

预算（启动前必须冻结，均有上限）：`maxRounds`、`maxModelCalls`、`maxWallClockMs`、`maxConcurrentSpeakers`、`maxDelegationDepth`、`maxTokensSoft`（Token 只能事后精确计量，标记为软限制）。计数来源为每次实际模型调用；主持、重试、工具引起的子工作都计入同一父预算，不得逃逸。

## 6. 发布、恢复与并发

发布沿用 Session §11：源 Entry 耐久落盘 → 公共根锁内重开、按 `publicationId` 幂等追加引用 → 更新可重建索引；`publicationId = pub-<hash(conversationId, attemptId, sourceSessionId, sourceEntryId, version)>`，同键异载荷为冲突。

| 写入口 | 授权 | 预期版本 | 锁顺序 | 幂等键 | 恢复 |
|---|---|---|---|---|---|
| 用户发消息（公共根） | 会话 active + 成员/管理者 | `conversationRevision` | 公共根 Session 锁 | `clientMessageId` | 重连按持久游标；不重复追加 |
| 群配置变更（成员/策略/预算/归档） | 管理者 | `expectedRevision` CAS | 注册表文件锁 | `requestId` | CAS 失败提示重读 |
| 发言派发（attempt） | 参与期 + 授权 revision | `definitionRevision` | 状态文件锁 | `attemptId` | queued 可恢复；running 缺终态 → interrupted |
| 公开提交（publication） | 提交前再校验成员/受众/授权 | `sourceEntryId` + 摘要 | 公共根锁内重开 | `publicationId` | 源已提交、根未提交 → 只重试发布 |
| 群内任务（工作） | 来源群/Entry 可信 + 返回目标 + **独立 Task Session** + 预算来源（`source`） | `originEntryId` | 工作创建锁 | `workId` | 独立 Task Session 完成后只发布授权结果引用（`conversations/<id>/works.json`）；`discussion` 来源计入根讨论预算，`user` 来源有独立预算；取消后结果不发布、终态不被覆盖 |
| 撤权/退群/归档 | 管理者 | `authorizationRevision` | 注册表文件锁 | `requestId` | 不撤销已执行副作用，只阻止后续读取/发布 |

等待模型、其他 Friend 或后台结果时释放执行占用与 Session 写锁，不持锁等待；单 Backend 同 Home 是现有边界，不声称跨进程 exactly-once。

## 7. 入口

- HTTP:`/api/long-agents/[longAgentId]/conversations*`:`POST/GET` 创建/列表;`[conversationId]` 的 `GET`(详情 + 讨论/尝试状态)与 `PATCH`(CAS 配置);`[conversationId]/members`(revoke/rejoin/setGrants/add)、`[conversationId]/archive`、`[conversationId]/messages`(GET 公共投影 + 用户消息;POST 幂等用户消息)、`[conversationId]/discussions`（POST 启动耐久编排，202+runId）、`[conversationId]/consult`（POST 启动一次耐久 A→B→A 请教，202+runId）、`[conversationId]/works`（GET 任务列表；POST start/cancel 群内后台任务）、`[conversationId]/stop`。所有写入口拒绝未知字段,不接受内联身份/scope。实时公共流为 `.../conversations/[conversationId]/stream`(SSE)。**身份是入口属性,不来自请求**:该路由是 owner 面(与其余本地 owner API 同一信任级,产品无浏览器登录),不接受任何身份参数,未知查询参数(含任何 viewer 提示)在流建立前直接 400;Friend 侧读取不走该路由,而是由服务函数用 Backend 已解析的群作用域构造成员 viewer(`memberConversationStreamViewerFromScope`),绑定到该群并每 tick 复核。执行状态、Agent Tool 与 Web 管理面板归 D(后端 API 已完成,Tool/Web 待续)。
- Tool：`conversation_manage`（Agent 侧只读 + 受权提议；不能自行扩大成员或授权）。
- Web：交流区可创建/选择群；中央复用现有聊天组件与事件流；顶栏显示群名/成员/协作项目/讨论状态；管理区承载成员、策略、预算；状态含等待模型/选人/排队/并行/待发布/已完成/失败与终止原因，结束汇总显示实际调用量。

## 8. 状态机

```text
Conversation: active ─(归档)→ archived ─(恢复)→ active
Participation: joined ─(退群/撤权)→ revoked ─(重新加入)→ joined(新 epoch，新 Session)
Discussion:  planned ─(启动)→ running ─┬→ completed
                                        ├→ stopped(用户/预算/无进展)
                                        ├→ failed(全员失败/非法策略)
                                        └→ interrupted(重启缺终态)
SpeechAttempt: queued ─→ running ─┬→ published
                                  ├→ failed ─(有界重试)→ running
                                  ├→ skipped(未选中/无进展)
                                  └→ cancelled(停止/撤权)
Publication:  pending ─→ committed ─(投递)→ delivered        （pending 表示源已落盘、公共根未确认）
```

## 9. 工作包与进度

| 包 | 内容 | 状态 |
|---|---|---|
| A 合同与权限基础 | 本文档；`src/long-agents/scope.ts` v2（三种 scope、**默认拒绝**、`excludedCapabilities`、授权元组 + 授权承诺 `grantsDigest`、真实注册地址、`applyScopeToCapabilities`）、装配快照 v2（v1 兼容）、公共工厂的资源/工具注册级裁剪与创建后泄漏校验、`src/long-agents/capabilities.ts` 与只读检查路由 `GET /api/long-agents/[id]/capabilities` | **完成**（证据：`test/long-agents/scope.test.mjs` 7 项，含真实 Pi 请求哨兵隔离、工具绕过尝试失败、direct/background 回归、伪造 scope 被可信授权承诺拒绝、能力检查与执行一致） |
| B 执行与发布 | **注册表 + 参与 Session + 发布已落地**：Conversation 注册表（`src/long-agents/conversations/`，`CHAT_HOME/projects/<id>/conversations.json`）、公共根 Session 创建、成员参与期与独立参与 Session 绑定、配置 CAS（成员/授权/策略变更提升 `authorizationRevision`）、撤权/重新加入/归档、`resolveParticipationScope` 产出**可信 scope + 授权承诺**（默认拒绝，已与装配校验对齐） | **已验收（LA5 本地单 Backend 群聊范围）**：发布（`publication.ts`，锁内二次鉴权）、普通详情/历史/附件/导出/历史的读取守卫、统一增量消息合同与公共流每 tick 鉴权、**SSE HTTP 路由**（owner 入口；**身份不来自请求**，未知身份参数 400；成员 viewer 仅由 `memberConversationStreamViewerFromScope(scope)` 构造，绑定该群并逐 tick 复核）、真实 HTTP 长连接验收、**身份边界静态+运行时门禁**、**真实发言派发** `dispatch.ts`（同调用栈解析 scope→公共工厂→参与 Session→执行前后各校验授权→发布）、讨论/尝试持久化与**恢复/中断**、发布与撤权的**锁内提交顺序**。证据：`test/long-agents/{conversations,conversation-publication,conversation-read-guards,conversation-dispatch,conversation-identity-boundary}.test.mjs` 与 `scripts/conversation-stream-http.test.mjs` |
| C 编排与委派 | 策略 Workflow、预算计量、群内任务来源扩展、请教链 | **已验收（本地范围）**：统一编排入口 `src/long-agents/conversations/orchestrator.ts`（mention/round-robin/parallel/moderator/free 五策略 + 默认不广播、冻结输入 cutoff、moderator 有界重试、free 允许沉默）；**原子预算**：`claimDiscussionModelCall` 在 discussions 文件锁内“检查+递增”，并经公共 Pi 装配的 `providerRequestGate` 在**每个 provider 请求前**（含工具续轮）准入/拒绝，讨论发言、派生 work、并行成员共享同一根预算，不通过结束事件事后补计数；**S2** 同 Friend 多群独立上下文 + 并发容量排队（超 `maxConcurrentSpeakers` 尝试保持 `queued` 带原因，`waiting` 可恢复）；**S8** 群内后台任务 `conversations/work.ts`：每个 work 拥有**独立的耐久 Task Session**（`sessionId`，与参与 Session 不同），模型轮次按**参与 Session 之外的 turn-lock** 串行，不进入群历史也不阻塞该 Friend 的群发言；**预算归属**：`source` 区分 `discussion`（派生子工作，模型调用计入根讨论，耗尽即 denied）与 `user`（仅 owner API 可创建，独立预算）；**取消/终态**：取消与发布提交共享 `work-commit-lock` 仲裁（锁序 public-root → work-commit），发布在锁内“重读状态→决策→append”并由同一个 release 覆盖，取消先获锁则发布被拒、发布先获锁则取消排队且不越权；取消可中止运行中模型，终态 CAS 不覆盖已取消，迟到结果不发布、不覆盖 `cancelled`/恢复出的终态，`finishWork` 带预期状态 CAS；启动恢复将 running work 标 failed 不重放。A→B→A 请教链（深度上限）。耐久编排 `src/workflows/group-discussion/`。证据：`conversation-orchestrator.test.mjs` 9 项、`conversation-work.test.mjs` 5 项、`conversation-execution-protocol.test.mjs` 8 项、`scripts/group-conversation-http.test.mjs`、`scripts/group-recovery-restart.test.mjs` |
| D Web 与管理 | 群管理 API/Tool/设置面板与状态展示 | **已验收（本地范围）**：后端 `/api/long-agents/[id]/conversations*`（创建/列表/详情/配置 CAS/成员/archive/messages/discussions/consult/works/stop；严格拒绝未知字段）；Agent 侧只读 `conversation_manage` Tool（身份来自 `toolContext.longAgentId`，只能看自己是成员的群，propose 只返回待确认建议）；Frontend `lib/friend-conversations.ts`（运行时校验、不发送身份）；**交流区**工作区导航新增“群聊”入口与中央 `LongAgentGroupChatView`（复用公共 `MessageView`、公共历史 + SSE 实时流 + 发送消息 + @一轮 + 状态），设置页 `LongAgentConversationsPanel` 专管成员/策略/预算/归档。证据：`test/tools/conversation-manage.test.mjs`、`frontend/lib/friend-conversations.test.mjs`、`scripts/group-browser.test.mjs`（真实浏览器） |
| E 集成验收 | 自动化 + 真实模型 + 真实浏览器联合验收与自审 | **已验收（本地单 Backend 群聊范围）**：真实 Nitro HTTP 全流程；**真实浏览器**（已装 Chrome/Chromium，经 CDP 驱动，不新增依赖）验证导航入口→中央群聊→公共历史→SSE 实时回复→发送；**真实模型**（现有 `~/.chat/agent` 配置以 symlink 接入隔离 Home，不复制/不输出/不改正式配置）跑通群回合；**真实进程 SIGKILL/重启**验证 running→interrupted 不重放、queued 恢复。证据：`scripts/{group-conversation-http,group-browser,group-real-model,group-recovery-restart}.test.mjs`。S1–S9/V1–V12 映射见验收记录；独立复核及修复已完成，最终证据见验收记录 |

## 10. 验证映射

必需矩阵（V1–V12）与真实验收最低链见 [LA5 任务书](../../development/long-agent-la5-taskbook.md#9-必验矩阵)。本合同的实现必须逐条给出“测试/证据”引用；哨兵隔离类断言（V3）必须检查**实际模型请求输入**，不得只断言 metadata。

## 11. 与既有合同的关系

对象语义：[机制 §9](./chat-long-agent-mechanism-contract.md#9-la0交互任务与调度的实施合同)；原生映射与发布：[Session §11](../sessions/chat-session-architecture.md#11-la0独立工作与群聊的原生-session-合同)；公共装配：[公共装配合同](../../architecture/chat-context-resource-model.md#15-公共-agent-装配合同p12026-09-19)；后台返回：[Workflow 返回](../workflows/chat-subworkflow-design.md#la1-实际返回路径)；任务/职责/产物沿用 [tasks.md](./tasks.md)、[duties.md](./duties.md)、[deliverables.md](./deliverables.md)；实施差距以[实施状态](./chat-long-agent-roadmap.md)为准。


## 12. 提交异常与停止（2026-09-21 验收修正）

- work 仲裁锁取得后，状态读取/解析/授权失败均由取得方释放；成功返回 release 才移交 publication 的 finally。append/flush 失败也必须释放公共根与提交锁。回归见 `conversation-commit-failure.test.mjs`。
- 用户停止讨论与发布共用提交仲裁，停止先成立则迟到群发言/派生任务结果不得公开；请求门拒绝后续调用，编排收尾不得把 stopped/interrupted 覆盖为 completed。已发出的 provider 请求可能仍完成，但不再发布其迟到结果。
- 圆桌每位新发言者在前一位提交后冻结自己的公共输入和 cutoff；同一 attempt 重试沿用持久快照，不重新取历史。并行仍使用轮次预先准备的输入。


### 预算持久化失败的收尾

Provider 回报的 Token 用量通过串行写入链保存。Pi 的同步事件回调不等待 I/O，但下一次 provider 请求准入和本轮收尾必须等待这条链；写入失败则拒绝续轮及公开结果，保留失败终态，不忽略错误后继续执行。讨论与独立 user work 使用相同约束，分别计入各自的耐久预算。`maxTokensSoft` 是事后计量的软限制，单次响应或已经准入的并发响应可能超出余额，不声称 Token 精确硬限额。
