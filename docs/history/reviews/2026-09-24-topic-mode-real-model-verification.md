# 主题模式：建题入口真实模型验证（2026-09-24）

状态：**真实模型端到端跑通**。范围：P2 #5「说一句建题」后端入口（`startTopicIntegration` + `POST/GET /topics/integrations`）在真实模型下的一次运行记录与失败点归档。原始证据（gitignored）：`.data/verification/topic-mode/evidence.json`。

## 方法

- 隔离 `CHAT_HOME`：临时目录，仅 symlink `~/.chat/agent` 的 `models.json`、`settings.json`、`auth.json`、`models-store.json`，不读取、不打印、不复制任何凭据。
- 真实模型：`provider=command`、`model=deepseek/deepseek-v4.1-flash`、`thinking=high`（取自已配置的 `settings.json` 的安全字段）。
- 链路：`daily turn → startTopicIntegration → drain(后台整合 work) → drain(节点 work+remember) → 用真实 settled 锚点建子节点`。全部走真实 `executeAcceptedLongAgentTurn` / 公共装配 / `topic_manage` 工具。
- 脚本：`.data/verification/topic-mode/verify.mjs`（手动运行，不在任何门禁内）。

## 结果（成功部分）

整合后台 work 的真实模型调用序列（原样，来自会话分支）：

| # | 工具调用 | 结果 |
|---|---|---|
| 1 | `topic_manage read_fulltext {sourceSessionId, limit:50}` | ok，读到来源日常会话 19 条 |
| 2 | `topic_manage read_memory {sourceSessionId}` | ok，读到来源会话记忆 |
| 3 | `topic_manage create_topic {requestId:"real-topic-1", title:"订单页空指针定位", purpose:...}` | created |
| 4 | `topic_manage create_node {topicId, requestId:"real-topic-1", title, integrationSummary, sources:[...]}` | created |

- **模型确实先读再整理再建**：`read_fulltext` → `read_memory` → `create_topic` → `create_node`，不是直接建。
- 产物：`topic-ccf2927ba46c039fcff46821de3c3a87` / `node-300c1750ddc71ef98409c21a10c49f22` / `sess-0c15f608d1e10deb36a0371ad4edb592`，与入口返回的**确定性 id 完全一致**。
- **初始来源可查**：`node.initialMemoryRefs = [{entryId:"smem-0001-b550f7b648bcb006", source:{storageProjectId:"friend", sessionId:"<daily>", entryId:"smem-0001-d21a3f6c60840161"}}]`——根节点初始记忆指回来源会话记忆条目。
- 根节点初始记忆正文（`purpose=background`）是整合后的独立事实，不是原文拼接。
- 节点轮次（真实模型）`work+remember` 完成：先 `read_memory`/`read_fulltext`/`read_graph`，再 `session_memory list` → `write`；settled 锚点 `anchorSequence=1`。
- **真正建出子节点**：用该真实锚点 `createTopicNodeWithSession` 建 `node-61fc9923e9a79faa263770c9f54bdb9a`，父边 `parentNodeId=node-300c…`、`anchorEntryId=64d18d98`、`anchorSequence=1`。

## 失败点与观察（如实记录）

1. **（第二次验证已修正）日常轮次的模型不知道自己的 sessionId。** 第一次验证时，模型在 daily turn 里把 `sourceSessionId` 填成 turn 形态，留下无节点主题壳。现在日常路径改为 `topic_manage request_topic`：模型只给 `title`/`purpose`，服务端从**当前可信 turn** 派生来源与请求身份；日常直接 `create_topic` 被拒绝。见下方「第二轮」。
2. **writer 的 purpose 白名单对真实模型有效，且模型能自我纠正。** 节点轮次的 writer 第一次用 `purpose:"排查方案"` 被拒绝（`会话记忆purpose不在允许列表：排查方案`），随后改用允许值重试成功（会话记忆 revision 1 → 2）。
3. 真实模型在高 thinking 下会输出较长整合摘要与排查方案，属于预期；单次全链耗时在分钟级。

## 第二轮：日常轮次模型真实选择 `request_topic`（2026-09-24）

方法：隔离 `CHAT_HOME` + symlink，真实模型 `command/deepseek/deepseek-v4.1-flash`（thinking high）。先跑一轮日常记录创建会话并写入一条 session-memory，再发**一句自然语言**「帮我把这个问题建成一个主题，方便我后面继续排查。」；脚本 `verify-daily.mjs`，证据 `evidence-daily.json`。

- 日常轮次**模型真实调用了 `topic_manage request_topic`**（不是手工调用工具）：参数只含 `title`/`purpose`，没有 `sourceSessionId`；`requestTopicCalled=true`。
- 后台整合工作（同一模型）随后执行：`read_fulltext → read_memory → create_topic → create_node`。
- 结果：`status=completed`，根节点 `node-644d532ef8ee2a67204604b93f828f0d`，`initialMemoryRefs` 指回来源会话记忆条目 `smem-0001-b151552ef451996d`。

结论：**「一句自然语言 → 模型选择受控工具 → 服务端解析来源/请求身份 → 后台整合建根节点」已由真实模型跑通**；这与“手工调用 `topic_manage.execute(request_topic)`”是不同性质的证据（后者只证明接线）。日常直接 `create_topic` 仍被拒绝，因此不再产生无节点的主题壳。

## 未覆盖 / 下一步

- fork 建题的 `parents` 透传与「用户确认后的补充整合（R4）」入口的**真实模型**验证未做（机制已由假模型覆盖）。
- relay 执行链、问题定位 workflow 的身份/归属已由假模型覆盖；如需真实模型确认，可另跑一次。
- 建议后续把验证脚本按需纳管（独立 manual 脚本或 opt-in 门禁），不放进每轮 `pnpm verify`。
