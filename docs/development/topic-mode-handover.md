# 主题模式（Topic Mode）交接文档

状态：**P1 已独立复核通过；P2 进行中（后端主干已可用，尚未收口）**。日期：2026-09-24。
基线：**`7dc339f13`** + 本批锚点修复提交（`git log` 顶部，含会话锁串行化）；`pnpm verify` exit=0：56 tooling / 616 Backend / 185 Frontend / 30 built / 8 dev。
本文是**面向新会话的交接**：先看 §1 的 5 分钟入口，再按 §4 未完成清单继续，不要只看测试数量判断进度。

---

## 1. 五分钟上手（新会话从这里开始）

```bash
cd /Users/xulater/Code/Chat
git log --oneline -8          # 基线应为 28a4d2483
git status --porcelain         # 必须为空
pnpm verify                    # exit=0；含架构检查、生产构建、built 与 test:dev
```

必读（按顺序，不要无差别通读）：
1. 根 `AGENTS.md`、`.agents/skills/chat-architecture/SKILL.md`（架构导航与改动影响流程）；
2. `docs/development/topic-mode-taskbook.md`（合同；§3.1–3.7、§4、§9 检视回复）；
3. `docs/development/topic-mode-plan.md`（P1–P4 分阶段目标与验证）；
4. `docs/development/topic-mode-p2-taskbook.md`（P2 后端合同与本文同源的现状标注）；
5. 本文 §5「设计决策与踩过的坑」，避免重犯。

定向测试（比全量快，改动后先跑这些）：

```bash
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types --test --test-timeout=120000 \
  test/long-agents/topics.test.mjs \
  test/long-agents/topic-anchor.test.mjs \
  test/long-agents/topic-node-creation.test.mjs \
  test/long-agents/topic-api.test.mjs \
  test/long-agents/topic-integration.test.mjs \
  test/tools/topic-manage.test.mjs \
  test/workflows/session-memory-workflow.test.mjs \
  test/workflows/session-memory-round-context.test.mjs \
  test/workflows/session-memory-writer-runtime.test.mjs
```

---

## 2. 已经做完并验证的（可按提交号查）

| 范围 | 提交 | 说明 |
|---|---|---|
| P1 会话记忆底座 | `66decf23d` | 条目 CAS/append-only、purpose 白名单、supersede、生命周期（orphan/purge）、用户 API、`session_memory` 工具 |
| P2 主题图 + 授权 | `096337af4` → `42d0fa39e` → `cdfbb4184` | `topics.json`（topics/nodes/edges，边带锚点 + `memoryRefs`）、创建请求摘要（不可变 digest）、同树/单根/整合指向约束、状态不可复活、`authorizeTopicSession`(read/relay/write) |
| 派生身份（取代预留表） | `eda0910ec` | `topicId=f(owner,requestId)`、`rootSessionId=f(topicId,requestId)`、`nodeSessionId=f(topicId,requestId)`；`ensureChatSessionWithId`（Pi 显式 id） |
| 会话创建并发与生命周期守卫 | `43f8c921d`、`d1a0be0ec` | 会话操作锁内“先 pending 意图 → 活跃文件 → removed/purged”，并发的同 id 只产生一个文件 |
| 四步编排 + settled 锚点原语 | `e85031170`、`b6b0c6f98`、`b64…`（见 `topic-anchor.ts` 提交） | 会话 → 整合摘要 → 初始记忆 → 图登记（同一 `requestId`，可重放）；来源只允许 Long Agent home 且必须是会话记忆条目；`chat.topic-round` 整轮标记 |
| `topic-manage` 工具 | `5bd6fe87f` → `8028e8a28` → `8e73b576a` | 读图/读节点/跨树只读记忆与全文（含游标）/建主题建节点（多来源）/补边（锚点 + 规格幂等）/状态/relay（**单次原生 user message + 内嵌请求关联**，按 `(nodeId,requestId)` 幂等，切换分支后不重复） |
| 节点只读 API | `0b1e0e06e`、`e163e35a3` | `GET /topics`、`GET /topics/{topicId}`（仅本主题边）、`GET .../nodes/{nodeId}/messages`（必须 `node.topicId === topicId`） |
| 节点会话绑定 + 写侧 | `a7978ebaa`、`3e5c1f85b`、`069fe47aa`、`1df9105a5`、`3f161ab80`、`325cb5fba` | state `nodeSessions`（schemaVersion 6）、绑定与 turn 同次写入、执行期会话选择、节点重放**双向**严格（轮次种类属于请求身份） |
| 生命周期与读取守卫 | `d14fe2f9a`、`b2664c9bf` | 会话 remove/restore/purge 镜像到节点状态；恢复回调在清 pending 前收敛记忆与主题图；`assertSessionFileReadable` 对通用读取入口应用主题判定 |
| 外层「会话记忆」workflow | `5f39c7308`、`e2a78cc0e`、`750596dbd`、`a54eb1456` | `work → remember` 同一节点会话；writer 只收到**当前轮**（从耐久分支投影）；worker 具备普通工作工具 + `workflow_call`；本轮返回**work 答案**；节点级记忆开关 |
| 外层编排 + 关闭提前分叉 | `28a4d2483` | 队列 worker = 编排点：工作段 → writer → 整轮完成标记 → 才 settle；锚点只认 `completed` 整轮标记 |
| 锚点窗口修复（复核后） | 本批（`git log` 顶部） | running 标记改由队列在**工作段之前**幂等写入（同一 `turnId`，且在**节点会话操作锁内**检查/追加/flush、work 前释放）；`readTopicSettledAnchors` 改为**按轮次**抑制 `chat.long_agent_turn`，不再用会话级开关抹掉历史；新增 3 条回归（历史锚点保留、恢复时先写 running 再工作、并发写入下标记串行落同分支） |
| 建题入口 | 本批（`git log` 顶部） | `topic-integration.ts` + `POST/GET /topics/integrations`：服务器解析/校验**日常来源会话**，启动 `startFriendWork({title:"整合：…"})`，返回 work/execution 与**确定性** `topicId/nodeId/sessionId`；整合由该后台 work 经**真实装配**调用 `topic-manage` 提交；假模型 API e2e 覆盖建题 → 建根节点+初始记忆 → 节点内 work+remember → 可分叉 |
| 建题幂等补齐 | 本批（`git log` 顶部） | `startTopicIntegration` 在节点已建成时也拿**已持久化 work** 核对请求身份：同 `requestId` 重放返回同一 work，改 title/purpose/source → 400，而不是静默成功；已持久化 work 的源在跨日重放时优先于重新解析“今天的日常会话”。补建成后重放测试 |
| 日常“说一句建题” + fork | 本批（`git log` 顶部） | `topic_manage request_topic`：模型只给 `title`/`purpose`（可选 `parents`），**服务端从当前可信 turn 派生请求身份、以当前会话为日常来源**，再调现有 `startTopicIntegration`；`fork` 用 `parents`（父节点 + settled 锚点）复用父主题与同一后台链；日常 `create_topic` 被拒绝；完成无节点 → `status=failed`。假模型：`test/long-agents/topic-integration.test.mjs`（建题 → 根；节点轮 → 锚点 fork → 有父边子节点；无节点不算成功） |
| 建题入口真实模型验证 | 本批（`git log` 顶部） | 隔离 `CHAT_HOME` + symlink：真实模型（`command/deepseek-v4.1-flash`）跑了 `read_fulltext → read_memory → create_topic → create_node` → 根节点+初始 provenance → 节点轮 `work+remember` → 真实锚点建子节点；证据：`docs/history/reviews/2026-09-24-topic-mode-real-model-verification.md` |

---

## 3. 当前用户可用能力（诚实范围）

- 能用：`topic-manage`（Agent 侧建树/读图/读记忆/补边/relay/开关/`request_topic` 建根与 fork）；节点只读 API；节点轮次（Post 消息 → work → remember → 记忆可查 → 可分叉）；记忆开关（节点级）；**日常“说一句建题”**（Agent 在对话里调 `request_topic`，后端解析来源与请求身份 → 整合后台 work → 根节点）；**fork 建题**（父节点 + settled 锚点 → 有父边的子节点）；显式 HTTP 入口 `POST/GET /topics/integrations`。
- 不能用：P3 Web 界面（主题图/记忆面板/整合状态/relay 来源）；P4 真实模型完整故事（含建题整合的提示词质量）。

---

## 4. 未完成清单（按优先级；每项都有验收标准）

1. ✅ **“说一句建题”入口（本批已实现）**
   - 服务器解析该 Friend 的**日常来源会话**（或校验显式 `sourceSessionId` 属于本 Friend 的日常会话），启动整合后台 work（`startFriendWork` 只接受日常来源），返回 work/execution 引用与确定性 `topicId/nodeId/sessionId`；`GET` 供 P3 恢复。
   - 验收已过：`test/long-agents/topic-integration.test.mjs` 假模型 API e2e（建题 → 后台整合 work 经真实装配调用 `topic-manage` 建根节点 + 初始记忆 → 节点内 work+remember → 可分叉）；同 `requestId` 重放返回同一 work，改 payload → 400。
   - **剩余**：真实模型下的整合提示词质量与“补充整合（R4）经用户确认”入口归 P4/P3。
2. ✅ **真实模型验证（本批已完成）**
   - 隔离 `CHAT_HOME` + **symlink** 复用 `~/.chat/agent`（不复制、不打印凭据）：真实模型跑通 `read_fulltext/read_memory → create_topic/create_node` → 根节点+初始 provenance → 节点轮 `work+remember` → 真实锚点建子节点；证据在 `docs/history/reviews/2026-09-24-topic-mode-real-model-verification.md`。
   - **已交付**：日常 Agent 在对话里调 `request_topic`（模型只给 title/purpose，服务端从当前可信 turn 派生来源与请求身份）→ 后台整合 → 根节点；`parents` 则 fork 出有父边的子节点；无节点不算成功。
   - **剩余**：日常自然语言里“没说用什么工具”的意图识别仍归模型自己；“用户确认后的补充整合（R4）”入口未接。
3. **relay 执行链（未实现，合同已定）**：接受侧携带并校验 relay 的 `userEntryId`，执行时对该条目 `resumePendingTurn()`，**不再 prompt 追加同文消息**；用真实 `relay → 执行 → settled → 分叉` 回归替换当前声明。
4. **进程级重启验证**：现有回归是同进程 drain（只证明“从耐久状态选会话”）；子进程探针此前**挂起未查明**，需要诊断后给出跨进程证据。
5. **P3 Web**：主题图（节点/边/锚点/状态）、点节点复用 `ChatWindow` 走节点 API、记忆面板（按 purpose 分组、编辑/推翻 + CAS 冲突提示）、记忆开关、整合状态机、relay 来源展示。
6. **小项（不单开轮）**：`sessionMemory` 未知值当前默认 `on`（应随后收紧）；节点记忆开关还没有 API/面板入口。

---

## 5. 设计决策与踩过的坑（务必先读）

1. **不新建第二条执行路径**：`executeAcceptedLongAgentTurn` 就是可复用的 **Long Agent 工作执行段**；**队列 worker 是外层编排点**（工作段 → writer → 整轮完成标记 → 才 `settledAt`）。不要为了 workflow 再写一套装配（会复制出第二条执行路径）。
2. **writer 只有一份实现**：`src/workflows/session-memory/writer-run.ts` 是**普通函数**（非 `"use step"`），被 Workflow 的 `remember` step 与队列 worker 共用。**worker 里必须惰性 import** —— 静态引入会把 Workflow 装配图并入 Long Agent runtime 图，Nitro dev Step worker 会以 `init_agent_definition is not a function` 启动失败（8 个 dev 测试全红）。
3. **writer 的上下文来自耐久分支**：`transformContext` 的入参**不含会话历史**（Workflow agent session 只有装配/控制条目）。`prepareWorkflowTurnContext` 也**不做**轮次投影。所以：投影 = `projectCurrentRoundContext(messages)`（保留最后一条 user 消息及其之后的一切）+ 从 `getContextBranch()` 取条目并 `sessionEntryToContextMessages` 转换；**没有 user 条目 → 返回 `null` 并拒写**（绝不把全部历史交给 writer）。
4. **两 stage 必须同一会话**：work step 若用 `sessionId: undefined` 会新建会话，必须把 work 解析出的 `sessionId` 传给 remember（否则 remember 打开第二个空会话、投影为空、直接拒写）。
5. **记忆目标身份**：toolContext 需要 `longAgentId`（会话自身存储项目）；`resolveSessionMemoryTarget` 仍强制必须是 agent home，普通项目会话永远拿不到记忆权限。
6. **锚点门禁**：**队列 worker** 在工作段启动**之前**，用 `ensureTopicRoundRunningMarker` 幂等写入 `chat.topic-round{status:"running"}`，`roundId` = 该轮 `turnId`（刚开始的轮次还没有用户条目，故 running 允许空 `userEntryId`）；检查/追加/flush 在**节点会话操作锁内**、且**在 work 之前释放**（不要把 work 包进同一把锁，会自锁），保证标记与 work/relay 落在同一分支。接受侧只排队、不写标记，所以“已接受、标记未写即中断”由 worker 在恢复执行时补上。`readTopicSettledAnchors` **按轮次**（`roundId === turnId`，兼容旧版把 `requestId` 当 `roundId` 的后缀匹配）抑制该轮**自己**的 `chat.long_agent_turn` completed，**不再用会话级开关**——主题模式之前的历史轮次继续可分叉、序号不变。关闭记忆时 worker 在工作段后直接写 completed。
7. **锁与恢复的边界**：`withFileLock` **不可重入**；读取型守卫（`requireTopicMemorySource`、`ensureChatSessionWithId`）用 **不触发恢复** 的 `readInactiveChatSessionState`；来源校验放在**图锁之外**；恢复只由真正的生命周期入口执行，且**清 pending 前**先收敛记忆与主题图。
8. **来源地址语义**：`TopicMemorySource` 指向**会话记忆条目**（agent home 下的 `smem-*`），不是 Pi 全文条目；Pi 全文地址只用于边的 `anchorEntryId`。
9. **relay 的耐久关联**：写在**原生 user message 自身**的 Chat 自有字段上（`message.chatTopicRelay`，Pi 原样往返），因此重放**精确匹配**、不用正文认领；去重范围是**整个会话文件**（`getEntries()`），不在当前分支 → 409。
10. **节点绑定唯一性**：`sessionId`、`nodeId` 各自唯一；**`topicId` 故意不唯一**（一个主题是多节点树）。

---

## 6. 常用命令与约定

```bash
# 定向测试（见 §1）；完整门禁
pnpm verify
git diff --check

# 真实模型配置复用（不复制、不打印凭据）
ln -s ~/.chat/agent <isolated-chat-home>/agent
```

约定：不推送、不部署，除非用户明确要求；只暂存本任务文件（不用 `git add .`）；保留其他 Agent 的工作区改动；发现实现与文档冲突时先判断是实现缺陷还是规范变化，不要只改文档合理化现状。
