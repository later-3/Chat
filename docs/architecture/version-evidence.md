# Chat 版本与供应链证据

> 当前安装真相以`pnpm-lock.yaml`和实际`node_modules/<package>/package.json`、LICENSE为准；本文记录直接依赖的用途与退出方式。

## 工具链

| 项目 | 固定值 |
|---|---|
| Node.js | `>=24 <25`；本地`.node-version`固定`24.8.0`，原生工件ABI固定`137` |
| pnpm | `10.13.1` |
| TypeScript | `5.9.3` |
| 模块 | ESM，TypeScript strict |

## 直接运行依赖

| 依赖 | 版本 | 许可证 | 用途与边界 | 退出方式 |
|---|---:|---|---|---|
| `@deepseek-ai/dsh` | `0.1.0-rc.6` + Later Fork `codex/chat-trajectory-location-rc6` | MIT | 唯一Web Host、原生会话/Composer/插件图；Trajectory直接链接Fork源码构建，只保留调用Location、语义标签与紧凑行预览；不拥有Chat产品事实 | 切换Fork分支或替换前端Host与Bridge Adapter；Chat API/Domain/Store不变 |
| `@chat/dsh-lifeos-bridge` | workspace `0.1.0` | 私有 | DSH Host/Client到Chat公开Query/Command的唯一集成面 | 删除bundle/profile层；Chat后端不变 |
| `dsh-mobile-hanui` | `0.2.4`（workspace精确依赖，profile link） | MIT | 移动端外壳：≤1023px抽屉/FAB/弹窗全屏/Composer修复；仅客户端DOM/CSS，零运行时依赖，无网络外发；桌面零影响 | 从profile bundles移除即退出；运行时可用`?mobileShell=0`关闭 |
| `code-server`官方发行工件 | `4.132.0` / commit `313bf0359b4d391ba18f1fa131aad8a583bc2919` | MIT | 独立Hosted Workbench；不进入pnpm运行依赖、不拥有Chat产品事实 | 替换Workbench Provider；DSH与Chat后端不变 |
| `hono` | `^4.13.0` | MIT | HTTP协议入口，不拥有事务 | 替换Router Adapter |
| `@hono/node-server` | `^2.1.0` | MIT | Node HTTP服务器 | 替换组合根服务器 |
| `workflow` | `4.8.0` | Apache-2.0 | 耐久Workflow API | 通过Workflow Port/Runner迁移 |
| `@workflow/world-local` | `4.2.4` | Apache-2.0 | 本地Workflow运行 | 生产World Adapter替换 |
| `@earendil-works/pi-agent-core` | Later Fork `codex/later-custom`（上游基线`0.84.2`） | MIT | Planner与AgentSession底层loop；与Coding Agent来自同一Fork构建，避免运行时类型实例分裂 | 替换`PiRuntimePort` Adapter |
| `@earendil-works/pi-ai` | Later Fork `codex/later-custom`（上游基线`0.84.2`） | MIT | Provider/模型调用；与Coding Agent来自同一Fork构建 | 替换pi Adapter |
| `@earendil-works/pi-coding-agent` | Later Fork `codex/later-custom`（上游基线`0.84.2`） | MIT | 完整AgentSession与通用fail-closed Provider Request Gate；直接链接Fork源码构建，外部Extension按Chat安全政策关闭，不拥有产品事实 | 切换Fork分支或替换Runner，保留Chat Operation Port |
| `zod` | `^4.4.3` | MIT | 网络、存储和外部结果运行时校验 | 迁移全部Schema边界 |
| `@ag-ui/core` | `0.0.57` | MIT | 公开Agent事件语义 | 保持Chat Event合同后替换 |

DSH的React、Client UI、Cordis、Host Webserver等传递包由`@deepseek-ai/dsh@0.1.0-rc.6`的锁文件闭包提供。本仓库的Bridge只把DSH Host服务列为peer，并将Chat公开Schema和Zod内联到发布bundle；profile运行时不得解析`workspace:*`依赖。

pnpm生命周期脚本白名单只包含`node-pty`与`@deepseek-ai/dsh-subprocess-local`：前者在
Linux构建DSH subprocess所需的`pty.node`，后者只恢复`spawn-helper`可执行位。其他传递包不得
因插件采用而获得构建脚本权限。

`dsh-mobile-hanui@0.2.4`的npm integrity为
`sha512-NSnQbZGPOeXXOOOKMyTBSrxLJec4iMB7ktPO5fePmR1d+7AzmMJZyl9c2Gg8muiO2zI/KQ8+dlEOF9XoYJPiNQ==`，
发布`gitHead`为`1022f058050d676cfea17ed88c1794386860a407`，tag为`v0.2.4`。完整所有权、
能力、兼容与人工更新政策由[DSH插件登记表](../../config/dsh-plugins.json)和
[插件治理合同](./dsh-plugin-governance.md)共同约束；`.data/dsh-home`中的profile lock只是
可重建投影，不拥有供应链事实。

Trajectory窄派生的源码位于Public仓库<https://github.com/later-3/deepseek-harness-chat>；当前稳定集成分支为
`codex/chat-trajectory-location-rc6`，官方<https://github.com/deepseek-ai/deepseek-harness>仅作为只读
`upstream`。上游rc.6基点为`15148dbd9a1d1f1ef1a26e5749b32af0cd663935`，当前本地分支头为
`6a932cf9a594b02989085b6c280eeeb43d0fd681`。`packages/dsh-lifeos-bridge`直接链接同级受管checkout
`../deepseek-harness-chat-trajectory/packages/client/ui-trajectory`；启动门同时校验真实解析路径、origin、分支和三个运行标记，不再生成或消费Trajectory package patch。

### Pi受管分支与运行工件

- Pi源码所有权位于公开受管仓库<https://github.com/later-3/pi>；本地`origin`指向该仓库，官方<https://github.com/earendil-works/pi>只读命名为`upstream`。当前稳定集成分支为`codex/later-custom`，上游基点为`1f2b9ff53c0adefff454f02bdcf60aeaf4d28684`，当前本地分支头为`311d9e6da0d468bb9e07e6fdf4f76052f436c971`。
- `packages/pi-runtime`直接链接同级受管checkout中的`packages/agent`、`packages/ai`与`packages/coding-agent`，运行时仍沿用包内上游版本`0.84.2`。三者必须来自同一个Fork工作树，避免带私有字段的运行时类型出现双实例。两个通用接缝`providerRequestGate`与`resumePendingTurn()`及其能力标记、源码测试全部属于Pi Fork；Chat不再生成或消费Pi package patch。
- 修改Pi时从`codex/later-custom`建立独立功能worktree，通过Pi检查与测试后合回该稳定分支并执行`npm run build:offline`。Chat启动前读取运行时能力标记，错误分支、未构建源码或官方包替代Fork都会失败关闭。
- 升级Pi必须先把官方正式版本汇合到Fork功能分支，再重跑Extension变换顺序、Gate fail-closed、Tool、恢复和真实Provider合同门；验证完成后才更新稳定集成分支。

## DSH固定证据

1. DSH Host基线保持`0.1.0-rc.6`；Trajectory通过本地`link:`直接消费受管Fork稳定分支，启动门验证origin、分支与运行标记。
2. Profile只安装本仓库Bridge的绝对`link:`；Bridge通过`dsh.bundle.patch`由DSH CLI原生加入profile bundles。
3. `DSH_HOME`固定在当前worktree的`.data/dsh-home`，不读取或污染用户全局`~/.dsh`。
4. 有效配置必须只有一个LifeOS row，默认模型为`lifeos/workflow`，DSH直接DeepSeek/pi-ai路由禁用，避免绕过Chat产品事实。
5. Boot Manifest、插件Inventory、URL和日志不得包含Chat API私有地址以外的秘密、Bridge状态路径或Runtime身份。
6. `assertDshTrajectoryExtension`在构建与启动前同时验证安装包版本、3个运行标记、Fork origin与稳定分支；任一漂移都失败关闭。
7. 升级DSH必须先在独立Fork源码分支重放并运行Trajectory测试、typecheck、bundle、lint与doc-sync，合回稳定集成分支并重建后，再通过profile安装、config dump、真实Host、Client插件加载和Planning/HITL浏览器E2E。
8. 公开派生的默认分支是`main`，官方remote必须命名为`upstream`；完整同步、差异预算与退出流程见[DSH前端派生与维护](./dsh-frontend-maintenance.md)。

官方来源：<https://github.com/deepseek-ai/deepseek-harness>；npm包：<https://www.npmjs.com/package/@deepseek-ai/dsh>。

## code-server固定证据

1. `scripts/workbench/fixed-code-server.mjs`固定`4.132.0`、上游commit、macOS/Linux的x64/arm64资产大小与SHA-256；不下载`latest`，不执行`curl | sh`。
2. 下载、解压和运行时目录都有完整Hash证据；共享缓存不进入Git，漂移时拒绝启动。
3. 运行时只绑定受管0700临时根内的0600 Unix socket；退役端口`43113`必须无监听，preflight以Node独占bind并成功close为权威空闲门，occupied、EACCES或其他unknown错误全部失败关闭，lsof/ss只补安全诊断且绝不决定放行或自动终止。关闭telemetry、update check、自动端口转发与code-server proxy，固定`EXTENSIONS_GALLERY={}`使扩展市场默认离线，Provider、GitHub和SSH凭据不进入子进程。固定工件校验必须确认`server-main.js`仍支持该官方环境hook，升级漂移时失败关闭。
4. user-data与extensions独立持久化；Chat受管安全设置覆盖，其他用户编辑器偏好保留。
5. 浏览器通过`localhost:43110/workbench/code/`的隔离Origin访问；Gateway在校验受管process evidence、0700目录和0600 socket后，剥离前缀、重写内部Host/Origin并通过`socketPath`代理动态WebSocket，Service Worker不得越过该子路径。
6. `43119`是准备与运行共同持有的内核互斥租约；收到连接立即断开，不提供HTTP、健康检查或Workbench内容。每次运行用唯一`instanceId`贯穿starting/running/stopped evidence；wrapper确认进程组与socket退出、原子发布最小stopped tombstone后才释放租约。PID登记丢失时，preflight与`dev:stop`先按evidence、启动时间、命令、cwd和Git Common Directory复核并回收wrapper/child，再取得租约、复读同一`instanceId`后才允许清目录或发布tombstone。
7. 升级必须更新版本、commit、四个平台资产证据，并重跑供应链、Files/Terminal/Git-Diff、WebSocket、Origin隔离和进程回收门。

官方来源：<https://github.com/coder/code-server>；运行工件内`package.json`与`LICENSE`均声明MIT。

## 固定Memory源码证据

1. memmy固定为公开仓库`MemTensor/memmy-agent`的commit
   `211d521b310fc23c63dd3d9ca848941173981c5e`与tree
   `c4b1e78046f10011dc28b0408fb1bb3b61a5c3a1`；只从受管HTTPS Git mirror对该对象
   `archive`，再使用上游lock执行限定workspace的`npm ci --ignore-scripts`与构建。安装过程
   不执行第三方lifecycle；`onnxruntime-node@1.21.0`的四个平台CPU运行库由npm包integrity
   覆盖，额外CUDA下载显式禁用；`better-sqlite3@12.10.0`只安装Chat按
   macOS/glibc ≥ 2.29 Linux × arm64/x64固定大小、归档SHA-256与解压后二进制SHA-256的
   Node ABI 137上游Release工件；glibc 2.28及musl在下载前失败关闭。缓存证据同时覆盖
   源码、`Memory/dist`与完整`node_modules`运行闭包。
2. Tencent MemoryCore固定为`later-3/TencentDB-Agent-Memory`的commit
   `3a9748d3c61c2a2feb38237c9b28992250c1804e`与tree
   `3b41130cd6f716112c1e357d86d4dc6f494cb52f`。该提交没有跟踪
   `MemoryCore/package-lock.json`，因此Chat保存一份SHA-256为
   `906c9bc6fec5fd08599cc9cfc8a1ddf9a1eb336d993bf9212bcd0ee4281a6aaf`、逐依赖
   具有npm registry HTTPS来源和SHA-512 integrity的审核lock；准备时复制到隔离archive并
   执行`npm ci --omit=dev --ignore-scripts --legacy-peer-deps`，不链接任何个人仓库的
   `node_modules`。lock生成与ci使用同一legacy peer策略，以固定上游optional peer冲突的
   解析结果；运行依赖仍由lock中的resolved与integrity约束。
3. 两套源码的默认来源都是固定HTTPS URL；本地mirror只有通过显式环境变量选择后才可用，
   但仍必须通过同一commit/tree门。缓存证据记录来源模式、源码清单Hash与运行工件或安装lock
   Hash，漂移时原子重建。
4. Memory固定证据与准备代码继续保留；普通setup/dev/debug不下载或自动启动第三方服务，
   当前产品完成门也不包含Memory。API与Workflow保留同一Provider合同以读取历史事实并允许
   后续重新接入；没有显式专项配置时Provider不可用，触达历史Memory Workflow会在Planner前
   安全失败。未来重新启用时，显式真实门使用
   `CHAT_FIXED_SOURCE_CACHE_ROOT`复用审核缓存，验证通用Query/Write Port、BM25 L1、L0
   accepted、只读对账、materialized与租户隔离，不改写或Fork上游源码。

## 构建与测试依赖

- `tsdown`只构建Bridge的Host ESM和DSH Client factory bundle。
- `tsx`只用于本地TypeScript入口和测试。
- Vitest/Node Test覆盖合同、状态机、Adapter与服务图。
- Playwright只用于显式浏览器门；真实Provider E2E与普通CI测试物理隔离。
- ESLint与Prettier只在开发/CI运行。

## 审计门

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm audit --prod
```

安装或升级后还要核对：lock integrity、实际LICENSE、Node engines、bundle无未预期裸import、Browser/Boot Manifest秘密扫描，以及上游版本替换后的退出测试。
