# 主题模式 P2 任务书：主题图与「会话记忆」workflow（后端能力）

状态：**草稿，待用户审核**。日期：2026-09-23。前置：P1（会话记忆底座）已独立复核通过，见 [P1 实施记录](../history/reviews/2026-09-22-topic-mode-p1.md)。合同见[主题模式任务书](./topic-mode-taskbook.md)，阶段计划见[开发计划](./topic-mode-plan.md) §2。

## 1. 本阶段目标：交付后端能力

**P2 只交付后端能力，用 API + 本地假模型证明。前端可见性归 P3（主题图视图/节点交互/记忆面板），真实模型完整故事归 P4。** 完成后后端具备：

1. **每轮 = `work → remember`**：节点会话里跑一轮普通 agent 产出结果，紧接着由 `remember` agent 把该轮（本轮产出与思考 + 用户发言）沉淀为会话记忆条目；
2. **Long Agent 能只读跨 Agent/跨树的记忆与全文**（带来源地址），据此**整合并创建**主题/节点，能**代传**，能更新节点状态；
3. **节点创建**产出：agent home 新会话 + 整合摘要（进入模型上下文）+ 初始会话记忆条目（带来源引用）+ 图登记，四步共用同一 `requestId`（幂等可重试）；
4. **节点会话 API**（读消息/发轮次/事件流）；识别为主题的会话在**所有入口**——节点 API、记忆 API、通用 Session 读写、Run 启动——走同一目标解析与授权；非主题会话沿用原合同；
5. **分叉**：新节点冻结锚点，父节点后续演进不影响它；真成环被拒；多亲合法；
6. **会话记忆开关**（主题/节点级）可关闭。

**不做**：Form B（跨轮有状态 workflow 绑定）、群会话的记忆、跨设备同步、真实外部平台（LA6 已交付）、前端 UI（P3）。

## 2. 开工前置（先落定再写功能代码）

1. **来源绑定派发链**（P1 未交付）：`sessionMemoryTarget: {storageProjectId, sessionId}` 经 `workflow-call-tool → workflow-call → ChatWorkflowInput → step → createWorkflowAgentSession → ChatToolRuntimeContext` 传递；嵌套继承不重盖；HTTP/模型参数不可自填。
2. **两条派发链**：外层 `session-memory` 在 agent home 的节点会话内启动、两 step 共用（不经 `workflow_call`，Session 与 run binding 归 agent home）；`work` 调业务 workflow 用既有 `workflow_call` 子会话与 run 归属（`collaborationProjectId === undefined ? projectId : collaborationProjectId`，显式 `null` 不回退）。
3. **授权范围**：Topic 授权只作用于**已识别为主题节点**的会话；非主题会话继续既有授权。
4. **锚点与 Skill**：只有整个外层 invocation 完成（`work`+`remember` 均终态）的轮次可分叉；Skill 路径 `src/resources/builtin-skills/session-memory/SKILL.md` 及其装配函数、历史读取签名（`history { afterEntryId?, limit? }`）在本阶段实现并测试。

## 3. 交付物（功能清单，含入口归属）

| # | 交付 | 落点 |
|---|---|---|
| 1 | **「会话记忆」workflow**：`work`（干活 agent）→ `remember`（写入 agent），每轮触发；`agentCallable: true`（供其他 workflow 在交接点调用） | `src/workflows/session-memory/{workflow.json,workflow.ts,step.ts,agents/{worker,writer}/…}` + `catalog.ts` |
| 2 | **主题图**：topics/nodes/edges（边带创建锚点 + memoryRefs）、防环、revision CAS | `src/long-agents/topics.ts` |
| 3 | **`topic-manage` 工具（已实现）**（Long Agent 入口）：① 跨 Agent/跨树**只读**读取会话记忆与全文（见 §4 来源地址）；② 建主题/建节点（提交整合产物）；③ 代传；④ 读图/读节点；⑤ 更新节点状态 | `src/tools/builtins/topic-manage/**`（照 `conversation-manage` 模式） |
| 4 | **节点创建服务**：`reserveChatSession` → 整合摘要 `appendCustomMessageEntry` → 初始 `background` 记忆条目 → 图 CAS 登记；四步同一 `requestId`，重试识别已写产物 | `src/long-agents/topics.ts` + `chat-session.ts` |
| 5 | **“说一句建题”接线**：从 Long Agent 的建题请求解析该 Friend 的**日常来源会话**，启动整合后台 work（`startFriendWork` 只接受日常来源），返回 work/execution 引用；补充整合走同一 `topic-manage` 领域入口（经用户确认） | `src/long-agents/topics.ts` + `work.ts` 复用 |
| 6 | **节点会话 API**：读消息 / 发轮次 / 事件流 | `src/routes/api/long-agents/[longAgentId]/topics/**` |
| 7 | **共享授权（读取已接入）**：read（跨树只读）/ relay（自己名下树）/ write（仅本会话记忆）在一处判定；节点 API、记忆 API、**通用 Session 读写与 Run 启动**在识别为主题节点后都走它；非主题会话走原合同 | `topics.ts` 共享函数，被 3/5/6 与 `sessions`/`runs` 路由复用 |
| 8 | **读侧按需读取**：`session-memory` 工具 + `session-memory` Skill（**不注入 prompt**） | `src/resources/builtin-skills/session-memory/SKILL.md`、现有工具 |
| 9 | **节点生命周期（已实现）**：既有 Session 被移除时把对应 node 标记 `removed`、**保留边**供溯源；`archived/removed` 节点拒绝 relay 与整合指向 | `topics.ts` + `session-removal.ts` 挂钩 |
| 10 | **随附业务 workflow**：问题定位 workflow（供主题会话按需调用，P4 实际使用） | `src/workflows/problem-diagnosis/**` + `catalog.ts` |
| 11 | **开关**：会话记忆可关闭 —— 不装配读取能力、不跑 `remember` | 节点记录字段 + workflow 判定 |

## 4. 方案要点（关键机制）

- **每轮 = 一次 workflow**：`work` step 在当前节点会话跑普通一轮 agent（连续会话逻辑不变）；`remember` step 用 `transformContext`（`src/workflows/agent-definition.ts`）把上下文**投影为当前轮**（本轮用户 entry + `work` stage 全部条目），前文与旧记忆由它按需读取。`triggerChatWorkflowAgentHandoff` 只作触发（它不传上下文）。
- **写入目标**：`session-memory` 工具目标来自派发盖章的绑定（P1 已就绪），节点会话内写入落在**当前节点会话**。
- **跨会话只读 + 来源地址**：`topic-manage` 提供跨 Agent/跨树**只读**操作，返回条目/全文，**每条来源引用为 `{storageProjectId, sessionId, entryId}`**（不是裸 `entryId`）。
- **溯源落点（唯一位置：图记录）**：来源映射保存在 `topics.json` 的 **`nodes[].initialMemoryRefs: [{ entryId, source: {storageProjectId, sessionId, entryId} }]`** —— 即“本节点初始记忆条目 → 其来源”，因此**根节点**（没有入边、没有 `memoryRefs`）也能回答“这条从哪来”。边的 `memoryRefs` 用**同一地址形状**记录跨节点引用。两处 schema 与主任务书 §3.2 一致；**P1 记忆条目本身不带来源地址**（只有 `originEntryId` 指向轮次），不要把它当作已有字段。
- **身份全部派生，不分配（“四步同一 `requestId`”的前提）**：Pi 支持显式 session id（`SessionManager.create(cwd, sessionDir, { id })` → `newSession({ id })`），因此节点身份是**纯函数**，不需要预留表：
  - `topicId = f(owner, requestId)`；`rootSessionId = f(topicId, requestId)`；`nodeSessionId = f(topicId, requestId)`；`nodeId = f(topicId, nodeSessionId)`。
  - `createTopic` **不接受** `rootSessionId`，`createTopicNode` **不接受** `sessionId`：调用方无法把“某个会话”登记成别的请求的节点，也不可能出现“预留的会话被登记成另一个会话”。
  - Chat 侧新增 `ensureChatSessionWithId(input, sessionId, displayName)`：会话文件已存在则重开（`created:false`），否则按该 id 创建（`created:true`）。**重试自行重算出同一 id**，因此“会话已落盘、图登记未完成”没有窗口、也不需要记录找回；登记后重试同样返回同一会话。
  - 该入口在**会话操作锁**（`chatSessionOperationKey(projectId, sessionId)`）内做“检查—创建—重开”：Pi 的文件名是 `<timestamp>_<id>.jsonl`，同 id 并发创建会留下两个文件，所以检查与创建必须在同一临界区（该锁**不可重入**，编排不要在同一 `projectId+sessionId` 上嵌套持锁）。
  - 同一把锁内**先查 pending 意图、再查活跃文件**：中断的移除可能在「意图已写、文件未移动」时留下活跃文件，中断的恢复可能已把文件移回但索引未完成——两种窗口都必须报 `SESSION_BUSY`，不能交出正在被移除/尚未完成恢复的会话。然后再查**生命周期状态**：`removed` / `purged` 的 id 一律拒绝创建（`SESSION_REMOVED` / `SESSION_PURGED`），恢复只能走既有 `restoreRemovedChatSession`；否则派生 id 会把已移除的会话（以及已标 `removed` 的主题节点）静默复活。
  - 根节点：新建主题的根会话 id 由**主题自身** `requestId` 派生，所以 `createTopic` 之前就能创建根会话（不存在“先有鸡还是先有蛋”）。
  - 归档主题仍拒绝新建节点；主题级 `updateTopicStatus` 只影响“能否新建”，不动节点状态。
- **旧文件容忍**：v1 图中缺少 `createdByRequestDigest` 的节点读作 `createdByRequestDigest: null`（legacy），任何重试对其 **fail-closed** 拒绝（“登记早于创建摘要”）；中间版本写出的 `reservations` 字段读入时直接忽略，因此既有图文件不会加载失败。
- **编排产物的请求身份（首轮检视补齐）**：① 创建摘要由**完整创建请求**判定，并额外折叠**编排指纹**（title/创建者/冻结 Project 上下文 + 整合摘要文本 + 初始记忆内容与 `originEntryId` + 来源地址 + 父边规格）——已登记节点重放时仍走 `createTopicNode` 的摘要比对，因此**换标题/换摘要/换记忆/换锚点都会 409**，不会被静默当成重放成功。② 初始记忆的去重身份是**记忆条目上的持久请求标记 `writeRequestId`**（`session-memory` 条目新增可选字段，缺省 `null`，旧文件照常可读），**不再用内容相等冒充请求身份**（内容相等会认领无关的既有条目）。③ 来源地址在**首次登记**前由领域服务解析：`TopicMemorySource` 指向**会话记忆条目**（`smem-*`，在 `<storageProjectId>` 的 agent home 中），**不是** Pi 全文条目（Pi 地址属于另一命名空间，只用于边的 `anchorEntryId`）；来源项目必须是 **Long Agent 归属**（普通项目会话没有主题图，`applicable:false` **不视为允许**，必须走其自身显式授权，本领域服务没有该授权因此拒绝）；来源会话必须处于活跃状态（已移除 → 409，符合 §3#9），记忆文件可读且该条目存在且未被推翻。**已登记请求的重放不做来源可用性检查**——先按不可变指纹识别既有节点，只有首次登记才要求来源当前可读。**锁与恢复的边界（重要）**：`withFileLock` **不可重入**（同一路径的回调不得再次申请该锁）。因此 ① 来源校验在 `createTopicNode` 中于**图锁之外**完成（已登记请求的重放跳过它），② 读取型守卫（`requireTopicMemorySource`、`ensureChatSessionWithId`）改用**不触发恢复**的 `readInactiveChatSessionState`：它就地解释耐久意图并返回 `pending`，让调用方 fail-closed，而**不**在图锁内触发恢复回调（该回调会收敛主题图＝再次申请图锁）。恢复仍只由真正的生命周期入口（remove/restore/purge/list）执行，并要求在清除 pending 前收敛记忆与主题图。
**校验位置在图写入口**：`createTopicNode`（首次登记）与 `addTopicNodeParent`（补边）对**每一个** `memoryRefs` 及 `initialMemoryRefs[].source` 都调用同一解析函数，因此任何调用方（含工具）都无法绕过；幂等早退分支（同父边已存在 / 已登记请求重放）不重复校验。**来源主题节点状态**：若来源会话对应某个主题节点且状态非 `active`（archived/removed），首次整合返回 409；普通 agent-home 会话不受此限。`initialMemory.originEntryId` 是**本会话内的轮次来源**，不与跨会话来源地址强行比较。
- **节点创建编排（四步一 `requestId`）**：`createTopicNodeWithSession` 在**该 `requestId` 专属文件锁**内按顺序完成 ① 派生会话并 `ensureChatSessionWithId` ② 整合摘要（CustomMessage，`customType: chat.topic-integration-summary`，`details.requestId` 去重）③ 初始 `background` 会话记忆（**多来源**：每个不同内容一条；条目带 `writeRequestId` + **`writeRequestFingerprint`**——由第一条条目**冻结整个请求**，中断重试先核对指纹再补缺失条目，改了请求内容 → 409；不再用内容相等冒充请求身份）④ `createTopicNode` 图登记（登记失败只在**图 revision 冲突**时重读重试，前三步已耐久且可重放）。锁的选择：请求锁用于整段编排；会话锁只在 `ensureChatSessionWithId` 返回之后用于②③（会话锁不可重入）；**不使用会话锁包整段流程**。
- **settled 锚点核验**（`src/long-agents/topic-anchor.ts`）：锚点有两个**耐久事实源**，同一条用户 entry 只算一个锚点（按分支位置排序、1-based 编号）：
  1. `chat.long_agent_turn` 标记 `status === "completed"` 的 Long Agent 轮次（取该轮次前的最后一条用户 entry）；
  2. **`chat.topic-round` 标记** `<roundId, userEntryId, status, settledAt>`——外层「会话记忆」Workflow 的整轮终态事实，**显式关联本轮用户 entry**（写入与读取都核对该 entry 确为**用户消息**，指向 assistant entry 的标记被拒绝/忽略），覆盖 `work` + `remember` 全轮（`appendTopicRoundMarker` 由该 Workflow 写入）。
  `running/failed/cancelled` 轮次与 assistant entry 都不是锚点；同一轮次的后续重试标记**不产生第二个锚点**。核验在**父会话的操作锁内**、写入任何产物**之前**完成（父轮次继续演进只会新增锚点，不会使已核验锚点失效）。`anchorEntryId`/`anchorSequence` 同时为空才表示“从起点分叉”；**指定 entry 就必须同时给定序号**。因此“`work` 完成、`remember` 未完成”时轮次尚未 settled，不可分叉。
- **`topic-manage` 工具**（`src/tools/builtins/topic-manage/**`，`system:tool/topic_manage`，risk `write`，permission `long-agent:topic`）：身份只取运行上下文的 `longAgentId`（模型参数不能指定 Long Agent 或存储项目），仅 `purpose === "execution"` 可用。操作：`read_graph` / `read_node` / `read_memory` / `read_fulltext`（跨树**只读**，走 `authorizeTopicSession(read)`；正确提取 `custom_message` 正文（整合摘要可读）、长条目带 `truncated` 标记、支持 `beforeEntryId` 游标翻页；会话记忆只存在于 Long Agent 归属会话，普通项目会话明确拒绝）/ `create_topic`（同一 `requestId` **且标题/目的一致**才幂等，内容不同 → 409）/ `create_node`（调 `createTopicNodeWithSession`；**`sources` 支持多来源**，每个来源一条初始记忆条目并各自记入 `initialMemoryRefs`；可传 `frozenProjectContext`；父边锚点必须 entry+sequence 成对）/ `add_parent`（调 `addTopicNodeParent`）/ `update_node_status` / `relay`。工具**不实现**来源、锚点、幂等或授权判定，全部委托领域服务；需要当前 revision 的写操作经 `withTopicGraphRevision` 在冲突时重读重试。**`relay`**（领域函数 `relayTopicNodeMessage`，全程在**节点会话操作锁内**）：**单次原生 user message 追加**，请求关联直接写在原生消息上——`message.chatTopicRelay = {requestId, targetNodeId, relayedByLongAgentId, source:"relay", textDigest}`（Pi 的 `parseSessionEntryLine` 是普通 `JSON.parse`，Chat 自有字段**原样往返**，已用「重新打开会话后仍可读到」验证）。因此：**不存在“消息已写、关联未写”的中断窗口**；重放按 `requestId` **精确匹配关联**（**不再用正文相同认领**，普通入口写入的同文用户消息不会被误标成代传）；**去重范围是整个会话文件（`getEntries()`），不只看当前分支**——单会话内切换 Pi 分支（`manager.branch(entryId)`）后重放**不会**再追加第二条；若原消息已不在当前分支 → **409**（既不重复追加，也不假装成功）。条目本身是**真实 user message**，后续节点轮次可 settled、可分叉（P3 读模型可直接用它渲染“代传 by <Agent>”）。**幂等键为 `(nodeId, requestId)`**（同一 id 指向另一节点是另一次代传），同键但正文 `textDigest` 不同 → 409。**状态与授权在锁内、紧邻追加处重新判定**，且 `updateTopicNodeStatus` 也先取**目标会话锁**再取图锁（与创建/relay 同为「会话锁 → 图锁」顺序），因此“归档与 relay 追加”互相排斥，归档排在前时 relay 必然看到 `archived` 并拒绝。**触发该轮执行属于节点会话 API/轮次 Workflow**，不在本工具内。

- **补边（R4 补充整合）**：`addTopicNodeParent` 与创建共用同一套门：**① 原样边规格才算幂等**（父/子相同但锚点或 `memoryRefs` 不同 → 409，不再按两个节点 ID 静默返回旧边）；**② 新边必须在父会话锁内做 settled 锚点核验**（`requireTopicAnchor`），再登记边；③ 父边 `memoryRefs` 走同一来源解析。**锁序**：预检（读图比较边规格 → 父会话锁核验锚点 → 来源解析）在**图锁之外**完成，随后才进图锁做 CAS 落盘，因此与编排的“会话锁 → 图锁”顺序一致，不会形成反向锁序。
- **节点只读 API（§3 表格第 6 行读取部分，已实现）**：`GET /api/long-agents/{longAgentId}/topics`（主题图 + 节点 `readable`）、`GET .../topics/{topicId}`（单主题 + 节点 + **仅该主题节点之间的边**）、`GET .../topics/{topicId}/nodes/{nodeId}/messages`（节点消息，复用 `readChatSession`；**必须 `node.topicId === topicId`**，否则 404 —— URL 只能是唯一一致路径）。**会话 id 一律由图解析**，客户端从不提供 sessionId，因此该路由不能被指向任意会话；共享主题判定与共享会话读取判定同时生效（`readChatSession` 现在自带存储归属，见下）。
- **节点会话绑定（已实现的状态地基，方案 1）**：state 新增 `nodeSessions: [{longAgentId, sessionId, topicId, nodeId, createdAt}]`（schemaVersion 5 → 6，v5 → v6 迁移只携带该版本拥有的字段）。**唯一性**：`sessionId` 与 `nodeId` **各自唯一**（同一节点不能绑两个会话，同一会话也不能服务两个节点）——但 **`topicId` 故意不唯一**：一个主题是**多节点树**，根节点与各子节点各有自己的会话与轮次；此外节点会话不能同时是每日会话或后台工作；turn 归属校验接受 `dailySessions` / `works` / 节点绑定三类。**迁移备份与收据**：备份只写给**来源版本低于该迁移目标**的状态（v5 状态就是 v5 的目标，不再被记为 `long-agent-work-v5` 的来源），legacy 收据只在**目标版本已落盘**后修复（读取时若仍需升级，收据在状态写入成功之后才补写）；v5 → v6 是无损升级（仅新增空数组），因此**不建自己的备份与收据**。
- **节点轮次的接受与执行（已实现）**：`POST /api/long-agents/{longAgentId}/topics/{topicId}/nodes/{nodeId}/messages`（body 只有 `{schemaVersion, requestId, text}`）：
  1. **接受侧**：`acceptLongAgentTurn` 增加 `topicNode: {topicId, nodeId}` 入口——**从主题图核实**（节点存在、`node.topicId === topicId`、会话即该节点会话；客户端不能传 `sessionId`），随后 `ensureProjectLongAgent` 的 `topicNode` 入口**只定位**（当日日期 + 该 Agent 时区 + 打开节点会话），**不动** `dailySessions` 与 primary 绑定；**节点绑定与 turn 在同一次 `updateLongAgentState` 写入**中保存（`nodeSessions` upsert 与 `turns` 追加同事务），turn 记录带 `topicNode` 目标。
  2. **执行侧**：`openAcceptedDay` 除每日记录外也接受**节点绑定**（返回以该节点会话为 primary 的定位，`sessionDate` 取绑定创建日），因此**重启后** Worker 仅凭耐久状态即可选回节点会话执行；不表达为 `works`。
  3. **重放**：同 `requestId` 的节点重放要求会话/主题/节点与既有记录一致，否则 409；普通轮次新增“同一 requestId 不能改投其他会话”的 409。
  全链已用真实会话验证：发轮次 → 重启（丢弃进程内缓存、只读耐久状态）→ 节点会话内执行到 `completed` 并写 `settledAt` → 该轮成为可分叉锚点 → 用该锚点建子节点。
- **事件流**：节点轮次的事件流可直接复用既有 `GET /api/long-agents/{longAgentId}/turns/{turnId}/events`（返回 `turnId` 后前端即可订阅）；主题作用域的 `.../stream` 门面属于 P3 展示层，等节点轮次落地后再决定是否需要。
- **节点生命周期挂钩（§3 表格第 9 行，已实现）**：`applyTopicNodeSessionLifecycle` 是**唯一可离开 `removed` 状态**的写入者（它镜像会话文件的事实）：`removeChatSession` 在「意图已写、文件已移动、完成前」把节点标 `removed`；`restoreRemovedChatSession` 把节点恢复为 `active`；`purge` 之后节点保持 `removed`（会话已永久消失，节点留作历史）。**边始终保留**供溯源；普通会话（非主题节点）为 no-op。它只取图锁（会话锁由移除流程持有，锁序仍为会话锁 → 图锁）；面向用户/Agent 的 `updateTopicNodeStatus` 仍视 `removed` 为终态。
- **恢复路径也必须收敛节点**：`recoverPendingOperation` 的收敛回调（`lifecycleConvergence`）除会话记忆外，**在清除 pending 之前**同样收敛主题节点状态（remove → `removed`、restore → `active`、purge → 保持 `removed`），因此“文件已移动但图写入失败”的中断不会留下 `active` 节点。`topics.ts` 已**静态**依赖 `removed-session-index.ts`，反向依赖用**惰性 `import()`** 解析以保持静态依赖图无环。
- **通用读取入口的主题判定（§3 表格第 7 行读取半，已实现）**：`assertSessionFileReadable`（detail / history / transcript / export / 未来节点 API 与事件流共用）在群参与判定之外，按会话的存储项目读取主题图并调用 `authorizeTopicSession(read)`；存储项目**由已解析的会话文件给出**（`readChatSession` 等通用入口不依赖调用方是否显式传入 `projectId`，否则该判定会被静默跳过）：`{kind:"owner"}`（或未声明身份）视为本地用户，`{kind:"friend", longAgentId}` 视为该 Agent。非主题会话不受影响；被移除的节点会话仍由既有会话生命周期错误拒绝（`SESSION_REMOVED`）。
- **整合产物落两处**：整合摘要（CustomMessage，进入上下文）+ 初始 `background` 条目（带 §4 的来源引用）。
- **防环**：加边只检查 `parent !== child` 且不存在 `child → … → parent`；`memoryRefs` 只校验来源存在与可读（**不禁止继承父记忆**）。新建节点没有出边，结构上不可能成环，因此防环真正生效的地点是**补边**（对既有节点追加父边，R4 补充整合），创建与补边共用同一检查。
- **图约束（首轮检视补齐，均为阻断项）**：
  1. **同树**：边的两端必须属于同一 `topicId`；跨树复用只记录为 `memoryRefs` 来源引用，绝不建图边。
  2. **单根**：一个主题只有一个根；无父节点的登记必须就是该主题的 `rootSessionId`，且同一 `rootSessionId` 不能属于两个主题（否则会话唯一规则会让真正的根永远无法登记）。
  3. **整合指向**：`archived/removed` 节点既不能作为整合来源，也不能接受新的整合（§3 表格第 9 行）；relay 同样在锁内重判状态。
  4. **`requestId` 是创建身份（创建摘要，不是反推）**：登记节点时把**创建请求的不可变摘要**（`createdByRequestDigest`：topic/session/title/创建者/冻结 Project 上下文 + 初始记忆来源 + 完整父边规格——父 ID、`anchorEntryId`、`anchorSequence`、`memoryRefs`；集合顺序不敏感）写进节点记录。`createTopicNode` 先按 `createdByRequestId` 查重：摘要相同返回**同一节点**（不新增节点、不涨 revision），摘要不同（换 `sessionId`/标题/锚点/来源）返回 **409 冲突**；`(topicId, sessionId)` 分支同样按摘要判定。
     **不允许从节点的当前入边反推原请求**：入边可被 R4 补充整合改变，反推会导致“同一 `requestId` 换了锚点却被静默当成成功”和“合法补边后原样重试反而 409”两种错误时序（两条均已有回归测试）。
  5. **状态不可复活**：`removed` 是终态，普通 `updateTopicNodeStatus` 不能改回 `active`；状态更新同样要求 `expectedRevision`；`archived/removed` 拒绝 relay（读保留，供溯源）。主题级 `updateTopicStatus` 只影响“能否新建节点/预留”，不动节点状态。
- **锚点**：节点读模型给出可分叉锚点（当前分支、用户 entry、invocation、终态），创建时在 Session 锁内核验并冻结，同时冻结记忆 revision；不使用 `forkChatSession()`。
- **代传**：一条**真实 user message**（持久标记 `source:"relay"` + 代传 Agent），并同步更新读模型与前端解析（前端展示在 P3）。
- **remember 的可见回复**必须关联工具实际返回的 entry ID 与 revision。

## 5. 测试（功能为主；P2 用 API + 假模型）

| # | 测试 | 断言 |
|---|---|---|
| T1 | workflow 两 agent 跑通（假模型） | `work` 产出结果；`remember` 写入条目并引用工具返回的 entry ID/revision |
| T2 | `remember` 的上下文范围 | 捕获模型实际输入：只含**当前轮**；旧记忆经读取工具可得 |
| T3 | 节点创建 | 图登记 + 初始记忆 + 摘要进入上下文；**同一 `requestId` 重放幂等**（不产生第二个节点/摘要）；**根节点的初始记忆可回答来源**（entry→来源引用） |
| T4 | 分叉 | 锚点定格（父继续 5 轮后子的初始上下文不变）；多亲合法；真成环被拒 |
| T5 | 代传与生命周期 | relay 是真实 user message + 标记可见；越权（他人树）拒绝；**会话被移除后 node `removed` 且边保留**，archived/removed 拒绝 relay |
| T6 | 权限（含绕行入口） | owner 可读写节点会话；树属 Agent 可代传；跨树只读可；写他人记忆拒绝；**通用 Session 读写与 Run 启动（如 `POST /runs`）对主题节点走同一授权，越权被拒** |
| T7 | 开关 | 关闭后不装配读取工具、不跑 `remember`，普通对话不受影响 |
| T8 | 后端端到端（假模型） | 建题请求 → 日常来源解析 → 后台整合 work → 建节点 + 初始记忆 → 节点内一轮（work+remember）→ 分叉 → 第二主题跨树引用父记忆；全程 API 断言 |
| T9 | 随附业务 workflow | 主题会话内调用问题定位 workflow 返回结果（假模型），run 归属符合 §2 第 2 条 |

退出条件：T1–T9 有证据；`pnpm verify` exit=0；无新增运行时旁路（不新建 Session/调度器/模型循环）。真实模型完整故事与浏览器可见性分别归 P4/P3。

## 6. 检视点

1. 记忆是**按需读取**而不是每轮注入（token 视角）。
2. `remember` 确实只看到当前轮。
3. 锚点/防环语义正确；父节点演进不影响已建子节点。
4. read/relay/write 在**一个共享函数**里判定，且**通用 Session/Run 入口**也复用（无绕行）。
5. 跨树读取与初始记忆溯源都有 `{storageProjectId, sessionId, entryId}` 地址，根节点可答来源。
6. 没有新增并行机制。

## 7. 阶段边界

- **P1（已通过）**：会话记忆底座（存储/工具/API/生命周期）。
- **P2（本任务书）**：后端能力；用 API + 假模型证明。
- **P3**：前端主题图视图、节点会话交互、记忆面板、整合状态机（依赖本阶段节点 API）。
- **P4**：真实场景验收（问题定位端到端 + 真实模型 + 证据归档）。
