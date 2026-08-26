# Chat Session 与轨迹架构

> As-built：2026-08-21。本文是 Chat Session、Run Activity、Trajectory 与 Debug Trace 的唯一边界说明。

## 1. Chat Session 的定义

Chat Session 是用户在 Chat 产品中持续协作的一段完整会话，不等于任一组件自己的 Session 文件。它以
`ProductSessionId`作为产品关联身份，按以下层级组织：

```text
Chat Product Session
├─ DSH interaction session（用户输入、DSH上下文注入、最终显示）
├─ Product Message
│  └─ Product Run
│     ├─ Workflow NodeRun / Decision / Evidence
│     ├─ Planning Attempt
│     │  └─ Agent / Model activity
│     ├─ Execution Attempt
│     │  └─ Pi Operation / Pi Session / Turn / Model / Tool
│     └─ committed Assistant Message
└─ 下一轮 Product Message / Run …
```

“完整”指这些来源可以按稳定身份组合，不表示必须把全部正文复制到同一个日志文件。模型明确输出的可见思考、
回复和工具活动可以成为会话记录；Provider隐藏推理、密钥、完整Provider Payload和未裁剪Workspace内容没有字段通道。

## 2. 五个互不替代的事实层

| 层 | 所有者 | 保存内容 | 不拥有 |
|---|---|---|---|
| DSH Session | DeepSeek Harness | DSH原生输入、请求、上下文注入和最终显示事件 | Product Run终态、Workflow/Pi授权 |
| Product Store | Chat Application | Product Session、Message、Run、NodeRun、Decision、Evidence和正式结果 | DSH/Pi原生事件流 |
| Pi Session / Operation Journal | Pi Executor | AgentSession恢复树、Turn、Provider和Tool执行证据 | 产品会话、产品终态 |
| Run Activity Journal | Chat Realtime | 按Product Run排序、幂等的Agent/Model/Tool可展示活动投影 | Product事实、Debug诊断、隐藏推理 |
| Debug Trace | 各进程 | 命令边界、失败、耗时和诊断关联 | Session历史、Trajectory数据源 |

Vercel Workflow Store另外拥有Checkpoint、重放、Hook与Sleep运行责任；公开轨迹只消费它的脱敏证据投影。

## 3. Run Activity Journal

`packages/realtime/src/run-activity-journal.ts`实现当前单机版本：

1. 每个Product Run独立写入`.data/run-activity/<productRunId>.jsonl`，不会扫描其他Run或全局Trace。
2. `sequence`只在Run内从1递增；`sourceKey`对Workflow重放和Direct Agent重新轮询做幂等去重。
3. Workflow进程是单写者，API进程只异步读取；读取时遇到正在append的未完成尾行会留给下一次查询。
4. 只接收严格白名单的Agent、Model、Tool、可见Assistant片段和生命周期；单个显示字段最多32K。
5. Activity是可重建投影。Run、Node、Decision和正式Message仍从Product Store读取，Pi原始恢复仍使用Pi Session/Operation Journal。
6. API共享增量Reader：文件不变时复用内存投影，增长时只读新增字节；轨迹UI最多发布最近500条完整Agent分组，
   不会因父子截断让Query整体失败。

Planner/Note/Executor既有结构化事件在Workflow组合根同时投影到Activity；Direct Executor事件按其原生Operation
`operationId + sequence`投影。Debug Trace是否启用或清理不会改变Session轨迹。

## 4. Trajectory 是读模型，不是第四份Session日志

`GET /api/runs/:productRunId/workflow-execution-trace`在Principal授权后组合：

1. Product Store中的实际NodeRun、Manifest引用、Decision、Execution Contract/Candidate与正式Message；
2. Run Activity Journal中的Agent、Model与Tool活动；
3. Vercel Workflow的脱敏运行时证据。

Bridge保存`DSH user/message ID → Product Run`关联，DSH Client用公开Conversation contribution把组合结果投影到
原生Trajectory。远端Pi Tool不再伪造成`lifeos_trace`工具调用，也不再向DSH Session追加假的`tool/call`和
`tool/result`。因此刷新可以重新查询投影，DSH原生Session仍只记录它真正执行过的事件。

公开轨迹在原生DSH树中按真实边界分区：`RUN → DSH → BRIDGE → BACKEND → WORKFLOW → NODE → STEP →
AGENT → MODEL/TOOL`。前三段只展示边界身份、Hash和选择摘要；Workflow以下才展示实际NodeRun与Agent活动。
层级来自Bridge绑定、Product事实和Run Activity，不靠时间猜测，也不把Debug Trace反向当成轨迹来源。

兼容接口`GET /api/runs/:productRunId/execution-trace`同样读取Run Activity Journal并提供cursor页，不再读取Debug Trace。

## 5. Debug Trace开关与容量政策

Debug Trace默认完全关闭。只有显式设置`CHAT_TRACE_MODE=errors|full`才创建文件Sink；再用
`CHAT_TRACE_SCOPES=dsh,bridge,api,application,workflow,pi,provider,tool`选择本次需要诊断的模块。未设置Scope时，
已启用模式覆盖全部模块；出现未知模式或Scope时启动失败关闭，不能静默扩大采集范围。`errors`只保留warn/error或
failure/rejected，`full`才记录该模块的完整严格事件。

DSH发送审核、Bridge发送审核和Provider Prompt审核都不等于Trace开关。审核可以开启而Trace保持关闭；仅开启DSH或
Bridge Trace也无需开启审核。DSH/Bridge边界事件只保存ID、Hash与计数，不保存请求正文、用户文本或Prompt Payload。
Trace Reader仍只供调试、Replay和运维工具使用，任何产品Query不得把它放进请求热路径。

新Trace写入每日独立的`*.bounded.jsonl`，默认硬上限16 MiB（`CHAT_TRACE_MAX_DAILY_BYTES`可调整）；到达上限后
只递增丢弃计数并输出一次稳定告警，不影响产品请求，更不影响Run Activity。历史超大Trace保留不删除，但不会继续追加。

## 6. 当前恢复与演进边界

- DSH历史恢复：读取DSH Session，并通过Bridge绑定恢复同一Product Session。
- 产品恢复：Product Store恢复Messages、Runs、Decisions和Outbox。
- Workflow恢复：Vercel Workflow Store恢复Checkpoint/Hook。
- Pi恢复：Pi Session与Operation Journal恢复或按`outcome_unknown`收敛。
- 轨迹恢复：重新组合上述权威来源和Run Activity；浏览器缓存不是事实。

首次升级时，Workflow唯一写者会在对外监听前执行两个一次性、带完成标记的流式迁移：历史Trace只抽取Pi/Provider/Memory
白名单事件，Direct Agent则从Pi原生Operation Journal恢复；原文件不删除。迁移完成后，所有新轨迹只读Activity。

当前传输仍是受控Query轮询；未来SSE只能是同一Activity读模型的增量传输，不能建立新的事实源。当前JSONL适用于单机
单写者；切换数据库时保持Run内sequence、sourceKey幂等和按Run选择性读取合同即可。

## 7. DSH中的Chat Session检查面

DSH原生会话继续负责可发送的对话体验。Client插件额外在对话头部注册“Chat Session”按钮；弹窗与“会话记录”页签
复用同一个`SessionRecordsController`和Bridge双源Query，分别展示Product Session正式消息、DSH Session原始事件及
稳定身份关系。它不是浏览器拼接的新Session文件，也不改变DSH原生Session；任一来源失败只影响自己的分区。

## 8. Workflow选择与一次性建项能力

Bridge v13把两个经常被混淆的作用域拆开，v14为每条Request持久化首次/既有Session提交目标，
v15再为每条Request记录Product Message写边界的耐久状态；当前v16完整保留这些语义，只增加Tool Decision本地重试投影：
`sessionWorkflowSelection`是当前DSH Session草稿，
`newSessionWorkflowPreference`只在另一个会话首次物化时冻结。创建绑定的唯一原语覆盖Prompt、审核开关、请求和
Workflow等所有first-write顺序；当前会话切换不会默认改写以后会话。v1-v7旧状态没有可证明的全局偏好，迁移时
保持`null`，不能从某个Session或JSON对象顺序反推。

Request提交状态只允许以下转换：

- `prepared → outcome_unknown → bound`：新Request先落盘，第一次Product HTTP写前原子标记unknown，合法响应再把
  Product Session、User Message与Run身份一次性绑定；
- `prepared → definitely_uncommitted`：接受HTTP前的DSH/Bridge本地审核拒绝，或Product白名单中明确证明未提交的
  4xx；`outcome_unknown → definitely_uncommitted`只接受后者，unknown阶段的本地拒绝只终止本次重放；
- `bound`与`definitely_uncommitted`是终态，同状态写幂等，所有逆向转换失败关闭。

任一其他`prepared/outcome_unknown` Request都会阻止新消息，因而两个并发或连续DSH消息不能在审核等待、HTTP调用、
响应解析或本地落盘窗口越过A。transport、任意5xx和2xx合同损坏都不能证明未提交，继续保持
`outcome_unknown`；兼容普通/专用种类与first/existing旧Hash域后仍返回的`command_id_reused`，或Message事务前返回的
`policy_denied`，都证明A没有可恢复提交并转为`definitely_uncommitted`。所有v1-v14旧Request只按一条可证明事实迁移：有`productRunId`即`bound`，没有即
`outcome_unknown`；迁移不查询Product、不从`chatSessionId`、JSON顺序、`currentRequestKey`或lifecycle猜测，
也不删除Request、改写冻结payload或制造lifecycle。

“创建项目”仍是普通DSH Session，但附带一次性`projectBootstrapLifecycle`。入口同时冻结：

1. 本次`project_bootstrap` Workflow选择；
2. 结束后要恢复的普通会话Workflow（可以明确为系统默认）；
3. 本次Prompt选择。

生命周期只在`ready`、`rejected`或确定失败时结束，并恢复第2项。后台Operation由Product Store和Outbox持有，
浏览器关闭/刷新不取消它；Bridge页面恢复与下一次发送都会先查询Product事实，因此页面内存、轮询间隔和当前
全局偏好都不能决定恢复结果。Product Store v18升级到v19只扩展Outbox合同；迁移不会替历史queued Operation
补造执行Outbox，也不会在启动迁移时调用Provider；历史`queued/dispatching`由用户在DSH显式触发
“检查并恢复”，Application只创建先对账的新Outbox；当前健康v20中的后台执行和活跃lease由Product Query明确投影为
不可恢复，Client不能仅按Operation status猜测，Retry也不得制造第二条活动Outbox。多Dispatcher以单调fencing
token隔离每个tick的新attempt；当前单API进程再用共享协调器把同一Operation从claim到finalize互斥，token进入
Provider Port并在每个Plane POST与Workspace写边界前重新验证。这样旧执行者在校验后暂停也不能与新attempt并发；
未来多进程数据库必须提供等价advisory lock。v12及更早Bridge数据也不能仅凭Workflow草稿中
`project_bootstrap`推断专用入口；迁移会从会话与新会话偏好移除该能力覆盖，但逐字保留所有冻结Request。
缺少`productRunId`可能是响应未知，Adapter会用原commandId+payload恢复已有Receipt，不能在迁移时改写Hash。
首次消息成功响应携带的Product Session、User Message和Run必须在一次Bridge State原子替换中提交；不能先单独保存
Session再保存Run，否则两次写之间退出会让同一Command重试到不同HTTP路径并改变Receipt hash。
升级前已经留下的v12/v13复合半绑定可能无法只从Bridge State证明原路由，终态lifecycle也无法再证明当时的Command
种类；Application只对已有Receipt采用Store记录的普通/专用Message种类并同时校验两种旧Hash域，legacy已有Session
一律使用既有Session目标，v14则持久保存以后每条Request的精确目标。v15不再依赖一次性lifecycle或Workflow类型
判断并发保护：任何其他`prepared/outcome_unknown` Request都会拒绝不同DSH Message创建第二个Request/Run；只有
白名单内可证明未提交的4xx会转为`definitely_uncommitted`并在适用时退出lifecycle，5xx、transport与2xx合同损坏
仍保留原Request，避免误丢已提交Run。旧unknown重放仍通过当前启用的两层审核；此时本地拒绝不能证明此前未提交，
所以保持unknown。

一次性授权还必须在Product边界可证明：普通Message在Application编译RunSpec后拒绝任何有效
`project_bootstrap`节点，即使能力来自个人Workflow Definition默认值；专用Message Command只接受精确系统
Direct Revision和显式单轮override。Candidate拒绝是纯Product决定，不依赖当时是否仍配置Plane/Workspace Provider。
普通入口的403发生在Prompt/Runtime Adapter读取前；已有专用Message或旧普通Message先按Store Receipt、RunSpec与
Message重建原Command Type/Hash，允许普通/专用Message入口恢复同一已提交结果，但不读取当前Prompt Catalog、Agent
Runtime或Provider。`legacy-planning.v1`历史Receipt可合法只有Message/Run引用：只有该Runner允许缺少
`workflowRunSpecId`；若Run本身仍有RunSpec则以Run引用继续完整校验，若最老v1/v2 Run也没有RunSpec则严格验证冻结的
legacy Runner/View、退役Definition Revision/Hash、Message↔Run↔Session、principal和旧existing-session普通命令
Hash。Receipt一旦携带RunSpec引用就必须与Run精确一致，现代Run缺失该引用仍按Store损坏失败关闭。其他Command类型
仍立即拒绝。Candidate、Confirm、Reject与
Retry的Receipt同样在Provider/Preflight前恢复。Candidate出现前专用Run已经终态时，Bridge将lifecycle收敛为
`failed_terminal`并恢复普通Workflow；rejected且无动作的Candidate不再占据审核Dock。
