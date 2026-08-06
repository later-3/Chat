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

P0只安装实际使用的依赖；未实现的Workflow/pi运行时依赖不在P0锁文件（见§4的版本记录）。

| 依赖 | 版本 | 许可证 | 用途 | 所在边界 | 退出/替换方式 |
|---|---|---|---|---|---|
| @ag-ui/core | 0.0.57 | MIT | Agent事件官方Zod Schema；`agUiCompatibleEventSchema`直接委托官方`EventSchemas`校验 | packages/contracts | 冻结技术栈；升级前必须重跑事件合同测试（AG-UI事件、Interrupt、序列化）。注意：其package.json未填写license字段，许可证以其仓库LICENSE文件（MIT）为准 |
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

## 4. 已冻结选型、P0记录版本但不安装的运行时依赖

以下属于P1+才使用的平台运行时。P0只记录可验证的版本证据，**不安装**，
避免未使用代码进入生产依赖面与审计面。

### 4.1 Vercel Workflow

| 项 | 值 |
|---|---|
| npm包 | `workflow@4.8.0` |
| 许可证 | Apache-2.0 |
| 源码仓库 | `github.com/vercel/workflow` |
| 源码提交 | `328653a7a265d62777e8bc3956ffd60650d8a356`（tag `workflow@4.8.0`，经GitHub API核验） |
| 引入时机 | P1第一条纵向链，进入`packages/workflows`依赖 |
| 升级门 | 重跑Hook、Checkpoint、重放合同测试 |

### 4.2 pi（Agent Runtime）

冻结合同钉住源码提交`10e99ae9914cd34f622633fac42f9a90714e9cf4`，该提交的
`packages/{agent,ai,coding-agent}/package.json`均为`@earendil-works/*@0.82.1`（MIT）。

但已核验：**npm上的`@earendil-works/pi-agent-core@0.82.1`发布自`b4f293684bba718d59cc1157679bcf6157b3a7f5`，
与冻结提交`10e99ae`存在75个文件差异，不能视为同一工件。**

因此P1引入pi前必须先决定工件方案，候选：

1. 从冻结提交`10e99ae`自行构建并以可验证方式发布（如workspace file:/link:协议或私有registry），保留构建与哈希证据。
2. 重新评估并将冻结提交更新到与npm发布一致的提交，走合同变更流程。

该决定属于合同变更，不在P0范围。记录：

| 项 | 值 |
|---|---|
| 冻结源码 | `/Users/xulater/Code/opc-os/pi`@`10e99ae9914cd34f622633fac42f9a90714e9cf4` |
| 冻结提交处版本 | `@earendil-works/pi-agent-core`/`pi-ai`/`pi-coding-agent` 0.82.1（MIT） |
| npm同版本号工件 | 发布自`b4f293684bba718d59cc1157679bcf6157b3a7f5`，与冻结提交差75个文件；`engines: node>=22.19.0` |
| 引入时机 | P1，且仅在工件方案决定之后 |
| 升级门 | 重跑pi事件归一化、Tool与恢复合同测试 |

### 4.3 其他待引入

| 依赖 | 引入时机 | 版本来源 |
|---|---|---|
| Playwright | P1端到端恢复场景 | 引入时固定 |

## 5. 已验证的P0完成门

1. 干净检出可启动：无dist副本`pnpm install`后：
   - `apps/api` `pnpm dev`与`pnpm start`均启动，`/api/healthz`返回合同形状；
   - `apps/web` `pnpm dev`启动，Vite直接转换`@chat/contracts`源码。
2. 构建通过：`pnpm build`（全部包tsc/vite构建成功）。
3. 测试通过：24个测试（合同Schema与AG-UI官方对齐、Domain状态机、API路由、Web渲染、架构依赖方向）。
4. 合同包被Web/API共同使用：`serviceStatusSchema`、`problemDetailSchema`两端共享。
5. 依赖方向由`packages/testing`架构测试固定，CI执行。
6. `pnpm audit --prod`无已知漏洞（生产依赖仅保留实际使用项）。
