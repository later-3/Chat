# Chat 文档

这里是 Chat 的文档入口。用户、运维人员、贡献者和协助维护项目的 AI 都从这里选择与当前任务相关的文档，不需要先阅读全部架构材料。

## 开始使用

| 任务 | 文档 |
|---|---|
| 了解、安装和启动 Chat | [项目 README](../README.md) |
| 配置网页登录、模型、Workflow、Agent 和 Project | [Chat 系统配置](./configuration.md) |
| 部署、更新、诊断和回滚 | [部署指南](./deployment.md) |
| 使用和管理长期记忆 | [Memory](./memory.md) |
| 了解 Long Agent、配置、使用场景与当前限制 | [Long Agent 使用与配置](./long-agents.md) |

## 开发 Chat

先阅读[开发文档索引](./development/README.md)，再按模块进入对应文档：

| 修改范围 | 文档 |
|---|---|
| Agent参与开发、架构审核与交接 | [贡献工作方法](./development/agent-contribution.md) |
| 端到端调试、源码学习与问题定位 | [调试与开发说明书](./development/debugging/README.md) |
| VSCode调试和一键启动 | [本地开发与调试](./development/local-debugging.md) |
| 用户反馈、日志、持久记录和故障闭环 | [诊断与记录](./development/diagnostics.md) |
| Backend、HTTP、Project、持久化或 Pi 装配 | [Backend 开发](./development/backend.md) |
| TypeScript、模块、错误、安全和持久化代码 | [编码规范](./development/coding-standards.md) |
| Frontend 页面、状态、HTTP 合同或 PWA | [Frontend 开发](../frontend/docs/development.md) |
| UI、交互、响应式或无障碍 | [Frontend UI/UX 规范](../frontend/docs/ui-ux-guidelines.md) |
| 测试选择、Fixture、假模型和完整验证 | [测试指南](./testing.md) |
| CI 环境、职责和阻断检查 | [CI 说明](./ci.md) |
| Pi 或 Frontend Submodule | [Submodule 维护](./managed-submodules.md) |

修改代码前还必须遵守当前目录适用的 `AGENTS.md`。`AGENTS.md`提供强制入口和工作边界；具体使用方法与开发说明以这里链接的独立模块文档为准。

## 架构与设计

[架构文档索引](./architecture/README.md)按“约束、上游事实、当前实现、需求、设计、验证”组织全部架构材料。只有在理解系统设计、评审架构影响或修改跨模块机制时，才需要进入这一组文档。

常用入口：

- [Agent 第一性原理与架构约束](./architecture/chat-agent-first-principles.md)
- [Chat 系统生命周期与协同](./architecture/chat-system-lifecycle.md)
- [Chat 当前架构](./architecture/chat-current-architecture.md)
- [Chat Project 架构](./architecture/chat-project-framework.md)
- [Project 管理 Skill 与 Tool](./architecture/chat-project-management-design.md)
- [Chat Workflow 开发框架](./architecture/chat-workflow-framework.md)
- [Chat Session 架构](./architecture/chat-session-architecture.md)
- [Chat Long Agent 定义与配置模型](./architecture/chat-long-agent-capability-model.md)
- [Chat Long Agent 架构](./architecture/chat-long-agent-architecture.md)
- [Chat Long Agent 机制与扩展合同（收口入口）](./architecture/chat-long-agent-mechanism-contract.md)
- [Long Agent 实施前约束、验证与场景依赖](./architecture/chat-long-agent-engineering-baseline.md)
- [Chat Long Agent 场景与验收要求](./architecture/chat-long-agent-scenarios.md)
- [Chat Long Agent 交互场景收敛与模拟（评审稿）](./architecture/chat-long-agent-interaction-simulations.md)
- [Chat Long Agent 共享认知与自主工作（新增要求与机制评审）](./architecture/chat-long-agent-awareness-and-autonomy.md)
- [Chat Long Agent 实施状态与迁移要求](./architecture/chat-long-agent-roadmap.md)
- [Chat、NanoClaw 与 Pi 当前集成基线](./architecture/chat-nanoclaw-pi-integration.md)
- [Context 与 Resource 模型](./architecture/chat-context-resource-model.md)

## 维护与排障

- [开发经验案例](./development-experiences/README.md)：已经发生过的故障、原因和回归门禁。
- [Pi Web 前端 API 迁移清单](./pi-web-frontend-api-migration.md)：Frontend 能力迁移状态。
- [部署指南](./deployment.md)：生产目录、服务、升级和回滚。

## 文档维护规则

1. 一个模块只保留一个主要使用或开发入口；其他文档只链接，不复制完整规则。
2. 普通文档说明用途、位置、写法、操作和验证；实现细节只在确有设计解释需要时进入架构文档。
3. 改变用户可观察行为、配置格式、目录、API、开发约束或验证命令时，同一变更必须更新对应文档。
4. 配置示例、命令和路径必须与当前版本一致。无法继续成立的旧设计应明确标为历史，不得伪装成现状。
5. 文档与代码不一致时，应先判断是实现缺陷还是经过评审的规范变化；不能只修改文字来合理化意外行为。
