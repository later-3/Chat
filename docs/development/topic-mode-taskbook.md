# 主题模式任务书（Topic Mode：主题会话树与会话记忆）

状态：**草稿（已吸收 Trae Agent doc review R1–R12，全部采纳；回复见 §9），待用户批准后开工**。日期：2026-09-22。前置：LA6 已完成并打 tag（Chat `v0.4.0` / frontend `v0.8.12` / nanoclaw `v2.5.0`），生产 release 运行中。本任务书按 feature 实际功能命名，不占用 LA 序号；总目标与既有阶段见 [LA0–LA6 计划](./long-agent-functionality-plan.md)。**执行计划（分阶段目标/方案/注意事项/验证/检视点）见 [主题模式开发计划](./topic-mode-plan.md)**。P1（会话记忆底座）已独立复核通过（证据见 [P1 实施记录](../history/reviews/2026-09-22-topic-mode-p1.md)），P2 起按其阶段推进。

> **【Doc Review · Trae Agent · 2026-09-22】** 本文档已完成一轮独立 doc review：文中所有 `【Doc Review · Trae Agent】` 批注（R1–R12）均为检视意见（问题 + 建议），未改动正文语义，是否采纳由本文原作者判断。检视时已核实正文引用的既有机制均属实：`AcceptedTurn.seed` 的 `chat.agent-assembly` 前缀合同、duties 的 `withFileLock` + `atomicWriteJson` + revision CAS、`ChatToolRuntimeContext.sessionId`、`ChatWindow.tsx`、三个前置 tag。其中 **R9 为关键未定项，建议批准开工前先落定**。

## 0. 一句话

Long Agent 作为**上下文策展人**创建并管理主题会话树：用户描述一个问题，Long Agent 从既有会话沉淀的**会话记忆**中整合出核心上下文、开一个新的主题会话；用户在里面与 workflow 多轮交互、随时分叉；节点关系构成**有向无环图**（多亲合法，边带创建锚点）；Long Agent 对自己创建的树了如指掌，并可代为传话。

## 1. 完成后用户获得什么

以问题定位为例：项目里长期积累的问题、共性知识、前置信息沉淀在各个会话的**会话记忆**里。用户对问题定位 Long Agent 说“我遇到 XX 问题”，它找出相关内容、去重整理、开一个新的主题会话——用户进来就能直接干活，不用自己翻历史找上下文。聊到一半可以分叉出子会话（第 20 轮 fork，父会话继续活着）；同一个 Long Agent 可以同时开多个主题。前端能看到所有主题、它们的**关系图**（谁从谁的第几轮分出来、初始上下文来自哪些会话的哪些记忆）、点进任意节点直接对话。

不做什么：不新增第二套 Session 运行时；不做会话与 workflow 的跨轮有状态绑定（Form B，见 §3.4）；不改动 mem0 与 NanoClaw memory；不新增登录/多租户；主题会话不改用 Pi 的 `parentSession` 血缘指针（图由 Chat 拥有，见 §3.2）。

## 2. 术语与行动者

| 术语 | 含义 |
|---|---|
| 主题（topic） | 一棵树的根，由一个 Long Agent 创建，有自己的目的与标题 |
| 节点（node） | 主题树中的一个**普通会话**（Pi session），可交互、可跑 workflow |
| 边（edge） | “子节点创建自父节点的第 N 轮之后”，并记录初始上下文使用了父节点的哪些会话记忆条目（provenance） |
| 会话记忆（session memory） | 会话的耐久伴生物，按目的分类的条目（背景/经验/规则/结论 + 自定义标签），由 workflow agents 主动维护、用户可查看/指定/修改 |
| 整合（integration） | Long Agent 在创建节点时的真实策展动作：选取相关会话的记忆条目，去重、整理逻辑关系，形成新节点的初始上下文 |
| 代传（relay） | Long Agent 以显式标记的 relay 身份，向**自己名下主题树**的任意节点注入一条用户轮 |

**行动者分工**（本合同的根基，不允许可机洗）：

| 行动者 | 职责 |
|---|---|
| 用户 | 在节点会话里与 workflow 多轮交互；查看/指定/修改该会话的会话记忆 |
| workflow 内部 agents | 干活，并**主动**维护本会话的会话记忆 |
| Long Agent | 创建主题与节点、整合初始上下文、维护主题图、代为传话；可经受控桥**只读**访问会话全文 |

**权限边界**：代传（写用户轮）仅限**自己创建的主题树**内全部节点（Long Agent 是树的根）；读全文与整合允许跨主题、跨 Long Agent（受控只读桥）；**写其他会话的会话记忆一律不允许**。

## 3. 必须先落定的合同

### 3.1 会话记忆（session memory）

- **归属与存储**：`<agent home>/session-memory/<sessionId>.json`，版本化文件（沿用 `withFileLock` + `atomicWriteJson` + revision CAS 原语，与 duties 同款合同）。按 `sessionId` 键控，与 Long Agent 解绑——任何 agent home 内的会话（日常/后台工作/主题）都可拥有；群会话（project 持有）本阶段不接入。

> **【Doc Review · Trae Agent】R1（缺口）** 会话被既有删除/清理流程移除后，`session-memory/<sessionId>.json` 是跟随删除、归档保留还是悬挂未定义，T1 也未覆盖。建议补一句合同（倾向：会话删除不自动删记忆，条目标记 orphan，避免 Long Agent 整合时读到死条目后无法溯源）。
> **【回复 · 原作者】R1：采纳：会话删除不自动删记忆，条目标记 orphan；已落入 §3.1 与 T1。**
- **条目结构（追加式，统一 schema）**：文件级 `{ schemaVersion, sessionId, orphan, revision, entries }`；条目级 `{ entryId, purpose, author, content, originEntryId, supersedes, status, createdAt, updatedAt }`。`status = active|superseded`（**不设 archive**，推翻即 superseded）；`orphan` 标在文件上（会话删除后保留）。
  - `author: "agent" | "user"`——**语义来源归属**：从 agent 内容（含其产出）提炼的记为 `agent`，从用户发言（含对其的浓缩）提炼的记为 `user`；逐字引用与蒸馏不区分归属，只看内容源自谁。
  - `purpose` 核心五类：`background` 背景 / `goal` 目标 / `experience` 经验 / `rule` 规则 / `finding` 结论；允许自定义标签（白名单），核心五类语义写入机制合同，不随 Agent 自造。工具操作 = `list | write | supersede`。
  - **追加式 + 可推翻**：条目只增不改；修改/推翻 = 新增一条带 `supersedes: <旧 entryId>`，旧条目置 `status: "superseded"`（退出整合默认集，仍可溯源）。用户在 UI 的编辑同样走“新条目 + supersedes”，不原地覆盖。
  - `originEntryId` 指向来源轮次 entry（可核验“这条从哪来”）。
- **写入者**：workflow 内部 agents 通过 `session-memory` 工具主动写（新增/推翻，带 purpose 与 author）；用户经前端查看、补充、推翻；其他会话/其他 Agent **无写权限**。
- **记录纪律的载体（§3.4 的「会话记忆」workflow agent，不是代码逻辑）**：纪律内容写在该 workflow agent 的 systemPrompt 中（同 `memory` workflow 的 Memory Agent 模式），并按基线的 Skill 生效合同可随请求展开。内容约定四件事：
  1. **什么时候记**：结论落定、背景/前提被澄清或变更、目标确立或调整、约束/决定被确认、踩坑或有效做法、阶段收尾回顾；**A→B 交接点**（上游把结果交给下游时）是天然记录点，由接手方（或专门的整理节点）判断是否落条目——这是 workflow 编排层的用法，不是运行时新机制。
  2. **什么不记**：寒暄与过程性对话、原始日志/大段代码（记路径或指针）、已被既有条目覆盖的重复内容、被立即推翻且无教训的临时假设、凭据等敏感信息（沿用既有红线）。
  3. **标签怎么选**：按五类语义对号入座；领域特化用自定义标签，但一条只表达一个事实。
  4. **身份怎么标**：按语义来源标 `agent`/`user`；蒸馏不改变归属。
- **与 Memory 的边界**：会话记忆是 **session 级、为主题模式服务**的沉淀；不写 mem0，不写 NanoClaw memory，也不等于跨会话的个人/项目 Prompt 资源。三层记忆（用户 mem0 / Long Agent NanoClaw memory / session memory）互不代写。
- **不是唯一信息渠道**：Long Agent 整合时可读会话全文；会话记忆只是高效索引。
- **会话删除/移除（PL4）**：挂钩既有删除入口 `removeChatSession`（路由 `POST /api/sessions/[sessionId]/remove`）——remove → session-memory 文件**不自动删除**，条目标记 `orphan: true` 保留可溯源，整合读取时来源标注“来源会话已删除”；**purge（`purgeRemovedChatSession`/过期清理）→ 记忆文件一并删除**（隐私对齐）。
- **写入目标解析（PL1，已按检视 14 统一）**：目标 = **可信绑定 `{storageProjectId, sessionId}`**（唯一合同）。由节点发起服务解析，经 `workflow-call-tool → workflow-call → ChatWorkflowInput → step → createWorkflowAgentSession → ChatToolRuntimeContext` 传递并持久化；**嵌套调用继承原绑定，不重盖成中间子会话**；HTTP/模型参数不可自填。**未获得绑定的普通项目会话不得因此获得 agent home 的记忆写入能力**（回退前必须校验当前会话属于受支持的 agent home）。

### 3.2 主题图（topics）与节点

- **归属与存储**：`<agent home>/topics.json`，Long Agent 拥有，版本化 + revision CAS。结构：`{ topics: [{ topicId, title, purpose, status, createdAt, rootSessionId }], nodes: [{ nodeId, topicId, sessionId, title, status, frozenProjectContext, createdAt, createdBy, initialMemoryRefs: [{ entryId, source: { storageProjectId, sessionId, entryId } }] }], edges: [{ edgeId, parentNodeId, childNodeId, anchorEntryId, anchorSequence, memoryRefs: [{ storageProjectId, sessionId, entryId }], createdAt }] }`。**来源地址统一为 `{storageProjectId, sessionId, entryId}`**（边上的 `memoryRefs` 与节点上的 `initialMemoryRefs.source` 同形）。**根节点的初始记忆溯源记在图记录的 `nodes[].initialMemoryRefs`**（根没有入边，边的 `memoryRefs` 覆盖不到）；不要声称 P1 记忆条目自带该字段——P1 条目只有指向轮次的 `originEntryId`。
- **不用 Pi 血缘指针**：Pi 的 `parentSession` 是单亲且与多亲 DAG 语义冲突；主题图的边完全由 Chat 拥有。主题会话是**普通 Pi 会话**（`openChatSession` 于 agent home），Pi 侧零改动。
- **防环（已按检视 05 修正）**：加边 `parent → child` 时只做两项检查——`parent !== child`，且图中不存在 `child → … → parent` 的既有路径。**不再用“memoryRefs 命中祖先即拒绝”**（那会拒绝正常的父记忆继承）。`memoryRefs` 单独校验：来源条目存在、来源会话可读（读权限见 §3.6）。创建与补边（R4）执行同一检查。

> **【Doc Review · Trae Agent】R2（表述不清）** 防环判定式不精确：`memoryRefs.fromSessionId` 可指向非节点会话（如 daily session），笼统的"上下文来源不得包含祖先链"无法直接实现。建议明确定义：祖先集 = 沿 edges 可达的全部节点；成环判定 = 新节点的任一 `memoryRefs.fromSessionId` 命中祖先节点的 sessionId；后续补边（见 R4）时同样执行该检查。
> **【回复 · 原作者】R2：采纳（**2026-09-22 二次修正**）：原表述会拒绝正常父记忆继承，已改为“加边只检查 parent≠child 且无 child→…→parent 路径；memoryRefs 单独校验来源与读权限”；见 §3.2。**
- **锚点口径**：`anchorSequence` 按**主分支已 settled 的用户轮序**计数；`anchorEntryId` 定格具体 entry。Pi 内部分支不改变已定格锚点，仅影响展示口径。
- **边是冻结的**：锚点（父会话 entry）与 memoryRefs 在创建时定格；父会话之后的演进不自动流入子节点。
- **补充整合（对既有节点）**：一个独立的整合动作，产物两种落法——经**用户确认**后写入目标节点的会话记忆（这是 §3.7 写入者规则的显式留痕例外），或经 relay 注入一条消息；同一动作追加边，并执行上面的防环检查。

> **【Doc Review · Trae Agent】R3（表述不清）** `anchorSequence`（"第 N 轮"）的计数口径未定义：Pi 会话支持内部分支/steer，以哪条分支的已 settled 用户轮序为准？建议明确锚点按主分支 settled 用户轮序计数、`anchorEntryId` 定格具体 entry（内部分支不改变已定格锚点，仅影响展示口径）。
> **【回复 · 原作者】R3：采纳：锚点按主分支 settled 用户轮序计数，entryId 定格；已落入 §3.2。**

> **【Doc Review · Trae Agent】R4（机制缺失）** "对现有节点的显式补充，需留痕"未说明产物走什么通道，且存在内部矛盾：`AcceptedTurn.seed` 只在会话创建时生效；往既有节点写会话记忆与 §3.7 决策表"Long Agent 只在创建整合时写新节点初始条目"冲突；多亲边（第二个父）在什么动作下产生也未写。建议明确：补充 = 新的整合动作，产物经 relay 注入或经用户确认后写入记忆，同一动作中追加边，补边执行 R2 的防环检查。
> **【回复 · 原作者】R4：采纳并修正矛盾：定义“补充整合”动作（用户确认写记忆 / relay 注入），补边走防环；§3.7 写入者例外已更新。**
- **节点生命周期**：状态 `active | archived | removed`。父会话归档/删除不删除子节点，边保留仅供溯源。节点会话被既有删除/清理流程移除时，node 标记 `removed`、边保留；`archived`/`removed` 节点**拒绝 relay**（409），拒绝整合指向。

> **【Doc Review · Trae Agent】R5（缺口）** 终态行为不全：① 节点会话被既有删除/清理流程移除后，topics.json 如何反应（node 标记 removed？边是否保留）未写，T8 只测重启不测此况；② relay 目标为 `archived` 节点是否允许未写（§3.5 只写越权拒绝）。建议补齐（倾向：节点标记 removed、边保留仅供溯源；archived 节点拒绝 relay）。
> **【回复 · 原作者】R5：采纳：node `removed`、边保留；archived/removed 拒绝 relay；已落入 §3.2/§3.5 与 T8。**
- **锚点可选规则（检视 17 定稿）**：只有**整个外层 invocation 已完成**（`work` 与 `remember` 均终态）的轮次可分叉；`work` 已完成但 `remember` 尚在写入、以及失败/取消轮**不可选**。
- **节点会话与 workflow 派发链（R9 三件事，已落定；R9② 按 PL2 修正为沿用既有语义）**：① 节点会话存 **agent home**（`long-agents/<id>/sessions`），与日常/后台工作一致；② **外层 `session-memory`**：Session 与 run binding 均归 **agent home**（外层在节点会话内启动，不经 `workflow_call`）。
③ **内部业务 Workflow**：子 Session 与 run binding 按既有 `workflow_call` 目标项目归属（`collaborationProjectId === undefined ? projectId : collaborationProjectId`）；冻结协作项目为**显式 `null`** 时业务 `workflow_call` **不回退**，调用被拒绝。节点会话文件始终在 agent home，`workflow-call` 的 `parentSessionManager`（agent home 会话）+ 显式 `projectId` 派发为既有能力（LA1/LA4 后台工作在用）；④ 节点会话的消息读取/发轮次/事件流走**新的节点会话 API 族**（见 §4 B 包）；授权见 §3.7（Topic 授权只作用于**已识别为主题节点**的会话）。
- **并发**：同一 Long Agent 的 topics.json 写入走 revision CAS；两个创建请求并发时只有一个赢家。
- **预算**：整合是一次真实模型调用（Long Agent 执行），单次整合的输入规模与产出规模有明确上限；会话记忆单条与单会话总量有上限。超限明确失败，不静默截断。

### 3.3 节点创建与整合

- **入口**：用户在对话中请求，或前端“新建主题/分叉”按钮——两者都必须经 Long Agent 整合后创建，**不允许绕过策展直接开节点**。

> **【Doc Review · Trae Agent】R6（缺口）** 前端“新建主题/分叉”触发的是异步 Long Agent 整合，整合中/失败/预算超限（T9）时按钮侧的中间态、失败可见性与重试方式未描述。建议在 C 包补前端状态合同：pending → 整合中 → 成功出节点 / 失败（原因可见、可重试）。
> **【回复 · 原作者】R6：采纳：C 包补整合状态机 idle/integrating/success/failed；已落入 §3.3 与 §4。**
- **整合产物落两处（已按检视 02 修正）**：① 写入新节点的会话记忆，作为初始 `background` 条目（provenance 指回来源条目 id）——agent 按需读取并可继续维护；② 整合摘要用 Pi `appendCustomMessageEntry()` 持久化一次并带来源元数据（**custom message 才进入模型上下文**）；**不使用 `AcceptedTurn.seed`**（该通道只接受 `chat.agent-assembly` 装配快照，摘要放进去会被解析器拒绝）。创建重试必须识别已写摘要，避免重复。
- **整合必须有效果**：默认只取 `status: "active"` 的条目；去重（合并指向同一事实的条目）、逻辑关系整理、按目的归位；不得原样拼接。整合结果与所选来源（memoryRefs，含被 superseded 的溯源链）一起留痕，Long Agent 必须能回答“这个结论从哪来、是否仍是最新”。
- **整合执行载体（R7 + PL3）**：整合在 Long Agent 的**后台 work**（`startFriendWork`，独立执行上下文）运行——它是一个**feed 可见的后台工作**，标题约定「整合：<主题标题>」，失败按既有 work 失败链路展示，不隐藏；不污染用户可见的日常对话。产物以 `topic-manage` 工具的**结构化入参**提交（title/purpose/memoryRefs/按目的正文）并留痕；工具调用记录即“整合真实发生”的证据（T2 直接引用）。鉴权/CAS/防环/上限等按 Chat 既有架构惯例实现，不作为本 feature 的重心。
- **前端状态合同（R6）**：新建/分叉触发异步整合，按钮状态机 `idle → integrating（显示整合的 Long Agent 与输入摘要）→ 成功出节点 | failed（原因可见：预算超限/成环/校验失败，可重试）`；整合中不可重复触发。

> **【Doc Review · Trae Agent】R7（表述不清）** 整合调用的执行载体未写：在 daily session 执行会污染用户可见对话。建议明确整合在后台 work/独立执行上下文运行，产物以 `topic-manage` 工具的结构化入参提交并由服务端校验（title/purpose/memoryRefs/去重正文），工具调用记录即"整合真实发生"的证据来源（T2 可直接引用）。
> **【回复 · 原作者】R7：采纳：整合在后台 work/独立上下文执行，产物经 `topic-manage` 结构化提交；已落入 §3.3。**
- **冻结项目上下文（R8）**：节点创建时冻结 `frozenProjectContext`（沿用既有 per-turn collaboration context 模型），节点内的轮次使用该冻结值；父节点的项目上下文不自动继承，由 Long Agent 在整合时决定并记录。**节点内该上下文只读展示、不可切换**——既有 per-turn 切项目 UI 在节点内禁用；需要换项目 = Long Agent 重新整合新节点。

> **【Doc Review · Trae Agent】R8（行为冲突）** 既有 per-turn collaboration context 每轮可切换项目（interaction-project / FriendProjectContext UI），节点内强制冻结值意味着该项目切换 UI 在节点内需禁用或每轮校验等于冻结值，一句"沿用"掩盖了这个行为分叉。建议写明节点内的项目上下文交互（倾向：冻结值只读展示，节点内不允许切换）。
> **【回复 · 原作者】R8：采纳：节点内项目上下文只读展示、不可切换；已落入 §3.3。**

### 3.4 workflow：Form A 与「带会话记忆的 workflow」

- 主题会话是普通会话：每轮按需派发 workflow（既有机制），**不做**会话↔workflow 实例的跨轮绑定。
- **每轮的 workflow 就是「会话记忆」workflow**：第一个节点是正常干活的 agent（连续会话逻辑）；需要专门流程时，它按需调用业务 workflow（如问题定位），走既有 `workflow_call` 能力——业务 workflow 不需要感知会话记忆。会话记忆关闭时，该轮就是普通模型轮。
- **读（按需，不注入）**：主题会话每轮的 workflow 第一个节点就是**正常干活的 Pi agent**（连续会话逻辑，多轮上下文天然连续）。**不把会话记忆注入 prompt**（每轮注入会持续消耗 token）；只提供读取会话记忆的 **Skill / 工具**，agent 自己按需读取——想读就读，不读也不影响主流程。
- **写（每轮触发，这是重点）**：workflow 的第二个 agent = **会话记忆写入 agent**。每轮在主 agent 完成后运行一次，**默认只给它当前轮**：
  1. **主 agent 本轮的输出与思考过程**；
  2. **用户这一轮的消息**。
  前面几轮会话与现有会话记忆**不预塞**，由它自己**按需读取**（工具）——让模型按上下文判断需要看多少，避免固定开销。"续写/修正/去重"靠它主动读前文与既有条目实现。**实现要求（检视 01）**：当前轮投影用 `transformContext`（`src/workflows/agent-definition.ts`）实现，work 阶段的条目要收集**整个 stage**（多个 assistant entry 与工具条目），不能只取最后一个 leaf；**不能依赖 `triggerChatWorkflowAgentHandoff` 传上下文**——它只把 entry ID 写进 CustomMessage 的 `details`，历史上下文依然存在。
> **投影原语现状**：`projectCurrentRoundContext()`（`src/workflows/session-conversation.ts`）已实现并测试——保留最后一条 user 消息及其之后的一切（本轮用户条目 + 整个 work stage），stage 标记因为是 `custom` 条目不进上下文，所以以“最后一条 user 消息”为边界；**没有 user 消息时返回 `null`（拒绝写入）**，绝不退化成“把全部历史交给 writer”。**注意**：既有的 `prepareWorkflowTurnContext` 不做轮次投影（它保留全部历史、只过滤控制消息），必须与前者组合使用。外层 workflow 本体（`src/workflows/session-memory/**`）、Skill 装配、开关与节点接线仍未实现。
- **开关**：会话记忆功能可关闭（主题/节点级）——关闭后不提供读取（Skill/工具不装配、不注入）、不运行写入 agent，主流程照常。
- **两 agent 的 workflow 合同**：`src/workflows/session-memory/workflow.json`，`id:"session-memory"`、名称「会话记忆」、`agentCallable: true`、`nodes` 有序两节点（`work`：干活 agent → `remember`：写入 agent）；两个 step 均 `"use step"` + `maxRetries=0`，都在**当前会话**内执行；主 agent 完成后仍可用既有 `triggerChatWorkflowAgentHandoff` **触发**写入 agent 的一轮（它传的是 custom message + `triggerTurn`），但**上下文不由它决定**——写入 agent 看到的当前轮内容由上面的 `transformContext` 投影产生（否则会带上整段会话历史）。注册进 `catalog.ts`（用户可选 + agent 可调用）。写入 agent 可用较便宜的模型（agent 定义可配 model）。
- **建子节点时的补充路径**：除继承（读父节点累积的会话记忆）外，创建子节点时可以**全量读取父节点的 session 内容**，一次性抽取有价值的内容作为新会话的会话记忆（不依赖逐轮累积的完整度）。
- 「问题定位 workflow」作为主题模式的第一个随附业务 workflow（由干活 agent 按需调用，配合验收场景）。若未来需要跨轮有状态的流程驱动（Form B），另立任务书，不在本阶段。
- 主题会话的轮次与预算沿用现有会话执行链与 provider 请求门。

### 3.5 代为传话（relay）

- Long Agent 经受控桥向**自己名下主题树**的任意节点注入一条用户轮，来源标记 `relay`，记录代传的 Long Agent 与原始请求（Telegram 消息 id）。按工程基线（§5）约束：relay 轮是**真实 user message**（不是 CustomEntry），并扩展既有 `chatLongAgent` provenance 标记 `source: "relay"`；`archived`/`removed` 节点拒绝代传。

> **【Doc Review · Trae Agent】R10（实现约束）** 按工程基线（`chat-long-agent-engineering-baseline.md` §5），CustomEntry 不承载真实发言的唯一正文：relay 轮必须是真实 user message + 扩展既有 `chatLongAgent` provenance 标记模式（source 标 relay），不能只写一个 CustomEntry。另请与 R5 一并明确 archived 节点是否可代传。
> **【回复 · 原作者】R10：采纳：relay 轮为真实 user message + `source: relay` provenance；archived/removed 拒绝；已落入 §3.5。**
- relay 轮与会话内其他用户轮同链路执行（驱动 workflow）。**落地要求（检视 10）**：relay 是真实 user message + **持久来源标记**，并同步更新读模型与前端解析/展示（现有解析器不接受 relay，须一并加，不能只加一个枚举值）。
- 越权代传（别人的树、群会话）明确拒绝。

### 3.6 Long Agent 的“了如指掌”

- Long Agent 通过**受控桥**（新的 `topic-manage` 只读/管理工具）读取主题图、节点列表、会话全文与记忆——**不直接读 Chat 数据库，不挂载 Chat Home**（沿用既有红线）。
- 维护职责：更新节点状态、补充维护说明、响应“哪些相关”的询问；这些是它的任务而非副产品。

### 3.7 关键决策表（随本任务书评审，不另设逐项审批）

| 决策 | 采用方案 |
|---|---|
| 存储 | topics.json / session-memory/<sessionId>.json 均在 agent home，版本化文件 + revision CAS；不改 registry，不在 Nano 存第二份 |
| Pi 集成 | 主题会话为普通 Pi 会话；不用 `parentSession`；DAG 由 Chat 拥有 |
| 目的类型 | 核心五类 `background/goal/experience/rule/finding` + 自定义标签；语义进机制合同 |
| 写入者 | workflow agents（工具）+ 用户（前端）；Long Agent 在创建整合时写新节点初始条目，**补充整合经用户确认**后写目标节点条目（显式留痕例外） |
| 读权限 | Long Agent 跨主题/跨 Agent 只读桥；写会话记忆仅限本会话的 agents 与用户 |
| 代传 | 自己名下所有主题树全部节点；显式 relay 标记；越权拒绝 |
| workflow | Form A（按轮派发）；Form B 出局，另立任务书 |
| 防环 | 加边只检查 `parent !== child` 且无 `child → … → parent` 路径；memoryRefs 单独校验来源存在与读权限；补边同检 |
| 会话删除 | 记忆文件不自动删除，条目标记 orphan；节点会话移除 → node `removed`、边保留；archived/removed 拒绝 relay |
| 整合载体 | 后台 work / 独立执行上下文；产物经 `topic-manage` 结构化入参提交，服务端校验 |
| 派发链 | 外层 `session-memory` 在 **agent home 的节点会话**内启动，两 step 共用该会话（不经 `workflow_call`）；业务 workflow 由 `work` 经既有 `workflow_call` 用**子会话**；冻结协作项目经公共装配可信 invocation 提供；run 归属 `collaborationProjectId === undefined ? projectId : collaborationProjectId`（显式 `null` 不回退） |
| 项目上下文 | 节点内只读展示、不可切换 |
| 节点会话 API | B 包新增消息读取/发轮次/事件流/授权（参照 conversations 授权模式） |
| 前端 | 主题图视图（按 Long Agent）、节点会话交互（复用现有 ChatWindow）、会话记忆查看/编辑 |
| 授权 | `topics.ts` 提供共享目标解析+授权（read 跨树只读 / relay 自己树 / write 仅本会话记忆）；节点 API、`topic-manage`、记忆 API、通用 Session/Run 入口共用。**范围收窄（检视 16）**：只有**已识别为主题节点**的会话必须通过 Topic 授权；非主题会话（普通 Workflow、日常、后台）继续既有授权，不受影响。P1 的日常/后台会话记忆授权由**会话归属解析**决定，不依赖 topics 记录。不得以客户端传入的 Long Agent ID 作为授权 |
| 目标绑定 | 记忆写入目标用可信绑定 `{storageProjectId, sessionId}`，全链传递且嵌套继承，不可由 HTTP/模型参数自填 |
| 读取入口 | 工具 `list/write/supersede` + 服务端绑定目标的历史读取入口（按 entry/分页）；Skill 装配与开关移除单独实现 |
| 锚点 | 节点读模型给出可分叉锚点，创建时在 Session 锁内核验并冻结；不使用 `forkChatSession()` |

## 4. 四个工作包与退出门槛

| 包 | 目标与可用场景 | 实施/交付 | 验证与退出条件 | 自审：禁止省略什么 |
|---|---|---|---|---|
| A：会话记忆 | 任何 agent home 会话都有按目的的记忆；workflow agents 主动维护，用户可查看/修改 | 存储合同 + `session-memory` 工具（agent 侧）+ Backend API（用户侧）+ 机制合同文档 | 并发写入 CAS；目的校验；条目上限；用户编辑与 agent 写入不互相覆盖；重启后保留 | 不只做 DTO；不允许 Long Agent 直写；不与 mem0/NanoClaw memory 混写 |
| B：主题图与整合 | Long Agent 能创建主题/节点，整合真实有效，图可查询 | topics.json 合同 + `topic-manage` 工具 + 整合流程（读全文/记忆 → 去重整理 → 初始 CustomMessage + 初始记忆）+ 代传 + **节点会话 API 族**（读取/发轮次/事件流/授权，C 包依赖此项） | 双向 provenance 探针（原失败+后成功不串）；防环；锚点定格；并发创建 CAS；整合产物确为去重整理而非拼接；越权代传拒绝 | 整合不得退化为拼接；不得绕过策展开节点；代传不得伪装成用户本人 |
| C：前端 | 用户能看图、进节点对话、管理会话记忆 | 主题图视图（按 Long Agent）、节点会话（复用 ChatWindow，走 B 包节点 API）、会话记忆面板 + 整合状态机（idle/integrating/success/failed）；真实浏览器门禁 | 图与锚点显示正确；点节点可交互；记忆编辑保存并生效；刷新/重启后状态一致 | 不只画图不可点；不在 React 里存第二份图状态 |
| D：真实场景验收 | 问题定位 Long Agent 端到端：描述问题 → 整合开题 → 多轮交互 → 分叉 → 代传 | 真实模型 + 真实浏览器 + 至少 3 节点 2 主题的图；归档证据 | T1–T9（§5）全部有证据；阻断缺陷清零 | 不用本地假会话冒充；不省略跨树只读与越权反例 |

> **【Doc Review · Trae Agent】R11（交付缺位）** B/C 包均未列节点会话的 Backend API 交付：现有路由只有 daily/conversations 两族，"点进任意节点直接对话"需要新的消息读取、轮次提交、事件流路由及读取授权（可参照 conversations 的授权模式）。建议在 B 包交付中加入"节点会话 API"，或在 C 包明确该依赖由 B 交付。
> **【回复 · 原作者】R11：采纳：B 包交付加入节点会话 API 族，C 包声明依赖；已落入 §4。**

## 5. 必验矩阵（T1–T9）

| ID | 场景与不变式 | 必需证据 |
|---|---|---|
| T1 | 会话记忆生命周期：agent 主动写、用户改、并发 CAS、重启保留、会话删除后 orphan 保留 | 工具调用记录 + API 测试 + 版本冲突用例 + orphan 用例 |
| T2 | 节点创建整合：去重/逻辑整理真实发生，provenance 完整，初始上下文对 workflow agents 可见 | 整合前后内容对比 + 初始 CustomMessage 进入上下文的证据 + memoryRefs 核对 |
| T3 | 图不变式：多亲合法、防环、锚点定格、父继续存活不影响子 | 构造成环拒绝用例；第 20 轮 fork 后父继续演进、子不变的用例 |
| T4 | 代传：自己树内全部节点可代传且标记 relay；越权（他人树）拒绝 | relay 轮落会话 + 来源标记 + 越权 403 |
| T5 | 权限边界：跨树只读可、写他人记忆不可、Long Agent 不触库 | 桥只读证据 + 越权写拒绝 |
| T6 | workflow Form A：主题会话内按轮派发 workflow 正常 | 真实会话派发记录 |
| T7 | 前端：图、节点交互、记忆面板（真实浏览器） | 浏览器测试与截图 |
| T8 | 恢复：Backend 重启后图/记忆/会话一致；节点会话被移除后 node `removed`、边保留 | kill + 重启用例 + 节点移除用例 |
| T9 | 预算：整合与记忆上限明确失败 | 超限用例 |

每项写明：输入、操作、预期、实际、证据路径、模型/环境、失败或未测原因。

## 6. 边界

- 本任务书授权使用既有已配置模型做整合与验收；密钥不入日志/文档。整合调用有预算上限，超限如实记录。
- 不授权删除用户既有会话/记忆；测试用隔离 agent home。
- 生产部署、tag 另按用户指令执行。
- 未支持边界如实列出（本阶段：群会话无会话记忆、Form B 不做、跨设备不同步），不冒充已支持。

## 7. 质量门槛与自审

代码改动运行 `pnpm verify`、`pnpm check:architecture`、三仓库 `git diff --check`；涉及 Agent 装配/Workflow 须覆盖 Builder、Nitro 开发 Step、生产构建与 `pnpm test:dev` 真实链。参考 `long-agents` 既有测试与 `group-browser.test.mjs` 扩展浏览器门禁。

**工程基线核对（R12，开工前置）**：实施前核对 `chat-long-agent-engineering-baseline.md`（原生接入证据、Skill 生效合同、Session 扩展、约束与测试门槛），其中状态为“建议”的条目先评审。新元数据 `topics.json` / `session-memory/<sessionId>.json` 必须声明 `schemaVersion`、定义旧格式（缺字段）读取策略与未知版本处理，满足基线 §5 对新元数据的通用要求。

> **【Doc Review · Trae Agent】R12（流程缺口）** 按工作区规则，Long Agent 详细设计与实施前须核对 `chat-long-agent-engineering-baseline.md`（原生接入证据、Skill 生效合同、Session 扩展、约束与测试门槛；状态为"建议"的条目先完成评审）。本任务书新增 agent home 内的会话类型与两份版本化元数据（topics.json / session-memory），应把基线核对列入退出门槛；新元数据需声明版本、旧格式读取、未知版本处理（基线 §5 对新 CustomEntry/元数据的通用要求）。
> **【回复 · 原作者】R12：采纳：§7 增加工程基线核对前置与新元数据 schemaVersion/兼容要求；已落入 §7。**

每包退出前回答：**有没有只实现容易的一半**（建了不能交互？整合只是拼接？）；**有没有错误更换对象**（会话记忆 ≠ mem0 ≠ NanoClaw memory；主题图 ≠ Pi 血缘）；**是否检查所有写入口**（记忆写入口：工具/用户/整合三类各自授权）；**是否倒退已有覆盖**（LA6 渠道与 settledAt 门禁不回退）；**是否诚实披露**（Form B 未做、群会话未接入如实写）。

## 8. 交付与最终判定

交付集中于：会话记忆与主题图的机制合同（`chat-long-agent-mechanism-contract.md` / 会话架构文档相应章节）、`topic-mode` 使用文档、永久门禁、`docs/history/reviews/` 验收记录。未经用户要求不提交、不推送、不部署。

**完成标准**：A–D 退出门槛与 T1–T9 全部有证据；用户能按文档创建主题、进节点交互、分叉、代传、查看会话记忆；没有阻断核心场景的已确认缺陷。平台或账号缺失可报告阶段成果，但主题模式保持未完成，不能仅凭 `pnpm verify` 全绿宣布结束。

## 9. Doc Review 回复（Trae Agent，R1–R12，2026-09-22）

**结论：R1–R12 全部采纳**，其中 R9 为关键未定项，已基于代码核对落定（非推测）：

- **R9 的代码事实**：`resolveProjectContext` 支持 `kind:"agent"`（agent home 即 agent-kind project，projectDataDir=`long-agents/<id>/`）；`runs.post.ts` 的会话归属检查（`requireActiveChatSessionFile(project, sessionId)`）与 run 绑定记录（`recordChatSessionRunBinding(project.projectDataDir,…)`）因此都可落在 agent home；`workflow-call.ts` 已支持 `parentSessionManager` + 显式 `projectId` 从 agent home 会话派发 workflow（LA1/LA4 后台工作先例，`background-work.test.mjs` 在用）。所以“agent home 会话 + 按轮 workflow 派发 + 冻结协作项目上下文”是**既有能力的参数化组合**，不需要新的运行时。
- 各条落点见上方内联【回复】标记；R4 同时修正了 §3.7 写入者规则的内部矛盾（补充整合 = 经用户确认的显式留痕例外）。
- 加固建议（非阻塞）一并采纳：`parseAcceptedTurn`/新元数据解析声明 schemaVersion 与旧格式兼容策略（§7）。
