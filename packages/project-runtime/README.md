# @chat/project-runtime

## 拥有

受权Workspace/Git/文档观察、Project Bootstrap本地Provision与Plane CE窄Adapter。

## 不拥有

不拥有Project产品账本、用户授权或Workflow编排；外部Plane ID与Git目录不是Product ID。

## 入口与边界

- internal：[`src/index.ts`](./src/index.ts)；资源观察：[`src/registry.ts`](./src/registry.ts)。
- 上游是Application Project Port；下游是受限根目录、Git和可选Plane CE。
- 创建使用专用Command/Outbox/lease/fencing；未知外部结果须查询对账，不能再次POST。
- 纵向见[Plane Project Bootstrap](../../docs/architecture/plane-ce-project-bootstrap-as-built.md)。

## 命令

- `pnpm --filter @chat/project-runtime build`
- `pnpm --filter @chat/project-runtime typecheck`
- `pnpm --filter @chat/project-runtime test`
- 普通测试只写临时目录；真实Plane写必须使用根`:external:`三闸门。
