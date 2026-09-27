# Chat 开发文档

这里按模块列出 Chat 的开发入口。先选择本次实际修改的模块，再阅读对应文档；跨模块变化需要同时阅读相关模块文档和[架构索引](../architecture/README.md)。

| 修改内容 | 开发文档 |
|---|---|
| Pi 摘要预算、失败恢复与原生会话入口 | [维护合同](../modules/sessions/chat-session-maintenance.md) · [实施计划](./pi-session-controls-plan.md) |
| 公共 Agent 装配、Friend 每日 Session 与统一交互改造（P1–P5） | [分阶段开发计划](./agent-unification-plan.md) |
| Friend/Project/Topic 统一 Workflow 与导航性能 | [性能合同与实测](./session-navigation-performance.md) · [实施计划](./unified-session-performance-plan.md) · [交付与实测](../history/reviews/2026-09-27-unified-session-delivery.md) |
| Friend 独立任务、长期职责、定时任务、动态与群聊（LA0–LA6） | [功能开发计划与阶段验收](./long-agent-functionality-plan.md) |
| LA5 群聊、多 Friend 协作实施交接（本地范围已验收） | [LA5 任务书](./long-agent-la5-taskbook.md) |
| LA6 Friend 项目关联、真实渠道与24h联合验收（待审核） | [LA6 任务书](./long-agent-la6-taskbook.md) |
| 主题模式：Long Agent 策展的主题会话树与会话记忆 | [当前纠偏方案与统一验收](./topic-mode-correction-plan.md) · [主题模式任务书](./topic-mode-taskbook.md) · [开发计划](./topic-mode-plan.md) · [P2 任务书](./topic-mode-p2-taskbook.md) · [交接文档](./topic-mode-handover.md) |
| Agent参与开发、架构审核与交接 | [贡献工作方法](./agent-contribution.md) |
| 端到端调试、源码学习与问题定位 | [调试与开发说明书](./debugging/README.md) |
| VSCode调试和一键启动 | [本地开发与调试](./local-debugging.md) |
| 用户反馈、日志、持久记录和故障闭环 | [诊断与记录](./diagnostics.md) |
| Backend、HTTP、Project、存储或 Pi 装配 | [Backend 开发](./backend.md) |
| 父仓库 TypeScript 与通用工程代码 | [编码规范](./coding-standards.md) |
| Frontend 页面、状态和浏览器合同 | [Frontend 开发](../../frontend/docs/development.md) |
| Frontend 全面更新 | [工作范围、覆盖与验证](./frontend-renewal-plan.md) |
| UI、交互、响应式和无障碍 | [Frontend UI/UX 规范](../../frontend/docs/ui-ux-guidelines.md) |
| Workflow、Node、Agent 或 Tool 装配 | [Workflow 开发框架](../modules/workflows/chat-workflow-framework.md) |
| 测试选择、Fixture 和完整验证 | [测试指南](./testing.md) |
| CI 环境与阻断检查 | [CI 说明](./ci.md) |
| Pi 或 Frontend Submodule | [Submodule 维护](./submodules.md) |
| 生产安装、更新和回滚 | [部署指南](../operations/README.md) |

开始修改前还要遵守目标目录中的`AGENTS.md`。模块文档说明正常开发方式，架构文档解释跨模块设计，`AGENTS.md`只提供强制入口和不可违反的工作边界。

当一次修改改变用户可观察行为、配置、API、目录、开发命令或验证方式时，同一变更必须更新相应文档和测试。

- [Friend 任务与导航统一](./friend-task-navigation-plan.md)：产品术语、任务成果/用量关联、共享控件与回归。
