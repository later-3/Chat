# 历史评审与验收

`reviews/` 按日期保存当时的判断和验证范围，保留证据，不作为现在的安装/运行命令入口。现状与命令以[文档首页](../README.md)链接的模块、配置、运维和调试规范为准。

| 主题 | 记录 |
|---|---|
| Agent 配置打样：节点、参数、范围与交互（待审核） | [2026-09-30 信息设计方案](./reviews/2026-09-30-agent-configuration-information-design.md) |
| Workflow 配置统一、节点展示、Memory 链接与完整历史 | [2026-09-30 后续 7 项复核](./reviews/2026-09-30-workflow-configuration-and-session-presentation.md) |
| 每日默认会话与额外直接会话（产品方向已确认，待实施） | [2026-09-30 现场复核与方案](./reviews/2026-09-30-default-and-additional-friend-sessions.md) |
| 配置表面、模型能力、Long Agent 自我认知与 Memory 闭环 | [2026-09-30 专项排查](./reviews/2026-09-30-configuration-capability-audit.md) |
| 0.5.4 版本与交付核对 | [2026-09-30](./reviews/2026-09-30-release-0.5.4.md) |
| Chat 业务与功能架构：整体协同、模块内部功能与业务闭环 | [2026-09-30 两层检视](./reviews/2026-09-30-chat-business-functional-architecture-review.md) |
| Frontend / Backend / NanoClaw 代码架构：职责、依赖、状态与跨端合同 | [2026-09-30 代码架构复核](./reviews/2026-09-30-frontend-backend-nanoclaw-architecture-review.md) |
| 工作区代码缺陷与文档一致性：8 项问题及复现证据 | [2026-09-30 问题记录](./reviews/2026-09-30-project-code-documentation-review.md) |
| 0.5.3 版本、会话记忆迁移与浮层统一核对 | [2026-09-29](./reviews/2026-09-29-release-0.5.3.md) |
| 0.5.2 版本、统一项目合同与前后端字段契约修复核对 | [2026-09-29](./reviews/2026-09-29-release-0.5.2.md) |
| 0.5.1 版本、Frontend 0.10.0 与界面统一批次核对 | [2026-09-29](./reviews/2026-09-29-release-0.5.1.md) |
| 0.5.0 版本、Linux release 与 VS Code 调试交付核对 | [2026-09-27](./reviews/2026-09-27-release-0.5.0.md) |
| 设置密度、模型参数入口与 Workflow 完成提示 | [2026-09-30](./reviews/2026-09-30-settings-density-and-completion.md) |
| Long Agent 设置 9 个入口：实现、可用性与测试盲区 | [2026-09-27](./reviews/2026-09-27-long-agent-settings-capability-audit.md) |
| Pi 摘要准入、取消恢复与原生会话入口 | [2026-09-27](./reviews/2026-09-27-pi-session-controls.md) |
| Pi 会话能力盘点、压缩适配与剩余缺口 | [2026-09-27](./reviews/2026-09-27-pi-session-capabilities.md) |
| Pi 原生测试分类、Chat 场景对照与定向验证 | [2026-09-27](./reviews/2026-09-27-pi-test-coverage.md) |
| 全局交互与 UI 盘点：30 个任务界面、规范分工与整改顺序 | [2026-09-27 审计](./reviews/2026-09-27-product-interaction-ui-audit.md) |
| Friend 群聊与多 Friend 协作（LA5 验收） | [LA5](./reviews/2026-09-21-long-agent-la5-acceptance.md) |
| LA6 联合运行：Friend 协作项目关联（A 包） | [LA6](./reviews/2026-09-21-long-agent-la6.md) |
| Friend 创建、任务/触发与真实浏览器 | [LA2](./reviews/2026-09-20-long-agent-la2.md) |
| Frontend 全面更新与覆盖矩阵 | [2026-09-27](./reviews/2026-09-27-frontend-renewal-delivery.md) |
| Friend 独立后台工作、真实模型与浏览器 | [LA1](./reviews/2026-09-20-long-agent-la1.md) |
| Friend 任务/群聊的合同与原生接缝 | [LA0](./reviews/2026-09-20-long-agent-la0.md) |
| 公共 Agent 装配合同与实现 | [P1](./reviews/2026-09-19-agent-unification-p1.md)、[P2](./reviews/2026-09-19-agent-unification-p2.md) |
| 前端重构与全页面适配 | [2026-09-19](./reviews/2026-09-19-chat-web-step2-review.md) |
| 安装、启动与发行对比 | [2026-09-18](./reviews/2026-09-18-startup-installation-distribution.md) |
| Friend 首次使用 | [2026-09-18](./reviews/2026-09-18-long-agent-first-use.md) |
| TUI | [2026-09-18](./reviews/2026-09-18-workflow-tui.md) |
| 上游维护 | [2026-09-17](./reviews/2026-09-17-upstream-maintenance.md) |
| 调试、停止、Docker 可选与重复启动 | reviews 下 2026-09-08 同主题记录 |
| Agent 开发治理 | [2026-09-07](./reviews/2026-09-07-agent-development-readiness.md) |

已有记录中的测试数量、路径、能力结论属于记录日期；后续补充明确标日期/范围，不回写成“当时已支持”。

- [2026-09-27 Friend 任务导航与共用交互](./reviews/2026-09-27-friend-task-navigation.md)：六项产品调整、摘要计量修复及浏览器证据。
