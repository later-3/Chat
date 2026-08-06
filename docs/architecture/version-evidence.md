# P0 版本证据清单

> 状态：随 P0 锁文件（pnpm-lock.yaml）固定
>
> 日期：2026-08-06
>
> 依据：技术合同§13。升级任何下列依赖前必须先运行对应合同测试，不允许只更新Lockfile后假定语义不变。

## 1. 工具链

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | 24.8.0（`engines: >=22.18`，CI固定24） | 运行时 |
| pnpm | 10.13.1（`packageManager`固定） | Workspace与锁文件 |
| TypeScript | 5.9.3 | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes |

## 2. 已锁定依赖

冻结技术栈的核心运行时依赖使用精确版本固定（无caret），升级必须走合同测试门。

| 依赖 | 版本 | 许可证 | 用途 | 所在边界 | 退出/替换方式 |
|---|---|---|---|---|---|
| @ag-ui/core | 0.0.57 | Apache-2.0 | Agent事件官方Zod Schema；`agUiCompatibleEventSchema`直接委托官方`EventSchemas`校验 | packages/contracts | 冻结技术栈；升级前必须重跑事件合同测试（AG-UI事件、Interrupt、序列化） |
| workflow（Vercel Workflow） | 4.8.0 | MIT | 耐久Step、Hook、Checkpoint（P1起实现） | packages/workflows | 冻结技术栈；升级前重跑Hook/Checkpoint/重放合同测试 |
| @earendil-works/pi-agent-core | 0.82.1 | MIT | Agent loop与事件（P1起实现） | packages/pi-runtime | 固定源码`/Users/xulater/Code/opc-os/pi`提交`10e99ae9914cd34f622633fac42f9a90714e9cf4`（该提交即0.82.1）；升级前重跑pi事件归一化合同测试 |
| @earendil-works/pi-ai | 0.82.1 | MIT | Model与Provider抽象（P1起实现） | packages/pi-runtime | 同上 |
| @earendil-works/pi-coding-agent | 0.82.1 | MIT | 受治理编码执行能力（P5起实现） | packages/pi-runtime | 同上 |
| react / react-dom | 19.2.8 | MIT | Web交互面 | apps/web | 冻结技术栈；替换需重新批准前端选型 |
| vite | 8.2.0 | MIT | Web构建与dev server | apps/web | 同上 |
| @vitejs/plugin-react | 6.0.5 | MIT | React编译 | apps/web构建期 | 随Vite升级门处理 |
| @tanstack/react-query | 5.101.4 | MIT | 服务端状态投影缓存 | apps/web | 冻结技术栈；缓存不成为事实源 |
| hono | 4.13.0 | MIT | HTTP/API Adapter | apps/api | 冻结技术栈；Hono不拥有产品事务 |
| @hono/node-server | 2.1.0 | MIT | Node上运行Hono | apps/api | 可换其他Hono runtime adapter |
| zod | 4.4.3 | MIT | 网络DTO/Command/Event运行时校验 | packages/contracts | 冻结技术栈；Schema拥有运行时合同。注意@ag-ui/core内部使用zod 3，两者并行解析互不共享Schema实例 |
| vitest | 4.1.10 | MIT | 单元/合同/架构测试 | 全部包（dev） | 测试框架替换不影响产品代码 |
| jsdom | 30.0.1 | MIT | Web组件测试DOM | apps/web（dev） | 同上 |
| @testing-library/react | 16.3.2 | MIT | React渲染测试 | apps/web（dev） | 同上 |
| eslint / typescript-eslint | 10.8.0 / 8.66.0 | MIT | Lint | 根（dev） | typescript-eslint暂不支持TS 7，故TS固定5.9 |
| prettier | 3.9.6 | MIT | 格式化（不格式化Markdown治理文档） | 根（dev） | — |
| tsx | 4.23.8 | MIT | API dev/start的TS执行 | apps/api（dev） | 生产打包方式随部署拓扑（未决定项）再定 |
| @types/node / @types/react / @types/react-dom | 26.1.2 / 19.2.18 / 19.2.4 | MIT | 类型 | dev | — |

## 3. 内部包消费方式（源码导出）

`@chat/*`内部包的`exports`指向`src/index.ts`（types与import同源）：

- 干净检出后`pnpm install`即可运行`pnpm dev`/`pnpm test`，不要求先构建dist。
- Vite（apps/web）与tsx（apps/api）直接消费TS源码；tsc类型检查走`types`条件同源。
- `pnpm build`仍对每个包执行tsc/vite构建，作为编译与产出验证门。
- API生产启动当前为`tsx src/index.ts`；生产打包方式属于未决定的部署拓扑，不提前冻结。

## 4. 合同要求但P0尚未引入

| 依赖 | 引入时机 | 版本来源 |
|---|---|---|
| Playwright | P1端到端恢复场景 | 引入时固定 |

## 5. 已验证的P0完成门

1. 干净检出可启动：`/tmp/chat-clean`无dist副本，`pnpm install`后：
   - `apps/api` `pnpm dev`与`pnpm start`均启动，`/api/healthz`返回合同形状；
   - `apps/web` `pnpm dev`启动，Vite直接转换`@chat/contracts`源码。
2. 构建通过：`pnpm build`（全部包tsc/vite构建成功）。
3. 测试通过：24个测试（合同Schema与AG-UI官方对齐、Domain状态机、API路由、Web渲染、架构依赖方向）。
4. 合同包被Web/API共同使用：`serviceStatusSchema`、`problemDetailSchema`两端共享。
5. 依赖方向由`packages/testing`架构测试固定，CI执行。
