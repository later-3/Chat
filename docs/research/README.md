# Chat研究资产入口

本目录保存已经进入Chat设计讨论、但仍需遵守各自审核门的研究输入。研究结论不自动成为Schema、模块实现或产品事实。

## Agent Memory：MemOS与memmy-agent

检索别名：`MemOS`、`Memory OS`、`memoryOS`、`memmy-agent`、`Memory Agent`、`Agent Memory`、`会话后管理`、`经验记忆`。

1. 统一先读跨仓总入口：`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/Agent-Memory-MemOS-memmy-agent-总入口.md`。
2. 视觉总图：`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/diagram/agent-memory-runtime-and-chat-decisions.svg`；同目录有`@2x.png`预览。
3. Chat对象、字段和管理差异：[管理机制对比](./agent-memory-management-comparison.md)。
4. Chat候选输入、处理、输出和验收预言机：[I/O落地合同](./agent-memory-io-implementation-contract.md)。

固定版本：MemOS `027dc8975836c066a7d1dd80c78c3da5c0fa084e`；memmy-agent `211d521b310fc23c63dd3d9ca848941173981c5e`。

当前边界：研究质量门已通过，S6/S7材料已形成并等待正式设计审核；Teach-back未认证，S8延期；没有授权正式Schema、迁移、Worker、UI或产品代码。

## pi原生技术基线

1. 计划与逐批审核门：[RP-01](../pi-native-replatform-plan.md)。
2. 当前研究正文：[pi原生技术基线研究](./pi-native-technical-baseline.md)。
3. 当前状态：RP-01计划与RP-01.0已获用户批准；RP-01.1整体心智模型已完成待用户审核，批准前不进入RP-01.2。
4. 当前边界：不创建目标TypeScript生产目录、依赖、Schema或迁移；不修改pi/pi-web产品代码，不调用真实付费模型。
