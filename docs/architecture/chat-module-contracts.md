# 模块边界、变更传播与连接

这是跨模块的导航和合同检查入口。具体 Schema 留在各模块及[配置文档](../configuration.md)。下表的“当前”来自本仓库源码；“目标”是后续设计约束，不表示已实现通用通知系统。

## 分层与所有权

```text
Web ──HTTP / Run NDJSON──→ Chat Backend
IM → NanoClaw ──认证 Event / Management HTTP──↔ Chat Backend
                           Workflow / Long Agent 生命周期
                                      ↓
                           createChatPiAgentSession
                                      ↓
                        Pi ResourceLoader / AgentSession / SessionManager
```

| 模块 | 拥有的事实与职责 | 消费者使用的边界 |
|---|---|---|
| Frontend | 草稿、导航、临时交互状态；展示和校验 Backend 响应 | `frontend/lib/*-browser.ts`；不拥有配置或 Session 的另一份事实 |
| Chat 配置、Project、资源服务 | Chat Home、稳定 Project 身份、配置解析、Catalog、授权及资源选择 | HTTP 与受控 Tool 使用同一服务；模型配置来自 Chat，不读 `~/.pi` |
| Workflow / Long Agent 生命周期 | 一次 Workflow 执行；长期身份关联、入站事件、执行关联与恢复 | 分别包装公共 Pi 装配；不再实现 Agent Loop |
| 公共 Agent 装配 | 把已解析的模型、Prompt、Skill、Tool、Extension 和 Session 装入 Pi | `src/agents/pi-agent-session.ts`；检查和运行遵守同一解析合同 |
| Pi | Agent Loop、资源加载、原生消息和 Session 文件 | 公开 SDK；产品关联用 CustomEntry/读模型扩展 |
| NanoClaw | Group、Workspace、Agent Markdown Memory、Channel、Inbox、调度触发、Delivery/Ack | 认证的版本化 Event 与 Management/Resource API；Chat 不读 Nano 数据库 |
| Memory | Chat Personal/Project Catalog+Mem0；Nano Group Markdown 各自持久化 | 两种作用域明确的接口/Tool；不能复制一份冒充另一类 Memory |

Long Agent 独立配置根、每人 Daily、跨 Session 历史、资源包版本和工具执行 Docker 是[已确认目标](./chat-long-agent-mechanism-contract.md)。当前旧配置分属 Chat 与 Nano；迁移前不能用“唯一事实源”的目标描述掩盖现有分工，也不能继续新增双写字段。

## A 改了，B 怎样知道

先判断改变的是**数据、合同还是语义**。自动感知成立的条件是消费者已经理解该合同。

| 变化例 | 传播机制 | B 是否需要改代码 |
|---|---|---|
| 新增已支持格式的旅行 Skill、Tool 条目 | 后端 Catalog 重新发现，返回来源/选择/可用状态；通用列表重新查询 | 通常无需逐项改清单；实际 Tool 仍须注册、授权和依赖就绪 |
| 修改 Skill 内容或 Agent 模型 | 下一轮解析新版本，在途固定；检查页和运行显示对应版本 | 不改资源清单；完整包版本固定/通知机制待实施 |
| 新增 API 字段、枚举或资源类型 | 修改 Schema、运行时解析器及合同测试；分析兼容窗口 | 可能需要，尤其当前严格拒绝未知字段的合同；不能承诺“新增字段必兼容” |
| 新增多参与者 Session、改变调度重试所有权 | 先设计身份、排序、耐久状态与恢复，再更新提供方和消费者 | 需要联合设计，不能靠广播一句消息完成 |

当前已有 Backend Catalog、部分 revision/CAS、装配时 `ResourceLoader.reload()`、页面操作后重读和 Workflow Run 流。**尚无覆盖所有配置/Skill/Memory 的统一失效通知合同**。自动刷新按以下目标设计：

1. 写入通过唯一管理入口提交，校验和耐久保存完成后才确认成功；生成作用域内的 revision。
2. 变更通知只传对象身份、作用域和版本等必要信息，驱动消费者失效并重新查询权威读模型；不在前端拼另一套资源表。
3. 文件编辑等外部写入通过受限目录扫描/重新解析发现；通知丢失、断线重连、页面聚焦或新一轮开始时可重新同步。具体 watcher、轮询或传输方式由技术方案选择。
4. 去重、乱序和权限变更按身份/版本处理；未知版本或冲突显式报错。新一轮资源解析和在途快照互不混淆。

这套失效与重读机制应复用于资源、配置、进度等已有读模型；不要求每个模块维护全系统事件状态。通知能加速展示，不能承担唯一持久化或授权职责。

## 长连接与恢复的当前事实

Workflow 通过 `POST /runs` 得到稳定 Run 引用，再由 `GET /runs/:runId/events?startIndex=...` 读取 `application/x-ndjson`。它是 HTTP 流，不是 WebSocket 或 SSE。来源：[事件路由](../../src/routes/runs/%5BrunId%5D/events.get.ts)、[事件发布](../../src/workflows/chat-run-events.ts)、[浏览器消费](../../frontend/lib/chat-workflow-browser.ts)。

页面通过 `resumeChatWorkflowRun()` 重新附着，恢复入口使用 `startIndex=-1`；Run 状态与 Pi Session 重新读取用于恢复事实。不能声称浏览器已持有逐条 ACK 游标或断线后完整重放所有 UI 增量。取消浏览器读取与取消服务端执行是不同操作，显式取消使用 Run API。当前 Long Agent Web 消息则等待本轮完成后重读原生 Session，不能把 Workflow 流当成已经覆盖 Long Agent 的全局通知通道。

Nano 入站在 Chat 返回 `202` 前耐久保存；出站通过 Gateway Delivery/Ack 关联。连接断开、推送超时和 Agent 执行失败必须分别定位。重试使用稳定事件/执行/投递标识，不靠正文去重。[集成基线](./chat-nanoclaw-pi-integration.md)维护精确职责。

## 修改合同的审核证据

每次跨模块变更列出：事实拥有者、实际消费者、读写接口、作用域/身份、版本与生效点、失败/并发/重连、持久化及兼容迁移。验证至少包含生产者响应→浏览器解析、检查→装配、触发→Run→Session 中本次受影响的完整链。详见[工作方法](../development/agent-contribution.md)、[测试指南](../testing.md)及[诊断记录](../development/diagnostics.md)。
