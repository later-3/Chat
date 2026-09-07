# Chat架构、需求与详细设计

这组文档按“架构约束 → 上游设计事实 → Chat需求 → Chat详细设计 → 实现与验证”的顺序持续维护。它不是一次性方案文档；每次实现改变了事实，都必须同步更新对应章节和证据。

本文只索引架构与设计材料。配置文件的位置、写法和常用示例见[Chat系统配置](../configuration.md)；其他使用、开发、测试和运维文档见[Chat文档索引](../README.md)。

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

## 文档状态

| 文档 | 内容 | 状态 |
|---|---|---|
| [Chat Agent第一性原理与架构约束](./chat-agent-first-principles.md) | Agent本质、稳定架构、配置生命周期、新需求归类和架构冲击判定 | 约束性基准 |
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
| [Chat Long Agent与多入口架构](./chat-long-agent-architecture.md) | NanoClaw、多Agent、Daily Inbox、Chat Web/IM交叉使用、主动任务和Chat能力 | Web与IM原生Pi主链已实现；后续范围见路线图 |
| [Chat Long Agent能力与NanoClaw Agent Group模型](./chat-long-agent-capability-model.md) | Long Agent持续Session、Agent Group身份与Workspace、Agent Memory、NanoClaw生态能力和运行边界 | Context Snapshot与Agent Memory已实现；其余能力见路线图 |
| [Chat Long Agent路线图与续接任务账本](./chat-long-agent-roadmap.md) | 产品目标、已达场景、本期裁剪、后续任务、验收和恢复顺序 | 当前发布与后续工作事实源 |
| [Chat、NanoClaw与Pi统一集成设计](./chat-nanoclaw-pi-integration.md) | Pi唯一Agent Runtime、Docker-free NanoClaw Channel Gateway边界、Binding合同及各场景数据流 | Web/Channel、`chat-pi` Driver、可靠Delivery与Agent Group资源合同已实现 |
| [Chat Frontend UI/UX规范](../../frontend/docs/ui-ux-guidelines.md) | Pi Web派生前端的Web/PWA、视觉、交互、自适应、无障碍和渐进治理规则 | 规范基线 |

现有[Pi Web前端API迁移清单](../pi-web-frontend-api-migration.md)继续作为接口迁移证据，但不能替代Pi Web架构分析。

## 当前源码基线

| 项目 | 路径 | 版本事实源 | 当前用途 |
|---|---|---|---|
| Chat | `Chat/` | 当前父仓库Checkout与工作区 | 产品后端、Workflow和集成 |
| Pi | `Chat/pi/` | 父仓库当前Commit记录的`pi` gitlink | Agent与Coding Agent源码 |
| Pi Web派生前端 | `Chat/frontend/` | 父仓库当前Commit记录的`frontend` gitlink | Chat浏览器前端 |
| NanoClaw | `Chat/nanoclaw/` | 父仓库当前Commit记录的`nanoclaw` gitlink | Long Agent Channel Gateway、耐久Inbox、调度触发与投递 |

使用`git rev-parse HEAD`查看父仓库Commit，使用`git rev-parse HEAD:pi`、`git rev-parse HEAD:frontend`和`git rev-parse HEAD:nanoclaw`查看父仓库记录的子模块版本。文档引用源码时以具体路径和符号为准，不手工维护容易过期的Commit副本。更新子模块后，要先判断上游设计是否变化，再更新这里的结论。
