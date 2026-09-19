# 模块文档

跨模块边界从[系统架构](../architecture/README.md)进入；本目录按事实拥有者归档。

| 模块 | 主要入口 | 补充 |
|---|---|---|
| Project | [架构与数据边界](./projects/chat-project-framework.md) | [管理 Skill/Tool](./projects/chat-project-management-design.md) |
| Session | [会话架构](./sessions/chat-session-architecture.md) | 历史、归属与上下文 |
| Workflow | [开发框架](./workflows/chat-workflow-framework.md) | [详细设计](./workflows/chat-detailed-design.md)、[子 Workflow](./workflows/chat-subworkflow-design.md) |
| Friend / Long Agent | [使用与配置](./long-agents/README.md) | [当前实施状态](./long-agents/chat-long-agent-roadmap.md)、[工程基线](./long-agents/chat-long-agent-engineering-baseline.md)；同目录其余设计按各自状态阅读 |
| Chat Web | [对象、交互与布局](./web/chat-web.md) | [API 迁移证据](./web/api-migration.md)、[Frontend 开发](../../frontend/docs/development.md)、[视觉规范](../../frontend/docs/ui-ux-guidelines.md) |
| Chat TUI | [终端使用](./tui/README.md) | [架构](./tui/chat-workflow-tui.md) |
| Memory | [使用与持久化](./memory/README.md) | 与 Friend 自身 Markdown Memory 区分 |
| Pi / 上游 Pi Web | [Pi 分析](./pi/pi-agent-design.md) | [Pi Web 分析](./pi/pi-web-design.md)，属于上游机制参考 |

Long Agent 的机制、场景、共享认知等保留在 long-agents 内，避免拆散一个模块的设计链。当前仍未实施的目标不因归档被提升为现状。Backend 代码开发在[开发指南](../development/backend.md)，通用配置在[配置合同](../configuration/README.md)，不复制到每个模块。
