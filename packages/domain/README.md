# @chat/domain

## 拥有

产品对象、状态机、Canonical Hash、版本化不变量和纯业务校验。

## 不拥有

不依赖Hono、React、DSH、Workflow、Pi或外部SDK；不执行I/O或提交事务。

## 入口与边界

- public：[`src/index.ts`](./src/index.ts)；内部实现与测试按对象靠近放置。
- 上游是Application和Adapter；下游只有TypeScript标准能力。
- 状态转换失败关闭；恢复由调用方以持久事实重建，不从Runtime ID猜测。
- 事实边界见[系统边界](../../docs/architecture/system-boundaries.md)。

## 命令

- `pnpm --filter @chat/domain build`
- `pnpm --filter @chat/domain typecheck`
- `pnpm --filter @chat/domain test`
- 全部命令为纯本地确定性测试，无Provider、付费或外部写。
