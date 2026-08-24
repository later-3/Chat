# @chat/contracts

## 拥有

公开网络DTO/Event、Command/Query、Schema版本与窄内部Runtime合同。

## 不拥有

不拥有业务事务、Store实现、HTTP路由或运行时凭据值；Schema不能替代Application授权。

## 入口与边界

- public：[`src/public.ts`](./src/public.ts)；完整服务端入口：[`src/index.ts`](./src/index.ts)。
- `./runtime-credential`仅供受管服务端，不得导入浏览器bundle。
- 上游消费者是Bridge/API/Application/Runtime；只依赖Zod和协议级类型。
- 公共代际read old/write current；同一schema literal不得原地改变必填或授权语义。
- 规范见[技术合同](../../docs/architecture/technology-contract.md)。

## 命令

- `pnpm --filter @chat/contracts build`
- `pnpm --filter @chat/contracts typecheck`
- `pnpm --filter @chat/contracts test`
- 全部命令确定性运行，不需要真实服务、付费或外部写。
