# @chat/realtime

## 拥有

Run Activity Journal、Trace、只读Replay、脱敏投影与历史Trace兼容迁移。

## 不拥有

不拥有Product Run终态、模型隐藏推理或完整Provider Payload；Trace不是第二套产品事实。

## 入口与边界

- public：[`src/index.ts`](./src/index.ts)；internal CLI：[`src/replay-cli.ts`](./src/replay-cli.ts)。
- 上游为Application/Workflow/Pi可观察事件；下游为受控本地Journal/Trace文件。
- sequence/cursor失败时停止应用并重新hydrate；Debug证据不能授予动作权限。
- 会话与证据见[Session架构](../../docs/architecture/session-architecture.md)。

## 命令

- `pnpm --filter @chat/realtime build`
- `pnpm --filter @chat/realtime typecheck`
- `pnpm --filter @chat/realtime test`
- 测试只使用临时证据目录，无付费或真实外部写。

