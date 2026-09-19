# Chat、NanoClaw 与 Pi 集成合同

## 1. 现行边界

2026-09-20 校正。原本文包含共享 daily、按 Project 建 Friend 主 Session、Web 等待完整响应等历史描述；这些已由 P1–P4 的合同替代。当前实现与未交付范围见[实施状态](./chat-long-agent-roadmap.md)，具体执行与恢复见[Long Agent 架构](./chat-long-agent-architecture.md)。

```text
Web → Backend → Workflow ──────────────────┐
Web → Backend → Friend 每日日历与队列 ──────┼→ 公共装配 → Pi AgentSession
IM → Nano 耐久事件 → Backend → 同一 Friend ┘
                              ↓
                     Nano Delivery / Ack → 原渠道
```

- Pi 是唯一模型执行与原生 Session Runtime；Workflow 组织 Node/Stage，Nano 负责长期 Group、Markdown Memory、Channel、Inbox/Outbox、调度和投递。
- 一个 Nano Host 可承载多个 Friend。Agent Group 是一个 Friend 的长期实体，不是 Agent Team。
- Agent Workspace、Session 所属根与本轮用户 Project 分开。Web 显式传协作项目或 null；渠道使用自己的绑定；调度使用可信任务上下文，不读取浏览器最近选择。
- Friend 的每个直接交流入口使用同一天原生 Session，有序接受和执行；普通用户项目可以创建多个普通 Workflow Session。两者共用装配与前端事件投影。

## 2. 原生接缝与源码证据

| 领域 | 实现入口 |
|---|---|
| 唯一 Pi 装配 | `src/agents/pi-agent-session.ts` |
| 本轮规则、资源、工具目标 | `src/agents/assembly-context.ts`、`assembly-resources.ts` |
| Friend 接受、排序与恢复 | `src/long-agents/turn-queue.ts`、`runtime.ts` |
| 日历、总结和交接 | `project-agent.ts`、`daily-maintenance.ts`、`summaries.ts` |
| Channel Event / Delivery / Ack | `src/long-agents/bridge.ts`、`nanoclaw-client.ts` |
| Nano 原生窄适配 | `nanoclaw/src/modules/chat-integration/`，修改须遵守该 Submodule 的 AGENTS |
| 前端公共消费 | `frontend/lib/execution-stream.ts`、`friend-execution.ts`、`hooks/useAgentSession.ts` |

Nano 的 `chat-pi` 模式跳过原生 Agent Loop、Session Runtime 和 Agent 容器生命周期。Backend 不可用时保留耐久 Inbox，不回退其他 Runtime。Docker 工具环境仍属未来能力，不能关闭 chat-pi 来模拟接入。

## 3. 身份、权限与接受

Nano → Backend 使用带服务认证的版本化 Event API；Backend 不读取 Nano 数据库，不把 CLI Socket 暴露成全权限 HTTP。一个信任域对应当前单 Host 配置，不能把服务 Token 当作多用户隔离实现。

私聊必须匹配 Friend 配置的 inbox 或已有可信绑定，包括地址和 messagingGroupId。群聊和陌生发送者不能进入 Friend 混合项目的私有每日历史。绑定查找同时核对来源，不因 chatSessionId 相同就选择另一个渠道。

`POST /api/internal/channel/v1/events` 校验实例/Group、事件 ID、内容和目的地；Backend 在返回 202 前持久化事件与已接受输入。重复事件复用原收据，冲突内容拒绝；不能按正文去重。资源/身份通过版本化 Group 与 Memory 接口装配，不从浏览器传宿主路径。

## 4. 返回与恢复

模型回复保存在 Pi 原生 assistant 消息中。Backend 完成后向 Nano 窄 Gateway 的 `/v1/deliveries` 持久化 Delivery，再调用 `/v1/acks` 确认原 Inbound；消息 ID、来源和目的地随原事件保留。

- 接受失败：没有成功 202，Nano 可按同一事件重送。
- queued：按冻结输入恢复，不采用后来选择的项目。
- running 中断：只有可信原生终态才能恢复完成，否则 interrupted，不能自动重放工具副作用。
- 模型完成、投递失败：只重试原 Delivery/Ack，不再调用模型，不因跨日新建会话。
- Web 离开/断网：仅停止观察，执行继续；主动停止通过真实取消接口，不能把断线伪装成取消。

Web 和 IM 不自动互相广播。Web 能读取同一每日历史；渠道回复只到原请求的目的地。

## 5. 配置、管理和历史

配置字段与服务环境变量只在[配置合同](../../configuration/README.md)维护；Group/OKF Memory API 只在[模块合同](../../architecture/chat-module-contracts.md)维护。有效身份快照与 revision 在请求接受时冻结；认证失败、对象不存在及合同不匹配不能用过期缓存掩盖。

Friend 可经受控 Tool 调用 Workflow；子 Session 属于显式协作项目并保留父来源，不能直接读 Chat 数据库或任意覆盖 projectId。Personal/Project Memory 与 Nano Agent Markdown Memory 保持不同域。

P5 保留旧项目和原生历史、精确旧 URL 与渠道上下文，迁移不把 Memory 提升到 Personal。恢复标记、冲突和回退步骤见[升级手册](../../operations/friend-migration.md)。旧 messages API 保留同步兼容；新 Web 使用 turns/事件流。历史出站投影仅用于旧事件恢复，不是第二个模型执行入口。

## 6. 验证边界

自动化覆盖真实 Pi 装配、模拟 Provider/Nano HTTP、耐久接受、跨入口排序、失败与投递重试；真实浏览器另验证 Workflow/Friend 的增量显示和终态。外部 Telegram → Nano → Backend → Pi → Nano → Telegram 必须使用明确授权的测试账号，记录实际收发结果，不能用 Gateway 健康、模拟 Event 或本机浏览器替代。各阶段证据见[统一开发计划](../../development/agent-unification-plan.md)。
