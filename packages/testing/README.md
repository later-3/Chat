# @chat/testing

## 拥有

跨包合同、架构门、Local World纵向、恢复/迁移Fixture与只读审计工具。

## 不拥有

不定义生产语义、不建立第二套E2E Harness，也不因测试方便绕过Application或真实状态机。

## 入口与边界

- internal test helpers：[`src/index.ts`](./src/index.ts)；正式测试按责任在[`src/`](./src/)中。
- 依赖所有生产Workspace仅用于组合真实纵向；生产包不得反向依赖本包。
- B2/M1/S7保留冻结历史代际含义；恢复、迁移、并发不变量不能为瘦身删除。
- lane、批次和内存政策见[测试lane](../../docs/testing/test-lanes.md)。

## 命令

- `pnpm --filter @chat/testing build`
- `pnpm --filter @chat/testing typecheck`
- `pnpm --filter @chat/testing test`
- 包命令确定性运行；浏览器、paid、external均由根级受管命令分开执行。

