# Friend 长期职责（LA3）

长期职责是持续负责的工作目标：目标、授权范围、资料、进度证据、下一步与推进节奏保存在 Chat，推进经 LA2 任务/触发进入 LA1 独立工作 Session 与公共 Pi 装配。本文是职责领域的技术合同；机制边界见[机制合同 §9.4](./chat-long-agent-mechanism-contract.md)。职责不是第二套任务状态机：调度、发生记录、执行容量与回执全部复用 `src/long-agents/tasks/` 与 `src/long-agents/work.ts`。

## 对象与生命周期

| 对象 | 实现 |
|---|---|
| Duty 定义与修订 | `src/long-agents/duties/`；`CHAT_HOME/long-agents/<id>/duties.json`，文件锁与原子写入 |
| 推进任务（派发与调度） | 复用 LA2 Task；FriendTask 增加可选 `dutyId` 链接 |
| 推进执行 | LA1 `startFriendWork`，requestId=occurrence id；独立原生 Session |
| 进度、证据、回执 | Duty 记录内嵌 `progress[]` 与 `advancements[]` |

- 两个版本号分开：`revision` 是并发版本，每次持久化变更都 +1，用于 `expectedRevision` 冲突保护；`goalRevision` 是目标代号，只在目标/授权范围字段（objective、materials、outcome、totalUnits、contextProjectId）变化时 +1。进度归属与 superseded 按 `goalRevision` 判定；暂停、恢复、结束、节奏、时区、预算、名称等生命周期与配置变更只提升 `revision`，**不重置进度、下一步、下次检查时间与当日预算**。
- 旧数据读取迁移（可重复、不删历史）：按 entry 存的 `dutyRevision` 迁移为 `goalRevision`；保留已有 `unitsDone`/`nextStep`/`nextCheckAt`，缺少完成量指针时保留未知（null），不从未核验历史推算。**缺少 `applied` 的旧条目一律迁移为 false**，即使完成量、下一步和检查时间都相同，也不能证明摘要和证据曾被应用。新格式显式标记保持不变；下次现有原子写入会持久化迁移标记，重复加载/写回稳定，不修改原记录内容或物理删除历史。
- 未核验条目仍可在进度历史中查看，但不进入模型的摘要、已覆盖材料或其他当前依据。已有历史而缺少有效依据时，模型明确得到“依据待核验”的提示，保留当前计划并先核对资料，不把它误认作第一次学习。用户可经现有 Web/主聊纠错提交核实后的新记录，新的 CAS 写入才成为有效依据。旧格式无法无损恢复应用关系，这是明确的兼容限制；不通过匹配指针或挑选最新条目猜测。此迁移不会反推修复之前错误迁移后已写成显式 true 的记录，若存在这种数据，应逐条核验后纠错。
- `status: active | paused | ended`。`paused` 只阻止未来自动推进（关联任务同步暂停）；手动"立即推进"仍可，在途执行不取消，单次停止走任务 `cancel-run`。`ended` 是终态：保留全部修订与历史，不可恢复；继续同类工作须新建职责（新 `dutyId`）。子任务或单次推进完成不自动结束职责；结束只能显式发起并记录。
- 等待不属于启停：缺资料（`awaitingMaterial` 或资料列表为空）、未到 `nextCheckAt`、预算耗尽、失败都作为推进前置检查的跳过原因持久在 occurrence、职责状态与页面中。

## ID 与去重键

`dutyId = duty-<hash(agentId,requestId)前32>`；推进键 = occurrence id（`occ-<hash(taskId,revision,source,sourceId)>`），同时是 work 的 `requestId`；进度提交键 `progressId = prog-<hash(dutyId,advancementKey)>`。同一次推进只产生一条进度记录：**同键同载荷是幂等重试，同键异载荷是冲突（409），不静默覆盖**；纠正请用新的请求键（用户纠正或主聊纠错各有一条独立记录，历史保留）。执行回执同键记录，不重复累计。

`report` 的来源绑定由服务端推导，模型不能伪造：

| 来源 | 绑定 | 归属目标代号 |
|---|---|---|
| 职责推进的后台工作 | turn→work→occurrence，且 `occurrence.definition.dutyId` 必须是本职责、`occurrence.workId` 必须等于该 work | `occurrence.dutyGoalRevision`（执行时冻结） |
| 日常主聊（Agent 管理纠错） | turn 存在且没有 workId，键为 `chat:<requestId>` | 当前 `goalRevision` |
| 用户 Web 纠错 | 键为 `user:<requestId>` | 当前 `goalRevision` |

迟到结果按执行时冻结的目标代号归档：不覆盖当前 `nextStep`/`awaitingMaterial`/完成量，只作为该代的历史（读取时标 superseded）。他职责的推进、普通后台工作、未知执行上下文都不能给本职责报告。

## 推进前置检查（模型调用前，确定性）

同一组检查在**耐久接受时**和**真正派发前**各执行一次（容量等待、重启或目标变化后不能沿用旧判断）；任一不满足则 occurrence 记为 skipped 并写明原因，不创建 Session、不调用模型：

1. 职责 active/未结束（`paused`/`ended` 的自动触发跳过；manual 触发不因暂停被挡，结束仍挡住）。
2. 到下次检查时间：`nextCheckAt` 在未来时自动触发跳过（`manual` 显式推进不受该门槛限制）。
3. 允许时段：`allowedHours`（duty.timeZone 本地小时 0–23，null 为全天）。
4. 资料可用：`materials` 非空且未置 `awaitingMaterial`。
5. 预算：`budget.tokensPerDay`（自然日，按 duty.timeZone，跨目标代号累计）；计量来源是推进 work 原生 Session 中该 turn 起点之后 assistant `usage.totalTokens` 累加，在终态回执时落账。已计量 ≥ 上限时自动推进跳过。这是启动前软上限：不中断在途执行；手动推进允许但记录超额。界面与文档说明该实际控制能力，不宣称精确硬上限。
6. 计量完整性：接受与派发前都先刷新消费账本（把已结束但未入账的执行补记），所以触发直达派发与维护派发看到同一份计量；计量读取失败时**不记零**，留待下次补记，并在设置了预算时暂不自动推进（原因"推进计量待恢复"）。只有原生 Session 已不可读时才按零入账。

派发前若 `occurrence.dutyGoalRevision` 与当前 `goalRevision` 不一致，旧推进以"目标已修订"跳过，不执行冻结的旧文本。

## 推进节奏与自主下一步

- `cadence: cron` 时关联任务是周期任务，`nextCheckAt` 作为自动推进的门槛。
- `cadence: none` 时职责自身持久化的 `nextCheckAt` 就是下一次推进计划：写入关联任务（`once` + active），由 Nano 到点触发；没有检查时间时任务保持休眠（暂停、不派发）。报告未给出 `nextCheckAt` 就等待，不无限自触发。目标代号变化时清空 `unitsDone`/`nextStep`/`nextCheckAt`，旧计划不得驱动新目标。
- 计划按**消费**而非墙上时钟转换：只要该计划还没有**属于本职责推进任务的** occurrence（同 `taskId` 且 `sourceId = <timeZone>:<nextCheckAt>`），计划就保持 active；因此"Nano 已到期、维护循环先跑、触发后到"这一合法顺序不会撤销计划，另一个职责在同一时刻的计划也不会被误判已消费。计划一旦交付（无论该次结果是执行还是跳过）即转为休眠（占位 cron + 暂停），后续推进需要新的计划（报告写入新的 `nextCheckAt`）或手动推进；同一计划的重投因 occurrence 身份相同而幂等。
- 推进文本（work 输入）在耐久接受时按当时代号状态组装并冻结在 occurrence（`workText`），使同一 occurrence 的重试必然命中同一输入；派发前的复核只决定"是否仍可执行"，不改写旧输入。

## 进度、证据与版本

- 进度条目（`progress[]`）是不可变历史：携带 `goalRevision`、`payloadHash` 与 `advancementKey`。当前状态（`unitsDone`/`nextStep`/`nextCheckAt`/`awaitingMaterial`）是单独的指针字段，只有"应用到当前目标"的报告才移动它；仅入历史的报告（旧目标、或执行期间状态已被别人改过）不改变指针，因此不会把旧的完成量或旧计划写回当前状态。百分比只在声明 `totalUnits` 时显示。
- 报告按来源串行化：**所有交互式修改**（Web 用户纠错、主聊管理纠错）都必须带上调用方实际观察到的 `expectedRevision`，基于同一版本的两个并发纠错只有一个成功、另一个 409；`update/pause/resume/end/report` 缺少该字段是 400，`duty_manage` 也要求先 `list` 再提交。**只有**推进工作中的报告使用接受推进时冻结的职责修订（occurrence 的 `dutyDispatchRevision`）：若期间用户已改动（暂停、纠错、改配置），该报告只入历史、不覆盖用户刚写下的状态（响应 `reportApplied: false`）。同推进键同载荷幂等（即使版本已前移也返回既有结果），异载荷 409。
- 每条进度条目持久记录 `applied`：是否真正应用到当时的当前指针。组装下一轮推进文本时，只有当前目标代号且 `applied` 的条目作为"近期进度（依据）"与"已覆盖的材料"；未应用或被取代的条目只作为带标记的历史（"历史（不构成当前依据）：另有 N 条…"），不能当作已学事实。
- 所有写操作（含会移动指针的报告）都在**状态锁内**做比较并推进 `revision`；锁外读取的旧修订不能覆盖新写入。
- 证据校验使用真实路径：项目职责的根是 `projectRoot`，Friend 空间职责的根是该 Friend 的 agent home 项目；相对路径解析后必须 `realpath` 落在根内（符号链接不得越界）、存在且是普通文件；`work` 证据必须属于本 Friend。越界、不存在、非普通文件都拒绝。
- `nextStep`、`nextCheckAt`、`awaitingMaterial` 由当前代号的报告持久化；跳过原因与下次检查时间持久可查。

## 同源入口

- API：`GET/POST /api/long-agents/:id/duties`，`schemaVersion 1`，操作 `list/create/update/pause/resume/end/advance/cancel-advance/report`；写操作要求 `expectedRevision`，create/advance 要求 `requestId`。暂停/恢复/结束/立即推进通过同一任务服务落到关联任务。
- Tool：`duty_manage`（`src/tools/builtins/duty-manage/`），与 API 调用同一 `manageFriendDuty`。`report` 在推进工作中绑定该次推进，在日常主聊中是管理纠错；推进键都由服务端从执行上下文或请求键推导。
- 前端：`frontend/lib/friend-duties.ts` 运行时校验；Friend 设置"职责"页展示修订/目标代号、进度、依据、进行中与停止、跳过原因，并提供用户纠错。

## 验证入口

Backend：`test/long-agents/duties.test.mjs`（含生命周期连续性、报告绑定、并发 CAS、同键异载荷、nextCheckAt 门槛与自调度、派发前复核、真实路径证据、主聊纠错）；Frontend：`frontend/lib/friend-duties.test.mjs`；完整门禁 `pnpm verify`。真实浏览器/模型验收与独立复核返工记录见 [LA3 验收](../../history/reviews/2026-09-20-long-agent-la3.md) 与 [LA3 独立复核](../../history/reviews/2026-09-20-long-agent-la3-independent-review.md)。
