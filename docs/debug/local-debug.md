# Chat 本地调试

## 固定端口

| 服务 | 地址 |
|---|---|
| LifeOS Web Gateway / DSH入口 | `http://127.0.0.1:43110` |
| Chat API | `http://127.0.0.1:43111` |
| Workflow | `http://127.0.0.1:43112` |
| Pi Coding Executor | `http://127.0.0.1:43115`（私有Runtime Key） |
| code-server内部服务 | 受管0700临时根内的0600 Unix socket（不监听TCP） |
| DSH内部Host | `http://127.0.0.1:43114` |
| Workbench浏览器入口 | `http://localhost:43110/workbench/code/` |
| code-server准备/运行租约 | `127.0.0.1:43119`（只做内核互斥，连接立即断开，不提供HTTP） |
| API Inspector | `127.0.0.1:43120`（`dev:debug`） |
| Workflow Inspector | `127.0.0.1:43121`（`dev:debug`） |
| Pi Executor Inspector | `127.0.0.1:43122`（`dev:debug`） |

所有服务只使用固定端口；冲突时失败关闭或在四重身份校验后回收同一Git仓库的旧进程，不能自动换号。

## 命令

首次克隆先按[本地安装指南](../getting-started/local-install.md)完成工具链与固定工件准备。

```bash
pnpm install --frozen-lockfile
pnpm run setup
pnpm dev
pnpm dev:debug
pnpm dev:status
pnpm dev:stop
```

`pnpm run setup`默认只准备code-server、Workflow Bundle与DSH Bridge/Profile，不准备或启动Memory；
检测到本仓库已有服务时只失败关闭，不执行preclean或Workflow版本收敛；
`pnpm dev`会复核同一批证据后启动Pi Executor、Workflow、API、code-server和DSH/Gateway；API与Workflow也不会实例化Memory Adapter。
Memory源码与独立测试保留，但统一安装、VS Code F5和开发启动器当前都没有启用入口。
Workbench当前为Beta，不属于通用CI/CD完成门；`--workbench=off`用于当前不需要IDE的日常调试和CI。
启用Beta Workbench时，终端SIGINT或
`pnpm dev:stop`必须反向停止并释放端口与Terminal子进程。

## DSH调试

断点与日志统一按“文件 + 函数/路由 + 观察变量”定位，不把易漂移的固定行号写成合同。

| 目标 | 文件/入口 | 观察内容 |
|---|---|---|
| Profile准备 | `scripts/dsh/prepare-web-profile.mjs` | 固定DSH版本、Bridge bundle、worktree私有`DSH_HOME` |
| Host启动 | `scripts/dsh/start-web.mjs` | 43110 Gateway、内部43114 DSH、Boot Manifest、插件加载失败 |
| Session映射 | `AtomicBridgeStateStore`、`LifeosLlmAdapter.ensureChatSession` | `dshSessionId -> productSessionId`、原子状态、稳定Command |
| 消息发送 | `LifeosLlmAdapter.stream`、`ChatProductClient.submitMessage` | 只处理正常会话请求；title/compaction无产品写入 |
| Plan/HITL | `LifeosBridgeService.projection/decide`、Client Slot | Run revision、Plan/Approval版本与Hash、Decision Command |
| Note审核 | `LifeosBridgeService.projection/decideNote`、`LifeosDock` | Candidate ID/revision/Hash、pending原样重试、Confirm/修订/拒绝 |
| 决定提交 | `ChatProductClient.submitDecision` | 同一pending command、Run CAS、Plan/Approval版本与Hash |
| 正式回复 | Bridge LLM Adapter | 只从Chat Message Query选择正式Assistant Message |
| Pi执行轨迹 | `LifeosLlmAdapter.nextTraceTool`、`createLifeosTraceTool` | cursor、toolCallId、input/result、DSH running/completed |

不要在日志/Watch中展示完整用户正文、密钥、Hook Token、Workflow Run ID或pi Session ID。

## 后端主链断点

1. `apps/api/src/product-routes.ts`：Message/Decision路由，只做协议和认证边界。
2. `packages/application/src/session-message-use-cases.ts`的`submitUserMessage`：Message、Run、Receipt、Outbox原子提交。
3. `apps/api/src/outbox-dispatcher.ts`的`dispatchStart/dispatchResume`：只在Outbox事实之后启动或恢复Runtime。
4. `packages/workflows/src/planning-execution-workflow.ts`的`planningExecutionWorkflow`：Planning/HITL/Execution耐久步骤。
5. `packages/application/src/plan-decision-use-cases.ts`的`submitPlanDecision`：Decision的权限、CAS、Plan版本与Hash边界。
6. `packages/workflows/src/workflow-result-steps.ts`的`commitExecutionResultStep`与`packages/application/src/commit-runtime-use-cases.ts`的`commitExecutionResult`：候选验证后提交正式Message和Run终态。
7. `packages/pi-runtime/src/executor-service.ts`、`coding-agent-executor.ts`与`executor-operation-store.ts`：Operation、AgentSession、工具前栅栏和安全事件。
8. `packages/pi-runtime/src/planner.ts`：Planner模型候选边界。
9. `packages/product-store-json`：revision、迁移、原子替换与完整性校验。

## Trace

```bash
pnpm debug:trace -- list-runs
pnpm debug:trace -- inspect-run <productRunId>
pnpm debug:replay -- --run <productRunId>
```

Trace保存可观察事件、对象引用、版本、耗时、安全错误，以及边界前已脱敏且有32K上限的Pi可见回复、工具输入和结果；不保存模型隐藏推理、密钥或完整Provider Payload。

真实门：`pnpm test:provider:bailian:coding`验证Pi标准配置链和`read/write/bash`；`pnpm --filter @chat/dsh-web test:e2e:trajectory-real`验证固定rc.6原生Trajectory的running→result投影，不调用付费Provider。

## Workbench调试

检查：侧边栏底部全局入口在空白Hero直接可达；code-server固定版本与SHA、精确Chat Workspace、独立用户数据目录、0700临时根与0600 Unix socket、Gateway HTTP与动态WebSocket代理、`localhost`虚拟Host隔离、Service Worker子路径、Terminal子进程回收，以及DSH关闭/重开Surface后的状态保持。受管child必须显示`EXTENSIONS_GALLERY={}`，真实浏览器全量HTTP/WS不得出现Open VSX、Copilot、telemetry或其他外部目标。launcher、独立`dev:status`与prepare各自从同一repo/env重建runRoot、受信tempParent和Git common-dir共享cacheRoot，不依赖launcher临时改写的`process.env`，也不从evidence反向信任路径；running status必须显示`healthy`、transport、instanceId及wrapper/child PID。退役`43113`必须始终无监听；preflight使用Node对`127.0.0.1:43113`独占bind并成功close作为唯一空闲证据，lsof/ss只补PID与安全进程摘要。occupied或unknown均拒绝启动且绝不自动终止；`pnpm dev:status`明确显示该端口的`free/occupied/unknown`。43114只允许DSH loopback内部Host；43119只承担准备/运行互斥，绝不返回Workbench或健康内容；停止时必须先发布同`instanceId`最小tombstone再释放租约。

```bash
pnpm workbench:prepare:code-server
pnpm test:workbench-runtime
pnpm test:workbench-runtime:real
pnpm test:e2e:dsh-workbench-real
```

最后一条是Workbench单独启用、修改或准备提升为稳定能力时的人工完成门，不属于当前通用CI/CD：从空白 Hero 的全局侧边栏入口进入，真实修改隔离 Git fixture，验证 SCM/Diff/Terminal、全部 WebSocket 白名单、Service Worker scope 和零外部 Telemetry。Terminal 使用唯一长寿命 argv canary；隐藏 Surface 和关闭浏览器后它仍存活，Playwright 全部服务退出后的外层 `finally` 再通过正式 reconcile 证明 canary 退出且 `43110/43113/43114/43119` 全部释放。
