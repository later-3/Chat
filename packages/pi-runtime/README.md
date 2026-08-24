# @chat/pi-runtime

## 拥有

Pi Planner/Executor Adapter、AgentSession、Capability Catalog、Operation/Tool Journal与Executor Client。

## 不拥有

不拥有产品会话、审批、权限或完成事实；模型回复和Journal不能替代Product Commit。

## 入口与边界

- public：[`src/index.ts`](./src/index.ts)；coding executor：[`src/coding-executor.ts`](./src/coding-executor.ts)。
- 上游是Workflow/API私有调用；下游直接链接固定Later Pi Fork的3个源码包。
- Tool Intent→Decision→一次执行→Result/unknown由Journal留证；未知结果不自动重放。
- Runtime所有权见[Pi Executor Service](../../docs/architecture/pi-coding-executor-service.md)。

## 命令

- `pnpm --filter @chat/pi-runtime build`
- `pnpm --filter @chat/pi-runtime typecheck`
- `pnpm --filter @chat/pi-runtime test`
- `test:paid:*`需要根安全门、`CHAT_ALLOW_PAID_TESTS=1`与精确Provider凭据，普通CI永不运行。

