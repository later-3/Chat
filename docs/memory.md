# Chat 长期记忆

本文定义 Chat 当前长期记忆的用户场景、Agent 使用方式、Target、存储、管理界面、HTTP API 和失败语义。代码修改必须与本文保持一致。

## 1. 能力定位

Memory 保存需要跨 Session 继续使用的稳定事实。它由 Agent 主动调用 `memory_*` Tool 读写，也可以由用户在 Memory 管理页直接管理。

当前适合写入的内容包括：

- 用户长期偏好，例如沟通方式、常用技术选择和生活背景。
- Project 稳定事实，例如架构决定、长期约束和已验证经验。
- 用户明确要求保留的决定、目标、事实或会话摘要。

一条 Memory 保存一个可以独立理解的长期事实。当前支持 7 种 `kind`：

| `kind` | 含义 |
|---|---|
| `preference` | 用户或 Project 的稳定偏好 |
| `fact` | 已确认的稳定事实 |
| `decision` | 已作出的长期决定 |
| `lesson` | 可跨任务复用的经验结论 |
| `goal` | 需要持续保留的目标 |
| `constraint` | 长期有效的限制或边界 |
| `session_summary` | 用户明确要求保存的会话摘要 |

Memory 与 Session 历史、Rule、Experience 和 Skill 各自保留独立职责：Session 保存会话过程，Rule/Experience 是可版本化的 Prompt 资源，Skill 描述任务方法，Memory 保存长期事实。Agent 在一次执行中可以同时装配并使用这些资源。

### Long Agent的Agent Memory边界

本文主体描述的Chat Catalog与Mem0是Personal/Project Shared Memory：它保存用户事实和Project事实，可以被当前Target内多个Workflow Agent与Long Agent共享。Long Agent还需要一份不同作用域的Agent Memory，由其NanoClaw Agent Group拥有，用于该长期同事自己的身份、关系史、工作方法、专长沉淀、开放事项和Scratchpad。

```text
Chat Personal/Project Memory
  → Catalog是事实源，Mem0是可重建语义索引
  → 多Agent按授权共享

NanoClaw Agent Group Memory
  → Open Knowledge Format Markdown是事实源
  → 按Agent Group隔离，只属于一个Long Agent
```

`chat-pi`执行链同时装配两类Memory。Chat `memory_search`与`memory_record`访问Personal/Project共享事实；`agent_memory_search`、`agent_memory_read`与`agent_memory_write`访问当前Long Agent自己的NanoClaw OKF Markdown。Host依据可信`longAgentId`绑定`agentGroupId`，模型参数不能选择其他Group。每轮Pi装配前读取Standing Instructions、`index.md`与`system/definition.md`；最后有效Snapshot只在网络错误、超时或NanoClaw 5xx时作为标记为stale的派生缓存，认证、对象或响应合同错误不回退缓存。Agent Memory写入限制为900 KiB UTF-8数据，并使用Revision乐观并发与Chat审计记录。

公开Pi Extension的评估结论如下：

- [`pi-memory`](https://pi.dev/packages/pi-memory)的Markdown、Daily Log、Scratchpad、可恢复删除、Compaction Handoff、稳定Context Snapshot和可选qmd检索值得复用；但其默认全局目录、固定Collection、Tool命名和进程级状态不满足同一Chat进程中多个Long Agent的并发隔离，不能原样全局安装。
- [`pi-agent-memory`](https://pi.dev/packages/pi-agent-memory)依赖额外claude-mem Worker、SQLite/FTS5/Chroma并自动采集Tool观察，形成第三套存储和索引；其跨引擎Project作用域、隐私、AGPL和运维边界与Chat当前架构不一致，不作为核心Long Agent Memory。

NanoClaw Markdown是Agent Memory唯一事实源，Chat通过带服务认证的静态Resource API和Pi Tool适配层访问。详细设计见[Chat Long Agent能力与NanoClaw Agent Group模型](./architecture/chat-long-agent-capability-model.md)。

## 2. 用户场景与入口

| 场景 | 用户入口 | 实际动作 |
|---|---|---|
| 让 Chat 记住一项事实 | 选择 Memory Workflow 并明确说明内容与范围 | Memory Agent 先检查重复，再调用 `memory_record` |
| 在任务中使用历史背景 | 使用装配了 `memory_search` 的 Agent | Agent 围绕当前任务主动语义查询 |
| 查看当前已有记忆 | Memory 管理页或 Memory Workflow | 页面调用列表 API；Agent 调用 `memory_list` |
| 更正一项记忆 | Memory 管理页或 Memory Workflow | 读取现有记录后按 Target 和 ID 更新 |
| 删除一项记忆 | Memory 管理页或 Memory Workflow | 确认目标记录后永久删除 |
| 检查或修复语义索引 | Memory 管理页 | 查看索引状态并从 Chat Catalog 重建 Mem0 索引 |

普通聊天本身不会触发隐式写入。写入发生在用户明确要求保存，且当前 Agent 已装配 `memory_record` 后；Memory Workflow 的 Skill 还要求新增前检查重复、更新或删除前消歧，并禁止把密钥、原始日志、临时调试输出和未经确认的推测写入 Memory。

## 3. Target、默认范围与可见性

Memory 按 Target 保存到相互独立的 Store：

```text
Personal Store
Project chat Store
Project example-project Store
...
```

支持两种 Target：

```json
{ "type": "personal" }
```

```json
{ "type": "project", "projectId": "chat" }
```

- Personal Memory 适用于跨 Project 的用户事实和偏好。
- Project Memory 适用于只属于一个已登记 Project 的事实、决定和经验。
- Agent 默认语义查询 Personal 与当前 Project。
- Agent 默认把新 Memory 写入当前 Project；明确的跨 Project 用户事实应写入 Personal。
- 用户明确指定时，Memory Tool 可以查询或写入一个或多个已登记 Project。
- Memory 管理页默认展示 Personal 与当前 Project，并允许切换到 Personal 或任意一个已登记 Project。

Memory 的完整地址是 `Target + memoryId`。同一个事实写入多个 Target 时，每个 Store 创建独立记录，并通过相同 `groupId` 关联；后续更新和删除仍按各自地址执行。

## 4. 当前架构

```text
Agent memory_* Tool ─┐
                     ├─> MemoryStoreManager ─> MemoryService ─> Chat Catalog
Memory 管理页 ─> API ┘                                 └──────> Mem0 语义索引
```

各层职责如下：

1. `MemoryStoreManager` 根据 Target 解析 Personal 或 Project Store，并负责多 Target 查询、写入和审计。
2. `MemoryService` 执行校验、Catalog CRUD、Mem0 同步、索引修复和重建。
3. `catalog.db` 是完整事实源，保存文本、类型、来源、版本和索引状态。
4. `vector-store.db` 是 Mem0 的本地语义索引，可以从同一 Store 的 `catalog.db` 重建。
5. HTTP API 和 Agent Tool 使用同一个 `MemoryStoreManager` 与 `MemoryService`，管理页只通过已认证的 Backend API 访问数据。

精确列表、详情和健康状态直接读取 Chat Catalog，不需要加载 embedding 模型。语义查询先调用 Mem0 检索候选，再以 Chat Catalog 中仍然有效的记录补全和过滤结果；已经从 Catalog 删除的记录不会因索引残留重新显示。

## 5. 存储目录

`<CHAT_HOME>` 默认是 `~/.chat`，也可以由 `CHAT_HOME` 覆盖。

| Target | Chat Catalog | Mem0 索引 |
|---|---|---|
| Personal | `<CHAT_HOME>/memory/personal/catalog.db` | `<CHAT_HOME>/memory/personal/vector-store.db` |
| Project | `<CHAT_HOME>/projects/<projectId>/memory/catalog.db` | `<CHAT_HOME>/projects/<projectId>/memory/vector-store.db` |

FastEmbed 模型缓存位于 `<CHAT_HOME>/cache/fastembed`。Project 源码目录中的 `.chat` 只保存 Project 声明和可移植配置，不保存 Memory 数据库。

## 6. Agent Tool 与 Memory Workflow

`memory_search` 和 `memory_record` 是 Chat 系统 Tool，可通过系统 Tool Registry 装配到显式选择它们的 Workflow Agent：

- `memory_search`：按自然语言语义查询一个或多个 Target；未传 `targets` 时查询 Personal 与当前 Project。
- `memory_record`：向一个或多个 Target 写入；未传 `targets` 时写入当前 Project，并记录当前 Tool Call 的来源。

Planning Execution Workflow 的 Planner 当前默认装配只读 `memory_search`，用于在规划前查询与任务相关的稳定背景。Memory Workflow 提供完整管理能力，由一个 `memory-agent` 执行，装配 6 个 Tool：

- `memory_search`
- `memory_record`
- `memory_list`
- `memory_get`
- `memory_update`
- `memory_delete`

其中 `memory_list`、`memory_get`、`memory_update`、`memory_delete` 是 Memory Workflow 的私有管理 Tool。更新和删除要求先读取记录并携带 `expectedVersion`，用于阻止覆盖并发变化。

Memory Skill 的源码位于 `src/workflows/memory/agents/memory-agent/skills/memory/SKILL.md`。生产构建把它物化到 `<CHAT_HOME>/runtime/skills/memory/SKILL.md`，`prepareMemoryAgentSession()` 读取完整 Skill 内容，并在最新一条用户消息前注入本次 Memory Agent 上下文。Agent 检查页与真实执行使用同一个装配入口。

Tool 写入会记录 `projectId`、`sessionId`、`workflowId`、`workflowInvocationId`、`stageId`、`agentId`、`toolCallId`、Tool 地址和版本；Catalog 当前直接投影其中的 Session、Project、Entry 和 Workflow Invocation 来源字段，完整管理动作同时写入 `<CHAT_HOME>/logs/audit.jsonl`。

## 7. Memory 管理页

Memory 管理页是 Backend Memory 能力的浏览器控制面：

1. 默认范围为“Personal + 当前 Project”。页面分别请求两个 Store 的精确列表，在浏览器中按 `updatedAt` 合并排序后分页；没有当前 Project 时只读取 Personal。
2. 选择 Personal 或某个 Project 后，列表、健康状态和重建操作只作用于该 Target。
3. 输入搜索文字后，页面调用多 Target 语义搜索 API；清除搜索后恢复 Catalog 精确列表。
4. 顶部状态卡汇总当前选择范围内的记录数、已索引、待索引、索引失败和待清理数量。
5. 在组合范围中点击“添加记忆”时，编辑器必须显示一个具体写入 Target，默认选择当前 Project；用户可以改为 Personal 或其他已登记 Project。
6. 编辑和删除使用记录自身的 Target，不受之后切换筛选范围影响。
7. “重建索引”只重建当前选中范围；组合范围会分别重建 Personal 与当前 Project，并汇总结果。

页面不会把“当前范围没有记忆”等同于系统没有任何 Memory。用户可以切换 Target 或清除语义搜索条件查看其他记录。

## 8. 数据模型与生命周期

每条 Catalog 记录包含：

- 业务字段：`id`、`text`、`kind`、`status`、`version`、`createdAt`、`updatedAt`。
- Target 字段：`scope`、`projectId`、`groupId`。
- 来源字段：`sourceSessionId`、`sourceProjectId`、`sourceEntryIds`、`sourceWorkflowInvocationId`。
- 索引字段：`mem0Id`、`indexStatus`、`indexError`。
- 扩展字段：`metadata`。

写入和更新按以下顺序执行：

```text
校验输入
  -> 写入 Chat Catalog，indexStatus=pending
  -> 使用 Mem0 infer:false 写入或更新语义索引
  -> Catalog 标记 indexed；失败则标记 failed 并保存错误
```

Mem0 使用 `infer: false`，存入索引的文字由调用 `memory_record` 的 Agent 或管理页决定，Mem0 不在存储层改写原文。

若 Catalog 已保存但 embedding 或 Mem0 同步失败，HTTP 写入返回 `503`，错误数据包含 `memoryId` 与 `persistedInChat: true`。记录仍保留在 Catalog 中并显示为索引失败；后续需要索引的调用会重试待处理记录，用户也可以从管理页完整重建。

删除先从 Catalog 移除记录，再清理 Mem0 ID。若索引清理失败，操作返回 `indexCleanup: "pending"`，待清理任务保存在 Catalog；语义查询始终以 Catalog 复核结果，因此该记录已经不可见。

## 9. HTTP API

所有 Memory API 都复用 Chat Web 登录认证：

| 操作 | 接口 | Target 形式 |
|---|---|---|
| 添加 | `POST /api/memories` | Body 中的 `target` 或 `targets` |
| 列表 | `GET /api/memories` | Query 中的 `scope`、`projectId` |
| 查看 | `GET /api/memories/:memoryId` | Query 中的 `scope`、`projectId` |
| 语义查询 | `POST /api/memories/search` | Body 中的 `targets` |
| 更新 | `PATCH /api/memories/:memoryId` | Body 中的 `target` |
| 删除 | `DELETE /api/memories/:memoryId` | Query 中的 `scope`、`projectId` |
| 完整重建 | `POST /api/memories/rebuild` | Body 中的 `target` |
| 状态 | `GET /api/memories/health` | Query 中的 `scope`、`projectId` |

写入当前 Project：

```json
{
  "target": { "type": "project", "projectId": "chat" },
  "text": "Chat 的 Memory Catalog 是长期记忆事实源。",
  "kind": "decision",
  "metadata": { "managedBy": "memory-page" }
}
```

同时查询 Personal 与当前 Project：

```json
{
  "query": "长期记忆的事实源是什么？",
  "targets": [
    { "type": "personal" },
    { "type": "project", "projectId": "chat" }
  ],
  "kind": "decision",
  "topK": 5
}
```

精确列出 Personal Memory：

```text
GET /api/memories?scope=personal&status=active&limit=30&offset=0
```

精确列出 Project Memory：

```text
GET /api/memories?scope=project&projectId=chat&status=active&limit=30&offset=0
```

## 10. Mem0 与 embedding 配置

Mem0 当前使用本地 `memory` Vector Store，Collection 名为 `later_chat_memories`，固定 `userId` 为 `later`，历史记录由 Chat Catalog 管理。Mem0 匿名遥测会在 SDK 加载前关闭。

默认 embedding Provider 是 FastEmbed，模型为 `fast-bge-small-zh-v1.5`，不需要 API Key。模型只在首次写入、更新、语义查询、修复或重建索引时加载。完整环境变量与重建要求统一记录在[系统配置：Memory embedding](./configuration.md#memory-embedding)。

## 11. 实现入口与验证

| 职责 | 实现入口 |
|---|---|
| Target 与数据类型 | `src/memory/types.ts` |
| 多 Store 路由与审计 | `src/memory/manager.ts` |
| Catalog CRUD 与索引生命周期 | `src/memory/repository.ts`、`src/memory/service.ts` |
| Mem0 适配器 | `src/memory/mem0-index.ts` |
| Store 路径与 embedding 配置 | `src/memory/runtime.ts` |
| HTTP 校验与 API | `src/memory/http.ts`、`src/routes/api/memories/` |
| 公共 Memory Tool | `src/tools/builtins/memory-search/`、`src/tools/builtins/memory-record/` |
| Memory Workflow | `src/workflows/memory/` |
| 管理页 | `frontend/components/MemoryManager.tsx`、`frontend/lib/memory-contract.ts` |

修改 Memory 后至少运行相关测试，并按项目要求运行完整验证：

```bash
pnpm verify
git diff --check
git -C frontend diff --check
```
