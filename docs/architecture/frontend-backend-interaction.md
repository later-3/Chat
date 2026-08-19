# DSH前端与Chat后端交互

> 文档类型：当前实现（as-built）

## 1. 拓扑

```text
Browser
  -> LifeOS Web Gateway（127.0.0.1:43110）
  -> DSH Web Host（内部43114）
     -> DSH原生Client插件图
     -> LifeOS Client插件（Workflow选择、Plan/HITL、Note审核、原生Trajectory、Workbench表面）
     -> LifeOS Host插件（LLM Adapter、同源桥接路由）
        -> Chat Hono API
           -> Application
              -> Product Store + Outbox
                 -> Vercel Workflow -> pi-agent-core
```

浏览器只访问DSH Host的同源页面和LifeOS桥接路由。Client插件不读取Chat私有存储、不调用Workflow/pi，也不知道Workflow Run ID、Hook Token或pi Session ID。

## 2. 会话身份

DSH原生界面创建自己的`dshSessionId`。Host插件把它映射到一个`productSessionId`，映射只保存在本地Adapter状态中：

- DSH Session负责原生会话选择、消息轨迹和Composer体验。
- Product Session负责权威消息、Run、Plan、Approval、Note Candidate/Decision和恢复。
- 映射不能作为授权；每次Chat请求仍经过API认证与合同校验。
- 映射或响应结果未知时，桥接层必须保留稳定命令身份并查询恢复，不能静默创建第二个Product Session或Message。

## 3. 发送链

1. 用户可在DSH原生Composer工具行的`conversation.input.left`公开Slot选择已发布Workflow；
   选择只是会话草稿，不创建Run，也不把Workflow Runtime身份暴露给浏览器。
2. 用户在DSH原生Composer提交消息。Bridge把该次发送冻结到选择的Definition revision与SHA；
   没有显式选择时使用Chat系统默认Planning Workflow。
3. DSH用固定`lifeos/workflow`模型调用LifeOS `LlmAdapter`，传入DSH Session和消息历史。
4. Adapter从本轮请求提取最新用户文本；`session-title`和`compaction`用途绝不写入Chat。
5. Adapter取得或幂等创建Product Session，以稳定`commandId`提交`POST /api/sessions/:id/messages`。
6. Chat在Command边界重新校验Workflow仍是已发布、active、当前Principal可用且Hash一致，再原子提交User Message、Product Run、Receipt和Workflow Start Outbox。
7. Adapter轮询公开Run、正式Message和安全Pi执行轨迹；Bridge投影按Run阶段读取Plan/Approval或Current Note Candidate，并读取完整Workflow执行轨迹。所有读模型都不从HTTP超时推断成功。
8. Run需要人工决定时，Client插件展示当前Plan/Approval或Note Candidate；用户的修订、批准、确认或拒绝经Host桥接为版本/Hash绑定的Chat Command。
9. 执行中出现Pi工具intent时，Adapter先发出`lifeos_trace`显示调用；DSH原生Trajectory立即显示running，显示工具等待同一`toolCallId`的Trace结果后落下输入、输出和耗时，绝不再次执行命令。
10. Run成功后，Adapter读取Product Store中的正式Assistant Message，并作为DSH文本流返回。DSH将它写入原生会话轨迹。

DSH显示出来的Assistant文本是Chat正式事实的副本，不是模型直接输出。Run失败、拒绝或结果未知必须返回明确状态，不能生成假交付。

## 4. 公开Chat API

主链使用：

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/sessions` | 幂等创建Product Session |
| `POST` | `/api/sessions/:sessionId/messages` | 幂等提交Message并创建Product Run |
| `GET` | `/api/workflow/definitions` | 读取当前Principal可用的active published Workflow |
| `GET` | `/api/sessions/:sessionId/messages` | 读取正式Message |
| `GET` | `/api/runs/:productRunId` | 读取Run状态、阶段与revision |
| `GET` | `/api/runs/:productRunId/execution-trace` | 读取Principal授权且脱敏的Pi执行轨迹cursor页 |
| `GET` | `/api/runs/:productRunId/workflow-execution-trace` | 读取Workflow节点、Vercel Runtime证据与Pi活动的脱敏聚合投影 |
| `GET` | `/api/runs/:productRunId/plans` | 读取Plan revisions |
| `GET` | `/api/runs/:productRunId/approvals/current` | 读取当前可操作Approval |
| `POST` | `/api/runs/:productRunId/decisions` | 提交版本/Hash绑定的决定 |
| `GET` | `/api/runs/:productRunId/note-candidates/current` | 读取当前安全Note Candidate审核DTO |
| `POST` | `/api/runs/:productRunId/note-decisions` | 提交Candidate版本/Hash绑定的Note决定 |

字段真相以`@chat/contracts/public`的Zod Schema为准。Host插件必须运行时解析外部响应，不能用TypeScript断言跳过校验。

## 5. Command与恢复

所有写请求使用稳定`commandId`；修改已有事实时还携带`expectedRevision`。Plan Decision绑定Approval、Plan ID、Plan revision和SHA-256；Note Decision绑定Candidate ID、revision和SHA-256。

桥接状态至少记录DSH Session映射、当前Product Run、发送/决定Command身份及最后已确认阶段。v4状态分别保存Plan与Note的pending command、原生轨迹显示cursor且禁止两个pending决定并存。写状态使用原子替换。发生请求已发但响应丢失时，只允许相同命令和内容原样重试或Query恢复，不生成新身份。

## 6. DSH插件表面边界

LifeOS Bridge是仓库内唯一DSH插件包，所有新增前端表面使用固定rc.6公开合同：Workflow选择器注册在
`conversation.input.left`，与权限、模型等原生Composer工具同一行；Plan/HITL与Note Candidate审核使用
`conversation.input.dock`；Workbench入口使用`sidebar.footer.action`，Surface使用`shell.overlay`。
审核Dock是临时命令表面，不是Run状态看板：只有当前Plan与开放Approval版本/Hash一致且Run正在等待
计划审核、当前Note Candidate仍可审核，或存在结果未知且必须原样重试的决定时才显示。决定被Chat确认后
Dock立即退出Composer；已批准、确认、修订或拒绝的历史由正式消息和Trajectory承载，不用常驻卡片重复展示。
执行轨迹不创建第二个页面：Bridge保存真实的`DSH user/message ID → Product Run`绑定，Client
从同源Query读取公开轨迹。State-only Definition在原生`user/message`处恢复绑定；可见的
`lifeos-execution-trace` Definition在随后同一轮的`request/header`处读取该绑定，并把调用树贡献到
`trajectory` target的真实Step Location。DSH的原始顺序因此保持为
`SYSTEM/USER/CONTEXT → WORKFLOW → ASSISTANT`，整个过程不追加或伪造DSH Session事件。
每一层继续使用原生`ToolCallBlock.subCalls`。固定rc.6窄扩展保留独立Tool contribution的
Conversation Location，并允许贡献方提供表现标签和紧凑行预览；原始`argsRaw`与Tool Result仍进入
DSH原生检查器，底层仍是原生`TOOL/SUBTOOL`种类、颜色、折叠、计时和检查器。Bridge显示
`WORKFLOW/NODE/STEP/AGENT/MODEL/TOOL`标签，并在自己贡献的Tool名称中增加
`├─/└─/│`树线，恢复`Workflow节点 → Agent → 模型/工具`的可见深度；它不读取、选择或修改DSH DOM，
也不复制或替换Trajectory组件。Pi行使用角色限定的
`规划/执行 Agent`标签；终态摘要直接显示模型/工具次数、模型输入/输出/总Token和耗时，不再以空结果呈现。
节点详情来自Product Store和严格Trace已经保存的事实：真实用户消息、Plan/Approval/Decision、Execution
Contract/Candidate、Validation与正式结果按Manifest引用解析；动态Execution Step由既有Contract、Attempt和
Candidate组合。列表只显示摘要，点击原生行后查看完整输入/输出；它不新增Prompt快照，也不声称这些事实是
Provider原始Payload。Pi Attempt通过既有Attempt ID显式绑定Workflow NodeRun和Execution Step，不按时间猜父子关系。
DSH Trajectory只投影这一套实际Workflow NodeRun及其Pi子过程。公开DTO仍保留脱敏Vercel
Run/Step/Hook/Sleep运行时证据供后续诊断或证据表面使用，但Bridge不把它与Workflow节点混排，
也不使用`Chat Workflow`或“业务节点”制造第二套流程概念。

时间戳默认保持紧凑。Client插件通过公开`conversation.session.header.utilities`加法Slot注册“时间”开关，
偏好由DSH公开Snapshot Store保存在浏览器本地；开关只让Conversation Definition按同一Trace重新投影，
不追加Session事件、不改Chat事实。开启后每行结果显示浏览器本地开始/结束时间，运行中行显示开始时间；
无论开关状态，展开原生详情始终可查看ISO开始/完成时间、DSH本地化Timing、审核决定、状态和严格白名单Payload。
DSH派生改动只允许存在于单独固定分支和仓库内可审核的pnpm补丁：当前仅涉及Contribution Location、
语义标签与紧凑行预览三个通用字段。不得复制DSH源码、重写Trajectory页面，或把完整Hosted App拆成自研React组件。

插件优先不等于插件能够改写全部宿主语义。rc.6公开Contribution已经携带Location，却没有在Trajectory
快照与layout中保留、消费独立根调用的Location；标签也固定为`TOOL/SUBTOOL`，完整Payload还会占满列表行。
LifeOS插件因此不能在不伪造Assistant事件、不操作DOM、不复制Trajectory组件的条件下同时得到真实Step顺序、
业务标签与“摘要列表/完整详情”的分层展示。Chat据此批准
独立公开DSH窄派生；修改仍是通用Contribution能力，Chat业务对象和产品事实继续全部留在Bridge与Chat后端。
详细决策、公开派生仓库与上游汇合流程见[DSH前端派生与维护](./dsh-frontend-maintenance.md)。

### 6.1 DSH注入的Context

DSH仍提供Host、Session、事件日志、Agent loop请求组装与插件运行时；Chat只替换了模型/业务执行出口，不能笼统
描述为“完全不用DSH后端”。默认base bundle会在真实User之后依次记录工作区`AGENTS.md`指令、DSH沙箱/审批
运行快照和Skill Catalog三类Context。它们分别来自`dsh-agent-instructions`、`dsh-system-prompt`与
`dsh-tool-skill`，不是PWA插件或Chat Workflow节点。LifeOS Adapter只提取`source.kind === "user"`的真实用户消息，
三类Context不会提交Chat Message、不会进入Planner/Executor，也不会产生第二套执行。精确来源和去向见
[DSH前端派生与维护](./dsh-frontend-maintenance.md#5-user之后的三条context)。

## 7. Workbench边界

Code Workbench不是Chat API或某个Chat Session的一部分。Client插件把唯一入口注册到DSH公开的`sidebar.footer.action` root list slot，因此空白Hero也可直接打开全屏Surface；不得再在Session Header注册第二个入口。统一启动器管理固定版本code-server。code-server只监听受管0700临时根内的0600 Unix socket；Web Gateway把`localhost:43110/workbench/code/`的HTTP与任意WebSocket代理到该socket，并拒绝该虚拟Host访问DSH与`/lifeos`。浏览器没有可直连的code-server TCP地址，因此DNS rebinding不能绕过Gateway取得Files或Terminal。返回对话只隐藏Surface，不卸载iframe和终端连接。

code-server拥有编辑器临时状态和Workspace内进程，不拥有Chat Session、Run或完成事实。当前是本机单用户能力：清洗环境和隔离HOME不等于OS沙箱，Terminal与扩展仍拥有当前用户的主机权限；第三方扩展必须视为高权限代码，远程或多用户场景必须改用容器/独立UID Provider。

真实完成门无条件记录浏览器全部WebSocket，不能在监听阶段先过滤。白名单只有两类固定源码路径：DSH主源`127.0.0.1:43110`的`/api/events.mux`或`/api/events.host`，以及Workbench隔离源`localhost:43110/workbench/code/stable-<固定commit>`；两类必须分别至少出现一条，其他origin/path一律失败。Terminal生命周期证据是当前用户拥有的`0600`文件，包含唯一argv canary、PID、完整命令、OS启动时间、cwd、code-server child与`instanceId`，任何PID复用或身份偏差都失败关闭，且不向无法证明身份的进程发送信号。

## 8. 调试入口

- 实例、端口与数据隔离：`scripts/dev/runtime-instance.mjs`
- 服务图与生命周期：`scripts/dev/app-runtime.mjs`
- DSH Host/Client桥接：`packages/dsh-lifeos-bridge`
- Execution Trace聚合：`packages/application/src/execution-trace-use-cases.ts`
- Vercel World脱敏投影：`packages/workflows/src/runtime-trace-projection.ts`
- DSH启动与Profile：`apps/dsh-web`、`scripts/dsh`
- Workbench运行：`scripts/workbench`
- Chat公开路由：`apps/api/src/product-routes.ts`
- Message用例：`packages/application/src/session-message-use-cases.ts`
- Decision用例：`packages/application/src/plan-decision-use-cases.ts`
- Workflow：`packages/workflows`
- pi Adapter：`packages/pi-runtime`

production与VS Code debug的固定端口、独立事实路径和命令见[本地调试](../debug/local-debug.md)。
