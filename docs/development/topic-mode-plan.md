# 主题模式开发计划（Topic Mode Development Plan）

状态：**P1 已独立复核通过（检视 18–34 全部收口，证据见 [P1 实施记录](../history/reviews/2026-09-22-topic-mode-p1.md)）；P2–P4 待开工。** P2 开工前先落定入口清单（见 §2 开头的「P2 入口前置」）。日期：2026-09-22。合同依据：[主题模式任务书](./topic-mode-taskbook.md)（同步修订）。检视回复见 §6。

## 0. 基准：Pi 的沟通链

```
一个会话  = 一个 Pi session 文件（jsonl entries）
一轮      = 用户消息 entry → AgentSession 跑模型 → assistant entry（content blocks 含 text/thinking/工具调用）
连续多轮  = 同一 session 文件持续 append（Pi 本来就有全部上下文）
进入上下文的只有：message 与 custom **message** entry；custom entry 不参与模型上下文
子会话    = 另一个 session 文件
```

会话记忆不为续聊服务，只为：沉淀可跨会话复用条目、建节点时不必搬原文、用户能看能改。因此**按需读取、不注入**。

## 1. P1 会话记忆底座（存储 + 工具 + 用户 API）

**开工前置（checklist，不是阶段）**：核对 `chat-long-agent-engineering-baseline.md`；schema 与工具签名随本阶段代码进机制合同（不先写空合同）。

**① 存储（范围：底座部分交付——检视 23）** `src/long-agents/session-memory.ts`：路径 `<agent home>/session-memory/<sessionId>.json`；原语 `withFileLock` + `atomicWriteJson` + CAS（同 `duties/storage.ts`）。**来源绑定在业务 workflow 派发链上的盖章与嵌套继承属 P2 门槛**（`sessionMemoryTarget` 字段与解析已在本阶段就绪并测试）。
**② 统一 schema（一个解析器）**：`{ schemaVersion, sessionId, orphan, revision, entries:[{ entryId, purpose, author, content, originEntryId, supersedes, status, createdAt, updatedAt }] }`；`purpose` = 五类 `background|goal|experience|rule|finding` + 白名单自定义标签；`status = active|superseded`；**不设 archive**（推翻即 superseded）；条目只增不改，编辑/修正 = 新条目 + `supersedes`。
**③ 目标绑定（修正：单个 sessionId 不够）**：可信绑定 `{ storageProjectId, sessionId }`。由节点发起服务解析，经 `workflow-call-tool.ts → workflow-call.ts → ChatWorkflowInput → step → createWorkflowAgentSession → ChatToolRuntimeContext` 传递并持久化；**嵌套调用继承原绑定**，不重盖成中间子会话；HTTP/模型参数不可自填；无绑定时回退前必须校验当前会话属于受支持的 agent home。
**④ 工具与读取入口**：`src/tools/builtins/session-memory/`（manifest + provider）加入 `CHAT_SYSTEM_TOOL_PROVIDERS`（`src/tools/registry.ts`），地址 `system:tool/session_memory`（下划线，取自 manifest.name）；操作 `list | write | supersede`；另提供**服务端绑定目标会话的历史读取入口**：工具操作 `history { afterEntryId?, limit? }`，返回该绑定会话的分页条目（不暴露其他会话）。
- **Skill 路径与装配**：`src/resources/builtin-skills/session-memory/SKILL.md`（记录纪律正文）；由 workflow agent 的 `agent.json` `resources.skillPaths` 装载，装配函数照 `src/workflows/memory/agents/memory-agent/runtime.ts` 的 `prepareMemoryAgentSession` 先例实现（`src/workflows/session-memory/agents/{worker,writer}/runtime.ts`）；开关关闭 = 不装配该 Skill、不注册读取工具、不跑第二步。
- **检查页与执行共用同一 prepare 函数**。
**⑤ 用户 API**：`GET/PATCH /api/long-agents/[id]/sessions/[sessionId]/memory`，带 revision；编辑 = supersede。
**⑥ 生命周期（统一领域服务，不只挂 HTTP 路由）**：remove → `orphan:true`（保留）；自动 purge（`purgeExpiredRemovedSessionsAcrossProjects`）、显式 `purgeRemovedChatSession` → 删文件；覆盖崩溃恢复与重试。
**验证**：真实公共装配 + 本地假模型触发工具调用，验证来源绑定（含嵌套调用不重盖）、用户编辑 CAS、生命周期（含自动 purge 与恢复）。

## 2. P2 主题图 + 「会话记忆」workflow

**P2 入口前置（先落定再写功能代码）**
1. **来源绑定的派发侧盖章与嵌套继承**（P1 明确未交付的底座剩余项）：`sessionMemoryTarget: {storageProjectId, sessionId}` 经 `workflow-call-tool → workflow-call → ChatWorkflowInput → step → createWorkflowAgentSession → ChatToolRuntimeContext` 传递并持久化；**嵌套调用继承原绑定**，不重盖成中间子会话；HTTP/模型参数不可自填；无绑定时回退前必须校验当前会话属于受支持的 agent home。
2. **派发链两条链分别实现**（检视 15）：外层 `session-memory` 在 agent home 的节点会话内启动且两 step 共用（不经 `workflow_call`，Session 与 run binding 都归 agent home）；`work` 调业务 workflow 时用既有 `workflow_call` 子会话与其 run 归属（`collaborationProjectId === undefined ? projectId : collaborationProjectId`，显式 `null` 不回退，调用被拒）。
3. **授权范围收窄**（检视 16）：Topic 授权只作用于**已识别为主题节点**的会话；非主题会话（普通 Workflow/日常/后台）继续既有授权；不以客户端传入的 Long Agent ID 作为授权。
4. **锚点与 Skill 落定**（检视 17）：只有整个外层 invocation 完成（`work`+`remember` 均终态）的轮次可分叉；Skill 真实路径 `src/resources/builtin-skills/session-memory/SKILL.md` 与其装配函数、历史读取工具签名（`history { afterEntryId?, limit? }`）在本阶段实现并测试。

**① 「会话记忆」workflow** `src/workflows/session-memory/`（照既有合同：manifest + agents + `"use workflow"` + `"use step"`）：
- manifest 两节点 `work`（干活 agent）→ `remember`（写入 agent），`agentCallable: true`，注册 `catalog.ts`；实际顺序由 workflow 函数 `await workStep(); await rememberStep();` 实现。
- `work` step：在**节点会话**里跑普通一轮 agent（连续会话逻辑不变）；**不注入记忆**，只装配读取 Skill/工具按需读。
- `remember` step：**用 `transformContext`（`src/workflows/agent-definition.ts`）做当前轮投影**——投影出「本轮用户 entry + work 阶段**全部**条目（该 stage 的多个 assistant entry 与工具条目，不是只取最后一个 leaf）+ remember 本轮后续」；前文与旧记忆经读取入口按需获取。**不要**依赖 `triggerChatWorkflowAgentHandoff` 传上下文（它只把 ID 写进 CustomMessage 的 details，历史仍在）。
- `remember` 的可见回复必须**关联工具实际返回的 entry ID 与 revision**（不靠模型口头宣称）。
- **开关**只决定：能力装配是否加入读取工具、第二步是否执行；不新增节点类型。
**② 节点创建**：
- `reserveChatSession`（agent home 新会话）；
- 整合摘要用 Pi `appendCustomMessageEntry()` 持久化一次并带来源元数据（**进入模型上下文**）；**不用 `AcceptedTurn.seed`**（它只接受 `chat.agent-assembly` 装配快照）；
- 初始 `background` 记忆条目（provenance）+ 图登记；
- 上述三件事共用**可重试操作标识**（幂等），创建重试识别已写摘要，避免重复与“CAS 输家留下无图节点”。
- 建子节点：可全量读父 session 抽取有价值内容作为初始记忆（一次动作）。
**③ 主题图与授权** `src/long-agents/topics.ts`：**范围（检视 16）**：Topic 授权只作用于**已识别为主题节点**的会话；非主题会话（普通 Workflow、日常、后台）继续既有授权。P1 的日常/后台会话记忆授权由**会话归属解析**决定，不依赖 topics 记录。
- topics/nodes/edges（边带创建锚点 + memoryRefs）；**防环修正**：加边 `parent → child` 只检查 `parent !== child` 且图中不存在 `child → … → parent`；**删除“memoryRefs 命中祖先即拒绝”**（那会拒绝正常的父记忆继承）；memoryRefs 单独校验来源存在与读权限。
- 共享**目标解析 + 授权函数**（以服务端绑定的 requester 与持久节点归属为准）：read（跨树只读）/ relay（自己名下树）/ write（仅本会话记忆）三类分别检查；**节点会话 API、`topic-manage`、记忆 API 与通用 Session/Run 入口都用它**；不得把客户端传入的 Long Agent ID 当授权。
**④ 锚点（检视 17 定稿）**：只有**整个外层 invocation 已完成**（`work` 与 `remember` 均终态）的轮次可分叉；`work` 完成但 `remember` 在写、失败/取消轮**不可选**。节点读模型返回可分叉锚点（当前分支、用户 entry、invocation 与终态），创建请求在既有 Session 锁内核验并冻结锚点与记忆 revision；**不调用 `forkChatSession()`**（它从选定用户消息之前复制分支，语义不符）。
**⑤ 派发链（检视 15：两条链分别写清）**：
- **外层 `session-memory`**：节点 API 在 agent home 的**节点会话**内启动，两 step 共用该会话；**Session 与 run binding 都归 agent home**（不经过 `workflow_call`）；冻结协作项目经公共装配的可信 invocation 提供。
- **内部业务 Workflow**（`work` 调问题定位等）：走既有 `workflow_call`，**子 Session 与其 run binding 按目标项目归属**（`collaborationProjectId === undefined ? projectId : collaborationProjectId`）；冻结协作项目为**显式 `null`** 时**不回退**，调用被拒绝。
**⑥ 节点整合服务（已实现根节点建题）**：`startFriendWork()` 只接受该 Friend 的日常来源——服务器解析/校验日常来源，启动整合后台 work 并返回 work/execution 引用与确定性 `topicId/nodeId/sessionId` 供 P3 恢复；整合产物仍由该后台 work 的 Agent 经 `topic-manage` 结构化提交（无第二条执行路径）。见 `src/long-agents/topic-integration.ts` + `POST/GET /topics/integrations`。**尚未接入**：fork 建题时“另存源主题节点与锚点”的 `parents` 透传，与“确认后的补充整合”入口。**随附业务 workflow（问题定位）在 P2 交付**，P4 实际调用一次。
**⑦ 节点会话 API**：读消息 / 发轮次 / 事件流；relay 轮 = 真实 user message + **持久来源标记**，并同步更新读模型与前端解析（现有解析器不接受 relay，须一并加）。
**验证（重新分配）**：捕获模型**实际输入**，验证当前轮隔离、初始摘要进入上下文、历史/记忆按需读取、正常分叉（父记忆继承不被拒）、多亲、真成环拒绝；完整跑既有开发与生产链（不另建门禁）。

## 3. P3 前端

主题图视图（节点/边/锚点/状态，数据全来自 Backend）；点节点复用 `ChatWindow` 走节点 API；记忆面板（按 purpose 分组、查看/编辑/推翻、CAS 冲突提示）；开关；整合状态机（idle → integrating → success/failed）；relay 来源展示。
**验证**：真实浏览器——remember 结果（关联 entry ID）、开关、节点内项目上下文只读、relay 来源、刷新恢复。

## 4. P4 联调验收

**验证**：一次真实模型完整故事（描述问题 → 整合开题 → 多轮含一轮记忆写入 → fork → 第二主题跨树引用 → 代传 → 归档一个节点），覆盖**实际业务 workflow（问题定位）**与两 agent 的**跨树只读**；复用前阶段确定性反例（成环、越权 relay、超限）；证据进 `.data/verification/topic-mode/`，检视记录进 `docs/history/reviews/`。

## 5. 通用门禁与里程碑

每阶段：`pnpm verify` exit=0 + 三仓库 `git diff --check`（verify 已含架构检查、生产构建、built 与 `test:dev`，不重复建门禁）。里程碑 M-P1 → M-P4。

## 6. 计划检视回复（01–13，2026-09-22）

**结论：13 条全部采纳**（其中 01/02/03/04/05/08/09 为机制级修正，10/11/12/13 为收口与分配）。落点见上文章节：

| ID | 采纳要点 | 落点 |
|---|---|---|
| 01 | remember 用 `transformContext` 做当前轮投影；收集整个 work stage；handoff 不传上下文 | §2① |
| 02 | 整合摘要改用 `appendCustomMessageEntry`；seed 只留装配快照；创建重试去重 | §2② |
| 03 | 区分外层同会话执行与业务子 Workflow；改为 `=== undefined ? : `（显式 null 不回退） | §2⑤ |
| 04 | 目标绑定改为 `{storageProjectId, sessionId}`，全链传递 + 嵌套继承 + 不可自填 | §1③ |
| 05 | 删除 memoryRefs 祖先禁令；成环判定改为加边路径检查；memoryRefs 单独校验 | §2③ |
| 06 | 明确工具 provider/地址、历史读取入口、Skill 发布与装配、检查与执行共用 prepare | §1④ |
| 07 | `topics.ts` 提供共享目标解析与授权（read/relay/write 三类），所有入口共用 | §2③ |
| 08 | 节点读模型给出可分叉锚点并在锁内冻结；不用 `forkChatSession()` | §2④ |
| 09 | 节点整合服务（解析日常来源、另存源节点/锚点）；补充整合走 `topic-manage`；随附业务 workflow 进 P2 | §2⑥ |
| 10 | remember 回复关联工具返回的 entry ID；relay 需更新持久标记+读模型+前端；thinking 从原生 content 读且容忍缺失 | §2①②⑦、§3 |
| 11 | schema 统一（orphan/标签/revision 层级/删 archive）；生命周期进领域服务并覆盖自动 purge 与恢复 | §1②⑥ |
| 12 | 验证重新分配；删祖先禁令；不建第二套任务引擎/图数据库/通知系统 | §1/§2/§3/§4 验证 |
| 13 | 保留两 agent 顺序执行与既有边界（无新运行时、三层记忆互不代写） | §2① |
