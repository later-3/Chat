# Plane CE 项目初始化纵向

> 文档类型：as-built
>
> 固定上游：Plane Community Edition 1.4.1，commit
> `5662b761062b0b2f9d42a6578b55481b5b069792`，AGPL-3.0-only

## 1. 用户结果

用户从 DSH 侧栏点击“创建项目”，进入一个普通新会话。Bridge 为这个会话预选：

1. 内置“项目创建 Agent”Prompt；
2. 现有 Direct Agent Workflow；
3. `project_bootstrap`能力模式。

用户继续用自然语言描述项目。Agent只能调用受控的
`project_bootstrap_prepare`工具生成候选，不能直接创建外部资源。DSH显示候选的Plane
Workspace、Project标识、本地Root、目录和初始Modules。只有用户显式确认后，Application
才会初始化Plane Project和本地Git Workspace。两边都完成并对账后，DSH才显示“进入
Workspace”和“打开Plane”。

这不是特殊Product Session，也不是第二套Workflow。专用侧栏动作只负责把已发布Prompt和
发送级Workflow配置预选到一个普通DSH会话；长期对话、Prompt审核、Direct Agent执行和
Trajectory仍走现有纵向。

## 2. 事实所有权

| 事实 | 唯一所有者 | Chat保存什么 |
|---|---|---|
| Project、Modules、Work Items、状态、成员、进度、面板 | Plane CE | 稳定外部引用和读取快照 |
| 文件、课程材料、笔记、代码、Commit | 本地Git Workspace | 获授权Root与目录绑定 |
| 建项候选、显式确认/拒绝 | Chat Product Store | revision、Hash、Principal和来源Run |
| 外部写入过程 | Chat Product Store | operation、结果未知、错误和对账状态 |
| Product Session与Project/Workspace的关联 | Chat Product Store | Plane Project ID + Workspace Root/目录Binding |
| DSH Session与Product Session的关联 | Bridge Adapter State | 两侧稳定Session身份映射，不复制项目事实 |
| Agent运行、Prompt审核、工具Journal | Chat | 现有Run/Attempt/Trace事实 |

Plane不拥有Chat Session、Run或Agent完成事实；Chat也不复制Plane的项目状态机、看板、通知
或任务CRUD。旧Chat原生Project聚合仍为历史兼容代码，本纵向不双写它，也不把它当Plane
项目的第二真相。

## 3. 运行链路

```text
DSH“创建项目”
  -> 新DSH Session + 固定Prompt/Direct配置
  -> 专用Product Message Command证明一次性bootstrap授权
  -> User与Agent澄清目标
  -> project_bootstrap_prepare（只准备候选）
  -> Product Store Candidate(prepared)
  -> DSH显示可读预览
  -> User confirm/reject
  -> 单一Product Command事务：Decision + queued Operation + pending Outbox
  -> API Outbox Dispatcher（独立于页面/Bridge生命周期）
  -> Workspace Adapter：Root白名单/一级子目录/Git/模板/marker
  -> Plane CE REST Adapter：查询业务键/创建Project/创建Modules
  -> 读后对账
  -> ready Binding
  -> DSH进入Workspace / 打开Plane
```

创建目录和Plane资源是两个不可原子提交的外部副作用。Plane公共REST没有通用
Idempotency-Key或expected revision，因此Application保存operation；Adapter使用
`external_source=chat`与`external_id=<operationId>`查询后创建。网络在写后断开时，操作进入
`outcome_unknown`，不得盲重试；用户点击重试会先按稳定业务键查询和对账。本地目录使用
`.chat/project-bootstrap.json`绑定同一个operation和candidate Hash，避免把已有任意目录误认
为本次创建结果。

只有Workspace和Plane两步都为`completed`时才建立Binding和显示`ready`。失败或结果未知
不会产生假成功。

确认后Bridge不会再调用第二个“execute”路由。Router只终止协议；Application确认事务一次性提交
Decision、Operation与`project_bootstrap_execute` Outbox，随后Dispatcher直接调用Application Worker。
Worker在私有Outbox上以每次tick唯一的attempt Command认领Operation和10分钟执行lease，并把
Operation revision作为单调fencing token写入lease与Receipt。当前Product Store是单API进程唯一写者；同一
Operation从claim到finalize还由共享执行协调器完整互斥。旧执行者只要仍可能恢复就继续持锁，新Dispatcher不能在
“校验后、真实POST前”的暂停窗口接管；进程崩溃后旧代码不可能恢复，进程锁才随之释放。未来若Product Store
升级为多进程数据库，该协调器必须替换为数据库advisory lock，不能退回仅靠超时lease。

fencing token同时进入Provider Port。Application在整个provision前校验一次，Plane Adapter还会在Project POST和
每个Module POST前逐次校验，Workspace Adapter在目录、marker、模板和Git的每个真实写边界前逐次校验并续租。
协调器保证校验与随后的本地/HTTP写之间不会发生另一个attempt接管；旧Claim Receipt也不能重放另一Worker调用的
写前校验。
活跃lease属于正常竞争，第二个Dispatcher只保留pending，不得调用Provider；只有lease过期才把
`dispatching`视为崩溃恢复，新attempt强制先`reconcile`。租约上限高于当前Workspace和Plane
Adapter的有界超时总和；以后Provider若延长运行上界，必须同步调整租约与竞争测试。
用户显式“重试”只创建`mode=reconcile`的新Outbox，且绑定当前Operation revision。
v18遗留且没有执行Outbox的`queued/dispatching` Operation不在迁移时补造副作用；Product Query明确投影
`recovery.canRecover/recovery.reason`，DSH只在该投影允许时显示“检查并恢复”。健康v19后台Outbox或活跃lease不会被
前端猜成遗留恢复。用户显式恢复只创建先对账Outbox。重复确认、响应丢失、页面关闭或刷新都不能产生第二个Operation或
第二次Provider写入。
公开Retry遇到任何活动execute/reconcile Outbox都会返回既有意图，不会再创建第二条活动Outbox；只有旧意图终结后
才能创建新的reconcile意图。

Bridge v13在专用入口冻结bootstrap Workflow及入口前的返回Workflow，v14为每条Request持久化首次/既有Session
提交目标，v15再持久化`prepared/outcome_unknown/bound/definitely_uncommitted`提交状态。普通Workflow写命令在
State和Bridge服务边界都拒绝`project_bootstrap`；Application还会在编译有效RunSpec后拒绝普通Message
携带该能力，包括个人Workflow Definition默认配置且空override的旁路。只有专用Product Message Command、
精确系统Direct Revision和显式单轮override同时成立才会形成bootstrap Run。v12及更早数据不能证明来自
专用入口，迁移时只从会话草稿和新会话偏好移除该高影响覆盖，不制造active lifecycle。冻结Request无论是否已有
`productRunId`都必须逐字保留：缺少该字段也可能是Product Command已提交、HTTP响应在`rememberRun()`前丢失。
Adapter收到首次消息响应后，会把Product Session、User Message和Run在同一次Bridge State原子写中绑定，消除
“Session已记住、Run尚未记住”时重试路径从`/api/messages`漂移到既有Session路由的窗口。
新Request先以`prepared`落盘；DSH/Bridge审核通过后、第一次Product HTTP写调用前，Bridge必须先原子转为
`outcome_unknown`。合法响应还必须证明首轮`Session.sessionId = Message.sessionId = Run.sessionId`且
`Run.sourceMessageId = Message.messageId`；既有Session响应则必须同时绑定请求目标Session和来源Message。验证通过后才在
同一次Bridge写中绑定必要身份并转为`bound`。prepared阶段本地审核拒绝或白名单中
明确证明未提交的4xx才转为`definitely_uncommitted`；unknown重放仍经过当前启用的两层审核，但本地拒绝只停止本次
调用并保持unknown。transport、任意5xx和2xx合同损坏继续保持unknown；兼容旧路由与Message种类后仍返回的
`command_id_reused`证明A没有可恢复提交，按确定4xx收敛。
任何其他`prepared/outcome_unknown` Request都会由State Store串行事务在创建新Request、更新`currentRequestKey`、
查询bootstrap/Run和调用任何Chat Message Command前阻止不同消息；失败事务不改写状态文件。
所有v1-v14迁移只按`productRunId`推导状态：存在即bound，缺失即unknown；不查询Product，不从Session、JSON顺序、
current key或lifecycle猜测，不删除历史Request、不改冻结payload、不制造产品事实。

进程退出矩阵如下；首次Session与existing-session路径共享同一状态机，只使用Request冻结的`submissionTarget`：

| 退出点 | 已提交Bridge状态 | 恢复结果 |
|---|---|---|
| Request原子写之前 | 无Request，且尚未调用Product HTTP | 原消息可重新准备；没有虚构响应未知 |
| `prepared`写入后、审核前/审核中 | `prepared` | 同一A重新审核；任何B在创建Request前被拒绝 |
| 审核通过后、unknown写入前 | `prepared`，且尚未调用Product HTTP | 同上；本地拒绝可证明未提交并转为definitely-uncommitted |
| unknown写入后、HTTP调用前/中/后 | `outcome_unknown` | 只允许原A、原Command、原payload和冻结目标重放；仍经过当前启用审核，B被拒绝 |
| 合法响应后、原子绑定写入前/中 | `outcome_unknown`或完整`bound` | unknown侧由Product Receipt恢复；原子替换不会留下仅Session或仅Run的新半绑定 |
| `bound`写入后 | 完整Session/Message/Run绑定 | 同A只Query原Run；terminal lifecycle后B不被历史Request永久阻塞 |
| 确定未提交写入后 | `definitely_uncommitted` | 同A不再发送；B使用新Command继续 |

`outcome_unknown`阶段再次本地拒绝只停止本次重放并保持unknown，因为旧HTTP可能已经提交；只有Product的确定4xx能从
unknown收敛为definitely-uncommitted。两个并发消息通过同一Bridge原子写队列竞争，先创建的prepared/unknown A会让
另一个B在新增Request、改写`currentRequestKey`和调用任何Chat Query/Command之前失败关闭。正常A先完成原子预留，随后才查询
lifecycle终态；若查询证明终态，只允许仍为`prepared`的A在同一次终态写中恢复入口前普通Workflow，unknown A的冻结payload
绝不改写。
对升级前已经存在的v12/v13复合半绑定，Bridge State本身可能无法逐条证明原路由，lifecycle也可能已先到终态；
Application只在已有Receipt时采用Store记录的普通/专用Message种类，并同时验证首轮与既有Session两个旧Hash域；
普通入口消费专用Receipt只允许既有Session历史恢复，且专用Command Type/Hash与已提交bootstrap RunSpec必须同时证明原授权。
专用入口绝不消费普通Receipt，包括legacy与现代形状；这项种类矩阵在运行依赖前失败关闭。
legacy已有Session一律使用既有Session目标，因此无Receipt时也不会创建第二Session。active lifecycle中已有响应未知
Request时，不同DSH Message会失败关闭，不能覆盖`currentRequestKey`或
创建第二个Product Run；首次Message只有收到白名单内可证明未提交的4xx Problem，才把Request转为
`definitely_uncommitted`并把本地lifecycle收敛为`failed_terminal`。5xx、transport与2xx合同损坏仍保留原Request，
不能假设Product事务未提交。
Adapter会用原commandId和原payload走普通历史路径；Application只在已有Message Receipt时按其原专用种类重放，
没有Receipt的新请求仍稳定403。入口点击先冻结当前Session所属
Workspace，再使用DSH公开`connectWorkspace()`返回的精确Session ID初始化；异步期间的导航不参与判定。
Candidate `ready`、被拒绝或确定失败后
一次性能力终止并恢复原选择；恢复依据冻结值而不是此后变化的新会话偏好。页面轮询只负责及时显示，下一次
普通发送在冻结请求前也会查询Product终态，因此不会继续携带`project_bootstrap`。
如果专用Direct Run在Candidate出现前已经`succeeded/failed/cancelled/outcome_unknown`，Bridge会读取该Run并把
lifecycle收敛为`failed_terminal`，下一条消息恢复普通Workflow。已拒绝且无动作的Candidate不再让审核Dock常驻。

拒绝Candidate是纯Product决定，只依赖Product Store和稳定ID工厂；即使API重启后移除了Workspace或Plane
Provider配置，用户仍能拒绝已准备Candidate并退出一次性生命周期。确认、后台执行和重试才要求Provider存在。
Message Receipt先从Product Store读取首次resultRefs，并用已提交RunSpec/Message与本次输入重建原Command Type和
Hash；显式提交的Definition Hash逐字进入Receipt Hash，只有整个Workflow选择缺省时才补系统默认。匹配时在`now`、ID分配、
Prompt Catalog、Agent Runtime与Provider读取前直接返回。同种类普通/专用入口精确重放；普通入口仅保留上述专用历史恢复，
专用入口遇到普通Receipt及其他Command类型的同ID Receipt立即拒绝。真实v1/v2迁移后的`legacy-planning.v1` Receipt只含
Message/Run引用：仅该Runner允许缺少`workflowRunSpecId`。若Run有RunSpec就以Run自身引用继续完整校验；最老Run同样
没有RunSpec时则验证冻结的legacy Runner/View、退役Definition Revision/Hash、Message↔Run↔Session、principal及
旧existing-session普通命令Hash。Receipt携带RunSpec引用时必须与Run精确一致，任何现代Run缺少该字段都失败关闭。
Candidate、Confirm、Reject与Retry Receipt也都先于Provider、外部Preflight和当前状态校验恢复；Provider检查只在
Store确认这是首次命令时执行。普通Message的bootstrap 403仍位于纯RunSpec编译后、Prompt/Runtime Adapter读取前。

## 4. 配置与权限

启用能力必须同时配置：

- `CHAT_PLANE_CE_BASE_URL`
- `CHAT_PLANE_CE_API_TOKEN`
- `CHAT_PLANE_CE_WORKSPACES_JSON`
- `CHAT_PROJECT_CREATION_ROOTS_JSON`

未配置时普通Chat能力不受影响；只配置一部分时组合根失败关闭。非loopback Plane地址强制
HTTPS。API Token只进入服务端Plane Adapter；浏览器只得到Plane Web Origin、允许的
Workspace slug和无绝对路径的Root描述。目录名必须是安全的单段名称，目标只能是配置Root
的一级子目录。

当前受控写能力仅包含：

1. 创建一个Plane Project；
2. 为项目创建初始化Modules；
3. 创建一级本地目录、受控模板和Git仓库。

Agent没有Plane原始REST、删除、任意PATCH、Shell或任意文件路径能力。后续推进若需要创建
Work Item或更新状态，应以新的窄工具和独立确认/对账合同逐项开放，不能把API Token或通用
HTTP工具交给Agent。

## 5. CE部署与退出路径

仓库的`scripts/plane-ce/lock.json`固定Plane源码、许可证、上游Compose Hash以及全部容器镜像
digest。`pnpm plane-ce:prepare`校验并生成私有的锁定Compose和0600环境文件；
`pnpm plane-ce:up`拉取并启动本机CE。该管理器是本地开发/验收便利层，不是Chat运行依赖。

其他环境可以按Plane CE官方方式独立部署同一固定版本，Chat只通过公开REST连接。迁移环境时
需要迁移Plane自身数据库/对象存储，并把Chat的Base URL、Token和Workspace白名单切到新
实例；本地Git仓库按普通Git方式迁移。Chat没有私有Plane数据格式，也不需要复制Plane前端。

停止本机服务使用`pnpm plane-ce:down`，不会删除`.data/plane-ce`中的卷数据。删除或重建数据
不属于普通停止命令，必须另行人工授权。

## 6. 完成门

1. 合同/Domain/Application/Store测试覆盖：确认前零外部写、Provider缺失仍可拒绝、确认后唯一Binding、结果未知无
   假ready、迁移和引用完整性；两个Dispatcher重叠时只有1次Provider写入，同一Dispatcher过期后形成新attempt，
   写前校验后暂停也由执行协调器阻止并发接管。
2. Adapter测试覆盖：Plane查询后创建/查重/Module对账；Workspace真实Git、幂等marker、路径
   越界和已有目录冲突。
3. API/Bridge测试覆盖：专用Product Message入口预选Prompt和能力、普通override/Definition默认值旁路在Runtime
   故障时仍稳定403、Message Receipt在Catalog/Runtime/Provider移除前重放且错误类型Receipt立即拒绝、
   Candidate/Confirm/Retry Receipt在Provider/Preflight前重放、单Command显式决定、first-write顺序矩阵、
   v1-v14→v15逐字保留响应未知Product payload并仅按`productRunId`迁移提交状态、复合半绑定Receipt跨旧Hash域和
   Message种类矩阵恢复/拒绝、真实v1磁盘legacy Receipt缺RunSpec引用仍在运行依赖前恢复、不同消息不能制造第二个bootstrap Run、
   单对象Schema合法但跨Session/Message/Run身份矛盾的真实Client 2xx响应保留unknown、pending A在全部Chat调用前阻止B且
   状态文件不改写、两个并发消息只有A能到达提交边界、
   白名单确定性4xx（含兼容历史域后仍冲突的Command ID）转为definitely-uncommitted且5xx/transport/2xx损坏仍
   保留unknown、旧unknown重放不能绕过仍启用的两层审核、
   `ready/rejected/failed_terminal`退出、刷新恢复与ready目标。
4. 锁定部署测试覆盖：来源Hash、镜像digest、无`latest`、Compose可解析。
5. 真实CE门：固定容器健康、Web入口可达；提供有效Token后再运行真实创建/对账门。
6. 根级`build`、`lint`、`format:check`、`typecheck`和`test`全部通过。
7. `pnpm test:e2e:dsh-project-bootstrap-real`使用真实DSH Host/Client与确定性Workspace/Plane Provider。
   首轮消息必须真实经过Router/Application创建Product Session、Run与Candidate来源绑定；确定性替身
   只结算该真实Run，不伪造`/api/messages`、Run或Message Query。门同时验证确认后关页仍完成、
   重开仍见目标且下一条普通消息不再携带bootstrap能力；不启动真实Plane或付费模型。

真实创建门是`pnpm test:provider:plane-ce`。它默认拒绝运行，只有显式设置
`CHAT_PLANE_CE_REAL_TEST=1`及专用Project/目录身份后才会产生持久副作用；成功后再次查询
Plane external ID、Workspace marker和Git仓库，不以单次POST响应宣告完成。
