# @chat/api

## 拥有

Hono协议入口、认证/运行上下文、公开Query/Command路由、私有Runtime路由与应用组合根。

## 不拥有

不拥有产品事务、状态机、Workflow终态、Pi Session或DSH页面；Router不直接写Product Store。

## 入口与边界

- executable：[`src/index.ts`](./src/index.ts)；composition：[`src/composition.ts`](./src/composition.ts)。
- public HTTP：[`src/product-routes.ts`](./src/product-routes.ts)；private runtime只对受管后端进程开放。
- 下游依赖Application及Store/Workflow/Pi/Project Adapter；上游是Bridge和私有Runtime Client。
- Product事务由Application提交；Outbox失败可恢复，外部Provider结果不能由HTTP响应冒充产品终态。
- 交互事实见[前后端交互](../../docs/architecture/frontend-backend-interaction.md)。

## 命令

- `pnpm --filter @chat/api build`
- `pnpm --filter @chat/api typecheck`
- `pnpm --filter @chat/api test`
- `pnpm --filter @chat/api start`会启动本地API；普通测试不需要Provider、付费或外部写。

