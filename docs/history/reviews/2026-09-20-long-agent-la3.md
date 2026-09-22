# LA3：长期职责与推进验收

最新结论（2026-09-20 收尾）：第五轮确认的迁移缺陷已由复核者直接修复。完整 `pnpm verify` 660 项通过、独立复核 20/20；下方早期“匹配指针判断可信”的迁移记录仅为历史，当前合同以 [duties.md](../../modules/long-agents/duties.md) 与本文末尾收尾记录为准。LA4 任务书已纳入阶段计划，尚未实施。

2026-09-20。范围来自 [LA 阶段计划](../../development/long-agent-functionality-plan.md) 的 LA3 交付清单与执行交接任务书，以及[机制合同 §9.4](../../modules/long-agents/chat-long-agent-mechanism-contract.md)。技术合同保存在 [Friend 长期职责](../../modules/long-agents/duties.md)，本文只记证据、发现和边界。未提交、推送或部署正式服务；未进入 LA4。

> **状态与校准（2026-09-20 追加）**：本记录首次提交时报告 LA3 完成。[第一轮独立复核](./2026-09-20-long-agent-la3-independent-review.md) 指出 5 个 P1 与 2 个 P2；[第二轮独立复核](./2026-09-20-long-agent-la3-independent-review-round2.md) 确认其中 4 项已修复，另指出 3 个新的 P1；[第三轮独立复核](./2026-09-20-long-agent-la3-independent-review-round3.md) 确认上一轮 3 项已修复，另指出 2 个新的 P1 与 1 个 P2。三轮返工与复验均已完成，见文末三段“复核与返工”。下方“交付范围”“真实模型与真实浏览器”“阶段自检”中关于职责修订、报告绑定、并发、心跳时间、证据存在性与聊天纠错的原表述偏乐观，**以返工段和 [duties.md](../../modules/long-agents/duties.md) 的现行合同为准**；原始内容保留以便对照差异。

## 交付范围（文件）

- 职责领域：`src/long-agents/duties/{contract,storage,service}.ts`（`CHAT_HOME/long-agents/<id>/duties.json`，文件锁 + 原子写入；不复制 Task 执行状态机）。
- 同源入口：`GET/POST /api/long-agents/:id/duties`（`schemaVersion 1`，`list/create/update/pause/resume/end/advance/cancel-advance/report`）；`duty_manage` Tool（`src/tools/builtins/duty-manage/`，注册进 `src/tools/registry.ts` 与默认能力 `src/long-agents/types.ts`）；职责管理与定时任务仍由同一个 `manageFriendDuty` 服务承担。
- 复用 LA1/LA2：推进经 LA2 Task/Occurrence + Nano 投影与可信触发，执行经 LA1 `startFriendWork` 独立 Session 和公共 Pi 装配。`FriendTask` 新增可选 `dutyId`；Occurrence 新增 `dutyRevision`/`workText`（在耐久接受时冻结组装好的推进文本，使崩溃重试必然命中同一输入）。
- 推进前置检查（模型调用前，确定性；返工后在耐久接受与真正派发前各执行一次）：启停、下次检查时间、允许时段（IANA 时区本地小时）、资料可用、预算；跳过原因持久到 occurrence 并可在页面查询。
- 进度与证据：`report` 由 Agent（推进键从执行上下文 turn→work→occurrence 推导，服务端核对职责与目标代号）与用户/主聊纠错共用；状态锁内 `expectedRevision` CAS；证据使用真实路径校验（两个作用域都要求存在、普通文件、realpath 不越界，工作引用必须属于本 Friend）。
- 回执与预算计量：终态 work 回执按推进键幂等写入，token 从该 turn 起点之后的原生 Session assistant usage 累加；预算在每次自动推进前检查，不中断在途执行。
- 前端：`frontend/lib/friend-duties.ts` 运行时校验 + `LongAgentDutiesSettings.tsx`（列表、创建/编辑、进行中与停止、进度与依据、跳过原因、纠错），Friend 设置新增“职责”标签；i18n 中英双语。
- 维护：崩溃恢复复用既有维护入口（`reconcileFriendTasks` 循环内调用 `reconcileFriendDuties`），没有新增与 Nano 竞相派发的定时器；服务启动时 `reconcileDefaultLongAgentTools` 为默认托管 Friend 补齐 `duty_manage`。

## 自动化

| 验证 | 结果 |
|---|---|
| Chat `pnpm verify` | 44 tooling + 388 Backend + 177 Frontend + 30 生产构建 + 1 Nitro 开发 Runtime，全部通过；typecheck、build、`check:architecture` 通过 |
| 新增职责门禁 `test/long-agents/duties.test.mjs` | 10 项：cadence none 休眠/改为 cron 建任务并应用投影、手动推进组装文本与两次连续推进复用进度、暂停/结束/缺资料/等待资料的确定性跳过、预算按真实 usage 计量并阻止自动推进、目标修订 supersede 与冲突拒绝、证据越界与不存在拒绝、重建丢失的推进任务与幂等回执重放、单个服务同源校验 |
| 前端 `frontend/lib/friend-duties.test.mjs` | 运行时结构校验（身份、版本、状态、字段、工作引用不匹配） |
| 更新既有门禁 | `test/tools/tools.test.mjs`、`scripts/built-server.test.mjs` 的 Tool 目录快照加入 `system:tool/duty_manage` |

`pnpm verify` 首次在 `scripts/debug-environment.test.mjs`（unrelated 的进程回收测试）失败：该用例等待孙进程写出 ready 文件只有 100×100ms = 10s 预算，而 `pnpm verify` 内同一批 tooling 测试并行运行真实 launchd fixture（7.3s/5.5s），满载下超时；单独运行该套件 3/3 通过。按“失败先修复”，把启动等待放宽到 200×100ms（仍在该用例自身 25s 超时内，断言未削弱），之后 `pnpm verify` 全绿。这是对既有脆弱门禁的最小修复，不是 LA3 功能绕过。

## 真实模型与真实浏览器

环境：隔离调试栈 `pnpm debug:start -- --nanoclaw`（Backend `45112`、Web `35145`、Nano Host `45300`、独立 `.data/debug/chat-home` 与 Nano 数据）；真实 Google Chrome（`playwright-core` + `channel: chrome`，headless）；真实模型 DeepSeek `deepseek-flash`（推进）与 Ark `glm-5-3-flash-260828`（连通性核对）。Nano 调试工作区补齐了 LA2 未提交的 chat-integration 改动与新增文件，未提交父仓库。

| 实际操作 | 结果 |
|---|---|
| 浏览器创建小思三项学习职责 | 天道学习（3 讲）、道德经学习（4 章）、金刚经学习（3 品），填写目标/成果要求/资料/节奏/时区/预算/总量；三份资料为工作区内真实可读文件 `materials/*.md` |
| 列表、刷新、窄屏 | 刷新后三项与修订、进度、`Next automatic advancement` 均恢复；390px 宽横向溢出 0px；页面错误 0 |
| 调度应用 | 三项目标职责各自生成归属任务（`task-c0146ed2…`/`task-352e86e5…`/`task-8b876336…`，`dutyId` 关联）并经 Nano 投影得到 nextAt `2026-09-21T01:00/02:00/03:00Z`（09/10/11 点 Asia/Shanghai） |
| Agent 通过真实管理 Tool 查询同一事实 | 真模型在主聊调用 `duty_manage{list}`（并顺带调用 task/agent_memory），逐条复述三项职责的名称、目标、节奏、进度、下一步，与页面/API 一致（1 tool call 起，32,843 tokens，7.1s） |
| 真实模型连续两次推进（天道） | 第 1 次：`completed`，组装文本为“资料清单 + 尚无记录”，产出 `notes/tiandao-01-文化属性.md`，`report` 提交 summary/evidence/nextStep，进度 1/3（33%）；第 2 次：组装文本含“已覆盖的材料 `notes/tiandao-01-文化属性.md`、当前累计完成量 1/3、第一次完整 summary、持久化下一步”，模型据此推进第二讲并回引第一份笔记，进度 2/3 |
| 三项职责独立推进 | 天道 2/3、道德经 2/4、金刚经 2/3 并行存在，产物 `notes/tiandao-01|02`、`notes/daodejing-01|02`、`notes/jingangjing-01|02` 均可打开，证据路径真实存在 |
| 浏览器修正目标（编辑）、暂停、恢复、纠错、立即推进 | 编辑：修订 v3→v4，旧修订进度标记 superseded 保留历史，`unitsDone/percent` 重置为空且 `nextStep` 被清空（见“发现与修复”）；暂停：职责与关联任务同时 paused；恢复：同时 active；纠错：用户进度记为 `source: user`、保留在历史；立即推进：每次一个独立 occurrence/work |
| 停止单次执行 | 后台推进运行中页面出现进行中条目与停止入口；点击后仅该次 work 变 `cancelled`（计量 41,750 tokens），其他已完成记录不变，职责不结束 |
| 后台推进期间主聊流式 | 后台 work `running` 时向主聊发消息，采样 40 次得到 7–9 个不同文本长度（真实流式增长），模型准确答出“正在推进《金刚经》第二品笔记，其余已完成第一讲/前两章” |
| 重启恢复 | 先停 Backend：职责文件、修订、进度、回执全部保留，`projectionError` 诚实显示“调度服务暂时不可用；已保存的定义保留”；重启完整栈后投影自动重放，`projectionError` 清空，nextAt 重新生成，三项状态完整 |
| 真实触发下的确定性跳过 | 经认证内部入口 `POST /api/internal/channel/v1/task-triggers`（与 Nano 相同路径）提交定时触发，返回 202 并耐久记录 occurrence，但状态为 `skipped`、原因“缺少学习资料，等待用户在职责中补充”，**未创建任何 work**（work 数不变）；页面“Skipped or blocked (reasons)”可查该原因 |

## 发现与修复（验收中真实暴露）

1. **运行中的推进没有停止入口**：职责页只渲染已有回执的推进列表，而回执在终态才写入，导致运行中的推进看不到、无法停止。修复为职责行内始终可见的“进行中（已接受或运行中）”区，带独立停止按钮。
2. **未推进原因在职责页不可见**：跳过/阻塞的 occurrence 没有 work 也没有回执，原页面完全看不到。修复为独立的“跳过或阻塞（原因）”区，展示时间与原因，满足“本次推进或未推进的原因可查”。
3. **目标修订沿用了旧计划的下一步**：修订只重置进度百分比，却把上一修订的 `nextStep/nextCheckAt` 带到新目标，等于让旧计划继续驱动新目标。修复为修订变更时清空下一步与下次检查；自动化补断言，浏览器复验页面显示 “Not set yet”。
4. **Provider 配额（外部原因，非代码缺陷）**：第一次真实推进在 Ark coding 端点返回 429“5 小时用量配额已耗尽（17:28 重置）”。两次失败都如实计量入账（36,828 + 0 tokens，状态 failed），随后把该 Friend 的模型切换到按量的 `deepseek/deepseek-flash` 继续验收。这同时验证了失败终态与计量是真实事实，而非一律“成功”。

## 阶段自检

| 检查 | 结论和限制 |
|---|---|
| 需求完整 | 三种职责不同进度、缺资料等待、用户改目标、暂停/恢复、重启、完成子任务但职责继续（子任务完成不结束职责，`end` 只能显式发起）均有真实入口或自动化证据；未用 Mock UI 或只写文档代替 |
| 架构一致 | 唯一 Pi 公共装配（推进走 LA1 `startFriendWork`）；无第二套执行/调度：职责复用 LA2 Task/Occurrence 与 Nano 投影，维护入口只有一个；Web 与 Tool 调同一 `manageFriendDuty` |
| 事实与权限 | 目标 revision、进度、证据、回执、跳过原因持久可回读；证据越界/不存在/外部 work 被拒；推进键由服务端从执行上下文推导，模型不能伪造职责或 Session 身份 |
| 生命周期 | 正常、失败、取消、重启、重复触发、迟到结果、缺资料等待都有准确终态与原因；结束后不可恢复但历史保留；取消只作用于单次执行 |
| 并发 | 后台推进独立 Session 并行，主聊在推进期间正常流式；同一职责最多一次等待并发的保护沿用 LA2 `queue-one`；职责/任务写入使用文件锁与原子写入 |
| 可用性 | 刷新、窄屏、进行中停止、进度与依据、跳过原因均可见；纠错保留历史并标注 superseded；页面与 Tool 读取同一事实 |
| 验证诚实 | 原生 API 自动化、真实模型、真实浏览器分别列出；Provider 配额失败如实记录；跨日只做自动化，见下 |
| 最终目标 | 三项学习职责跨日持续推进已具备机制；3+1 产出（笔记/动态）与群聊分别留给 LA4/LA5，本阶段未越过边界 |

## 明确未验证／未覆盖

- **实际跨日运行**：跨日、DST、错过时间用 LA2 既有自动化与 LA3 可控时钟断言覆盖，没有真实等待一天；24h 联合运行仍归 LA6。
- **自动触发的真实时钟**：本次真实触发使用与 Nano 相同的认证内部入口（LA2 已验 Nano 定时扫描链路），没有等待次日 09:00 的自然到点。
- **预算语义**：预算是“自动推进前检查的软上限 + 真实用量计量”，不中断在途执行；UI 与合同均如此说明，不宣称精确硬上限（Provider 侧计量仍可能有细微差异）。
- **外部渠道**：Telegram/微信收发、Delivery/Ack 未在本轮测试；LA4 的笔记/动态发布闭环、LA5 的群聊完全未实施。
- **运行数据**：全部为隔离验收对象（Friend `thingk`/小思 已有，职责 `duty-cfc369de…`/`duty-fe8461c0…`/`duty-51f325d6…`），不是用户正式数据。日志、截图、脚本与最终 `pnpm verify` 输出在 `.data/verification/la3-2026-09-20/`，不提交。

## 独立复核与返工（2026-09-20）

[独立复核](./2026-09-20-long-agent-la3-independent-review.md) 用自己的探针确认了 7 个问题。逐条结论：全部属实，均已修复并补了会在原实现失败的行为测试。

| 复核项 | 修复 | 回归测试 |
|---|---|---|
| P1-1 暂停/恢复使进度与当日预算失效 | 分离 `revision`（并发版本）与 `goalRevision`（目标代号）：生命周期/配置变更只提升 `revision`；进度与 superseded 按目标代号；预算按职责按自然日累计，不随目标代号重置 | 生命周期与配置变更保持进度、计划与计量；仅目标变化才 supersede 并清空下一步 |
| P1-2 报告未核对职责与目标版本 | `report` 由服务端从 turn→work→occurrence 推导并核对 `dutyId` 与 `workId`；主聊纠错走独立的 `chat:<requestId>` 键；迟到结果按执行时冻结的目标代号归档，不写当前 `nextStep`/完成量 | 他职责的推进、普通后台工作、未知上下文都被拒；旧目标迟到报告只进历史 |
| P1-3 修订检查在锁外，并发静默覆盖 | 所有写操作在状态锁内 CAS；同推进键异载荷 409，同载荷幂等 | 同 `expectedRevision` 并发更新一成一败；同键异载荷冲突、同载荷幂等 |
| P1-4 心跳下一步时间不控制推进 | `nextCheckAt` 进入前置检查（未到时间跳过、manual 不受限）；`cadence: none` 时用职责自身的 `nextCheckAt` 自调度关联任务（`once` + active），无未来时间则休眠 | 未到检查时间跳过、manual 可推进、自调度任务变 `once`/active、过去时间回落休眠 |
| P1-5 排队到执行之间不复核 | 派发前重新执行同一组确定性检查；维护循环先回收回执（预算）再派发 | 容量占满时排队的推进，在暂停/改目标后派发被跳过且不新建 work |
| P2-6 证据可用性与路径边界不完整 | 两个作用域都用 `realpath` + `stat`：必须存在、是普通文件、真实路径不越出授权根（符号链接被挡） | Friend 空间缺失文件、符号链接越界；项目作用域同样的缺失与越界 |
| P2-7 聊天纠错未打通 | `duty_manage.report` 在无 work 的主聊里作为管理纠错，键为 `chat:<requestId>`，保留审计与证据校验 | 主聊纠错入库（当前目标代号、未被 supersede）、同请求幂等、异载荷冲突；被取消的推进仍按其冻结目标代号归档并被回执记录为 cancelled |

复核者保留的探针源码（`.data/verification/la3-review/probe-source.mjs`）在修复后被复跑：原来的 5 项缺陷输出全部转为正确行为（缺资料证据被拒、`nextCheckAt` 返回“未到下次检查时间”、暂停恢复后 `unitsDone:1/superseded:false`、并发更新一成一败、B 的 work 无法给 A 报告）。探针本为暴露缺陷而写，其中一项因正确拒绝而直接失败；为观察其余各项，用只替换证据为合法 note 的临时副本运行，未修改其原文件。

返工后的真实验收（隔离栈重启，真实 Chrome + 真实 DeepSeek，旧数据含 `dutyRevision` 旧字段直接被读取迁移）：

| 操作 | 结果 |
|---|---|
| 浏览器暂停→恢复「天道学习」 | 修订 1→3，目标代号保持 g1，进度 2/3（67%）、今日计量 293,492 tokens、持久化下一步全部保留 |
| 浏览器只改每日预算 | 修订 →4，目标代号仍 g1，进度与下一步保留，预算生效 |
| 真实模型第三次推进 | `completed`，258,573 tokens，3/3（100%），并主动说明三讲已覆盖、无未读讲次、需用户决定而不自行推进，`nextCheckAt=2026-09-20T23:00:00Z` |
| 真实触发链路 + `nextCheckAt` | 认证内部入口返回 202 并耐久记录 occurrence，但状态 `skipped`、原因“未到下次检查时间（2026-09-20T23:00:00.000Z）”，**未创建 work**（work 数不变） |
| 真实模型主聊纠错 | 模型调用 `duty_manage.report`（无 work 绑定），键 `chat:tool:chat-web:thing…`，source agent，目标代号 g2，units 2（50%），下一步落地，未被 supersede，页面可见 |

返工后的门禁：`pnpm verify` 通过（44 tooling + 397 Backend + 177 Frontend + 30 生产构建 + 1 Nitro 开发 Runtime；Backend 含 19 项职责门禁），`check:architecture`、typecheck、build 与父仓库/Frontend 的 `git diff --check` 全过。日志与截图在 `.data/verification/la3-2026-09-20/`（`rework-*`）与 `.data/verification/la3-review/`。

未因返工改变的限制仍然成立：真实跨日、自然到点定时、24h 联合运行归 LA6；预算仍是启动前软上限；外部渠道与 LA4/LA5 未实施。

## 第二轮复核与返工（2026-09-20）

[第二轮独立复核](./2026-09-20-long-agent-la3-independent-review-round2.md) 独立编写探针，确认第一轮中的暂停连续性、配置 CAS、聊天纠错、排队暂停检查已通过，同时指出 3 个新的 P1。逐条结论：全部属实，均已修复并补了会在修复前失败的测试。

| 复核项 | 修复 | 回归测试 |
|---|---|---|
| R2-1 到期的自调度计划被维护循环撤销 | 计划改为按**消费**转换：只要该计划时间还没有对应 occurrence，`once`+active 就保持（维护循环不再因“时间已到”把它改回占位 cron 并暂停）；计划被耐久接受后才转休眠。Nano 到点、维护先跑、触发后到的合法顺序不再丢一次执行 | 未来计划 → 到期后在维护后仍为 `once`/active → 延迟交付仍 `accepted`→`started` → 消费后转休眠暂停 → 同计划重投幂等、不产生第二次执行 |
| R2-2 进度纠错的并发 CAS 仍无效 | 报告改为版本化写入：移动当前指针的报告推进 `revision`；用户/主聊纠错用读到的修订做 CAS（同一版本的两个并发纠错只有一个成功，另一个 409）；推进工作中的报告用**接受时冻结的职责修订**（`dutyDispatchRevision`）判定，期间用户已改动则只入历史（`reportApplied:false`）且不移动指针 | 并发纠错一成一败 409；用户在运行期间纠错后，后台报告只入历史、当前完成量与下一步保持用户值 |
| R2-3 排队后预算复核读取旧计量 | 接受与派发前都先刷新消费账本（补记已结束未入账的执行），触发直达派发与维护派发看到同一份计量；计量读取失败不记零、留待补记，并在设置预算时暂不自动推进 | 第一次推进结束（60 tokens）但未跑维护，第二次经触发直达派发被跳过（“预算已耗尽 60/50”），work 数不变 |

此外把 `unitsDone` 从“进度条目推导”改为**独立的当前指针字段**：仅入历史的报告不再影响当前完成量（此前会把旧执行的完成量算进当前值）。

复核者保留的第二轮探针源码（`.data/verification/la3-review-round2/probe-source.mjs`）复跑结果：**7 项中 6 项通过**，包括此前失败的“进度纠错并发 CAS”“到期计划不被撤销”“排队预算复核”。唯一失败的“暂停后继续学习”探针在报告后仍用**报告前的旧修订**去暂停（该探针写作时报告不推进版本），与 R2-2 要求的版本化写入自相矛盾；把暂停/恢复改用当前修订后，同一流程通过：`units=1`、`tokens=60`、`goalRevision=1`，第二次推进的模型输入仍包含第一次的下一步 `CONTINUE_CHAPTER_TWO`。

第二轮返工后，`test/long-agents/duties.test.mjs` 共 22 项职责门禁全部通过；`pnpm verify` 通过（44 tooling + 400 Backend + 177 Frontend + 30 生产构建 + 1 Nitro 开发 Runtime），`check:architecture` 与父仓库/Frontend/Nano 的 `git diff --check` 全过。真实验收（隔离栈 + 真实 Chrome + 真实 DeepSeek）：暂停/恢复保持 `units 2/4`、`tokens 149,658`、`goalRevision 2`、下一步与下次检查时间；真实模型推进 3/3 并如实报告用户修订目标超出资料范围；真实触发链路对未来 `nextCheckAt` 返回 202 但 `skipped`“未到下次检查时间”且不创建 work；真实主聊纠错把完成量改为 3（75%、键 `chat:tool:...`、未被 supersede）。

## 第三轮复核与返工（2026-09-20）

[第三轮独立复核](./2026-09-20-long-agent-la3-independent-review-round3.md) 的 14 项探针中 12 项通过，指出 2 个 P1 与 1 个 P2。逐条结论：全部属实，均已修复并补了会在修复前失败的测试。

| 复核项 | 修复 | 回归测试 |
|---|---|---|
| R3-1 消费判定跨职责串扰 | 计划身份改为"本职责推进任务 + 计划时间"：`planConsumed` 同时核对 `taskId` 与 `sourceId`，不再用时间戳在 Friend 全部 occurrence 中搜索 | 两个 cadence=none 职责设同一时刻：A 交付并维护后，B 仍为 `once`/active，B 的合法触发正常 `started`（两个 work） |
| R3-2 主聊纠错忽略调用方 revision | 所有交互式修改（user 与 chat）都使用调用方 `expectedRevision` 做 CAS，过时即 409；只有后台执行报告走冻结版本的历史归档分支。`update/pause/resume/end/report` 缺该字段为 400，`duty_manage` 报错提示先 `list`；同键同载荷的重试仍幂等 | 主聊带 v1 提交（用户已写入 v2）被拒 409、当前值保持用户值 8；带当前版本成功应用为 2 |
| R3-3 未应用报告仍进入下一轮 Prompt | 进度条目持久记录 `applied`；组装推进文本时只有当前目标代号且 applied 的条目作为依据与"已覆盖材料"，未应用/被取代条目只以带标记的历史计数出现；前端同时显示"仅历史（未应用）" | 同目标下的 stale 报告 `reportApplied:false`；下一轮输入不含其 summary 与证据路径，含用户值与"历史（不构成当前依据）" |

复核者保留的第三轮探针源码（`.data/verification/la3-review-round3/probe-source.mjs`）复跑结果：**14/14 全部通过**，含此前失败的"同时间双职责独立消费""主聊过时修订必须被拒""staleInPrompt"。第二轮探针中的暂停流程探针也已按新合同改为使用报告后的新版本。

第三轮返工后，`test/long-agents/duties.test.mjs` 共 25 项职责门禁全部通过；`pnpm verify` 通过（44 tooling + 403 Backend + 177 Frontend + 30 生产构建 + 1 Nitro 开发 Runtime），`check:architecture` 与父仓库/Frontend/Nano 的 `git diff --check` 全过。真实验收（隔离栈 + 真实 Chrome + 真实 DeepSeek）：真实模型在主聊先 `list` 再用当前 revision 提交纠错成功、过时 revision 被拒；真实推进与 `nextCheckAt` 门槛行为与自动化一致。

## 第四轮复核与返工（2026-09-20）

[第四轮独立复核](./2026-09-20-long-agent-la3-independent-review-round4.md) 的 17 项探针中 16 项通过，指出 1 个 P2：旧数据迁移把缺失 `applied` 的条目一律认定为已应用，会把上一版本中本该只作历史的迟到报告重新变成当前依据。核对属实（第三轮之前的写入确实支持 `reportApplied=false`，只是没有落盘该标记），已修复。

| 复核项 | 修复 | 回归测试 |
|---|---|---|
| R4-1 迁移重新认定历史未应用报告 | `normalizeLegacy` 不再默认可信：只有内容与已冻结指针完全一致（`unitsDone`/`nextStep`/`nextCheckAt` 三项相等）的最新一条旧条目被认定为已应用，其余旧条目一律 `applied: false` 未核验历史；指针与历史都保留，写回后标记成为显式字段，重复读取/重启稳定 | 旧格式同目标迟到记录：有效条目 applied=true、迟到条目 applied=false，下一轮模型输入不含其 summary/文件路径/下一步且带“历史（不构成当前依据）”；普通有效旧记录保持为当前依据；两次读取与写回后分类稳定 |

复核者保留的第四轮探针源码（`.data/verification/la3-review-round4/probe-source.mjs`）复跑结果：**17/17 全部通过**，含原失败的 `R4 migration {"units":8,"applied":false,"summary":false,"file":false}` 与“迁移后的实际模型输入不含未应用内容”。

真实运行时迁移验收（隔离栈）：向隔离 Chat Home 写入一条旧格式条目（无 `applied`、用 `dutyRevision`、内容与指针不一致），真实后端加载后 API 显示该条 `applied: false` 且指针不变；对活数据调用组装器得到的推进会文本包含“历史（不构成当前依据）”且不含该条的摘要、文件路径与下一步。第四轮返工后 `test/long-agents/duties.test.mjs` 共 27 项职责门禁全部通过；`pnpm verify` 通过（44 tooling + 405 Backend + 177 Frontend + 30 生产构建 + 1 Nitro 开发 Runtime），`check:architecture` 与父仓库/Frontend/Nano 的 `git diff --check` 全过。


## 最终收尾：迁移不推测应用事实，LA4 交接

用户要求直接修复第五轮剩余问题。改动仅限职责迁移、推进输入提示、相应回归及文档，不改已通过的调度/CAS，不修改正式数据，不提交或部署。

- 缺少 applied 的旧报告统一作为未核验历史（false）；删除匹配指针/最新条目启发式。已有显式指针保留，缺少完成量指针时保留未知，不由历史推导。
- 有历史但没有有效依据时明确告知模型依据待核验、保留当前进度与计划，不能把它当作第一次推进或重复从头学习。现有历史页保留记录，核实后通过同源纠错提交新的有效依据。
- 新增相同指针、跨目标和缺少指针三组回归；每组经历三轮读取→暂停/恢复写回→实际公共执行，并检查真正发往测试模型的请求。最后核实新报告可正常进入依据，旧记录仍保留且隔离。
- 旧的“普通有效旧记录自动成为依据”断言同步改为保守未知：旧格式没有应用证据，无法保证其有效。不是删掉失败断言，而是测试用户认可的新迁移合同；所有记录和当前指针仍受保留断言保护。

验证结果：

| 门禁 | 结果 |
|---|---|
| 职责针对性测试 | 30/30，通过上述实际输入与读写边界 |
| 历轮独立复核探针集中复验 | 20/20；保留调度、并发、预算、主聊、指针/历史等断言，仅将旧记录“自动可信”的预期改为明确未核验 |
| 隔离源码副本 pnpm verify | 660 项：44 tooling + 408 Backend + 177 Frontend + 30 built + 1 Nitro dev；类型检查和生产构建均通过 |
| 导航和差异 | pnpm check:architecture、父仓库及 Frontend git diff --check 通过 |
| 源码一致性 | 隔离副本中两个职责代码文件与测试文件和最终工作区逐字节一致，哈希记录保存 |

验证副本第一次导航检查发现复制脚本遗漏目录符号链接 `.agents/skills/chat-architecture`，补齐副本链接后重新执行完整 verify 成功；这是验证环境准备问题，未改业务代码绕过门禁。完整构建只在独立副本运行，未覆盖常驻实例的 `.output` 或前端构建。

日志和复核源保存在 `.data/verification/la3-closeout/`：`verify.log`、`duties.log`、`independent.log`、`source-parity.json`。临时探针源码保留为 evidence，已从测试发现目录移除；永久门禁在 `test/long-agents/duties.test.mjs`。

本次未重新运行付费模型、真实浏览器或外部渠道；检查的是经公共 Pi 链发往隔离 HTTP 测试模型的真实请求。此前真实模型/浏览器证据保留，不冒称为本次重新验收。24h 联合运行仍归 LA6。早期有缺陷程序若已经把错误推断持久化为显式 true，本次无法反推出来源，需经既有纠错入口核验，不能宣称自动修复所有历史污染。

五轮已确认问题在上述复核范围内闭环，LA4 可按[执行交接任务书](../../development/long-agent-functionality-plan.md#la4-执行交接任务书笔记与动态闭环)启动。LA4 尚未开始编码，也未委托额外 Agent。
