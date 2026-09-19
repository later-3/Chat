# 系统架构

本目录只保存跨模块的原则、执行链和合同。模块专属设计已经归入 [modules](../modules/README.md)，用户操作进入[配置](../configuration/README.md)、[安装与运行](../operations/README.md)、[开发调试](../development/README.md)。

| 文档 | 职责 |
|---|---|
| [Agent 第一性原理](./chat-agent-first-principles.md) | 稳定约束、新能力归类和架构审核 |
| [当前架构](./chat-current-architecture.md) | 当前执行链、服务与状态来源；以源码和测试复核 |
| [模块合同](./chat-module-contracts.md) | 谁拥有事实、谁调用谁、变更与连接如何传播 |
| [Context 与 Resource](./chat-context-resource-model.md) | Context、Target、Owner、授权、资源和版本 |
| [系统生命周期](./chat-system-lifecycle.md) | 安装/启动/停止、组件就绪与尚未实施的业务排空 |
| [需求](./chat-requirements.md) | 目标用户场景；与当前实现分开阅读 |

## 阅读与评审顺序

先按[贡献工作方法](../development/agent-contribution.md)分析场景和机制，然后核对上游事实、当前实现、需求差距和所属模块设计。不要从想要的前端结构反推后端能力，也不要把目标设计写成已发布功能。

结论至少有一种依据：Pi/上游公开合同、实际调用链、Chat 源码与持久数据、自动化/真实运行证据，或明确确认但尚未实现的目标。测试通过不替代架构复核。

常见模块入口：

- [Project](../modules/projects/chat-project-framework.md)、[Session](../modules/sessions/chat-session-architecture.md)、[Workflow](../modules/workflows/chat-workflow-framework.md)。
- [Friend 当前使用](../modules/long-agents/README.md)、[实施状态](../modules/long-agents/chat-long-agent-roadmap.md)、[工程基线](../modules/long-agents/chat-long-agent-engineering-baseline.md)。
- [Web 对象与交互](../modules/web/chat-web.md)、[TUI](../modules/tui/chat-workflow-tui.md)。
- [Pi Agent](../modules/pi/pi-agent-design.md)、[上游 Pi Web](../modules/pi/pi-web-design.md)。

历史审核进入 [history](../history/README.md)；可复用故障进入 [development/experiences](../development/experiences/README.md)。这里不复制逐模块状态或历次验收表。

## 当前源码基线

Chat 的事实是当前父仓库 Commit；`frontend/`、`pi/`、`nanoclaw/` 均由它固定版本。分别用 `git rev-parse HEAD` 与 `git rev-parse HEAD:<submodule>` 查看父提交及 gitlink。工作区未提交改动不是其他机器可安装的版本。

源码引用采用路径与符号，版本记录放验收或 Release 清单。更新子模块先判断上游合同是否变化，再更新所属模块设计和消费者测试；不能让子模块自行追踪远端代替父仓库的版本决策。
