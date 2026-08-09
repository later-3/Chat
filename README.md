# Chat

Chat 是一个以对话为入口、以耐久 Workflow 为执行骨架、由用户持续介入和审核的 AI 协作产品。

它负责把自然语言输入转化为可查看的上下文、计划、执行、人工决定、结果、证据和可恢复的长期状态，而不是只提供一个消息页面。

## 已冻结技术基线

- 前端：React + TypeScript + Vite，目标形态为响应式 PWA。
- 产品数据：REST Query/Command，由服务端 Product Store 持有权威事实。
- 实时交互目标：SSE 承载 Chat 有序事件流；Agent 事件采用 AG-UI 兼容语义。当前纵向链仍使用受控 Query 轮询，尚未实现 SSE Cursor Runtime Journal。
- HTTP 后端：Node.js + TypeScript，使用 Hono 作为 Web/API Adapter。
- 耐久执行：Vercel Workflow。
- Agent Runtime：`pi-agent-core`，模型能力来自 `pi-ai`，编码执行能力来自 `pi-coding-agent`。
- 前端服务端状态：TanStack Query；浏览器只保存交互投影和可丢弃草稿。

完整约束见[前后端技术选型与实施合同](./docs/architecture/technology-contract.md)。

## 目标系统主链

```text
React/PWA
-> Chat Query / Command API
-> Product Application
-> Vercel Workflow
-> pi Agent Node / Governed Tool
-> Product Commit + Runtime Journal
-> Chat SSE Event Feed
-> React Projection
```

Product Session、Product Run、Workflow Run、Workflow Checkpoint、pi Runtime Session 和浏览器连接始终是不同对象。

当前已经实现的进程、模块、REST交互和两套Workflow见[仓库与关键文件地图](./docs/architecture/repository-map.md)、[前后端交互现状](./docs/architecture/frontend-backend-interaction.md)和[Workflow运行设计现状](./docs/architecture/runtime-workflows.md)。

## 当前仓库状态

P0工程骨架、响应式PWA、固定端口调试与严格Trace、版本化JSON Product Store、真实Vercel Workflow、pi Planner/Executor、百炼`qwen3.7-plus`、Plan人工修订/批准和Product Commit已经合入。第一条真实规划—确认—执行纵向链可从浏览器完成并在刷新后恢复。

memmy与Tencent MemoryCore两套真实Memory后端的查询、显式导入和对账已经接入。当前下一任务是把BMAD方法转化为Chat拥有的Project阶段、状态和文档上下文能力，之后实现带标签并可主动选择的用户规则集。当前事实和下一步入口见[项目状态](./PROJECT_STATE.md)与[跨Session续接](./docs/project-session-handoff.md)。

## 文档入口

1. [Chat概念空间](./docs/product/concept-space.md)
2. [项目上下文](./PROJECT_CONTEXT.md)
3. [当前状态](./PROJECT_STATE.md)
4. [实施计划](./PROJECT_PLAN.md)
5. [Chat项目飞轮](./docs/product/flywheel.md)
6. [仓库目录与关键文件地图（当前实现）](./docs/architecture/repository-map.md)
7. [前后端交互（当前实现）](./docs/architecture/frontend-backend-interaction.md)
8. [Workflow运行设计（当前实现）](./docs/architecture/runtime-workflows.md)
9. [前后端技术选型与实施合同（目标边界）](./docs/architecture/technology-contract.md)
10. [状态与运行时边界（目标边界）](./docs/architecture/system-boundaries.md)
11. [长期上下文：Memory、Project与用户规则](./docs/architecture/context-memory-project-rules.md)
12. [本地调试与Trace](./docs/debug/local-debug.md)
13. [工程规范](./docs/engineering-standards.md)
14. [单Workflow任务规划与执行设计](./docs/architecture/planning-execution-workflow.md)
15. [跨 Session 续接入口](./docs/project-session-handoff.md)

历史任务书位于 `docs/tasks/`，用于解释当时的范围、依据和验收证据；当前行为优先看 `PROJECT_STATE.md`、源码和上述as-built文档。
