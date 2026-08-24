# @chat/pi-executor

## 拥有

私有Pi Coding Executor Service进程入口、HTTP生命周期和运行时装配。

## 不拥有

不拥有Product Run、Decision、完成事实或公共HTTP；Pi Session与Tool Journal不能成为产品授权。

## 入口与边界

- executable：[`src/index.ts`](./src/index.ts)；公共网络面为零，只接受受管私有Runtime合同。
- 上游是Workflow/API私有Client，下游是`@chat/pi-runtime`和固定Later Pi Fork。
- Operation/Journal负责执行证据与重启恢复；Product Commit仍经Application。
- 普通build/test使用确定性Faux；真实模型属于根`:paid`命令。
- 设计见[Pi Executor Service](../../docs/architecture/pi-coding-executor-service.md)。

## 命令

- `pnpm --filter @chat/pi-executor build`
- `pnpm --filter @chat/pi-executor typecheck`
- `pnpm --filter @chat/pi-executor test`
- `pnpm --filter @chat/pi-executor start`只用于受管本地运行，不读取外部写授权。

