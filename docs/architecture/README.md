# Chat架构、需求与详细设计

这组文档按“架构约束 → 上游设计事实 → Chat需求 → Chat详细设计 → 实现与验证”的顺序持续维护。它不是一次性方案文档；每次实现改变了事实，都必须同步更新对应章节和证据。

本文只索引架构与设计材料。配置文件的位置、写法和常用示例见[Chat系统配置](../configuration.md)；其他使用、开发、测试和运维文档见[Chat文档索引](../README.md)。

先按[Agent贡献工作方法](../development/agent-contribution.md)形成场景与机制判断，再沿下列层次查证。[模块合同](./chat-module-contracts.md)集中说明所有权、变更传播和连接恢复。

## 分析顺序

```text
Chat Agent第一性原理与架构约束
  ↓
Pi Agent设计与能力
  ↓
Pi Web架构与能力消费方式
  ↓
Chat当前架构与现有用户场景
  ↓
Chat差距与需求分析
  ↓
Chat详细设计
  ↓
代码、测试与部署结果反向校正文档
```

不能从Chat想要的配置结构反推Pi，也不能把Pi Web现有界面直接当成后端能力。新需求必须先通过[Chat Agent第一性原理与架构约束](./chat-agent-first-principles.md)中的归类方法和评审清单，再进入具体设计。每个Chat设计结论都要能够追溯到以下至少一种证据：

1. Pi或Pi Web公开接口和类型。
2. Pi或Pi Web实际调用链源码。
3. Chat当前源码和持久化数据。
4. 自动化测试或真实运行结果。
5. 已确认并明确标为目标的用户场景与架构决策；必须同时记录当前实现差距，不能伪装成源码事实。

## 文档状态

| 文档 | 内容 | 状态 |
|---|---|---|
| [Chat Agent第一性原理与架构约束](./chat-agent-first-principles.md) | Agent本质、稳定架构、配置生命周期、新需求归类和架构冲击判定 | 约束性基准 |
| [模块边界、变更传播与连接](./chat-module-contracts.md) | 分层所有权、数据/合同/语义变化、NDJSON与恢复 | 当前证据与目标通知机制分列 |
| [Chat Session架构](./chat-session-architecture.md) | Project固有归属、Pi原生消息、Workflow元数据、上下文投影、第一句话和历史迁移 | 约束性基准 |
| [Pi Agent设计与源码分析](./pi-agent-design.md) | Pi分层、核心对象、运行链、能力机制、接口和数据结构 | 第一版完成 |
| [Pi Web架构与源码分析](./pi-web-design.md) | 原前端、原后端、Agent RPC、事件和资源管理接口 | 第一版完成 |
| [Chat当前架构](./chat-current-architecture.md) | 前端、HTTP API、Workflow、Pi AgentSession和Session持久化 | 第一版完成 |
| [Chat需求分析](./chat-requirements.md) | Project-first与Daily Project、统一交互入口、Workflow、Long Agent、Session和Agent能力需求 | 持续确认中 |
| [Chat详细设计](./chat-detailed-design.md) | Workflow目录、内部Agent、装配边界、根配置和注册API | 已按当前实现校正 |
| [Chat Workflow开发框架](./chat-workflow-framework.md) | 新增Workflow时必须遵守的目录、配置、节点、Tool和前后端合同 | 规范基线 |
| [Chat Workflow调用Workflow设计](./chat-subworkflow-design.md) | Planner审批后通过Pi Skill/Tool并行调用完整子Workflow，以及父子Session与调用状态合同 | 已实现并有真实Runtime门禁 |
| [Chat Context与Resource统一模型](./chat-context-resource-model.md) | Context、Target、Owner、跨Project资源、加载、版本和日志的统一协议 | 规范基线 |
| [Chat Project架构设计](./chat-project-framework.md) | 定义Project-first、Daily Project、Workspace、Session、资源、信任和Memory隔离 | Project核心与Daily默认解析已实现；多入口绑定实现中 |
| [Project 管理 Skill 与 Tool 设计](./chat-project-management-design.md) | 自然语言创建学习、旅游等项目，6 个管理 Tool、Skill 发布、配置与会话边界 | 当前工作区已实现，随 Backend 发布 |
| [Long Agent使用与配置](../long-agents.md) | 用户和Agent的阅读入口、操作场景、配置与能力限制 | 区分当前可用与目标 |
| [Chat Long Agent定义与配置模型](./chat-long-agent-capability-model.md) | 独立空间、文件配置、Prompt区域、资源、自我管理与公共Skill | 2026-09-07已确认目标，待实施 |
| [Chat Long Agent架构](./chat-long-agent-architecture.md) | Project/Session、历史连续性、调度、Docker、Social与恢复 | 目标架构；具体实现合同待审核 |
| [Chat Long Agent机制与扩展合同](./chat-long-agent-mechanism-contract.md) | 三类意图、三类触发、六项机制、扩展分级及完整交付 | 2026-09-07机制收口，详细合同待审核 |
| [Long Agent实施前约束、验证与场景依赖](./chat-long-agent-engineering-baseline.md) | Nano原生接入核查、代码约束、Skill生效、Session扩展、测试层级与基础场景依赖 | 已认可设计输入；具体合同待设计，未下发实现任务 |
| [Chat Long Agent场景与验收要求](./chat-long-agent-scenarios.md) | 道德经、旅游监控、每日日记、Ziji开发及跨场景边界 | 已确认验收要求，未运行验收 |
| [Chat Long Agent交互场景收敛与模拟](./chat-long-agent-interaction-simulations.md) | 临时互助、多方工作、后台协作、自由活动；并发及突发模拟 | 机制收口的场景依据；具体呈现待详细设计 |
| [Chat Long Agent共享认知与自主工作](./chat-long-agent-awareness-and-autonomy.md) | 项目/进度的共享发现、灵魂模式长期职责、自由活动与时间/事件触发 | 方向已认可并进入机制收口；具体配置待详细设计 |
| [Chat Long Agent实施状态与迁移要求](./chat-long-agent-roadmap.md) | 当前能力、目标差距、迁移约束和后续讨论 | 实施状态入口；本轮仅文档 |
| [Chat、NanoClaw与Pi当前集成基线](./chat-nanoclaw-pi-integration.md) | 当前chat-pi、旧Binding、可靠Delivery与Group资源合同 | 迁移前实现证据；旧唯一主Session/Docker禁用不限制新目标 |
| [Chat Frontend UI/UX规范](../../frontend/docs/ui-ux-guidelines.md) | Pi Web派生前端的Web/PWA、视觉、交互、自适应、无障碍和渐进治理规则 | 规范基线 |

现有[Pi Web前端API迁移清单](../pi-web-frontend-api-migration.md)继续作为接口迁移证据，但不能替代Pi Web架构分析。

生命周期协同的已确认目标见[Chat系统生命周期](./chat-system-lifecycle.md)：完整实例启停、就绪、收尾、故障恢复与当前差距。

## 审核记录

- [2026-09-07 Agent开发入口与架构治理](./reviews/2026-09-07-agent-development-readiness.md)：本次缺口、两轮只读问答、工程验证与后续输入。

## 当前源码基线

| 项目 | 路径 | 版本事实源 | 当前用途 |
|---|---|---|---|
| Chat | `Chat/` | 当前父仓库Checkout与工作区 | 产品后端、Workflow和集成 |
| Pi | `Chat/pi/` | 父仓库当前Commit记录的`pi` gitlink | Agent与Coding Agent源码 |
| Pi Web派生前端 | `Chat/frontend/` | 父仓库当前Commit记录的`frontend` gitlink | Chat浏览器前端 |
| NanoClaw | `Chat/nanoclaw/` | 父仓库当前Commit记录的`nanoclaw` gitlink | Long Agent Channel Gateway、耐久Inbox、调度触发与投递 |

使用`git rev-parse HEAD`查看父仓库Commit，使用`git rev-parse HEAD:pi`、`git rev-parse HEAD:frontend`和`git rev-parse HEAD:nanoclaw`查看父仓库记录的子模块版本。文档引用源码时以具体路径和符号为准，不手工维护容易过期的Commit副本。更新子模块后，要先判断上游设计是否变化，再更新这里的结论。
