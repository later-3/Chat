# P0 版本证据清单

> 状态：随 P0 锁文件（pnpm-lock.yaml）固定
>
> 日期：2026-08-06
>
> 依据：技术合同§13。升级任何下列依赖前必须先运行对应合同测试，不允许只更新Lockfile后假定语义不变。

## 1. 工具链

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | 24.8.0（`engines: >=22`，CI固定24） | 运行时 |
| pnpm | 10.13.1（`packageManager`固定） | Workspace与锁文件 |
| TypeScript | 5.9.3 | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes |

## 2. 已锁定依赖

| 依赖 | 版本 | 许可证 | 用途 | 所在边界 | 退出/替换方式 |
|---|---|---|---|---|---|
| react / react-dom | 19.2.8 | MIT | Web交互面 | apps/web | 冻结技术栈；替换需重新批准前端选型 |
| vite | 8.2.0 | MIT | Web构建与dev server | apps/web | 同上 |
| @vitejs/plugin-react | 6.0.5 | MIT | React编译 | apps/web构建期 | 随Vite升级门处理 |
| @tanstack/react-query | 5.101.4 | MIT | 服务端状态投影缓存 | apps/web | 冻结技术栈；缓存不成为事实源 |
| hono | 4.13.0 | MIT | HTTP/API Adapter | apps/api | 冻结技术栈；Hono不拥有产品事务 |
| @hono/node-server | 2.1.0 | MIT | Node上运行Hono | apps/api | 可换其他Hono runtime adapter |
| zod | 4.4.3 | MIT | 网络DTO/Command/Event运行时校验 | packages/contracts | 冻结技术栈；Schema拥有运行时合同 |
| vitest | 4.1.10 | MIT | 单元/合同/架构测试 | 全部包（dev） | 测试框架替换不影响产品代码 |
| jsdom | 30.0.1 | MIT | Web组件测试DOM | apps/web（dev） | 同上 |
| @testing-library/react | 16.3.2 | MIT | React渲染测试 | apps/web（dev） | 同上 |
| eslint / typescript-eslint | 10.8.0 / 8.66.0 | MIT | Lint | 根（dev） | typescript-eslint暂不支持TS 7，故TS固定5.9 |
| prettier | 3.9.6 | MIT | 格式化（不格式化Markdown治理文档） | 根（dev） | — |
| tsx | 4.23.8 | MIT | API dev模式TS执行 | apps/api（dev） | 可用node --watch替代 |
| @types/node / @types/react / @types/react-dom | 26.1.2 / 19.2.18 / 19.2.4 | MIT | 类型 | dev | — |

## 3. 合同要求但P0尚未引入

以下依赖属于P1+工作包，P0不预建：

| 依赖 | 引入时机 | 版本来源 |
|---|---|---|
| `workflow`（Vercel Workflow） | P1第一条纵向链 | 引入时记录稳定版本与源码提交 |
| `@ag-ui/core`（按需`@ag-ui/client`） | P1事件归一化 | 引入时与`agUiCompatibleEventSchema`对齐测试 |
| `pi-agent-core` / `pi-ai` / `pi-coding-agent` | P1 Agent节点 | 固定源码`/Users/xulater/Code/opc-os/pi`，提交`10e99ae9914cd34f622633fac42f9a90714e9cf4` |
| Playwright | P1端到端恢复场景 | 引入时固定 |

## 4. 已验证的P0完成门

1. 空应用可启动：`apps/api`启动后`/api/healthz`返回合同形状，未知路由返回Problem Detail。
2. 构建通过：`pnpm build`（全部包tsc/vite构建成功）。
3. 测试通过：22个测试（合同Schema、Domain状态机、API路由、Web渲染、架构依赖方向）。
4. 合同包被Web/API共同使用：`serviceStatusSchema`、`problemDetailSchema`两端共享。
5. 依赖方向由`packages/testing`架构测试固定，CI执行。
