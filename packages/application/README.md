# @chat/application

## 拥有

产品用例、权限、事务协调、CAS/幂等、Decision、Outbox与Product Commit政策。

## 不拥有

不拥有HTTP、具体Store/Provider实现、Workflow Checkpoint或Pi Session；模型输出只是候选。

## 入口与边界

- public：[`src/index.ts`](./src/index.ts)；依赖Port集中在[`src/deps.ts`](./src/deps.ts)。
- 上游为API/Workflow；下游为Domain和由组合根注入的Store/Runtime Port。
- 本地事实与Outbox同事务提交；外部未知结果不能普通重试，须对账或人工处置。
- 技术所有权见[技术合同](../../docs/architecture/technology-contract.md)。

## 命令

- `pnpm --filter @chat/application build`
- `pnpm --filter @chat/application typecheck`
- `pnpm --filter @chat/application test`
- 测试使用本地Port替身，不调用付费Provider或真实外部写。

