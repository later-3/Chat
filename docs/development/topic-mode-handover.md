# 主题模式（Topic Mode）交接文档

状态：**完整会话与审核创建已落地；当前结论以本次收口报告为准。** 更新：2026-09-25。
父仓库与 Frontend 均包含既有及本次未提交改动；不得清理或重置。当前实现/证据见[纠偏方案](./topic-mode-correction-plan.md) §0 与[收口报告](../history/reviews/2026-09-25-topic-mode-closeout.md)。测试数量不能替代实际交互验收。
本文 §2 和旧实施记录用于溯源；其中后台 work 直接建题是历史实现，新建请求现统一走审核 Workflow。

---

## 1. 五分钟上手（新会话从这里开始）

```bash
cd /Users/xulater/Code/Chat
git log --oneline -8          # 核对当前提交，不假定历史基线仍是 HEAD
git status --porcelain         # 记录并保留既有未提交改动，不要求清空
pnpm verify                    # exit=0；含架构检查、生产构建、built 与 test:dev
```

必读（按顺序，不要无差别通读）：
0. `docs/development/topic-mode-correction-plan.md`（当前用户目标、技术方案、UI 标准、统一验收）；
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
| `topic-manage` 工具 | `5bd6fe87f` → `8028e8a28` → `8e73b576a` | 读图/读节点/跨树只读记忆与全文（含游标）/建主题建节点（多来源）/补边（锚点 + 规格幂等）/状态/relay（先落**耐久意图**，轮到它的轮次才在活动分支追加**唯一**原生消息 + 内嵌关联，按 `(nodeId,requestId)` 幂等） |
| 节点只读 API | `0b1e0e06e`、`e163e35a3` | `GET /topics`、`GET /topics/{topicId}`（仅本主题边）、`GET .../nodes/{nodeId}/messages`（必须 `node.topicId === topicId`） |
| 节点会话绑定 + 写侧 | `a7978ebaa`、`3e5c1f85b`、`069fe47aa`、`1df9105a5`、`3f161ab80`、`325cb5fba` | state `nodeSessions`（schemaVersion 6）、绑定与 turn 同次写入、执行期会话选择、节点重放**双向**严格（轮次种类属于请求身份） |
| 生命周期与读取守卫 | `d14fe2f9a`、`b2664c9bf` | 会话 remove/restore/purge 镜像到节点状态；恢复回调在清 pending 前收敛记忆与主题图；`assertSessionFileReadable` 对通用读取入口应用主题判定 |
| 外层「会话记忆」workflow | `5f39c7308`、`e2a78cc0e`、`750596dbd`、`a54eb1456` | `work → remember` 同一节点会话；writer 只收到**当前轮**（从耐久分支投影）；worker 具备普通工作工具 + `workflow_call`；本轮返回**work 答案**；节点级记忆开关 |
| 外层编排 + 关闭提前分叉 | `28a4d2483` | 队列 worker = 编排点：工作段 → writer → 整轮完成标记 → 才 settle；锚点只认 `completed` 整轮标记 |
| 锚点窗口修复（复核后） | 本批（`git log` 顶部） | running 标记改由队列在**工作段之前**幂等写入（同一 `turnId`，且在**节点会话操作锁内**检查/追加/flush、work 前释放）；`readTopicSettledAnchors` 改为**按轮次**抑制 `chat.long_agent_turn`，不再用会话级开关抹掉历史；新增 3 条回归（历史锚点保留、恢复时先写 running 再工作、并发写入下标记串行落同分支） |
| 建题入口 | 本批（`git log` 顶部） | `topic-integration.ts` + `POST/GET /topics/integrations`：服务器解析/校验**日常来源会话**，启动 `startFriendWork({title:"整合：…"})`，返回 work/execution 与**确定性** `topicId/nodeId/sessionId`；整合由该后台 work 经**真实装配**调用 `topic-manage` 提交；假模型 API e2e 覆盖建题 → 建根节点+初始记忆 → 节点内 work+remember → 可分叉 |
| 建题幂等补齐 | 本批（`git log` 顶部） | `startTopicIntegration` 在节点已建成时也拿**已持久化 work** 核对请求身份：同 `requestId` 重放返回同一 work，改 title/purpose/source → 400，而不是静默成功；已持久化 work 的源在跨日重放时优先于重新解析“今天的日常会话”。补建成后重放测试 |
| 日常“说一句建题” + fork | 本批（`git log` 顶部） | `topic_manage request_topic`：模型只给 `title`/`purpose`（可选 `parents`），**服务端从当前可信 turn 派生请求身份、以当前会话为日常来源**，再调现有 `startTopicIntegration`；`fork` 用 `parents`（父节点 + settled 锚点）复用父主题与同一后台链；日常 `create_topic` 被拒绝；完成无节点 → `status=failed`。假模型：`test/long-agents/topic-integration.test.mjs`（建题 → 根；节点轮 → 锚点 fork → 有父边子节点；无节点不算成功） |
| 建题入口真实模型验证 | 本批（`git log` 顶部） | 隔离 `CHAT_HOME` + symlink：真实模型（`command/deepseek-v4.1-flash`）跑了 `read_fulltext → read_memory → create_topic → create_node` → 根节点+初始 provenance → 节点轮 `work+remember` → 真实锚点建子节点；**第二轮**用一句自然话语验证模型**真实选择 `request_topic`**（非手工调用）→ 后台整合建根；证据：`docs/history/reviews/2026-09-24-topic-mode-real-model-verification.md` |
| P2 收口：R4 + 跨进程 + P3 窄 API | 本批（`git log` 顶部） | R4 `supplementTopicChildIntegration`（用户确认留痕 + 记忆/relay 产物 + 补边，同一 `requestId` 幂等）及 owner 路由；子进程接受节点/relay 轮次后新进程成功 drain（`test/long-agents/topic-restart.test.mjs`）；`sessionMemory` 非法值解析收紧；P3 窄 API：`GET .../nodes/{nodeId}/anchors`、`PATCH .../nodes/{nodeId}`、`POST /topics/integrations` `parents`、read model 暴露 `chatTopicRelay` |

---

## 3. 当前用户可用能力

- **创建**：日常对话请求、新建与 fork 均走 `topic-session-create`（整理 → 审核/多轮修改 → 批准后创建）；取消不创建。现有 Run/Session 绑定保存可信来源与请求身份；只读 GET 恢复同一审核任务。新旧 HTTP 发起入口均守审核边界，旧 work 请求仍可重放查询。
- **会话**：节点就是既有 Pi Session，中央是公共 ChatWindow，支持连续对话、流式、工具、按模型能力上传图片、停止、草稿与刷新恢复。节点由图解析、接受绑定与轮次一次落盘，执行仍用原有 Long Agent 队列。
- **记忆**：work 答案先显示；remember 真实阶段可见且可停止，回执不顶替工作答案；整轮成功后才产生分叉锚点。记忆查看/编辑/CAS、开关、来源与关联在按需资料弹层。
- **关系**：从 settled 锚点审核后创建子节点，冻结父边；R4 补充整合保留用户确认与请求身份；relay 耐久意图在执行期生成唯一原生消息。
- **恢复**：审核/聊天刷新与断线重连恢复现有引用，不重发；进程中断保持既有 interrupted/不自动重放合同，不能宣称外部副作用 exactly-once。
- **布局**：桌面完整会话，窄屏导航折叠、输入/停止可直接操作；390/768/1440 与缩放等效视口均有浏览器截图。

## 4. 交接与发布边界

1. 查看 [收口报告](../history/reviews/2026-09-25-topic-mode-closeout.md) 的最终门禁、模型证据及预览地址。预览数据和正式 `~/.chat` 分离；未部署正式服务。
2. 保留工作区全部改动。提交/推送/部署仅在用户明确要求后进行；Frontend 是 submodule，发布时必须记录对应 commit。
3. 验收分层：假模型 + 真实 Runtime + 浏览器证明确定性交互/存储/恢复；真实文本模型证明实际工具选择/整理/创建/回答/fork；图片 HTTP 传输验收不等于真实视觉识别质量。
4. 动态 Workflow 热加载、任意外部副作用自动重试、全局 UI 改版不在本轮范围。不要因这些扩展重新打开已闭环的主题会话任务。

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
9. **relay 的耐久身份**：受理写**耐久意图**（custom entry），原生 user message 带 `message.chatTopicRelay`，Pi 原样往返；重放按 `requestId` 精确匹配意图或原生消息，**一次请求只有一条原生消息**，重放 `created:false`。
10. **节点绑定唯一性**：`sessionId`、`nodeId` 各自唯一；**`topicId` 故意不唯一**（一个主题是多节点树）。
11. **冻结项目的摘要顺序**：节点轮次的 `frozenProjectContext` 必须在**计算请求摘要之前**解析（`acceptLongAgentTurn`），否则首存摘要写 `null`、重试从已接受记录取到真项目 → 同一 POST 自相矛盾 409。冻结目标（`FriendWork.topicIntegration`）同理要在 `readTopicIntegration` 里**先于**图推导。
12. **relay 身份统一：先意图、后消息**：受理只写**耐久代传意图**（`chat.topic-relay-intent` custom entry，不进上下文），原生 user message 由**轮到它的轮次在活动分支上追加一次**（带 `chatTopicRelay` 关联，再 `resumePendingTurn()`）。这样 N 条排队 relay 自然成为同分支完整轮次、**每请求唯一一条消息**、完成后原样重放 `created:false`。不要在执行期 `branch()` 或重挂消息（会复制条目、破坏一请求一消息与重放）。

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
