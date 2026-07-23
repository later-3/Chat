# 活动Run重连与通用Execution Worker详细设计

> 状态：D1-D8已于2026-07-23获用户批准；12号迁移、通用Execution Worker、事件游标重连和保守Reconciler纵向切片已实现。
>
> 日期：2026-07-23
>
> 当前目标：活动Run事件游标重连、通用Execution Worker、Worker失联收敛；Tool副作用对账和独立Evidence生命周期仍是后续阶段。

## 1. 先给结论

本阶段不能只在现有SSE上补一个“重连”按钮。要同时增加4个互相独立的能力：

1. **Runtime Job**：说明某个Product Run Attempt当前由哪个执行任务承载。
2. **Run Event Journal**：先持久化可公开AG-UI事件，再交给浏览器；浏览器断开不影响执行。
3. **Cursor Subscription**：浏览器带最后确认游标接回同一个Attempt，补齐缺口并去重。
4. **Execution Worker + Lease**：HTTP进程只接纳请求和订阅事件，独立Worker领取任务、续租并执行MAF Workflow。

这一阶段提供的保证是：

```text
浏览器断开
-> Worker继续
-> 公开事件进入Journal
-> 浏览器按游标补齐
-> Product提交成功后才出现RUN_FINISHED
```

它不会虚构以下保证：

1. Worker死在Provider或外部Tool调用中间时，不能自动断言“没有执行”。
2. 未具备幂等键、结果查询或副作用账本的外部调用不能自动重放。
3. Event Journal是活动运行投影，不是长期Product Message、Trace或Evidence。
4. MAF Checkpoint只说明控制流安全点，不说明外部副作用结果。

## 2. 实施前事实和缺口

### 2.1 已有事实

当前代码已经有：

1. `Product Run`和`Run Attempt`，长期保存接纳、失败、取消、重试和终态。
2. Product Message提交门：Assistant Message和Run成功先落库，再允许发送成功终态。
3. 持久ExecutionDraft、RunSpec、ModelCallDraft/Attempt和Decision/Grant/Consumption。
4. 主Workflow的MAF Checkpoint、Runtime Interrupt Link和Governance Outbox。
5. 独立Outbox Worker可以在另一OS进程恢复已记录的HITL决定。

### 2.2 当前缺口

本次迁移前，在线AG-UI请求仍由HTTP SSE生成器直接驱动MAF Workflow：

1. 浏览器连接和实际执行仍共享一个调用栈。
2. 没有持久的逐事件序号，刷新后只能从Product Trace/Message看终态，不能补流。
3. 没有通用Runtime Job、Worker Lease和Heartbeat。
4. 启动对账会把非审批安全点的遗留活动Run收敛为`interrupted`。
5. 当前Outbox Worker只恢复特定Workflow审批，不是任意Run的通用执行宿主。

## 3. 证据分层

### 3.1 MAF安装版事实

目标项目安装版为：

- `agent-framework-core==1.11.0`
- `agent-framework-ag-ui==1.0.0rc8`

安装版`agent_framework_ag_ui._endpoint`在HTTP响应生成器中直接迭代`protocol_runner.run(input_data)`；可选Thread Snapshot保存最新Messages/State/Interrupt投影，不提供持久事件游标、Job Lease或通用Worker所有权。

因此本阶段必须由Host产品层提供Job、Journal、Cursor和Worker，不能把Thread Snapshot改名当作活动流恢复。

### 3.2 MAF参考源码事实

本地MAF参考提交为`9c4cd07899502157284b64a73f9a0adfb4594d96`。参考源码新增的`agent-framework-durabletask`仍是Beta，需要Durable Task/Task Hub gRPC基础设施。其Workflow流采用轮询Custom Status并在客户端维护累积事件索引，粒度主要是Executor/Yield，不是AG-UI Token级Event Journal。

结论：它证明MAF允许独立耐久宿主，但当前不直接采用。Runtime Adapter必须可替换，使未来可以重新评估，而不是把Beta依赖和外部Task Hub写死进Product合同。

### 3.3 pi事实

固定提交`2b00dade7cec918aefb025c8b7a4fa304a30acdd`中，Agent拥有进程内AbortController、订阅者、steering/follow-up队列和事件生命周期；Session Manager使用追加式JSONL和树结构保存长期会话事实。

采用：事件生命周期必须显式；最终结算不能早于异步监听器完成；长期会话事实与活动运行对象分开。

不采用：进程内Agent对象不能成为Product Run的执行所有者。

### 3.4 nanobot事实

固定提交`2c789767280482f38667044f8a3be5102c71dd26`中，MessageBus是进程内`asyncio.Queue`；AgentLoop显式经历`RESTORE -> COMPACT -> COMMAND -> BUILD -> RUN -> SAVE -> RESPOND -> DONE`，并以Session锁和待处理队列控制并发。

采用：显式阶段、Session准入锁、先持久化再响应。

不采用：内存Queue和活动Task映射不能承担跨进程恢复。

### 3.5 QwenPaw事实

固定提交`2134427584c2657bb717bb083a120f2de011d047`的`src/qwenpaw/app/task_tracker.py`为每个Run保存Task、订阅Queue和事件Buffer；`attach()`回放Buffer后接收新事件，客户端断开只移除Queue，不取消Task。Console路由使用`reconnect=true`接回同一个Task。

采用：断开订阅不等于取消；同一Run只能启动一个Producer；重连先回放再接实时事件。

不采用：Buffer、Task和锁都在单进程内，Run完成即删除，无法跨进程、重启或长期审计。

### 3.6 LibreChat事实

固定提交`8e5ef1fb31e9d63b735c089b21cbc82c50acce46`把长期Conversation/Message与短期Generation Job分开；Redis模式保存Chunk、Run Step和Resume State，并通过Pub/Sub支持跨实例订阅。它还用状态CAS保护HITL Resume，避免两个请求同时驱动暂停的Run。

采用：产品事实与活动Job分开；跨实例重连需要持久Chunk；Snapshot与Subscribe之间的竞态必须封闭；终态前检查当前运行所有权。

改造：Chat使用关系库序号、Run Attempt和Lease Epoch，不复用Conversation/Stream ID，也不把Redis Chunk当Product Message。

不采用：LibreChat的实际生成AbortController和运行图仍留在内存进程里；它没有替本项目提供通用Worker接管合同。

## 4. 五个核心对象

### 4.1 Product Run

长期产品事实，回答“用户这次输入最终发生了什么”。已有对象，不新增职责。

### 4.2 Run Attempt

一次明确执行尝试。重试需要新Attempt；不能通过重置旧Attempt掩盖已经发生过的外部调用。已有对象，后续把`runtime_kind`从`in_process`升级为`execution_worker`。

### 4.3 Runtime Job

一个Run Attempt的短期可领取执行投影。它回答：

1. 等待、执行、等人还是等恢复？
2. 哪个Worker持有Lease？
3. 当前Checkpoint和最后事件在哪里？
4. 当前是否允许安全重新领取？

一个Run Attempt最多一个Runtime Job；真正重试创建新Run Attempt和新Job。

### 4.4 Runtime Event Record

一个已经允许公开给客户端的AG-UI事件Envelope。它拥有Attempt内严格递增`sequence`，先持久化后发布。隐藏推理、未脱敏Provider Body、密钥和内部Traceback不得进入该表。

### 4.5 Runtime Control Command

浏览器或治理流程提交给Worker的持久命令。首批只支持：

1. `cancel`
2. `resume_checkpoint`

断开订阅不是Control Command。后续Steer/Follow-up可以复用同一Inbox合同，但不在本阶段伪装成已实现。

## 5. 候选Schema

以下为审核用逻辑Schema；批准前不创建迁移。

### 5.1 `runtime_jobs`

| 字段 | 约束与含义 |
|---|---|
| `id` | UUID主键 |
| `scope_id` | 必须与Product Session/Run可信Scope一致 |
| `product_run_id` | FK，长期Run |
| `run_attempt_id` | FK + UNIQUE，一个Attempt一个Job |
| `workflow_definition_id/version` | Worker重建正确的根Workflow，版本不匹配不得猜测恢复 |
| `status` | 下述Job状态机 |
| `recoverability` | `safe_requeue/checkpoint_only/outcome_unknown/terminal` |
| `checkpoint_id` | 可空；指向已提交的MAF安全点 |
| `input_ref/hash` | 指向不可变RunSpec/Workflow输入，不复制密钥 |
| `lease_owner` | Worker ID，可空 |
| `lease_epoch` | 每次成功领取递增；所有写入都必须带当前Epoch |
| `lease_expires_at` | Lease到期时间 |
| `heartbeat_at` | 当前持有者最近续租时间 |
| `last_event_sequence` | 已提交Journal最大序号 |
| `earliest_retained_sequence` | 游标过期判断 |
| `available_at` | 延迟重试/恢复时间 |
| `failure_code/summary` | 脱敏稳定错误 |
| `created_at/updated_at/finished_at` | 生命周期时间 |

唯一与索引：

1. `UNIQUE(run_attempt_id)`。
2. `INDEX(status, available_at, lease_expires_at)`供领取。
3. `INDEX(product_run_id, created_at)`供Run工作台。

### 5.2 `runtime_event_records`

| 字段 | 约束与含义 |
|---|---|
| `id` | UUID主键 |
| `runtime_job_id` | FK |
| `run_attempt_id` | 冗余绑定，防错误跨Attempt回放 |
| `sequence` | 从1递增 |
| `agui_event_type` | 标准AG-UI事件类型或显式产品扩展类型 |
| `public_payload_json` | 已脱敏、可授权返回的事件 |
| `payload_hash` | 完整性和去重诊断 |
| `is_terminal` | 终态事件标志 |
| `size_bytes` | 保留策略与容量观测 |
| `created_at` | Journal时间 |

约束：

1. `UNIQUE(runtime_job_id, sequence)`。
2. 一个Job最多一个`is_terminal=true`事件。
3. Worker必须在同一事务中CAS校验`lease_owner + lease_epoch`并递增序号。
4. 高频Text Delta可以在25-50ms或16KiB边界内合并，但合并后的事件仍必须先提交再发布。

### 5.3 `runtime_control_commands`

| 字段 | 约束与含义 |
|---|---|
| `id` | UUID主键 |
| `runtime_job_id/run_attempt_id` | 精确目标 |
| `command_kind` | 首批`cancel/resume_checkpoint` |
| `request_key` | Principal作用域内幂等键 |
| `expected_status/checkpoint_id` | 防止过期命令操作新状态 |
| `payload_json` | 已校验的公开命令参数 |
| `requested_by/scope_id` | 可信身份和Scope |
| `status` | `pending/claimed/applied/rejected/failed` |
| `claimed_by/claimed_at` | 命令领取信息 |
| `result_code/summary` | 处理结果 |
| `created_at/finished_at` | 生命周期时间 |

### 5.4 `execution_workers`

这是运维投影，不是Job所有权源：

| 字段 | 含义 |
|---|---|
| `id/boot_id` | 稳定Worker名 + 每次启动ID |
| `host/pid/version` | 诊断信息，不作为授权 |
| `capabilities_json` | 支持的Workflow/Runtime版本 |
| `status` | `starting/ready/draining/stopped/lost` |
| `started_at/heartbeat_at/stopped_at` | 健康状态 |

Job是否归属某Worker只由`runtime_jobs.lease_owner/epoch/expires_at`决定。

## 6. 状态机

### 6.1 Runtime Job

```text
queued
  -> leased
  -> running
      -> waiting_human -> queued（收到有效Decision和Checkpoint Resume命令）
      -> cancelling -> cancelled
      -> waiting_recovery
      -> succeeded
      -> failed
      -> outcome_unknown

leased --领取后未外发且Lease失效--> queued
running --安全Checkpoint且Lease失效--> queued
running --Provider/Tool可能已外发且Lease失效--> waiting_recovery/outcome_unknown
```

规则：

1. `succeeded/failed/cancelled/outcome_unknown`是Runtime Job终态。
2. `waiting_human`不是终态，必须保留Checkpoint和Decision Request。
3. `waiting_recovery`表示需要Reconciler或人决定，不自动重放。
4. 只有`safe_requeue`或已验证Checkpoint允许原Job重新领取。
5. 新的真实执行重试创建新Run Attempt，不把旧Attempt改回`running`。

### 6.2 Lease

```text
unowned -> claim(owner=A, epoch=1)
        -> heartbeat(A, 1)
        -> release(A, 1)

expired -> claim(owner=B, epoch=2)
old A使用epoch=1写事件或终态 -> CAS拒绝
```

Lease解决“谁还能提交”，不保证能物理停止已经离开进程的Provider/Tool请求。

### 6.3 Cursor

客户端游标是一个不透明、带签名的投影：

```json
{
  "runtime_job_id": "...",
  "run_attempt_id": "...",
  "last_applied_sequence": 37,
  "scope_fingerprint": "...",
  "version": 1
}
```

游标只定位回放位置，不授权。每次订阅仍校验当前Principal、Scope、Product Run和Attempt。

## 7. 端到端运行链

### 7.1 首次发送

1. 前端提交用户消息和当前根Workflow选择。
2. REST/AG-UI入口校验Product历史前缀，并在Product事务中创建Interaction、User Message、Product Run、Run Attempt和Runtime Job。
3. HTTP入口返回`202 + product_run_id + run_attempt_id + runtime_job_id + initial_cursor`，不直接执行MAF。
4. Execution Worker使用原子CAS领取Job并取得`lease_epoch`。
5. Worker加载不可变RunSpec、ContextPackage、Workflow定义和必要Checkpoint。
6. Worker运行MAF Workflow；每个可公开事件经过脱敏映射，进入Event Journal事务。
7. API订阅端先读取`sequence > cursor`的历史，再接后续事件；数据库轮询是首个跨进程唤醒实现。
8. HITL节点先提交Decision Request和MAF Checkpoint，再写公开Interrupt事件；Job进入`waiting_human`并释放Lease。
9. 用户决定先落Product DB；Governance Outbox不再直接运行Workflow，而是幂等写入`resume_checkpoint`Control Command并把Job转回`queued`。
10. Worker重新领取同一Job，验证Checkpoint、Decision binding和Workflow版本后恢复。
11. 正常结束时，在同一数据库事务中提交Assistant Message、Product Run/Attempt成功、Trace和唯一`RUN_FINISHED`事件。
12. 浏览器收到`RUN_FINISHED`后可以立即刷新，REST读取的Product Message与终态必须已经存在。

### 7.2 浏览器断开再重连

1. 浏览器保存“最后成功应用”的游标，不保存权威Run状态。
2. 网络断开只结束Subscription，不发`cancel`。
3. Worker继续写Journal。
4. 重连先查询活动Run，校验返回的Attempt与本地游标一致。
5. 订阅端回放`sequence > last_applied_sequence`，再进入长轮询。
6. 前端按`(attempt_id, sequence)`去重；发现序号跳跃时停止应用并重新补拉。
7. 如果游标早于`earliest_retained_sequence`，服务端返回类型化`410 cursor_expired`，前端改用Product Run/Message/Trace Hydrate，而不是猜测缺失文本。

## 8. 前端交互

### 8.1 Chat区

1. 发送后立即显示“已接纳/等待Worker”。
2. 连接状态独立显示`连接中/已接回/正在补齐/游标已过期`，不能把“断线”显示为“Run失败”。
3. 显式停止按钮创建`cancel`命令；关闭页面、折叠工作台和网络断开都不创建取消。

### 8.2 Workflow工作台

设计者视图增加：

1. Product Run、Run Attempt、Runtime Job四对象映射。
2. Worker ID、Lease Epoch、最后Heartbeat、最后Event Sequence。
3. 当前Checkpoint、安全恢复等级和是否可能已外发。
4. 点击节点查看该节点经过的公开输入、输出和关联事件序号。
5. 重连时节点状态由Journal重放恢复；终态由Product Trace和Run事实Hydrate校正。

### 8.3 客户端状态规则

1. 浏览器保存的Cursor只用于体验恢复，可以丢失。
2. 收到重复Sequence直接忽略；同Sequence不同Hash视为协议错误。
3. 收到新Attempt时清空旧Attempt的活动投影，但保留历史Run查看入口。
4. 终态事件后仍以REST Product Run为最终校验，不能仅凭本地动画宣布成功。

## 9. Worker和Reconciler

### 9.1 Execution Worker职责

1. 注册自身版本和能力。
2. 原子领取兼容Job并周期续租。
3. 构建MAF Runtime Adapter和Workflow。
4. 写入公开Event Journal和运行Trace。
5. 消费Control Command。
6. 在Lease Fence内提交Checkpoint、等待状态和终态。
7. 失去Lease立即停止本地推进；后续写入必被CAS拒绝。

Worker不负责：

1. 自行批准HITL。
2. 修改ExecutionDraft/RunSpec。
3. 把模型文本直接写成长期Memory/Work完成事实。
4. 猜测外部副作用是否发生。

### 9.2 Scheduler/Reconciler职责

1. 找出Lease过期且非终态的Job。
2. 根据`recoverability + checkpoint + external_dispatch_state`分类。
3. `safe_requeue`：转回`queued`。
4. `checkpoint_only`：验证Checkpoint、Workflow版本和Decision后转回`queued`。
5. `outcome_unknown`：转`waiting_recovery`并生成公开处置项，不自动重试。
6. 对齐Product Run/Attempt与Runtime Job，不允许Runtime成功而Product仍永久活动。
7. 标记失联Worker，但不以Worker表单独决定Job归属。

## 10. 与Tool副作用和Evidence的边界

本阶段必须预留但不提前实现：

1. `external_dispatch_state`至少区分`not_started/dispatching/dispatched/result_recorded`。
2. Provider或Tool一旦可能离开进程，Worker失联不能回到`safe_requeue`。
3. 后续Tool副作用对账将增加Tool Call Request、幂等键、外部Receipt、结果查询、补偿和人工裁决。
4. 后续Evidence将独立拥有来源、采集、验证、接受、失效和与Work完成的关联；Runtime Event和Trace都不能冒充Evidence。

## 11. 故障矩阵

| 故障点 | 本阶段动作 | 禁止行为 |
|---|---|---|
| 请求接纳事务前失败 | 不创建Run/Job，不调用模型 | 返回已接纳 |
| Job已创建、Worker未领取 | 其他Worker可领取 | HTTP进程自己偷偷执行 |
| 浏览器断开 | 只移除订阅，Worker继续 | 自动取消Run |
| Journal提交前Worker崩溃 | 未发布该事件；按安全等级恢复 | 发布未持久事件 |
| Journal提交后发布前崩溃 | 重连从Journal补齐 | 重建第二份不同Sequence |
| Worker失去Lease | 旧Worker停止，所有后续写CAS失败 | 旧Worker提交Final |
| HITL Checkpoint提交后崩溃 | Job保持`waiting_human`，用户可跨进程决定 | 把等待当失败或成功 |
| 决定已提交、恢复前崩溃 | Outbox/Control Command幂等重投 | 重复消费Grant |
| Provider发送前崩溃 | `safe_requeue` | 标成`outcome_unknown`拖死 |
| Provider发送后无结果崩溃 | `waiting_recovery/outcome_unknown` | 自动重复付费调用 |
| Product提交失败 | 不写`RUN_FINISHED` | 前端先显示成功 |
| Cursor过期 | 410 + Product Hydrate | 猜测或拼接缺失Delta |

## 12. 测试方案

### 12.1 领域与Repository

1. Job状态机合法/非法转换。
2. 8个并发Worker只允许1个领取成功。
3. Lease Epoch递增；旧Owner事件和终态写入被拒绝。
4. Event Sequence严格递增、重复幂等、同序不同Hash失败。
5. Control Command幂等、过期Attempt拒绝。
6. Cursor签名、Scope、Attempt和保留边界。

### 12.2 进程级故障注入

1. API进程重启，Worker继续，浏览器从旧Cursor补齐。
2. Worker在Provider发送前被`SIGKILL`，新Worker安全领取。
3. Worker在事件持久后、发布前被杀，重连不缺不重。
4. Worker在Provider发送后被杀，Reconciler进入`waiting_recovery`，不产生第二次调用。
5. HITL等待时API和Worker都重启，决定后由新Worker恢复同一Checkpoint。
6. 旧Worker恢复运行后尝试写Final，Lease Fence拒绝。

### 12.3 浏览器E2E

1. 流式中断网、恢复、刷新、多次断连。
2. 两个标签页订阅同一Run，事件一致且不启动第二个Worker执行。
3. 一个标签页显式取消，另一个标签页收到同一终态。
4. 关闭Workflow工作台不取消Run。
5. Cursor过期后通过Product Hydrate得到完整已提交消息和可解释状态。

### 12.4 真实模型

1. 使用现有私有配置发起真实模型回合。
2. 首个Delta后主动断开浏览器连接，保持Worker存活。
3. 等待至少3个Journal事件后重连，验证最终文本、顺序、Hash和Product Message完全一致。
4. 验证Provider只收到1次请求，防止重连触发二次计费。
5. Worker故障测试只在“发送前安全点”自动重跑；发送后故障用可控假Provider验证`outcome_unknown`，不拿真实付费接口制造不确定重复调用。

## 13. 分步迁移记录

1. 已新增Schema迁移、Runtime Service和状态机，未改写Product Run权威事实。
2. 已新增Execution Worker CLI和Runtime Adapter，并用确定性Workflow验证。
3. 已把全部在线AG-UI入口切换为“接纳后入队”，没有保留会与新Runtime竞争执行权的旧路径。
4. 已增加事件订阅/Cursor API和前端回放；浏览器断开只结束订阅。
5. 已把Governance Outbox Resume改为写Control Command，由通用Worker恢复。
6. 已完成进程竞争、浏览器静态投影与真实模型断线验证；剩余故障矩阵见第15节。
7. 下一阶段进入Tool副作用对账；其通过后进入独立Evidence生命周期。

## 14. 已批准决策记录

### D1：Runtime Job与Run Attempt一对一

- 选择A：一对一；重试新建Attempt和Job。
- 选择B：一个Job跨多个Attempt反复重置。
- 建议：A。
- 原因：外部调用、Lease和恢复血缘不会被覆盖；符合现有Product Run/Attempt边界。
- 代价：对象和查询多一层。

### D2：同一Product DB中的独立Runtime表

- 选择A：先使用现有SQLite文件、独立表/Repository和WAL；合同允许未来换PostgreSQL/Redis通知。
- 选择B：现在引入Redis。
- 选择C：直接采用MAF Durable Task/Task Hub。
- 建议：A。
- 原因：当前本地优先、已有同库提交门；A能原子提交Product终态与Terminal Event。B增加双事实协调，C是Beta且事件粒度不满足当前AG-UI需求。
- 限制：SQLite首期按单机和有限Worker并发验收，不宣称横向大规模能力。

### D3：持久化后发布，允许小窗口Delta合并

- 选择A：每个原始Token单独事务。
- 选择B：25-50ms或16KiB内合并公开Delta，批量事务后发布。
- 选择C：先发布、后台尽力持久化。
- 建议：B。
- 原因：保留不丢事件的顺序保证，同时控制SQLite写放大；C会产生浏览器见过但无法重放的幽灵文本。

### D4：数据库回放 + 轮询作为首个跨进程传输

- 选择A：Journal回放加100-250ms自适应轮询/长轮询。
- 选择B：立即增加Redis Pub/Sub。
- 建议：A，保留`EventNotifier`端口。
- 原因：权威事件已经在DB；首期减少基础设施和双写故障。未来可用Pub/Sub只做唤醒，不改变Journal事实源。

### D5：Lease Epoch作为提交Fence

- 选择A：Owner + Epoch + Expires CAS保护每次事件、Checkpoint和终态。
- 选择B：只用Heartbeat超时判断。
- 建议：A。
- 原因：Heartbeat只能发现“可能失联”，不能阻止旧Worker复活后抢写Final。

### D6：浏览器断开与显式取消严格分离

- 选择A：断开只取消订阅；取消必须写Control Command。
- 选择B：最后一个订阅者离开时自动取消Run。
- 建议：A。
- 原因：满足后台继续和多端重连；也避免关闭工作台误杀任务。

### D7：Worker失联后的保守恢复

- 选择A：只在未外发或已验证Checkpoint自动重领；外发结果未知进入人工恢复。
- 选择B：所有超时Run自动重试。
- 建议：A。
- 原因：当前尚无完整Tool/Provider副作用对账，B可能重复写文件、发消息或付费。

### D8：不直接采用MAF Durable Task

- 选择A：当前自建薄Runtime Job/Journal/Worker端口，MAF继续负责Agent/Workflow/Checkpoint。
- 选择B：现在引入`agent-framework-durabletask`和Task Hub。
- 建议：A。
- 原因：目标安装版未包含该包；参考源码是Beta、需要外部基础设施，并未提供Token级AG-UI游标、Product提交门或Tool副作用账本。
- 未来重审条件：需要多主机Workflow编排，且Durable Task版本、部署、事件和HITL合同通过独立Spike。

## 15. 实施结果与当前边界

2026-07-23实施结果：

1. `d84f39e71b20`建立`runtime_jobs`、`runtime_event_records`、`runtime_control_commands`和`execution_workers`；一个Run Attempt只对应一个Runtime Job。
2. 所有AG-UI入口改为“Product接纳 -> Runtime入队 -> Worker执行 -> Journal订阅”；关闭HTTP订阅不再取消执行。
3. Execution Worker支持注册、领取、Lease Epoch Fence、Heartbeat、取消/Checkpoint Resume命令、公开事件持久化和独立CLI进程角色。
4. Runtime Cursor绑定Scope、Job、Attempt和Sequence；前端按Sequence/Hash回放，拒绝缺口和同序不同Hash，并在新Segment的`RUN_STARTED`清除旧Interrupt终帧。
5. Product成功后才允许持久`RUN_FINISHED`；若Worker死在Product已提交与Runtime终帧之间，Reconciler按Product权威终态补写终帧。运行中取消不会发布假成功。
6. Governance Outbox不再直接恢复Workflow，而是写`resume_checkpoint`命令交给通用Worker；独立Outbox Worker与Execution Worker可在不同OS进程工作。
7. 专项10项测试覆盖8 Worker竞争、两个OS进程领取、旧Epoch拒写、双Reconciler竞争、空闲Worker心跳、断线后台继续、Cursor回放、取消、Lease过期和Product/Runtime终态修复；后端100项、前端36项全量测试通过。
8. 真实Provider验证完成一次“审批 -> 批准 -> 主动断开订阅 -> Worker继续 -> Cursor全量回放”：同一Runtime Job共57条事件、唯一终态、Product/Runtime/Provider Attempt均成功。

仍不外推的能力：

1. `external_dispatch_state`目前在AG-UI运行启动时保守进入可能外发，尚未由每个Provider/Tool的持久发送边界精确驱动；这会宁可要求人工处置，也不会冒险自动重放。
2. Event保留和410合同已经存在，但容量清理、真实游标过期、多标签页/换设备完整E2E及Delta批量写优化尚未完成。
3. Provider/Tool外发后的结果查询、幂等Receipt、补偿和人工对账属于Tool副作用阶段；本阶段只收敛为`outcome_unknown`。
4. 独立Evidence、Artifact、Provenance和Delivery生命周期未由Runtime Event替代。
