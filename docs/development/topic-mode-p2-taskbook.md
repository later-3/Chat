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
| 3 | **`topic-manage` 工具**（Long Agent 入口）：① 跨 Agent/跨树**只读**读取会话记忆与全文（见 §4 来源地址）；② 建主题/建节点（提交整合产物）；③ 代传；④ 读图/读节点；⑤ 更新节点状态 | `src/tools/builtins/topic-manage/**`（照 `conversation-manage` 模式） |
| 4 | **节点创建服务**：`reserveChatSession` → 整合摘要 `appendCustomMessageEntry` → 初始 `background` 记忆条目 → 图 CAS 登记；四步同一 `requestId`，重试识别已写产物 | `src/long-agents/topics.ts` + `chat-session.ts` |
| 5 | **“说一句建题”接线**：从 Long Agent 的建题请求解析该 Friend 的**日常来源会话**，启动整合后台 work（`startFriendWork` 只接受日常来源），返回 work/execution 引用；补充整合走同一 `topic-manage` 领域入口（经用户确认） | `src/long-agents/topics.ts` + `work.ts` 复用 |
| 6 | **节点会话 API**：读消息 / 发轮次 / 事件流 | `src/routes/api/long-agents/[longAgentId]/topics/**` |
| 7 | **共享授权**：read（跨树只读）/ relay（自己名下树）/ write（仅本会话记忆）在一处判定；节点 API、记忆 API、**通用 Session 读写与 Run 启动**在识别为主题节点后都走它；非主题会话走原合同 | `topics.ts` 共享函数，被 3/5/6 与 `sessions`/`runs` 路由复用 |
| 8 | **读侧按需读取**：`session-memory` 工具 + `session-memory` Skill（**不注入 prompt**） | `src/resources/builtin-skills/session-memory/SKILL.md`、现有工具 |
| 9 | **节点生命周期**：既有 Session 被移除时把对应 node 标记 `removed`、**保留边**供溯源；`archived/removed` 节点拒绝 relay 与整合指向 | `topics.ts` + `session-removal.ts` 挂钩 |
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
  - 同一把锁内还查**生命周期状态**：`removed` / `purged` 的 id 一律拒绝创建（`SESSION_REMOVED` / `SESSION_PURGED`），恢复只能走既有 `restoreRemovedChatSession`；否则派生 id 会把已移除的会话（以及已标 `removed` 的主题节点）静默复活。
  - 根节点：新建主题的根会话 id 由**主题自身** `requestId` 派生，所以 `createTopic` 之前就能创建根会话（不存在“先有鸡还是先有蛋”）。
  - 归档主题仍拒绝新建节点；主题级 `updateTopicStatus` 只影响“能否新建”，不动节点状态。
- **旧文件容忍**：v1 图中缺少 `createdByRequestDigest` 的节点读作 `createdByRequestDigest: null`（legacy），任何重试对其 **fail-closed** 拒绝（“登记早于创建摘要”）；中间版本写出的 `reservations` 字段读入时直接忽略，因此既有图文件不会加载失败。
- **编排产物的请求身份（首轮检视补齐）**：① 创建摘要由**完整创建请求**判定，并额外折叠**编排指纹**（title/创建者/冻结 Project 上下文 + 整合摘要文本 + 初始记忆内容与 `originEntryId` + 来源地址 + 父边规格）——已登记节点重放时仍走 `createTopicNode` 的摘要比对，因此**换标题/换摘要/换记忆/换锚点都会 409**，不会被静默当成重放成功。② 初始记忆的去重身份是**记忆条目上的持久请求标记 `writeRequestId`**（`session-memory` 条目新增可选字段，缺省 `null`，旧文件照常可读），**不再用内容相等冒充请求身份**（内容相等会认领无关的既有条目）。③ 来源地址在**首次登记**前由领域服务解析：`TopicMemorySource` 指向**会话记忆条目**（`smem-*`，在 `<storageProjectId>` 的 agent home 中），**不是** Pi 全文条目（Pi 地址属于另一命名空间，只用于边的 `anchorEntryId`）；来源项目必须是 **Long Agent 归属**（普通项目会话没有主题图，`applicable:false` **不视为允许**，必须走其自身显式授权，本领域服务没有该授权因此拒绝）；来源会话必须处于活跃状态（已移除 → 409，符合 §3#9），记忆文件可读且该条目存在且未被推翻。**已登记请求的重放不做来源可用性检查**——先按不可变指纹识别既有节点，只有首次登记才要求来源当前可读。**校验位置在图写入口**：`createTopicNode`（首次登记）与 `addTopicNodeParent`（补边）对**每一个** `memoryRefs` 及 `initialMemoryRefs[].source` 都调用同一解析函数，因此任何调用方（含工具）都无法绕过；幂等早退分支（同父边已存在 / 已登记请求重放）不重复校验。**来源主题节点状态**：若来源会话对应某个主题节点且状态非 `active`（archived/removed），首次整合返回 409；普通 agent-home 会话不受此限。`initialMemory.originEntryId` 是**本会话内的轮次来源**，不与跨会话来源地址强行比较。
- **节点创建编排（四步一 `requestId`）**：`createTopicNodeWithSession` 在**该 `requestId` 专属文件锁**内按顺序完成 ① 派生会话并 `ensureChatSessionWithId` ② 整合摘要（CustomMessage，`customType: chat.topic-integration-summary`，`details.requestId` 去重）③ 初始 `background` 会话记忆（同一请求重放时按 `purpose+author+originEntryId+content` **采用既有条目**，不追加第二条）④ `createTopicNode` 图登记（登记失败只在**图 revision 冲突**时重读重试，前三步已耐久且可重放）。锁的选择：请求锁用于整段编排；会话锁只在 `ensureChatSessionWithId` 返回之后用于②③（会话锁不可重入）；**不使用会话锁包整段流程**。
- **settled 锚点核验**（`src/long-agents/topic-anchor.ts`）：锚点有两个**耐久事实源**，同一条用户 entry 只算一个锚点（按分支位置排序、1-based 编号）：
  1. `chat.long_agent_turn` 标记 `status === "completed"` 的 Long Agent 轮次（取该轮次前的最后一条用户 entry）；
  2. **`chat.topic-round` 标记** `<roundId, userEntryId, status, settledAt>`——外层「会话记忆」Workflow 的整轮终态事实，**显式关联本轮用户 entry**（写入与读取都核对该 entry 确为**用户消息**，指向 assistant entry 的标记被拒绝/忽略），覆盖 `work` + `remember` 全轮（`appendTopicRoundMarker` 由该 Workflow 写入）。
  `running/failed/cancelled` 轮次与 assistant entry 都不是锚点；同一轮次的后续重试标记**不产生第二个锚点**。核验在**父会话的操作锁内**、写入任何产物**之前**完成（父轮次继续演进只会新增锚点，不会使已核验锚点失效）。`anchorEntryId`/`anchorSequence` 同时为空才表示“从起点分叉”；**指定 entry 就必须同时给定序号**。因此“`work` 完成、`remember` 未完成”时轮次尚未 settled，不可分叉。
- **整合产物落两处**：整合摘要（CustomMessage，进入上下文）+ 初始 `background` 条目（带 §4 的来源引用）。
- **防环**：加边只检查 `parent !== child` 且不存在 `child → … → parent`；`memoryRefs` 只校验来源存在与可读（**不禁止继承父记忆**）。新建节点没有出边，结构上不可能成环，因此防环真正生效的地点是**补边**（对既有节点追加父边，R4 补充整合），创建与补边共用同一检查。
- **图约束（首轮检视补齐，均为阻断项）**：
  1. **同树**：边的两端必须属于同一 `topicId`；跨树复用只记录为 `memoryRefs` 来源引用，绝不建图边。
  2. **单根**：一个主题只有一个根；无父节点的登记必须就是该主题的 `rootSessionId`，且同一 `rootSessionId` 不能属于两个主题（否则会话唯一规则会让真正的根永远无法登记）。
  3. **整合指向**：`archived/removed` 节点既不能作为整合来源，也不能接受新的整合（§3 表格第 9 行）。
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
