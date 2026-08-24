# @chat/dsh-lifeos-bridge

## 拥有

唯一Chat业务前端集成面：DSH Host Adapter、浏览器Client Slot、Bridge State与HITL投影。

## 不拥有

不拥有Product Session/Run/Decision历史或运行终态；浏览器不得直连Workflow/Pi或保存Runtime凭据。

## 入口与边界

- public Host bundle：[`src/index.ts`](./src/index.ts)；Client：[`src/client/index.tsx`](./src/client/index.tsx)。
- executable由DSH Profile加载[`cordis.patch.yml`](./cordis.patch.yml)，不是独立前端。
- 上游是DSH公开插件合同，下游只调用`@chat/contracts/public`定义的Chat Query/Command。
- Bridge State可迁移恢复但不是产品事实；失败时重新Query，不猜测成功。
- 交互见[前后端交互](../../docs/architecture/frontend-backend-interaction.md)。

## 命令

- `pnpm --filter @chat/dsh-lifeos-bridge build`
- `pnpm --filter @chat/dsh-lifeos-bridge typecheck`
- `pnpm --filter @chat/dsh-lifeos-bridge test`
- 普通命令不需要Provider；真实浏览器由根`test:browser`统一编排。

