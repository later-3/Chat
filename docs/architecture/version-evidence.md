# Chat 版本与供应链证据

> 当前安装真相以`pnpm-lock.yaml`和实际`node_modules/<package>/package.json`、LICENSE为准；本文记录直接依赖的用途与退出方式。

## 工具链

| 项目 | 固定值 |
|---|---|
| Node.js | `>=22.19` |
| pnpm | `10.13.1` |
| TypeScript | `5.9.3` |
| 模块 | ESM，TypeScript strict |

## 直接运行依赖

| 依赖 | 版本 | 许可证 | 用途与边界 | 退出方式 |
|---|---:|---|---|---|
| `@deepseek-ai/dsh` | `0.1.0-rc.6` | MIT | 唯一Web Host、原生会话/Composer/插件图；不拥有Chat产品事实 | 替换前端Host与Bridge Adapter；Chat API/Domain/Store不变 |
| `@chat/dsh-lifeos-bridge` | workspace `0.1.0` | 私有 | DSH Host/Client到Chat公开Query/Command的唯一集成面 | 删除bundle/profile层；Chat后端不变 |
| `hono` | `^4.13.0` | MIT | HTTP协议入口，不拥有事务 | 替换Router Adapter |
| `@hono/node-server` | `^2.1.0` | MIT | Node HTTP服务器 | 替换组合根服务器 |
| `workflow` | `4.8.0` | Apache-2.0 | 耐久Workflow API | 通过Workflow Port/Runner迁移 |
| `@workflow/world-local` | `4.2.4` | Apache-2.0 | 本地Workflow运行 | 生产World Adapter替换 |
| `@earendil-works/pi-agent-core` | `0.82.1` | MIT | Workflow内Agent loop | 替换`PiRuntimePort` Adapter |
| `@earendil-works/pi-ai` | `0.82.1` | MIT | Provider/模型调用 | 替换pi Adapter |
| `zod` | `^4.4.3` | MIT | 网络、存储和外部结果运行时校验 | 迁移全部Schema边界 |
| `@ag-ui/core` | `0.0.57` | MIT | 公开Agent事件语义 | 保持Chat Event合同后替换 |

DSH的React、Client UI、Cordis、Host Webserver等传递包由`@deepseek-ai/dsh@0.1.0-rc.6`的锁文件闭包提供。本仓库的Bridge只把DSH Host服务列为peer，并将Chat公开Schema和Zod内联到发布bundle；profile运行时不得解析`workspace:*`依赖。

### pi运行工件与能力对照源码

- 实际运行工件是锁文件固定的npm `@earendil-works/pi-agent-core@0.82.1`与`@earendil-works/pi-ai@0.82.1`，发布基点为`b4f293684bba718d59cc1157679bcf6157b3a7f5`。
- 本地能力对照源码是`/Users/xulater/Code/opc-os/pi`的`10e99ae9914cd34f622633fac42f9a90714e9cf4`；它不是运行时依赖来源。
- 升级pi必须同时更新精确npm版本、lock integrity，并重跑事件、Tool、恢复和真实Provider合同门；不能用本地源码提交替代安装工件证据。

## DSH固定证据

1. 运行依赖精确写为`0.1.0-rc.6`，不使用caret、tag或Git浮动分支。
2. Profile只安装本仓库Bridge的绝对`link:`；Bridge通过`dsh.bundle.patch`由DSH CLI原生加入profile bundles。
3. `DSH_HOME`固定在当前worktree的`.data/dsh-home`，不读取或污染用户全局`~/.dsh`。
4. 有效配置必须只有一个LifeOS row，默认模型为`lifeos/workflow`，DSH直接DeepSeek/pi-ai路由禁用，避免绕过Chat产品事实。
5. Boot Manifest、插件Inventory、URL和日志不得包含Chat API私有地址以外的秘密、Bridge状态路径或Runtime身份。
6. 升级DSH必须通过bundle构建、profile安装、config dump、真实Host、Client插件加载和Planning/HITL浏览器E2E。

官方来源：<https://github.com/deepseek-ai/deepseek-harness>；npm包：<https://www.npmjs.com/package/@deepseek-ai/dsh>。

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
