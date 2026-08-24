# @chat/workflows

## 拥有

Vercel Workflow定义、耐久步骤、暂停/恢复、重放、Checkpoint和Runtime绑定。

## 不拥有

不拥有Product Store事实、权限或产品终态；Step不得直接写产品数据库或把Hook Token暴露给浏览器。

## 入口与边界

- public definitions：[`src/index.ts`](./src/index.ts)；executable：[`src/runtime-main.ts`](./src/runtime-main.ts)。
- 上游由Application/Outbox启动；下游调用Application Port、Pi Executor及受控Adapter。
- Workflow Store只拥有运行恢复；Product Commit仍由Application决定，未知副作用不得自动重放。
- 节点与恢复见[Workflow运行设计](../../docs/architecture/runtime-workflows.md)。

## 命令

- `pnpm --filter @chat/workflows build`
- `pnpm --filter @chat/workflows typecheck`
- `pnpm --filter @chat/workflows test`
- `pnpm --filter @chat/workflows start:runtime`仅用于受管本地栈；确定性测试不调用Provider。
