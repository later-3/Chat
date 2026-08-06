# Chat 项目跨 Session 续接入口

> 更新日期：2026-08-06

## 1. 当前停点

1. 产品定义和完整目标范围已固定。
2. 前端、后端、实时交互、Workflow和Agent Runtime技术选型已批准并写入合同。
3. 仓库已重置为全新基线；当前没有生产代码、依赖锁、Schema或迁移。
4. 当前分支为`codex/chat-workflow-foundation`。
5. 唯一下一工作包是P0工程与合同骨架。

## 2. 新 Session 读取顺序

1. [AGENTS.md](../AGENTS.md)
2. [PROJECT_LESSONS.md](../PROJECT_LESSONS.md)
3. [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
4. [PROJECT_STATE.md](../PROJECT_STATE.md)
5. [PROJECT_PLAN.md](../PROJECT_PLAN.md)
6. [技术合同](./architecture/technology-contract.md)
7. [系统边界](./architecture/system-boundaries.md)
8. 本文件

## 3. 当前技术基线

```text
React + TypeScript + Vite + PWA
REST Query/Command + Chat SSE Event Feed
AG-UI compatible Agent events
Node.js + TypeScript + Hono
Vercel Workflow
pi-agent-core + pi-ai + pi-coding-agent
```

## 4. 唯一下一工作包

P0必须交付：

1. pnpm Workspace与TypeScript strict配置。
2. `apps/web`和`apps/api`最小可运行入口。
3. `packages/contracts/domain/application/realtime/workflows/pi-runtime/testing`边界。
4. Product ID、Command、Problem Detail和Chat Event Envelope的第一版Schema。
5. 架构依赖测试、单元测试、构建和CI。

P0不创建业务数据库Schema，不实现真实Workflow或pi调用。

## 5. 禁止事项

1. 新增实现必须从当前合同出发，不引入未获批准的兼容层、Schema或方案资产。
2. 不让浏览器直接连接Vercel Workflow或pi。
3. 不并行建立多套实时事件协议。
4. 不把Workflow Run、Checkpoint或pi Session当成Product Session/Product Run。
5. 不在P0顺手实现Memory、Workflow编辑器、外部Tool、语音、日历或Canvas。
6. 不读取、输出或提交私有配置、数据库和运行数据。

## 6. 可复制续接指令

```text
继续Chat项目。按AGENTS.md顺序读取治理文件，再读取
docs/project-session-handoff.md、docs/architecture/technology-contract.md和
docs/architecture/system-boundaries.md。当前是全新TypeScript基线，唯一下一工作包是P0工程与合同骨架。
不要引入合同之外的实现或方案，不要提前做业务Schema、Workflow实现、Memory或外部Tool。
```
