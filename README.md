# Chat

Chat 是一个以对话为入口、以耐久 Workflow 为执行骨架、由用户持续介入和审核的 AI 协作产品。

它负责把自然语言输入转化为可查看的上下文、计划、执行、人工决定、结果、证据和可恢复的长期状态，而不是只提供一个消息页面。

## 已冻结技术基线

- 前端：React + TypeScript + Vite，目标形态为响应式 PWA。
- 产品数据：REST Query/Command，由服务端 Product Store 持有权威事实。
- 实时交互：SSE 承载 Chat 有序事件流；Agent 事件采用 AG-UI 兼容语义。
- HTTP 后端：Node.js + TypeScript，使用 Hono 作为 Web/API Adapter。
- 耐久执行：Vercel Workflow。
- Agent Runtime：`pi-agent-core`，模型能力来自 `pi-ai`，编码执行能力来自 `pi-coding-agent`。
- 前端服务端状态：TanStack Query；浏览器只保存交互投影和可丢弃草稿。

完整约束见[前后端技术选型与实施合同](./docs/architecture/technology-contract.md)。

## 系统主链

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

## 当前仓库状态

P0工程与合同骨架已经完成并合并。仓库现在包含pnpm TypeScript Workspace、共享合同、React/Hono空应用、架构依赖测试、CI和版本证据；业务Schema、Product Store、Workflow/pi Adapter与第一条纵向链尚未实现。

当前阶段是P1第一次可用的Chat闭环：可安装PWA、发送一条消息、看见后台进度、得到正式回复，并在页面刷新或短暂断线后恢复。P1已拆成8个独立任务；当前先审核[P1.1响应式Chat与工作流界面任务书](./docs/tasks/p1.1-responsive-chat-workflow-shell.md)，随后再进入纯前端实现。

## 文档入口

1. [Chat概念空间](./docs/product/concept-space.md)
2. [项目上下文](./PROJECT_CONTEXT.md)
3. [当前状态](./PROJECT_STATE.md)
4. [实施计划](./PROJECT_PLAN.md)
5. [Chat项目飞轮](./docs/product/flywheel.md)
6. [前后端技术选型与实施合同](./docs/architecture/technology-contract.md)
7. [状态与运行时边界](./docs/architecture/system-boundaries.md)
8. [工程规范](./docs/engineering-standards.md)
9. [P1.1响应式Chat与工作流界面任务书](./docs/tasks/p1.1-responsive-chat-workflow-shell.md)
10. [跨 Session 续接入口](./docs/project-session-handoff.md)
