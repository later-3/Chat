# Chat 开发文档

这里按模块列出 Chat 的开发入口。先选择本次实际修改的模块，再阅读对应文档；跨模块变化需要同时阅读相关模块文档和[架构索引](../architecture/README.md)。

| 修改内容 | 开发文档 |
|---|---|
| Backend、HTTP、Project、存储或 Pi 装配 | [Backend 开发](./backend.md) |
| 父仓库 TypeScript 与通用工程代码 | [编码规范](./coding-standards.md) |
| Frontend 页面、状态和浏览器合同 | [Frontend 开发](../../frontend/docs/development.md) |
| UI、交互、响应式和无障碍 | [Frontend UI/UX 规范](../../frontend/docs/ui-ux-guidelines.md) |
| Workflow、Node、Agent 或 Tool 装配 | [Workflow 开发框架](../architecture/chat-workflow-framework.md) |
| 测试选择、Fixture 和完整验证 | [测试指南](../testing.md) |
| CI 环境与阻断检查 | [CI 说明](../ci.md) |
| Pi 或 Frontend Submodule | [Submodule 维护](../managed-submodules.md) |
| 生产安装、更新和回滚 | [部署指南](../deployment.md) |

开始修改前还要遵守目标目录中的`AGENTS.md`。模块文档说明正常开发方式，架构文档解释跨模块设计，`AGENTS.md`只提供强制入口和不可违反的工作边界。

当一次修改改变用户可观察行为、配置、API、目录、开发命令或验证方式时，同一变更必须更新相应文档和测试。
