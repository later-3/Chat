# @chat/memory-runtime

## 拥有

暂停Memory能力的Provider Port实现、memmy/MemoryCore协议适配与历史Workflow兼容读写边界。

## 不拥有

不拥有长期产品事实或Memory引擎；当前统一启动器不准备、不启动也不装配Memory Provider。

## 入口与边界

- internal：[`src/index.ts`](./src/index.ts)与[`src/registry.ts`](./src/registry.ts)。
- 上游是Application Memory Port；下游是可替换外部引擎，仅在明确恢复专项时装配。
- 历史快照保持只读兼容；外部写必须幂等、支持unknown与显式`:external:`门。
- 当前状态以[PROJECT_STATE](../../PROJECT_STATE.md)为准。

## 命令

- `pnpm --filter @chat/memory-runtime build`
- `pnpm --filter @chat/memory-runtime typecheck`
- `pnpm --filter @chat/memory-runtime test`
- 普通测试用协议替身；真实Memory只能由根`:external:`命令和专用开关运行。
