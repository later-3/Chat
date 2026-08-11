# Chat 本地调试与 Trace

本文说明Chat应用统一的本地启动、VS Code调试、端口与Trace查询方式。
当前运行合同见[统一开发启动与调试任务书](../tasks/app-development-runtime.md)；历史验收背景见
[后端闭环任务书](../tasks/planning-execution-backend-closure.md)。清理只作用于已确认属于本项目的进程，
不使用模糊`pkill`伤害其他应用。

## 1. 固定端口

| 用途 | 地址/端口 |
|---|---|
| Web HTTP | `127.0.0.1:43110` |
| Chat API HTTP | `127.0.0.1:43111` |
| Workflow本地运行时 | `127.0.0.1:43112` |
| memmy HTTP | `127.0.0.1:18960` |
| Tencent MemoryCore HTTP | `127.0.0.1:18970` |
| API Node Inspector | `127.0.0.1:43120` |
| Workflow Node Inspector | `127.0.0.1:43121` |

Vite使用`--strictPort`，API/Workflow端口被占用时进程直接失败关闭，禁止自动换号。
Memory是本地真实依赖，但不是默认调试目标，因此不开放Inspector；日常在Chat自己的API、Workflow和
`packages/memory-runtime` Adapter中设置断点。

## 2. 统一启动入口

仓库拥有唯一服务图，VS Code不拥有应用生命周期：

```text
preflight（清理同仓库已登记/可证明的遗留进程与专属浏览器 + 拒绝其他端口占用）
→ 校验/准备固定Memory源码缓存
→ 构建Workflow Bundles
→ 检查活动Workflow与当前Bundle版本；本地不兼容Run安全收敛
→ 启动所选Memory并逐个等待真实健康检查
→ 启动Workflow并等待/healthz
→ 启动API并等待/api/readyz
→ 启动Vite并等待页面
→ 输出 [chat] ready: http://127.0.0.1:43110/
```

### 2.1 终端

```bash
pnpm dev                                      # 默认启动两套Memory、Workflow、API和Web
pnpm dev -- --memory=memmy                   # 只启动memmy依赖
pnpm dev -- --memory=memorycore              # 只启动MemoryCore依赖
pnpm dev:debug                                # 同一服务图；API/Workflow开放Inspector
pnpm dev:status                               # 查看登记与监听状态
pnpm dev:stop                                 # 安全停止已登记进程
```

`pnpm dev`与`pnpm dev:debug`都调用`scripts/dev/start.mjs`。启动器是本地开发工具，不是生产部署器；
生产环境仍由未来部署编排分别管理Chat进程和外部依赖。

### 2.2 VS Code

唯一入口是 **“Chat：调试应用”**。它直接调用同一个`scripts/dev/start.mjs --debug`，在唯一Debug
Console中汇总带服务前缀的日志；应用输出Ready标记后才启动Chrome。`.vscode/tasks.json`不再存在，
VS Code不复制Memory、Workflow、API和Web的启动/停止合同。

前端通过内联`pwa-chrome`会话启动，固定使用当前worktree的`.data/debug/browser-profile`。启动器会在
服务准备前只查找带这个精确`--user-data-dir`的Chrome主进程，先SIGTERM、再次身份复核后才可能
SIGKILL，并在进程收敛后删除该Profile中的`SingletonLock/Socket/Cookie`和`code.lock`。日常Chrome
没有这个参数，不会成为清理目标。父会话停止时使用`cleanUp: wholeBrowser`和`killBehavior: forceful`
收敛专属浏览器，因此正常停止和下一次F5都不需要开发者手动关窗口。

### 2.3 就绪期限与失败

- Bundle构建后，启动器会比较活动Planning Run的Git、源码Manifest、Bundle Manifest和定义版本。
- 完全一致的Run按Checkpoint正常恢复；历史证据缺失、损坏或Binding不完整仍失败关闭。
- 本地代码已经变化且旧Bundle不可用时，旧SDK Run通过Workflow API取消，Product Run、Attempt和相关Outbox通过Application事务进入`workflow.version_incompatible`失败终态。Message、Plan、Trace、Runtime事件、Binding和版本证据全部保留，不删除`.data`，随后继续启动当前应用。
- 该自动收敛只属于`pnpm dev/dev:debug`；生产环境必须保留历史Workflow部署并把旧Run路由到原版本。
- Memory冷启动期限为180秒；Workflow、API和Web为30秒。
- 期限从对应进程`spawn`成功后开始，不包含前置服务准备时间；这不是业务倒计时，也不重试用户命令。
- 探针每250ms复核进程状态与HTTP；单次HTTP最长1.5秒。进程提前退出时立即失败。
- 任一必要服务失败，启动器停止本轮已启动进程并退出非0，不留下半套应用。
- 固定端口是整个Git仓库的排他资源；从另一个worktree启动时，会先停止同仓库上一轮Chat调试服务。
- PID登记丢失时，只有固定端口角色、命令签名、进程cwd和Git Common Directory四项同时匹配，
  才会被识别为同仓库遗留进程并清理；其他应用仍只报告端口、PID和安全进程名，不自动终止。

### 2.4 进程、缓存与秘密

- 应用监督器是主仓库`.data/debug/pids.json`的正常单写者；同一Git仓库的worktree共享这份固定端口
  登记。终端或IDE强制中断后，下一次status/start/stop会剔除已确认退出或僵尸的记录；活PID仍需
  通过命令片段和启动时间身份复核。
- Memory包装进程收到SIGTERM后向真实子进程转发；安全清理至少等待7秒后才考虑SIGKILL。
- 同一Git仓库的worktree共享主仓库`.data/cache`中经过commit/tree/Hash校验的固定源码缓存；
  Memory数据库、Product Store、Workflow Store和Trace仍保存在各worktree自己的`.data`中。
- `.env`和本地Provider配置由目标进程内部加载，不写入`launch.json`、argv、日志或Git。
- `pnpm dev:debug`只开放API `43120`和Workflow `43121`；Memory第三方进程不开放Inspector。
- `pnpm dev:stop`同时收敛已登记Chat进程与当前worktree的专属调试浏览器；未知浏览器不处理。

保留的低层安全入口：

```bash
pnpm debug:preclean   # 清理并校验冻结端口
pnpm debug:stop       # 停止本轮调试进程
```

## 3. 调试会话与源码归属

选择唯一入口 **“Chat：调试应用”** 后，VS Code会建立三类真正需要关注的调试上下文：

| 调试上下文 | 负责源码 | 常用断点 |
|---|---|---|
| Chrome：`Chat：前端浏览器（内部）` | `apps/web/src/**/*.ts(x)` | React事件、TanStack Query、公开API Client |
| API Node Inspector `43120` | `apps/api`、`packages/application`、`packages/product-store-json` | 公开路由、事务、Outbox、Product Commit |
| Workflow Node Inspector `43121` | `packages/workflows`、`packages/pi-runtime`、`packages/memory-runtime` | Workflow主函数、耐久Step、Hook、Planner/Executor、Memory Adapter |

`autoAttachChildProcesses`会把API和Workflow子进程附加到同一个父调试会话；看到多个Call Stack属于正常现象，不代表启动了多套Chat。memmy和Tencent MemoryCore是真实依赖进程，但默认不开放Inspector，也不需要在第三方服务里单步。

断点文档以“文件 + 函数/路由 + 观察变量”为准，不把会随注释和格式化漂移的行号当合同。VS Code中可用`⌘P`打开文件，再用`⌘⇧O`按函数名定位。

## 4. 规划—确认—执行主链断点

完整数据角色和所有权见[前后端交互：当前实现](../architecture/frontend-backend-interaction.md)。第一次熟悉代码不需要把下表所有断点同时打开；建议按4.1、4.2、4.3分三次走。

### 4.1 用户发送到Plan出现

| 顺序 | 进程 | 文件 | 函数/断点位置 | 重点观察 |
|---:|---|---|---|---|
| 1 | Browser | `apps/web/src/components/RealWorkspace.tsx` | `RealChatPane`内的`send` | `text`、`selectedContext`；这里只提交意图，不创建Message |
| 2 | Browser | `apps/web/src/real/use-real-chain.ts` | `sendMessage`创建`pending`后 | `PendingSend.version/payload/commandId`以及先写Storage、后发HTTP的顺序 |
| 3 | Browser | 同上 | `sendMutation.mutationFn`、`onSuccess` | 请求前的同一`commandId`；响应中的`message`、`run.productRunId` |
| 4 | Browser | `apps/web/src/api/client.ts` | `apiSubmitMessage` | `CommandEnvelope<SubmitMessagePayload>`；201只表示产品事务已提交 |
| 5 | API | `apps/api/src/product-routes.ts` | `POST /sessions/:sessionId/messages`回调 | URL `sessionId`、`envelope.commandId`、严格`payload` |
| 6 | API | `packages/application/src/session-message-use-cases.ts` | `submitUserMessage`的`deps.store.transact` | 同一draft中新建的Message、Product Run、ContextRequest、Workflow Attempt和Outbox |
| 7 | API | `apps/api/src/outbox-dispatcher.ts` | `OutboxDispatcher.tick`、`dispatchStart` | `entry.kind/status/outboxId/productRunId`、`attemptId`、Runtime三态响应 |
| 8 | Workflow | `packages/workflows/src/runtime-server.ts` | `/internal/workflow/v1/start`路由 | `WorkflowStartRequest`、`startClaim`、SDK `run.runId`只进入私有Binding |
| 9 | Workflow | `packages/workflows/src/planning-execution-workflow.ts` | `planningExecutionWorkflow`入口 | `productRunId`、`attemptId`、`maxPlanRevisions`；没有用户正文和Hook Token |
| 10 | Workflow | `packages/workflows/src/workflow-planning-steps.ts` | `compilePlanningInputStep`、`runPiPlannerStep`、`publishPlanReviewStep` | Planning Input Manifest、结构化Plan候选、提交后的Plan/Approval引用 |
| 11 | API | `apps/api/src/internal-runtime-router.ts` | `/publish-plan-review`路由 | Workflow通过私有API回到Application，而不是直接写JSON Store |
| 12 | API | `packages/application/src/plan-decision-use-cases.ts` | `publishPlanForReview` | Plan Hash、Approval绑定以及Run进入`waiting_human/plan_review` |

正常现象：浏览器在第4～6步后就收到201，而第7～12步异步继续。若在API断点暂停时间较长，前端轮询可能挂起或显示连接问题，但不会因此创建第二个Run。

### 4.2 Plan Query回到页面

| 进程 | 文件 | 函数/断点位置 | 重点观察 |
|---|---|---|---|
| Browser | `apps/web/src/real/use-real-chain.ts` | `run`、`plans`、`approval`三个`useQuery`的`queryFn` | 三个Query共享`activeRunId`，但分别读取Run、Plan集合和当前Approval |
| Browser | `apps/web/src/api/client.ts` | `apiGetRun`、`apiGetPlans`、`apiGetCurrentApproval` | 每个响应再次通过公开Zod DTO校验 |
| API | `apps/api/src/product-routes.ts` | 三个`GET /runs/:productRunId/*`路由 | Query只读取Product Store投影，不查询Workflow返回值 |
| Browser | `apps/web/src/workflow/use-workflow-run-view.ts` | `useWorkflowRunView`、`useWorkflowNodeDetail` | `productRunId/nodeRunId/include`、Query Key、AbortSignal；未来SSE只能失效Query |
| Browser | `apps/web/src/components/workflow/WorkflowRunPanel.tsx` | `WorkflowRunPanel`、`chooseNode` | `WorkflowRunViewDto`、`historyCompleteness`、selection；节点从DTO读取，不从phase猜图 |
| Browser | `apps/web/src/workflow/layout-workflow-view.ts` | `layoutWorkflowView`、`linearizedWorkflowView` | 临时LR坐标、loop_back、parentNodeRunId；坐标不得回写服务端 |
| Browser | `apps/web/src/components/workflow/WorkflowNodeInspector.tsx` | `WorkflowNodeInspector` | 当前Tab只加载对应Manifest/Timeline/Evidence；viewHash不一致时失败关闭 |
| Browser | `apps/web/src/components/PlanPanel.tsx` | `PlanReviewContent`、`DecisionBox` | review节点复用唯一表单；Run动作与Approval决定按钮，界面不推导状态机 |

也可以在Chrome Network面板按`/api/runs/`过滤。当前活动Run每1.5秒受控轮询；终态后停止，并最后失效一次Message/Plan/Approval/Context Query。

#### Run Viewer读取与恢复

1. 在`api/client.ts`的`getWorkflowProjection`观察首次200的`ETag`；下一轮相同URL应发送`If-None-Match`，304只能返回此前已通过Schema的内存快照。
2. 在`apps/api/src/product-routes.ts`的`GET /runs/:productRunId/workflow-view`观察公开DTO；响应不得含Workflow Run ID、Hook Token、pi Session、坐标或正文。
3. 快速点击两个节点，在`useWorkflowNodeDetail`和Network面板确认旧请求收到Abort；最终Inspector只能显示最后一次选择。
4. 断网时运行图保留最后一次成功投影并出现“离线·显示上次快照”；恢复网络后Query重新读取，不在前端合并第二套状态。
5. `historyCompleteness=legacy_limited`是诚实的历史缺证据提示，不是`data_inconsistent`。只有`complete`投影的Run终态与Node Run状态矛盾时才停止渲染。
6. 手机宽度默认走`linearizedWorkflowView`；桌面Canvas加载或React Flow故障不应阻止手机从顺序列表进入同一Inspector与审核表单。

### 4.3 修改、批准或拒绝到Workflow恢复

| 顺序 | 进程 | 文件 | 函数/断点位置 | 重点观察 |
|---:|---|---|---|---|
| 1 | Browser | `apps/web/src/components/PlanPanel.tsx` | `requestRevision`、`approve`或`reject` | payload绑定`approvalRequestId + planId + revision + sha256` |
| 2 | Browser | `apps/web/src/real/use-real-chain.ts` | `beginDecision`、`decisionMutation` | `expectedRunRevision`与稳定`commandId`；网络未知时是否保留同一PendingDecision |
| 3 | Browser | `apps/web/src/api/client.ts` | `apiSubmitDecision` | Command Envelope中的CAS revision和Decision payload |
| 4 | API | `apps/api/src/product-routes.ts` | `POST /runs/:productRunId/decisions` | Principal、Envelope、payload三层边界 |
| 5 | API | `packages/application/src/plan-decision-use-cases.ts` | `submitPlanDecision`事务 | Run CAS、Approval三元组绑定、Decision、Plan/Run状态、Resume Outbox原子提交 |
| 6 | API | `apps/api/src/outbox-dispatcher.ts` | `dispatchResume` | Outbox只传Approval/Decision产品引用，不读取Hook Token |
| 7 | Workflow | `packages/workflows/src/runtime-server.ts` | `/internal/workflow/v1/resume`路由 | `approvalRequestId`查私有Binding、`resumeDispatchState`和`resumeHook`结果 |
| 8 | Workflow | `packages/workflows/src/planning-execution-workflow.ts` | `await decisionHook`之后、`loadCommittedDecisionStep` | Hook信号只给`decisionId`；Workflow再次读取并核验已提交Decision |

分支结果：

- `request_revision`：同一个Workflow进入下一轮`for`循环，Plan revision增加，不启动新Workflow。
- `reject`：调用`commitRejectedRunStep`，Run进入`cancelled/rejected`。
- `approve`：进入不可变Execution Contract和执行链。

### 4.4 批准后执行到正式回复

| 顺序 | 进程 | 文件 | 函数/断点位置 | 重点观察 |
|---:|---|---|---|---|
| 1 | Workflow | `packages/workflows/src/workflow-execution-steps.ts` | `compileExecutionContractStep` | 合同引用已批准Plan/Decision/Context和限制，不接受浏览器原始正文 |
| 2 | Workflow | 同上 | `beginExecutionAttemptStep`、`runPiExecutorStep`、`completeRunAttemptStep` | 每个Plan Step独立Attempt、依赖引用、输入Manifest和候选Hash |
| 3 | Workflow | `packages/workflows/src/workflow-result-steps.ts` | `persistExecutionCandidateStep` | Executor输出先成为耐久候选引用，不是正式Assistant Message |
| 4 | Workflow | 同上 | `validateExecutionStep` | 确定性Validation结果与失败项，不依赖模型自述成功 |
| 5 | Workflow | 同上 | `commitExecutionResultStep` | 使用稳定Command ID提交已经验证的候选；失败时不重新调用Executor |
| 6 | API | `apps/api/src/internal-runtime-router.ts` | `/commit-execution-result`路由 | 私有DTO校验后调用Application Product Commit |
| 7 | API | `packages/application/src/commit-runtime-use-cases.ts` | `commitExecutionResult` | 正式Assistant Message和Run`succeeded`在同一Product Store事务提交 |
| 8 | Browser | `apps/web/src/real/use-real-chain.ts` | 终态`useEffect`和`messages` Query | 最终回复来自重新Query的`MessageDto`，不是Workflow函数返回值 |

### 4.5 建议固定在Watch中的身份

| 变量 | 在哪里首次出现 | 用途 |
|---|---|---|
| `commandId` | Web `PendingSend/PendingDecision` | 判断网络重试是否仍是同一意图 |
| `sessionId` | Session Bootstrap响应 | 关联正式消息历史 |
| `productRunId` | Message Command响应 | 贯穿Query、Trace、Outbox和Workflow产品引用 |
| `messageId` | Message事务 | 区分用户正式Message与最终Assistant Message |
| `attemptId` | Message事务创建的Workflow Attempt | 关联Trace和一次Runtime尝试 |
| `outboxId` | Message/Decision事务 | 关联一次Start或Resume派发及对账 |
| `planId / planRevision / planSha256` | Plan Review提交 | 证明用户决定绑定到精确计划版本 |
| `approvalRequestId / decisionId` | Plan Review / Decision事务 | 连接产品审核事实与Runtime私有Hook映射 |

不要把SDK `workflowRunId`、Hook Token或pi Session ID加入前端Watch、localStorage或公开请求；它们只应在Workflow Runtime内部诊断。

## 5. Memory断点顺序

规划召回建议按以下顺序设置断点：

1. `packages/workflows/src/planning-execution-workflow.ts`：`beginPlanningContextStep`调用处，进入Memory节点。
2. `packages/workflows/src/workflow-planning-steps.ts`：`queryMemoryContextStep`，耐久查询Step。
3. `packages/memory-runtime/src/tencent-memorycore-adapter.ts`：`query`中的真实`atomic/search`请求。
4. `packages/workflows/src/workflow-planning-steps.ts`：`runPiPlannerStep`，观察Memory Context如何进入Planner。

显式导入建议按以下顺序设置断点：

1. `packages/application/src/memory-import-use-cases.ts`：`createMemoryImport`，冻结Intent/Result/Outbox。
2. `apps/api/src/outbox-dispatcher.ts`：`dispatchMemoryImport`，派发MemoryImportWorkflow。
3. `packages/workflows/src/memory-import-workflow.ts`：`memoryImportWorkflow`，观察导入/对账分支。
4. `packages/workflows/src/memory-import-workflow-steps.ts`：`callMemoryImportStep`，唯一外部写入Step。
5. `packages/memory-runtime/src/tencent-memorycore-adapter.ts`：`import`中的真实`conversation/add`。
6. 同上：`reconcile`中的L0/L1只读对账。
7. `packages/application/src/memory-import-use-cases.ts`：`commitMemoryImportAccepted`，提交合法accepted。
8. `apps/api/src/outbox-dispatcher.ts`：`superviseAcknowledgedImport`，确认accepted不会被终态监督器降级。

Workflow Step通过tsx解析回TypeScript源码，断点应设置在上述`.ts`文件，不要进入
`.workflow-bundle`或`dist`。第三方Memory进程保持环境隔离，日常排查优先观察Chat Adapter请求与
严格响应分类。

## 6. Project Intake与Advancement断点顺序

先按`.env.example`配置`CHAT_PROJECT_ROOTS_JSON`，只加入你明确允许Chat只读观察的工作区。随后从浏览器切换“建立项目”、选择资源并发送消息，建议按以下顺序设置断点：

1. `packages/application/src/project-use-cases.ts`的`beginProjectIntake`：原子提交Message、queued Candidate和Start Outbox。
2. `apps/api/src/outbox-dispatcher.ts`的`dispatchProjectIntake`：派发独立Project Intake Workflow。
3. `packages/workflows/src/project-intake-workflow.ts`的`projectIntakeWorkflow`：进入耐久建项链与Hook等待。
4. `packages/workflows/src/project-intake-workflow-steps.ts`的`prepareProjectCandidateStep`：Workflow到API私有Command边界。
5. `packages/pi-runtime/src/project-intake-understanding.ts`的`understand`：pi与当前服务端Model Profile的真实模型调用。
6. `packages/project-runtime/src/registry.ts`的`observe`：允许根内Git、治理文档和脚本清单观察。
7. `packages/application/src/project-use-cases.ts`的`prepareProjectCandidateForReview`：模型理解、资源证据与Domain规则编译Candidate。
8. 同文件的`decideProjectCandidate`：用户确认后原子提交Project账本和Resume Outbox。

项目建成后，从浏览器切换“管理项目”发送待办、决定或贡献，可在`beginProjectManagementCandidate`和`decideProjectManagementCandidate`断点观察“正式Message → 可修改Candidate → 确认后单一账本事实”。这条简单确定性链不调用模型，也不启动额外Workflow。

### 6.1 从前端调试Project推进

在页面先选择Project，再切换“推进项目”并发送阶段目标/关键结果。建议按顺序设置以下断点：

1. Browser `apps/web/src/components/RealWorkspace.tsx`的`send`与`ProjectPanel`：观察显式`advance`模式、可编辑`advancementProposal`，页面不携带Provider/模型。
2. Browser `apps/web/src/real/use-project-chain.ts`的`beginAdvancement`、`decideAdvancement`：观察`activeProjectId`、Candidate `revision/candidateSha256`和每次新Command ID。
3. API `apps/api/src/product-routes.ts`的`POST /project-advancements`：公开strict payload只含Session、Project和正文。
4. API `packages/application/src/project-advancement-use-cases.ts`的`beginProjectAdvancement`：同一事务里的Message、queued Candidate、Receipt和Start Outbox。
5. API `apps/api/src/outbox-dispatcher.ts`的`dispatchProjectAdvancement`：只派发产品Candidate引用，不把正文或模型配置发给Runtime。
6. Workflow `packages/workflows/src/project-advancement-workflow.ts`的`projectAdvancementWorkflow`：观察Candidate ID/revision、Hook等待与恢复。
7. Workflow `packages/workflows/src/project-advancement-workflow-steps.ts`的`prepareProjectAdvancementCandidateStep`：Workflow到API私有Command边界。
8. API/Workflow `packages/pi-runtime/src/project-advancement-understanding.ts`的`understand`：观察服务端Model Profile、一次Provider调用和strict工具候选；不要把Prompt或工具参数加入Watch日志。
9. API `packages/application/src/project-advancement-use-cases.ts`的`prepareProjectAdvancementCandidate`：观察输入manifest Hash、模型证据和`under_review` Candidate编译。
10. 同文件的`decideProjectAdvancementCandidate`：观察旧revision/Hash 409，以及确认时Decision、Stage、Milestone、Project Update、Project revision和Resume Outbox的一次原子提交。
11. 同文件的`transitionProjectStage`、`transitionProjectMilestone`：观察Domain转换规则、Decision/Evidence要求和严格`ProjectStateTransition`历史。

建议Watch：`projectCandidateId`、`boundProjectRevision`、`boundStageRevision`、`boundMethodSha256`、`candidateSha256`、`projectStageId`、`projectUpdateId`和`outboxId`。Workflow Run ID与Hook Token仍只在Runtime私有调试上下文中查看，禁止加入浏览器Watch或公开响应。

## 7. Trace 查询

Request ID规则：API不信任客户端`x-request-id`，只有通过受限Schema（`req_`前缀）
的传入ID才被复用，否则生成新的服务端ID；响应头始终返回最终生效ID。
Trace写入失败不影响业务响应，但会计入内部故障计数并输出不含事件内容的稳定错误日志。

Trace按任务书§7.2写入`<仓库根>/.data/traces/chat-trace-YYYY-MM-DD.jsonl`
（一行一个JSON对象，UTC日期切分；`.data/`不进入Git）。

```bash
pnpm debug:trace --run run_xxx        # 按Product Run重建时间线
pnpm debug:trace --request req_xxx    # 按请求
pnpm debug:trace --command cmd_xxx    # 按命令
```

- 输出：stdout为严格合同校验通过的JSONL事件（按timestamp+文件+行号稳定排序），stderr为摘要。
- 退出码：0成功（含0条）、2用法错误、3读取或校验失败。
- 读取失败关闭：损坏行或不符合严格合同的事件（含旧版任意`attributes`事件）报告文件与行号，**绝不修改原始JSONL**。
- 内容边界：Trace合同是以`eventName`判别的严格联合，不存在任意`attributes`内容通道；
  HTTP只记method/route template/status，Provider只记模型、请求ID、耗时与Usage等白名单字段，
  正文、密钥、Prompt与Provider Payload在结构上无法写入（不是写入后脱敏）。
  完整历史回放（组合Product Store正文）属B7的`pnpm debug:replay`，见任务书§7.5。

## 8. Trace实现边界

- API、Application、Outbox、Workflow、Hook、Provider/pi、Memory、Validation和Product Commit均已产生严格Trace事件。
- API使用`@chat/realtime`提供的唯一Trace Sink；Workflow进程也通过相同严格合同写入当前worktree的Trace目录。
- 事件名及允许字段在`packages/contracts/src/trace.ts`冻结；新增事件必须先扩展判别联合和测试，不能临时塞任意`attributes`。
- 当前前端仍使用Query轮询；Trace不是浏览器实时协议，也不能替代Product Store正文。

## 9. 端口冲突报告的安全边界

- 进程身份复核在内部使用完整命令行片段（防止PID复用误杀），但不输出到报告或Trace。
- 面向用户的端口冲突报告只包含：端口、PID、可执行文件basename（如`node`）。
- 未知进程的完整argv可能含其他应用的Token、密码或私有路径，绝不输出。
