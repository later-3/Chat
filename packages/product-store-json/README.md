# @chat/product-store-json

## 拥有

当前单实例JSON Product Store Adapter、v1→v20串行迁移、完整性检查与原子落盘。

## 不拥有

不定义产品语义、不宣称多实例数据库能力，也不把Workflow/Pi/DSH状态写成产品事实。

## 入口与边界

- public：[`src/index.ts`](./src/index.ts)；Store实现：[`src/json-product-store.ts`](./src/json-product-store.ts)。
- 上游是Application Port；下游只有受控本地文件系统。
- read old/write current；迁移必须幂等、非空Fixture可验证，损坏或未知代际失败关闭。
- 状态边界见[系统边界](../../docs/architecture/system-boundaries.md)。

## 命令

- `pnpm --filter @chat/product-store-json build`
- `pnpm --filter @chat/product-store-json typecheck`
- `pnpm --filter @chat/product-store-json test`
- 测试只写临时目录；不得指向真实`.data`，无需Provider或外部服务。
