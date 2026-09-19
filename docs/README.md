# Chat 文档

按“系统 → 模块 → 操作”阅读。当前实现、待实施设计、历史验收分别维护；不要从历史讨论复制安装命令。

| 目录 | 内容与入口 |
|---|---|
| [architecture](./architecture/README.md) | 全局架构、执行链、模块合同、生命周期和约束 |
| [modules](./modules/README.md) | Project、Session、Workflow、Friend、Web、TUI、Memory、Pi 的模块资料 |
| [configuration](./configuration/README.md) | 配置位置、Schema、继承、模型与认证的统一合同 |
| [operations](./operations/README.md) | 从零安装、日常启停、更新回退、平台与网络访问 |
| [development](./development/README.md) | 贡献、编码、测试、CI、Submodule、诊断 |
| [development/debugging](./development/debugging/README.md) | 首次准备、模块启动、F5 组合、断点、日志与停止 |
| [development/experiences](./development/experiences/README.md) | 可复用故障原因与回归门禁 |
| [history](./history/README.md) | 已发生的评审和交付证据，不是当前操作规范 |

## 按任务进入

- 新电脑安装：[Linux / WSL2 安装](./operations/installation.md) → [拉起与维护](./operations/running.md)。
- 开发调试：[首次准备](./development/debugging/first-install.md) → [环境与 F5](./development/debugging/environment.md)。
- 修改前端：[对象与交互](./modules/web/chat-web.md) → [Frontend 开发](../frontend/docs/development.md) / [UI 规范](../frontend/docs/ui-ux-guidelines.md)。
- 修改运行机制：[模块合同](./architecture/chat-module-contracts.md) → 所属模块文档。

## 归档规则

1. docs 根只留索引；跨模块原则放 architecture，模块专属资料放 modules，安装运行放 operations。
2. 同一规范只有一个事实源；Frontend/Pi/Nano 的自身开发规范留在各 Submodule，通过链接进入。
3. 模块使用说明描述当前可用行为；目标设计明确标状态，不能当作已发布功能。
4. 日期命名的讨论/验收进入 history；可复用故障机制进入 development/experiences。不为移动文件保留旧路径副本。
5. 移动文件同时更新 Markdown 链接、Skill/AGENTS 导航、源码来源和测试引用；`pnpm check:architecture` 检查文档树的本地链接。
