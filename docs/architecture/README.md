# Chat架构、需求与详细设计

这组文档按“架构约束 → 上游设计事实 → Chat需求 → Chat详细设计 → 实现与验证”的顺序持续维护。它不是一次性方案文档；每次实现改变了事实，都必须同步更新对应章节和证据。

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
| [Chat Session架构](./chat-session-architecture.md) | Pi原生消息、Workflow元数据、上下文投影、第一句话和历史迁移 | 约束性基准 |
| [Pi Agent设计与源码分析](./pi-agent-design.md) | Pi分层、核心对象、运行链、能力机制、接口和数据结构 | 第一版完成 |
| [Pi Web架构与源码分析](./pi-web-design.md) | 原前端、原后端、Agent RPC、事件和资源管理接口 | 第一版完成 |
| [Chat当前架构](./chat-current-architecture.md) | 前端、HTTP API、Workflow、Pi AgentSession和Session持久化 | 第一版完成 |
| [Chat需求分析](./chat-requirements.md) | Workflow管理结构、Workflow内Agent与相关代码、资源分组、Session和自定义提示词区域 | 第一版完成 |
| [Chat详细设计](./chat-detailed-design.md) | Workflow目录、内部Agent、装配边界、根配置和注册API | 已按当前实现校正 |
| [Chat Workflow开发框架](./chat-workflow-framework.md) | 新增Workflow时必须遵守的目录、配置、节点、Tool和前后端合同 | 规范基线 |
| [Chat Context与Resource统一模型](./chat-context-resource-model.md) | Context、Target、Owner、跨Project资源、加载、版本和日志的统一协议 | 规范基线 |
| [Chat Project架构设计](./chat-project-framework.md) | 参考Pi的用户级/项目级分层，定义Project、Workspace、Session、资源、信任和Memory隔离 | 核心能力已实现 |

现有[Pi Web前端API迁移清单](../pi-web-frontend-api-migration.md)继续作为接口迁移证据，但不能替代Pi Web架构分析。

## 当前源码基线

| 项目 | 路径 | Commit | 当前用途 |
|---|---|---|---|
| Chat | `Chat/` | `a492ae63f360fc39a8e9ab4a322d95bdb8a8c683`及之后的未提交开发状态 | 产品后端、Workflow和集成 |
| Pi | `Chat/pi/` | `1e44171651f99e3c9066f805529db58bf93a5136` | Agent与Coding Agent源码 |
| Pi Web派生前端 | `Chat/frontend/` | `96c4063fc591c36dc376d704b942a4f18079ebc0`及之后的未提交开发状态 | Chat浏览器前端 |

文档引用源码时以具体路径和符号为准。更新子模块后，要先判断上游设计是否变化，再更新这里的结论。
