# Chat 长期记忆

Chat 把长期记忆拆成两个职责清晰的本地存储：

- `.chat/memory/catalog.db`：Chat 的事实源，保存完整文本、分类、来源、版本和索引状态。
- `.chat/memory/vector-store.db`：Mem0 的语义索引，可随时从 `catalog.db` 完整重建。

因此 Mem0 或 embedding 初始化失败时，原文不会丢失；创建接口会返回 `503` 和
`persistedInChat: true`，记录保留为待修复状态，后续调用会自动重试同步。

## 管理 API

这些接口都复用 Chat 现有的 Web 登录认证：

| 操作 | 接口 |
| --- | --- |
| 添加 | `POST /api/memories` |
| 列表 | `GET /api/memories` |
| 查看 | `GET /api/memories/:memoryId` |
| 语义查询 | `POST /api/memories/search` |
| 更新 | `PATCH /api/memories/:memoryId` |
| 删除 | `DELETE /api/memories/:memoryId` |
| 完整重建 | `POST /api/memories/rebuild` |
| 状态 | `GET /api/memories/health` |

浏览器里的 Memory 管理页只调用这些 Chat API，不导入 Pi SDK，也不直接操作
SQLite 或 Mem0。页面支持语义搜索、精确列表、添加、编辑、删除、分页、健康状态和完整重建。

最小写入请求：

```json
{
  "text": "Later 偏好简单、模块化的 Agent 架构。",
  "kind": "preference"
}
```

工作流节点可以附加溯源信息：

```json
{
  "text": "Chat 的长期记忆以 catalog.db 为事实源。",
  "kind": "decision",
  "scope": "project",
  "projectId": "chat",
  "metadata": { "curatedBy": "memory-agent" },
  "source": {
    "sessionId": "session-id",
    "entryIds": ["entry-id"],
    "workflowInvocationId": "invocation-id"
  }
}
```

查询请求只需要文本，也可以限制范围、项目、类型和数量：

```json
{
  "query": "长期记忆的事实源是什么？",
  "scope": "project",
  "projectId": "chat",
  "topK": 5
}
```

## 本地 embedding

默认使用 Mem0 的 FastEmbed 适配器和 `fast-bge-small-zh-v1.5`，不需要 API Key。
模型只在第一次写入或语义查询时加载；单纯列出和查看 Chat 记录不会加载模型。
Mem0 匿名遥测在加载 SDK 前被关闭。

可用环境变量：

- `CHAT_MEMORY_EMBEDDING_MODEL`：FastEmbed 模型名。
- `CHAT_MEMORY_EMBEDDER_PROVIDER`：默认 `fastembed`；兼容 OpenAI embedding 服务时设为 `openai`。
- `CHAT_MEMORY_EMBEDDER_BASE_URL`：OpenAI 兼容服务的 `/v1` 地址。
- `CHAT_MEMORY_EMBEDDER_API_KEY`：OpenAI 兼容服务所需的 key。
- `CHAT_MEMORY_EMBEDDING_DIMENSION`：自定义服务返回的向量维度。

写入时固定使用 Mem0 `infer: false`：Chat/Pi 工作流决定存入什么文字，Mem0 只负责索引，
不会在存储层偷偷调用 LLM 改写内容。

## Memory Workflow

Memory 作为现有 Workflow Registry 中的一个普通工作流注册，只有一个 `manage` Stage，
由 `memory-agent` 执行。它复用 Chat 现有的 Agent 定义解析、Pi `AgentSession`、
`DefaultResourceLoader`、Session 持久化和 Stage 事件日志，不建立第二套 Agent Runtime。

Workflow 定义通过通用的 `prepareAgentSession` 合同注册 Memory 私有能力。实际执行和
`POST /api/workflows/:workflowId/agents/:agentId/resolve` 检查接口都会调用同一个
`prepareMemoryAgentSession()`，所以前端现有 Agent 能力面板可以自动看到最终 Tool 和 Skill，
不需要硬编码 Memory。`GET /api/workflows` 只投影浏览器安全的元数据，不暴露这个可执行装配器。

Memory Agent 的执行面严格限制为 6 个 Chat 自有工具：

- `memory_search`：语义搜索当前项目可见的全局和项目记忆。
- `memory_list`：不加载 embedding，精确列出记录。
- `memory_get`：按 Chat memory ID 查看完整记录。
- `memory_add`：写入 Chat 事实源并同步 Mem0 索引。
- `memory_update`：携带读取到的版本号更新，避免覆盖并发修改。
- `memory_delete`：携带读取到的版本号永久删除。

Agent 不暴露 Bash、Read、Write 或 Edit。运行时由 Chat 把私有 Memory Skill 放到
`.chat/memory/runtime/skills/memory/SKILL.md`，交给 Pi 的 ResourceLoader 加载，并用
`/skill:memory` 显式展开。Skill 规定：普通聊天不能自动写入；模糊更新和删除先搜索并消歧；
新增前检查明显重复；不存密钥、临时日志或未经确认的推测。

项目级记忆的 `projectId` 由当前 Chat Session 的 `cwd` 注入，Agent 不能读写其他项目的
项目级记忆。每次新增还会自动记录 Session ID 和 Workflow Invocation ID，便于追踪来源。

## 设计边界

1. Chat SQLite 是唯一事实源，管理页和 Agent 都通过同一个 `MemoryService` 读写。
2. Mem0 只负责语义索引；重启后从本地数据库恢复，也可以从 Chat SQLite 全量重建。
3. 是否调用 Memory Workflow 由用户主动决定，不在普通对话链路中隐式检索或写入。
4. 以后若增加自动总结，只增加新的触发策略或 Workflow Stage，不改变当前 CRUD 合同。
