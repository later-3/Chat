# Friend 任务（LA2）

任务管理入口是 Friend 设置的“任务”，Agent 使用同源 `task_manage` Tool。任务定义由 Chat 管理；NanoClaw 只保存调度投影、计算到期时间并可靠转交触发。模型执行继续使用 LA1 的独立工作 Session、公共 Pi 装配和实时聊天。长期职责（LA3）用职责归属的推进任务复用本机制：`FriendTask` 可带 `dutyId`，任务定义由[职责服务](./duties.md)派生并按职责状态同步（职责页是这类任务的唯一管理入口）；职责进度、心跳跳过原因与预算见该文档。群聊属于 LA5。

## 操作和场景

- 创建或编辑：名称、任务说明、显式项目（可为空）、一次性时间/周期 cron/可信事件来源、IANA 时区、错过与重叠策略。空项目表示 Friend 自身工作空间，不继承当前网页项目。
- 可选"产物"（LA4）：`deliverable` 声明该任务是站内动态（`post`）或 Workspace 笔记（`note`）并指定槽位（如 `morning`/`noon`/`evening`/`night-note`）与动态受众（`friends`/`self`）。配置后任务发生会获得系统附加的产物提交说明，模型必须用 `artifact_manage` 提交；产物身份、写入/发布与校验按[产物闭环合同](./deliverables.md)执行。受众来自本任务修订，执行中的模型不能改宽。
- 一次性时间必须带 UTC 偏移；cron 按指定时区计算，复用 Nano 的 cron-parser 及原有每日最多 4 次限制。时区修改产生新修订，仅改变未来触发。
- 暂停/恢复/取消任务修改未来触发；不会停止已接受的执行。取消保留定义和历史，不物理删除。已取消定义不可恢复，可另建任务。
- “立即执行”创建一次独立发生记录；暂停的任务也可手动执行。停止某次执行通过 occurrence 定位 LA1 work/turn，不停止主聊或其他任务。尚未分配 work 的等待记录也可以取消。
- 错过超过 5 分钟：`skip` 记录跳过；`latest` 补最新一次，不逐次补齐停机期间的全部周期。DST 完全遵循所用 cron-parser 的当地时间语义，页面不自行算时钟。
- 上一次未结束：`skip` 跳过本次；`queue-one` 最多保留一次等待，更多记录为跳过。每个 Friend 的后台并发容量沿用 LA1 的 4 项；达到容量等待，不占用主会话。
- 事件任务不是自动监视器。受服务认证的调用方提交 `sourceId=<配置来源>:<稳定事件ID>`，由 Backend 校验来源、Friend、Task 修订；文件变化、网站更新等生产者需要显式接入，不由模型自行监听。
- 结果在任务的执行历史中打开原生聊天，复用 Session 事件流；LA1 返回摘要/引用到日常收件位置。任务成功与外部消息投递成功是两件事，渠道投递继续使用既有 Delivery/Ack，不因投递失败重跑模型。

## 合同与持久化

| 对象 | 所有者及实现 |
|---|---|
| Task 定义、不可变修订、Occurrence | `src/long-agents/tasks/`；`CHAT_HOME/long-agents/<id>/tasks.json`，文件锁及原子写入 |
| 调度投影、触发 Outbox、迁移所有权 | Nano `task-projections.ts`；中央 DB 的 `chat_task_owners/projections/outbox` |
| 工作绑定及执行终态 | LA1 `FriendWork`、`AcceptedTurn`、Pi Session；Task 引用，不复制模型状态机 |
| 前端 | `friend-tasks.ts` 运行时响应校验；设置页不计算调度或持有唯一执行事实 |

`GET/POST /api/long-agents/:id/tasks` 使用 `schemaVersion:2`。写操作为 `create/update/pause/resume/cancel/run/cancel-run`；修改要求 `expectedRevision`，create/run 要求稳定 `requestId`，取消正在运行的 work 要求 `expectedTurnId`。浏览器在会话存储中保留未确认的 create/run 命令，刷新后可用同一请求确认，不能为网络重试自动生成新执行。旧 schema 1 写入明确拒绝，需刷新新版页面。

Nano `POST /webhook/chat-backend/v1/task-projections` 为 schema 1，包含 claim/preview/apply/list。应用要求单调修订；相同版本不同内容冲突，重复应用不重置下一次时钟。定义先持久化再应用，应用失败显示“已保存，等待调度”，现有维护循环重试；创建/编辑需要 Nano 完成时间规则校验。暂停/取消已有定义可在 Nano 临时不可用时保存。

Nano 每 60 秒扫描，事务中同时写出 Outbox 和推进下一次时间。它向认证接口 `POST /api/internal/channel/v1/task-triggers` 提交 schema 1 触发，Backend 耐久保存后返回 202；回执必须匹配 occurrenceId。失败保留相同事件退避重试，202 仅表示接收，不代表工作完成。

Occurrence 以 Task、修订、来源、稳定来源 ID 确定身份；同 ID 不同内容拒绝。职责推进的 occurrence 还冻结派发时的职责目标代号与组装好的推进文本（`dutyGoalRevision`/`workText`），使崩溃重试命中同一输入，也让迟到结果按目标代号归档；派发前会重跑职责的确定性前置检查。发生时冻结 Task 文本/项目/策略；获得执行容量时才按公共接受合同冻结 Agent 的有效装配。工作创建请求和来源日常 Session 耐久保存，重启/跨日重试不另建工作。未知运行结果沿用 LA1 的中断终态，不盲目重放工具副作用；可显式立即执行新一次。

## 旧任务迁移及部署

Backend 首次管理或维护每个 Friend 时，先经 Nano 窄 API 领取该 Group 的任务所有权。Nano 先记录独占 owner、保存旧任务不可变快照、暂停旧 mailbox 中的待执行项，再允许 Chat 应用投影。迁移重试读取同一快照；旧 CLI/Management 写入口拒绝修改已被 Chat 接管的 Group，旧 forwarder 不再转发其任务。已被 Chat 接受的旧执行保留；尚未接受的旧 schedule 事件只做移交收尾，不再新起模型。

迁移时已经到期的一次性任务暂停并提示核对旧执行结果，防止移交临界点重复执行；需明确改为新时间后恢复。普通旧任务保留说明、cron/时间、时区和暂停状态。包含前置脚本的旧任务保留在快照，导入为暂停并显示原因；必须显式编辑为模型任务后才能恢复，绝不静默执行宿主脚本或丢弃脚本语义。

新建 Friend 不再暗中创建晨间联系和总结草稿两项 Nano 任务；已有定义通过上述迁移保留。每日原生 Session 的日终总结机制仍独立工作。需要固定提醒或工作，应在任务页明确建立。

这是协调升级：先更新 Nano 源码并运行其正式迁移/构建流程，再启动匹配的 Backend/前端。旧 Host 缺少投影接口时显示迁移待完成，不能声称调度已应用。未完成验证前不要覆盖正在运行的构建；正式环境只按部署文档升级。本次开发验收使用独立 Chat Home、Nano 数据和端口。

## 验证入口

Backend：`test/long-agents/tasks.test.mjs`；Nano：`task-projections.test.ts` 与旧 forwarder/Management 回归；Frontend：`friend-tasks.test.mjs`。完整门禁执行 `pnpm verify`，Nano 独立 typecheck/test/build。真实浏览器及真实模型、重启和失败场景的结果记录在阶段验收文档，不以本设计页替代测试证据。
