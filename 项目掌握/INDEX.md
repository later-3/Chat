# 项目掌握 — 全局索引

## 分类目录

### 执行层与pi运行时

本分类覆盖 pi 编码 Agent 的启动、通信、治理和运行时管理相关问题。

| 文档 | 问题摘要 | 归档日期 |
|------|----------|----------|
| [pi子进程在哪里启动](./执行层与pi运行时/pi子进程在哪里启动.md) | 找到调用执行层的地方，即 pi 子进程的启动入口和调用链 | 2026-07-28 |
| [从用户点击发送到pi执行的完整链路](./执行层与pi运行时/从用户点击发送到pi执行的完整链路.md) | 前端点击发送到最终交给 pi 的完整前后端链路梳理 | 2026-07-28 |

### Workflow架构与ProductAwareWorkflow

本分类覆盖 ProductAwareWorkflow 设计、Workflow 定义注册、前端设计者视图和 MAF 节点执行链相关问题。

| 文档 | 问题摘要 | 归档日期 |
|------|----------|----------|
| [ProductAwareWorkflow设计与全部Workflow的关系](./Workflow架构与ProductAwareWorkflow/ProductAwareWorkflow设计与全部Workflow的关系.md) | 展开 ProductAwareWorkflow.run() 设计，澄清 39 节点持续协作 Workflow、设计者视图和系统执行链的关系 | 2026-07-28 |
| [持续协作主Workflow的39节点设计](./Workflow架构与ProductAwareWorkflow/持续协作主Workflow的39节点设计.md) | continuous-collaboration v1.8.0 的整体设计、39 个节点逐一说明和代码组织方式 | 2026-07-28 |
