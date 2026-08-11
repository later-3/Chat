# P0 版本证据清单

> 状态：随 P0 锁文件（pnpm-lock.yaml）固定
>
> 日期：2026-08-06
>
> 依据：技术合同§13。升级任何下列依赖前必须先运行对应合同测试，不允许只更新Lockfile后假定语义不变。

## 1. 工具链

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | 24.8.0（`engines: >=22.19`，CI固定24） | 运行时 |
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
| vite-plugin-pwa | 1.3.0 | MIT | P1.2：从实际dist生成Manifest、预缓存清单与Service Worker | apps/web构建期（dev only） | 构建期插件，不进运行时bundle；退出方式：移除插件与注册组件即回到纯静态站点。peer range含Vite 8，Node要求>=16，低于仓库基线 |
| workbox-window | 7.4.1 | MIT | P1.2：浏览器侧SW注册与“用户确认后更新”流程 | apps/web**运行时**依赖：进入浏览器bundle（`workbox-window.prod.es5-*.js`），纳入`pnpm audit --prod`审计面 | 随vite-plugin-pwa一起退出；Workbox由Google维护，generateSW产物不缓存/api与写请求 |
| react-markdown | 10.1.0 | MIT | S5：把Note Markdown源码安全投影为有限React元素；`skipHtml`、元素白名单和自定义URL/Link组件禁止raw HTML、图片、iframe与非HTTP(S)链接 | apps/web运行时，`NoteMarkdownRenderer`动态import为独立chunk | 标准React没有CommonMark解析器；退出时删除该依赖与lazy renderer并恢复安全源码视图，Note API、Store源码和Revision Hash均不变 |
| @playwright/test | 1.62.1 | Apache-2.0 | P1.2：真实Chromium验证SW离线外壳、草稿与手机布局 | apps/web（dev） | 仅测试边界，替换不影响产品代码 |
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

P0曾以本地源码提交`10e99ae9914cd34f622633fac42f9a90714e9cf4`作为能力证据，
但npm同名版本发布自`b4f293684bba718d59cc1157679bcf6157b3a7f5`，两者不是同一工件。
B2已完成工件决策：运行时只消费npm `0.82.1`，由pnpm锁文件的SHA-512完整性固定；
`10e99ae`只保留为补充能力对照，不再被描述成实际运行工件。升级必须走合同PR。

| 项 | 值 |
|---|---|
| 能力对照源码 | `/Users/xulater/Code/opc-os/pi`@`10e99ae9914cd34f622633fac42f9a90714e9cf4` |
| 实际运行工件 | npm `@earendil-works/pi-agent-core@0.82.1`与`pi-ai@0.82.1`，发布基点`b4f293684bba718d59cc1157679bcf6157b3a7f5`，`engines: node>=22.19.0` |
| 锁文件完整性 | agent-core `sha512-Z3kloziJIE2dmrisRckZX8zDca/gIv9/YdFAzeoqpHiLV2wsni6bL4hInNSjVKLbqT+4kqLIkph2JQLKvSepjg==`；ai `sha512-3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==` |
| 引入时机 | B2 M2（已引入） |
| 升级门 | 重跑pi事件归一化、Tool与恢复合同测试 |

### 4.3 其他待引入

| 依赖 | 引入时机 | 版本来源 |
|---|---|---|
| Playwright | P1.2已引入为`@playwright/test` 1.62.1（Apache-2.0，apps/web dev边界） | npm锁文件 |

## 5. 已验证的P0完成门

1. 干净检出可启动：无dist副本`pnpm install`后：
   - `apps/api` `pnpm dev`与`pnpm start`均启动，`/api/healthz`返回合同形状；
   - `apps/web` `pnpm dev`启动，Vite直接转换`@chat/contracts`源码。
2. 构建通过：`pnpm build`（全部包tsc/vite构建成功）。
3. 测试通过：24个测试（合同Schema与AG-UI官方对齐、Domain状态机、API路由、Web渲染、架构依赖方向）。
4. 合同包被Web/API共同使用：`serviceStatusSchema`、`problemDetailSchema`两端共享。
5. 依赖方向由`packages/testing`架构测试固定，CI执行。
6. `pnpm audit --prod`无已知漏洞（生产依赖仅保留实际使用项）。

## 6. P1.2已验证的PWA完成门

1. 生产构建产物包含`manifest.webmanifest`、`sw.js`、预缓存清单（11项，不含任何`/api`）、192/512/maskable图标与带Hash的JS/CSS。
2. Service Worker导航回退白名单排除`/api`（`denylist:[/^\/api\//]`）；不配置任何API runtime cache与Background Sync。
3. 真实Chromium（生产构建+vite preview+真实API）验证：SW激活控制页面、离线重开外壳、草稿跨刷新恢复、离线发送被阻止、恢复联网不自动发送、离线`/api/healthz`真实失败。
4. 320/375/390/430px竖屏与844×390横屏无页面级横向滚动；手机触控目标≥44px。
5. `pnpm audit --prod`通过；`workbox-window`作为浏览器运行时依赖已归入`dependencies`并纳入生产审计，vite-plugin-pwa与Playwright仅为dev依赖。

## 7. B2 M2已安装的运行时依赖

B2 M2首次引入Workflow与pi运行时。依赖证据如下；升级前必须重跑对应合同测试
（Workflow Hook/重放/Retry、pi工具校验/事件归一化、Provider错误族）。

| 依赖 | 版本 | 许可证 | 用途 | 所在边界 | 标准库为何不足 | 退出/替换方式 |
|---|---|---|---|---|---|---|
| `workflow` | 4.8.0（含`@workflow/core` 4.8.0） | Apache-2.0 | 耐久Step、Hook、重放与Checkpoint | packages/workflows（唯一Workflow定义与Step） | Node无内建耐久执行/暂停恢复语义 | 冻结技术栈；替换需重新批准Workflow选型 |
| `@workflow/world-local` | 4.2.4 | Apache-2.0 | 本地World（JSON事件日志+内存队列） | packages/workflows Runtime进程 | 同上 | 可换远程World（Vercel/Postgres），Product Store事实不受影响 |
| `@workflow/builders` | 4.1.6（dev） | Apache-2.0 | 预构建workflow/step bundle（SWC转换） | packages/workflows构建期脚本 | 无 | 仅开发期；产物gitignored |
| `@earendil-works/pi-ai` | 0.82.1 | MIT | Model/Provider抽象与OpenAI兼容流 | packages/pi-runtime | 无统一模型流抽象 | 冻结pi选型；升级门为pi事件/Tool合同测试 |
| `@earendil-works/pi-agent-core` | 0.82.1 | MIT | Agent loop与结构化工具 | packages/pi-runtime | 无Agent循环/工具治理 | 同上 |
| `undici` | 7.29.0（根override只覆盖`>=7 <7.29`） | MIT | Workflow World的传递HTTP客户端；修复7.28.0安全公告 | `@workflow/world-local`/`world-vercel`传递边界 | Workflow SDK直接依赖，不能用Node内建fetch替换其内部实现 | Workflow上游依赖升级到安全版本后移除override并重跑全门 |

### 7.1 pi工件与冻结源码的关系（重要）

- 能力对照源码：`/Users/xulater/Code/opc-os/pi` @ `10e99ae9914cd34f622633fac42f9a90714e9cf4`；它不是运行时依赖来源。
- 已核验：冻结提交的唯一自定义改动是`.gitignore`/`.vscode`调试配置（非运行时代码）；
  其`packages/ai`、`packages/agent`代码 = npm 0.82.1发布基点`b4f2936`之后的39个上游提交。
- 当前消费npm `@earendil-works/pi-ai`/`pi-agent-core` 0.82.1（gitHead `b4f2936`，MIT），
  与冻结提交存在16个源文件差异（主要为`stopReason:"pending"`流错误强化与Bedrock/OpenRouter修补，
  不减少Agent/AgentTool/openai-completions能力面）。
- 本地与CI由pnpm锁文件中的上述SHA-512固定同一npm工件，满足“本地与CI使用同一份代码”；
  能力对照以冻结提交为准（文档`docs/architecture/planning-execution-workflow.md`§18.2）。
- 退出路径：上游发布覆盖冻结提交语义的版本后整体升级并重跑pi合同测试；
  不得在未重跑测试时只更新锁文件。

### 7.2 Workflow本地运行形态

- Workflow Runtime进程（127.0.0.1:43112）= Local World + 预构建bundle + 进程内handler。
- bundle由`@workflow/builders`从`packages/workflows/src`预构建（`pnpm --filter @chat/workflows build:bundles`），
  产物`.workflow-bundle/`已gitignore；Step非step模块保持external，经tsx解析到TS源码，
  VS Code断点直接命中TypeScript，不需要在生成产物中调试。
- 确定性测试复用同一装配路径（`setupWorkflowWorld`），真实World+真实Hook+真实bundle。

### 7.3 B2运行版本证据

- Workflow bundle构建时保存Git SHA、源码状态（`clean|dirty`）、源码Manifest SHA-256、
  bundle Manifest SHA-256，以及Workflow Definition、Prompt模板和模型配置版本集合。
- Workflow Start越过Runtime边界前，按`productRunId`以0600不可变文件保存当次Build证据；
  同一Run遇到内容不同的证据时失败关闭，不用当前HEAD覆盖历史。
- Runtime启动恢复活动Run前逐字段比对当前Build与历史证据；不一致时拒绝使用新bundle恢复旧Run。
- Replay遇到`dirty`源码证据必须标为不可复现，不能把结果归因到记录的Git SHA。
- 真实付费E2E只接受`clean`证据；工作区有未提交运行源码时在Provider调用前失败关闭。
