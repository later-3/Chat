# Chat 本地调试

若尚未确定模块Owner和安全完成门，先读[0–15分钟接手](../getting-started/quick-context.md)。

## 运行实例与固定端口

| 服务 | production | VS Code debug |
|---|---|---|
| LifeOS Web Gateway / DSH入口 | `http://127.0.0.1:43110` | `http://127.0.0.1:44110` |
| Chat API | `127.0.0.1:43111` | `127.0.0.1:44111` |
| Workflow | `127.0.0.1:43112` | `127.0.0.1:44112` |
| Pi Coding Executor | `127.0.0.1:43115` | `127.0.0.1:44115` |
| DSH内部Host | `127.0.0.1:43114` | `127.0.0.1:44114` |
| API Inspector | `127.0.0.1:43120`（production不启用） | `127.0.0.1:44120` |
| Workflow Inspector | `127.0.0.1:43121`（production不启用） | `127.0.0.1:44121` |
| Pi Executor Inspector | `127.0.0.1:43122`（production不启用） | `127.0.0.1:44122` |
| DSH Host / LifeOS Bridge Inspector | `127.0.0.1:43123`（production不启用） | `127.0.0.1:44123` |
| Code Workbench | 受管Unix socket；租约`43119`；浏览器入口`localhost:43110` | 固定关闭；`44119`保留给debug实例 |

端口所有权是失败关闭合同：`431xx`只允许LaunchAgent或显式前台production使用；任何分支、
worktree、VS Code F5和测试都不能借用。VS Code“Chat：调试应用”与`pnpm dev:debug`只使用
`441xx`，一个时刻只运行一个交互式debug worktree。Playwright真实门分别使用
`451xx`（Prompt Studio）、`452xx`（三闸门）和`453xx`（通用DSH/E2E）；端口占用时只报告
并失败，不运行production `debug:preclean`或终止未知进程。Memory保留位`18960/18970`和
`19960/19970`当前必须空闲。

production使用主checkout的`.data`；F5/debug使用当前worktree的
`.data/instances/vscode-debug`。Product Store、Workflow Store、Runtime Binding/Key、Trace、
DSH Profile/Bridge状态、PID登记和浏览器Profile均不共享。两组端口分别固定；当前实例冲突时
失败关闭或在四重身份校验后只回收同实例旧进程，不能自动换号或跨实例发信号。

源码与构建产物也要完全隔离时，应在独立worktree中打开VS Code。production可以继续从主
checkout由LaunchAgent运行；不要在同一个主checkout中一边改源码、一边把它当作稳定production来源。

## 命令

首次克隆先按[本地安装指南](../getting-started/local-install.md)完成工具链与固定工件准备。

```bash
pnpm install --frozen-lockfile
pnpm run setup --memory=off --workbench=off
pnpm dev --memory=off --workbench=off
pnpm dev:debug
pnpm dev:status
pnpm dev:stop
pnpm dev:debug:status
pnpm dev:debug:stop
```

production已由LaunchAgent占用`431xx`时，在独立debug worktree首次准备应使用：

```bash
pnpm install --frozen-lockfile
pnpm run setup --instance=debug
```

该命令只检查debug端口并准备debug Workflow Bundle/DSH Profile，不停止或读取production运行数据。

`pnpm run setup`默认只准备code-server、Workflow Bundle与DSH Bridge/Profile，不准备或启动Memory；
检测到本仓库已有服务时只失败关闭，不执行preclean或Workflow版本收敛；
`pnpm dev`属于production实例；推荐显式`--memory=off --workbench=off`，启动Pi Executor、
Workflow、API和DSH/Gateway。显式`--workbench=code-server`才增加Beta Workbench；
若LaunchAgent已常驻，不要再运行production入口。`pnpm dev:debug`与VS Code F5属于debug实例，可在production
继续服务PWA时并行启动相同的Pi Executor、Workflow、API和DSH服务图；API与Workflow同样不会实例化Memory Adapter。
Memory源码与独立测试保留，但统一安装、VS Code F5和开发启动器当前都没有启用入口。
Workbench当前为Beta，不属于通用CI/CD完成门；debug实例强制`--workbench=off`，避免本机权限工作台
跨进程边界进入公网或调试实例。
VS Code F5是Node/Chrome调试合同，不另起占用production端口的GDB服务。启用Beta Workbench时，终端SIGINT或
`pnpm dev:stop`必须反向停止并释放端口与Terminal子进程。

## DSH调试

断点与日志统一按“文件 + 函数/路由 + 观察变量”定位，不把易漂移的固定行号写成合同。

| 目标 | 文件/入口 | 观察内容 |
|---|---|---|
| Profile准备 | `scripts/dsh/prepare-web-profile.mjs` | 固定DSH版本、Bridge bundle、debug实例私有`DSH_HOME` |
| Host启动 | `scripts/dsh/start-web.mjs` | debug的44110 Gateway、内部44114 DSH、Boot Manifest、插件加载失败 |
| Bridge输入取舍 | `packages/dsh-lifeos-bridge/src/adapter.ts`的`LifeosLlmAdapter.stream`、`lastUserPrompt` | 原始`options`、最后一条真实用户文本、稳定request key、冻结的Workflow选择 |
| Bridge请求正文 | `packages/dsh-lifeos-bridge/src/chat-client.ts`的`ChatProductClient.submitMessage` | `commandId`、`payload.text`、已发布Workflow Revision与Hash；不会把整段DSH消息历史提交给Chat API |
| Session映射 | `AtomicBridgeStateStore`、`LifeosLlmAdapter.ensureChatSession` | `dshSessionId -> productSessionId`、原子状态、稳定Command |
| 历史会话授权 | `DshSessionQueryHistory.assertAccessible/describe/readEvents` | 当前Chat Workspace、live/persisted/archived、完整事件、seq分页；跨Workspace失败关闭 |
| 双源会话记录 | `LifeosBridgeService.sessionRecords*`、`SessionRecordsController`、`SessionRecordsView` | Bridge v5 Message身份关联、Chat不透明cursor、DSH seq、来源独立失败、正文/Payload不裁剪 |
| 消息发送 | `LifeosLlmAdapter.stream`、`ChatProductClient.submitMessage` | 只处理正常会话请求；title/compaction无产品写入 |
| Plan/HITL | `LifeosBridgeService.projection/decide`、Client Slot | Run revision、Plan/Approval版本与Hash、Decision Command |
| Note审核 | `LifeosBridgeService.projection/decideNote`、`LifeosDock` | Candidate ID/revision/Hash、pending原样重试、Confirm/修订/拒绝 |
| 决定提交 | `ChatProductClient.submitDecision` | 同一pending command、Run CAS、Plan/Approval版本与Hash |
| 正式回复 | Bridge LLM Adapter | 只从Chat Message Query选择正式Assistant Message |
| Pi执行轨迹 | `createRunActivitySink`、`getWorkflowExecutionTrace`、`ExecutionTraceProjection` | Run内sequence/sourceKey、Agent/Model/Tool、DSH投影；不读取Debug Trace |
| Workflow轨迹Query | `GET /api/runs/:productRunId/workflow-execution-trace`、`getWorkflowExecutionTrace` | 实际NodeRun、Runtime可用性、Pi活动、稳定`traceRevision` |
| DSH轨迹绑定 | `LifeosLlmAdapter.ensureRequest`、`LifeosBridgeService.executionTraces` | 真实`user/message ID → Product Run`、Query失败不阻断Plan/HITL |
| 原生轨迹折叠 | `ExecutionTraceProjection`、`executionTraceDefinition`、`executionTraceRoot` | 原生消息锚点→Workflow→NodeRun→Pi Agent→模型/工具；不写自定义Session事件 |

不要在日志/Watch中展示完整用户正文、密钥、Hook Token、Workflow Run ID或pi Session ID。

F5会让DSH Host在`44123`开放固定Inspector，并只在进程创建瞬间传递VS Code自动附加握手；
Host安装受管环境后会删除这些调试变量，Bridge插件不会重新获得Provider、云账号或SSH环境。
Bridge Host与Client bundle都生成source map，因此发送链断点应优先下在`src/adapter.ts`与
`src/chat-client.ts`；历史读取断点下在`src/dsh-session-history.ts`、`src/bridge-service.ts`和
`src/client/session-records-controller.ts`，不要依赖每次构建都会漂移的`dist/dsh-bundle.js`行号。

F5同时为API、Workflow、Pi Executor和DSH Host启用Node Source Map，并把Workflow VM中
`src/*`映射回`packages/workflows/src/*`。Workflow Builder的编排与Step bundle使用内联Map
（VM执行的是workflowCode字符串，不能改成只依赖外置`.map`）；构建器会验证Map及
`sourcesContent`完整存在。因此`configurable-planning-workflow.ts`、`workflow-*-steps.ts`、
`pi-runtime`和Bridge都应直接在TypeScript源码断点，不再打开`.workflow-bundle`或`dist`。
断点在对应子进程加载前可能暂时显示为空心：等待`workflow ready`或`web ready`后再发送新消息；
若加载后仍未绑定，先用`pnpm dev:debug:stop`收敛旧debug实例，再从唯一F5入口重启。

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
# 默认完全关闭；只诊断Bridge与Workflow的完整严格事件
CHAT_TRACE_MODE=full CHAT_TRACE_SCOPES=bridge,workflow pnpm dev --memory=off --workbench=off

# 只保留API/Application失败与拒绝事件
CHAT_TRACE_MODE=errors CHAT_TRACE_SCOPES=api,application pnpm dev --memory=off --workbench=off

pnpm debug:trace -- list-runs
pnpm debug:trace -- inspect-run <productRunId>
pnpm debug:replay -- --run <productRunId>
```

未设置`CHAT_TRACE_MODE`时，DSH、Bridge、API、Application、Workflow、Pi、Provider和Tool八个模块均不创建Trace
Sink。`CHAT_TRACE_MODE`只接受`off/errors/full`；`CHAT_TRACE_SCOPES`只接受上述模块的小写逗号列表，非法配置启动
失败关闭。Trace只保存可观察事件、对象引用、Hash、版本、耗时、统计与安全错误；Pi可见回复、工具输入和结果只进入
Run Activity/Pi Session，不再复制到Trace。新写入每日`bounded`文件默认上限16 MiB，可用
`CHAT_TRACE_MAX_DAILY_BYTES`调整。Trace不保存模型隐藏推理、密钥、用户正文或完整Provider Payload。

付费门：`pnpm test:paid:provider:bailian:coding`验证Pi标准配置链和`read/write/bash`；确定性
浏览器门`pnpm test:browser:trajectory`验证固定rc.6原生Trajectory的running→result投影与
双源完整会话记录，不调用付费Provider。

真实页面验证时，在DSH发送一条Planning消息后切换到“轨迹”：

1. 根行应为`Chat 本轮执行`，展开后按`DSH → Bridge → Chat后端 → Workflow`分区；Workflow子行必须来自实际`WorkflowNodeRun`，不能把静态Definition画成已执行。
2. `任务规划`或执行节点可展开Pi Agent；其下显示模型、Token与`submit_*`工具生命周期。
3. Trajectory不得出现`Vercel Workflow Runtime`、Run/Step/Hook/Sleep行；这些脱敏数据只保留为后端证据，后续由独立诊断/证据表面消费。页面不得出现Workflow Run ID、Hook Token、Pi Session ID、Provider Request ID、Prompt或工具参数/结果正文。
4. 默认Profile选择“规划执行工作流”，该Definition不含Memory节点，因此轨迹不得出现Memory；这不是展示过滤。完整上下文Planning Workflow仍保留，只有显式选择时才会解释其资源节点；当前统一启动器仍不会启动Memory服务或装配Adapter。

同一会话切换到“会话记录”时再检查：

1. Product Session与DSH Session的ID、标题和状态必须分开显示；空白草稿显示“首条消息后创建”，不得访问Chat Session API。
2. “Chat 正式消息”按`sessionSequence`显示完整用户正文与正式Assistant Message；“DSH 原始日志”展开后显示单条完整JSON事件，两边均可继续分页。
3. 任一来源Query失败只能在该来源显示错误，不能清空另一来源；刷新会取消前一代请求，Chat cursor不得由Client解析或猜测。
4. 未归档历史会话从原生侧栏重开后仍绑定同一Product Session并可继续对话；DSH原生归档只隐藏入口并保留两侧记录，当前界面不得声称永久删除成功。

同样内容必须可从对话头部“Chat Session”按钮打开的预览弹窗查看；弹窗和页签必须复用同一Controller，不能因
浏览器局部状态产生不同的Product/DSH身份或消息内容。

对应同源路由为`/lifeos/sessions/:dshSessionId/records`、`records/chat`与`records/dsh`。它们必须返回
`Cache-Control: no-store`，拒绝跨站、未知/重复分页参数、跨Workspace Session和超过100条的页大小。

## Workbench调试

检查：侧边栏底部全局入口在空白Hero直接可达；code-server固定版本与SHA、精确Chat Workspace、独立用户数据目录、0700临时根与0600 Unix socket、Gateway HTTP与动态WebSocket代理、`localhost`虚拟Host隔离、Service Worker子路径、Terminal子进程回收，以及DSH关闭/重开Surface后的状态保持。受管child必须显示`EXTENSIONS_GALLERY={}`，真实浏览器全量HTTP/WS不得出现Open VSX、Copilot、telemetry或其他外部目标。launcher、独立`dev:status`与prepare各自从同一repo/env重建runRoot、受信tempParent和Git common-dir共享cacheRoot，不依赖launcher临时改写的`process.env`，也不从evidence反向信任路径；running status必须显示`healthy`、transport、instanceId及wrapper/child PID。退役`43113`必须始终无监听；preflight使用Node对`127.0.0.1:43113`独占bind并成功close作为唯一空闲证据，lsof/ss只补PID与安全进程摘要。occupied或unknown均拒绝启动且绝不自动终止；`pnpm dev:status`明确显示该端口的`free/occupied/unknown`。43114只允许DSH loopback内部Host；43119只承担准备/运行互斥，绝不返回Workbench或健康内容；停止时必须先发布同`instanceId`最小tombstone再释放租约。

```bash
pnpm workbench:prepare:code-server
pnpm test:workbench-runtime
pnpm test:workbench-runtime:real
pnpm test:e2e:dsh-workbench-real
```

最后一条是Workbench单独启用、修改或准备提升为稳定能力时的人工完成门，不属于当前通用CI/CD：从空白 Hero 的全局侧边栏入口进入，真实修改隔离 Git fixture，验证 SCM/Diff/Terminal、全部 WebSocket 白名单、Service Worker scope 和零外部 Telemetry。Terminal 使用唯一长寿命 argv canary；隐藏 Surface 和关闭浏览器后它仍存活，Playwright 全部服务退出后的外层 `finally` 再通过正式 reconcile 证明 canary 退出且 `43110/43113/43114/43119` 全部释放。
