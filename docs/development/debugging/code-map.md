# 源码、流程与核心接口地图

## 先分清 4 个模块

| 模块 | 学习入口 | 负责的事实 | 不负责的事 |
|---|---|---|---|
| Frontend | [useAgentSession](../../../frontend/hooks/useAgentSession.ts)、[浏览器 Run 客户端](../../../frontend/lib/chat-workflow-browser.ts) | 页面草稿、导航、显示、HTTP 响应解析 | 不保存另一份权威 Session，不直接连接模型或 Nano 数据库 |
| Backend | [Run 路由](../../../src/routes/runs.post.ts)、[公共装配](../../../src/agents/pi-agent-session.ts) | Project、配置、Workflow、Long Agent 生命周期、HTTP合同 | 不复制 Pi Agent Loop |
| Pi | [SDK](../../../pi/packages/coding-agent/src/core/sdk.ts)、[AgentSession](../../../pi/packages/coding-agent/src/core/agent-session.ts) | 模型请求、Tool Loop、原生消息、资源加载、Session 文件 | 不认识 Chat 的页面与 Nano Group |
| NanoClaw | [main](../../../nanoclaw/src/index.ts)、[router](../../../nanoclaw/src/router.ts) | Channel、Group、Wiring、Mailbox、投递和回执 | `chat-pi` 下不执行原生容器 Agent Runtime |

表中 Nano 链接用于阅读父仓库固定版本；实际调试断点与编辑文件在 `.data/debug/nanoclaw`，先核对两边 Commit。

## Web 普通对话：按函数追踪

1. `useAgentSession` 根据 Session `owner` 判断普通会话或长期同事；普通会话调用 `runChatWorkflowPrompt()`。
2. `POST /runs` 校验用户输入与 Project，恢复默认选择/Session，返回 `runId / workflowInvocationId / sessionId`。
3. [startChatWorkflow](../../../src/workflows/start-chat-workflow.ts) 从 Registry 选择 Workflow，由 Workflow SDK 启动。
4. [minimalPiCodingAgentWorkflow](../../../src/workflows/minimal-pi-coding-agent/workflow.ts) 组织一次执行，进入 [runPiCodingAgentPromptStep](../../../src/workflows/minimal-pi-coding-agent/step.ts)。Workflow 代码受持久执行约束；Node 文件 IO、模型和 Tool 执行在 Step 中。
5. `prepareChatWorkflowTurnConfiguration()` 冻结本轮选择；`resolveWorkflowAgentDefinition()` 解析 Prompt/Tool/资源路径。
6. `createWorkflowAgentSession()` 是薄包装，最终只调用 `createChatPiAgentSession()`。后者构造 `DefaultResourceLoader`、加载资源、注册系统 Tool，并调用 Pi `createAgentSession()`。
7. `session.prompt()` 开始模型与 Tool 循环；事件订阅进入日志/Run 流，SessionManager 保存原生消息。最后释放 Session。
8. 浏览器消费 NDJSON，终态重新读取 Session；页面内存不是运行事实源。

## 渠道对话：跨进程的边界

```text
Telegram/微信 Adapter
  → routeInbound（平台身份、成员权限、Wiring、触发规则）
  → resolveSession / writeSessionMessage（Nano Channel Session / Inbox）
  → chat-pi ExecutionDriver（耐久 HTTP Outbox）
  → POST /api/internal/channel/v1/events（服务认证 + 结构校验）
  → acceptLongAgentEvents（Chat 耐久接收，返回 202）
  → syncLongAgentEvents（恢复 Worker / 重试）
  → executeLongAgentTurn（真实 Project + 原生 Chat Session）
  → createChatPiAgentSession → Pi
  → persistNanoClawDelivery → Nano Outbound
  → acknowledgeNanoClawInbound → Nano Inbox Ack
  → delivery poll → 对应 Adapter → 平台
```

Ack 与投递是不同操作；不能看到 Ack 就判断平台用户已读。Chat Session ID 与 Nano Session ID 也不同：Nano ID 是 Channel/Mailbox 路由坐标，映射关系保存在 Chat Long Agent 状态中。

## 核心接口速查

| 接口/函数 | 输入与输出 | 在这里看什么 |
|---|---|---|
| `POST /runs` | Project、prompt、workflow、可选 Session/本轮选择 → 202 + 三个 ID | accepted 不等于 completed；已有活跃 Run 不能随意叠加 |
| `GET /runs/:id` | Run ID → 当前状态/最终结果 | 区分 running、completed、failed、cancelled |
| `GET /runs/:id/events` | Run ID、startIndex → NDJSON | HTTP流，不是 WebSocket/SSE；恢复不是逐条已确认重放 |
| `DELETE /runs/:id` | Run ID → 取消执行 | 停止浏览器读取不是这个操作 |
| `resolveWorkflowAgentDefinition()` | 当前作用域、Agent 默认值、有效选择 → 解析后的 Definition | 权限根、模型覆盖、Prompt revision、资源规范路径 |
| `createChatPiAgentSession()` | 可信 ChatSession、SessionManager、已解析 Agent → session/resourceLoader/tools | 唯一装配入口；本身不调用模型；调用方负责 dispose |
| `POST .../agents/:id/resolve` | projectId/cwd + 可选 selection → 实际检查结果 | 内存 Session 装配，模型/Prompt/active tools/资源诊断 |
| `POST /api/internal/channel/v1/events` | schemaVersion、instanceId、events → accepted/duplicate | 服务认证；同 ID 不同内容拒绝；202 前耐久保存 |
| `executeLongAgentTurn()` | Long Agent、已绑定 Project/Session、Turn 输入 → 执行结果 | Turn 重试/原生分支、固定 Group Snapshot |
| Gateway `/v1/deliveries`、`/v1/acks` | 稳定 Delivery/Turn/Inbox 标识 → 持久结果 | 路径基于 Registry gatewayBaseUrl，鉴权使用双方服务 Token |

HTTP 请求体精确定义以[路由源码](../../../src/routes)与[配置文档](../../configuration.md)为准。新增字段时同时更新提供方、Frontend 的运行时 parser、测试；不能只改 TypeScript 类型。

## 常见名字的含义

| 名字 | 含义 |
|---|---|
| Project | 配置、Session、资源和授权的作用域；daily 也是真实 Project |
| Workflow | 一次执行的节点组织，不是第二套 Agent Runtime |
| Agent Definition | 本轮模型、Thinking、Prompt、Tool、Skill/Extension/Plugin 策略 |
| Long Agent | 跨任务长期身份；当前 Registry 映射到一个 Nano Agent Group |
| Agent Group | Nano 的长期实体，一个 Group 不是多个 Agent 的 Team |
| Messaging Group | 平台上的一段会话；Wiring 把它连接到一个或多个 Group |
| Rule / Experience | 可选择的版本化 Prompt 资源，不是另一套执行引擎 |
| Skill | 方法文档；发现摘要与读取正文是两个阶段 |
| Tool | 注册后可执行的动作；出现在目录不代表已激活 |
| Memory | 持久事实；Chat Personal/Project 与 Nano Group Markdown 作用域不同 |
