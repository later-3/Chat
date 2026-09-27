# Long Agent 设置：9 个入口的实现与测试审计

日期：2026-09-27。对象：用户截图中的运行策略、任务、职责、交付、活动、群聊、主题、智能体组、助手记忆。代码基线为 `codex/unified-session-performance` 当前未提交工作区；当前实例为隔离预览 `http://127.0.0.1:63291`。本轮解释与审计，不改产品代码，不修改正式配置，不发送外部消息。

## 结论

9 个入口都能追到真实的 HTTP/领域实现，没有发现仅在浏览器假保存或使用硬编码结果冒充实现的入口。但这不等于 9 项已完整验收：当前预览存在 NanoClaw 依赖不可用，追加探针还确认了职责计量、活动计量和活动时区 3 处缺陷。

本轮既有测试 200 项通过（Backend 167 + Frontend 33），新增审计探针 2 项失败。不能引用上一轮 `pnpm verify` 全绿，推导本轮发现的场景已经通过。本轮没有重新跑全部 verify 或逐个点击所有浏览器控件。

## 入口到底做什么

统一前端入口：`frontend/components/LongAgentSettingsPanel.tsx` 的 `tabs` 与各子组件。下表的服务都位于真实路由之后，不以“存在文件”代替调用链检查。

| 入口 | 实际用途与生效边界 | 后端链路 | 本轮复跑的主要证据 |
|---|---|---|---|
| 运行策略 | 配置显示名、时区、默认协作项目、模型、思考等级、提示词、工具和资源。保存修订后由后续轮次装配；在途执行保留冻结配置。模型能力取决于对应供应商，不表示每个模型支持所有思考等级。 | `config.get/put` → `configuration.ts` → Agent 独立定义；`prepareLongAgentAssembly` → 公共 Pi 装配。检查与执行共享解析。 | `long-agents.test.mjs` 的配置 CAS、HTTP、有效 Skill 检查与原生执行；`config-root.test.mjs` 的独立根、日期与项目；前端 settings/parser 测试。 |
| 任务 | 一次性、cron 或可信事件触发的具体工作；可暂停、恢复、立即执行、取消某次运行。自动定时需要 NanoClaw 成功应用调度；事件类型需要真实事件生产者，页面不会自行监视网站。 | `tasks.get/post` → `tasks/service.ts` → Nano 调度投影/触发 → 独立 Friend Work → Workflow/Pi Session。 | `tasks.test.mjs`：幂等、重叠、丢回执、恢复、暂停、取消、投影离线与主聊并发。测试替换 Nano 投影 HTTP 边界，实际执行使用 Pi/本地模型。 |
| 职责 | 持续工作目标、资料、成果要求、推进节奏、进度依据和下一步；关联任务驱动独立执行。Token 日预算是自动推进前的软限制，手动推进可越过预算；不是每次请求硬截断。 | `duties.get/post` → `duties/service.ts` → Task/Work；模型用 `duty_manage` 报告进度，服务校验来源和版本。 | `duties.test.mjs`：实际模型输入、资料等待、允许时段、预算、进度 CAS、迟到报告与迁移。**本轮额外发现压缩摘要漏计，见 F1。** |
| 交付 | 查看任务产出的笔记与站内动态、提交状态、版本和冲突；支持补交、修订、导出、重新生成。任务完成不自动等于产物已提交。这里不是“发到任意外部平台”的通用发布器。 | `artifacts.get/post` → `artifacts/service.ts` → 不可变笔记存储 / Social 发布与回读校验；重新生成走新的 Task occurrence。 | `artifacts.test.mjs`、`artifacts-boundaries.test.mjs`、`note-store.test.mjs`：真实临时文件写入、人工修改保护、符号链接边界、版本 CAS、发布幂等及崩溃恢复；前端协议测试。 |
| 活动 | 查看日常状态、按日的会话/轮次/Token/工具统计和动态。它是历史投影，不是自动工作的开关，也不是完整运行审计日志。 | `activity.get` → `buildLongAgentActivity`；`social.get` → Social 服务。统计读取 Agent Home 的 Session JSONL。 | `activity-social.test.mjs` 以文件夹具验证统计和帖子/评论；当前 API 返回真实历史。**F2/F3 说明统计不完整且时区有误，不能称全面正确。** |
| 群聊 | 用户与多个 Friend 在共同会话中讨论；支持指定/@、圆桌、并行、主持、自由讨论，以及受控请教/后台工作。各 Friend 的参与 Session 独立，不直接共享全部私有记忆。 | `conversations/**` → service/orchestrator/dispatch/work/publication → Workflow/Pi → 公共引用投影。 | conversations、orchestrator、work、channel 与 summary-budget 测试：隔离、策略、取消、幂等发布和预算。历史浏览器/真实模型/重启证据另列。 |
| 主题 | 围绕长期问题组织主题节点；每节点有会话、记忆、来源锚点，可分叉、关联和补充整合。这里指问题主题，不是外观主题。设置中这个页签是进入主题工作区的入口。 | `topics/**` → topic 创建/节点/整合服务 → Workflow/Pi 与 Session Memory。 | topics、topic-api、topic-node-creation、topic-integration；前端 topics 协议。当前 API 能读到主题；历史有浏览器 fork、真实模型与中断恢复证据。 |
| 智能体组 | NanoClaw 的 **一个 Friend 的运行实体**：身份名称、长期指令和工作空间摘要。不是群聊，也不是一组多个 AI。长期指令负责身份约束，和“职责”中有调度/进度的工作目标不同。 | `agent-group.get/patch` → `agent-group-service.ts` → Nano Management API；冻结身份快照进入 `prepareLongAgentAssembly`。 | `agent-group-service.test.mjs`：HTTP 修改、版本、缓存、离线旧快照、身份注入与工具身份绑定；前端协议。**当前预览 GET 502。** |
| 助手记忆 | 管理该 Friend 自己的 Markdown 长期记忆：列出、搜索、读写和删除。核心索引与身份文件参与装配，其余文件按需读取。它和 Session Memory、Personal/Project Memory 是不同事实源。 | `agent-memory.get/patch` → 同一资源服务 → Nano Markdown Memory API；Agent 的 `agent_memory_*` 工具复用服务。 | 同上：真实 Chat 路由 + 受控 Nano HTTP，路径/大小/版本/身份与审计边界。不是当前实例真实 Nano 收发验收。**当前预览 GET 502。** |

Backend 测试均指 `test/long-agents/`；Frontend 测试指 `frontend/lib/`。职责与交付依赖任务的自动调度，因此不能因为自身 GET 返回 200 就判定自动推进已经可用。

## 当前预览的直接观察

只请求现有 HTTP 查询入口，未新建任务、职责或消息。精简结果保存在 `.data/verification/long-agent-settings-audit/live-api-summary.json`。

- 运行配置、活动、职责、交付、主题读取返回 200；活动查询覆盖 9 月，返回 17 个日期记录。
- 智能体组、助手记忆均返回 502，错误为 NanoClaw 暂时不可用。
- 任务返回 200，但 `migration=pending`，`projectionError` 明确表示任务所有权迁移未完成，需检查 NanoClaw 连接与版本。职责响应也带同一调度错误。这不是“自动任务已经启用”的证据。
- 当前任务、职责、交付列表为空；主题列表有数据。空列表只说明此隔离数据集中的状态，不代表功能是假实现，也不代表已实际验收过创建/执行。
- Agent Home 的会话目录是 `long-agents/<id>/sessions`：由 `ensureProjectDataLayout(kind="agent")` 创建，与活动读取路径一致。审计初期对“旧目录”的怀疑已排除，不列为缺陷。

以上是隔离预览在本轮读取时的状态，不外推到正式实例，也没有据 502 推定具体是服务未启动、认证还是版本故障。

## 新确认的缺陷与原测试盲区

### F1 / P1：职责日预算漏掉摘要用量

`src/long-agents/duties/service.ts` 的 `measureTurnTokens` 只累计 assistant message 的 usage，不累计原生 compaction/branch summary usage。职责预算的“下一次自动推进是否允许”会以偏小的账本为依据。

隔离探针通过实际 `manageFriendDuty(advance)` → Task/Work → 公共 Pi → 本地 HTTP 模型执行，实际触发原生自动压缩。2 个普通请求 + 2 个摘要请求合计 **127,310 tokens**；职责账本仅记录 **127,070**，漏记 **240**。没有调用付费模型或正式任务。Workflow 传输使用现有 `workflow-transport-fixture.mjs` 替身并执行同一工作 body；本探针不冒充真实 Nitro Runtime 进程测试。

之前修复的 Pi 请求准入和群讨论/群工作摘要计量仍有对应测试通过；它们不能代替职责独立日账本的正确性证明。职责本身仍是启动前软上限，本问题是漏计，不是要求把它改成每请求硬上限。

### F2 / P2：活动 Token 统计同样漏掉摘要

`src/long-agents/activity.ts` 只累计 assistant message usage。相同真实压缩探针中活动总量也为 **127,070**，比实际响应的 Token 总量少 **240**。原 `activity-social.test.mjs` 的手工 JSONL 只有普通消息，没有压缩或分支摘要，因此现有测试全绿仍覆盖不到该问题。

### F3 / P2：活动日期使用服务器时区

`activity.ts` 的 `dateOfLocal` 使用 Node 本地日期；没有读取 Friend 的 `timeZone`。前端查询范围还使用浏览器本地日期。三者不同时，跨午夜活动会分到错误日期或漏出查询范围。

确定性边界探针：服务器 UTC、Friend `Asia/Shanghai`，记录时间 `2026-09-26T20:00:00Z`，Friend 当地是 **9 月 27 日**，接口实际归到 **9 月 26 日**。这个探针使用固定 JSONL 验证日期投影，不声称是新的模型运行证据。

探针：`.data/verification/long-agent-settings-audit/precision-probe.test.mjs`，结果 `precision-probe.log`，**2/2 失败，exit 1**。这些是本轮审计证据，尚未转为修复后的永久回归，不隐藏失败，也未修改实现来让它们通过。

## 测试层级与历史证据

本轮：18 个 Backend 测试文件 **167 项通过**；9 个 Frontend 协议/状态测试文件 **33 项通过**。日志为本地证据目录的 `backend.log`、`frontend.log`。Frontend 协议测试不能冒充页面真实点击，Nano HTTP 替身不能冒充当前 Host 在线。

历史验收保留原日期和范围，本轮没有重新执行其中的付费模型、完整浏览器或外部平台动作：

- [LA2 任务验收](./2026-09-20-long-agent-la2.md)：浏览器创建/编辑、真实 Nano 到点、真实模型、取消与进程重启。
- [LA3 职责验收](./2026-09-20-long-agent-la3.md)：职责推进、真实模型输入、进度与资料/预算门槛，后续多轮修复记录以末节为准。
- [LA4 交付验收](./2026-09-20-long-agent-la4.md)：真实模型产出笔记和站内动态、文件/feed 回读、浏览器交付页；历次并发/路径修复以末节为准。
- [LA5 群聊验收](./2026-09-21-long-agent-la5-acceptance.md)：真实模型策略、浏览器、重启与隔离；[LA6](./2026-09-21-long-agent-la6.md) 补充 Telegram 真平台，24 小时持续运行仍为豁免/未测。
- [主题总验收](./2026-09-25-topic-mode-p4-total-acceptance.md)：真实模型、浏览器分叉与中断恢复；不代表产出质量经人工评价。
- [上一轮整体门禁](./2026-09-27-pi-session-controls.md)：1003 项通过；新发现的 F1–F3 当时没有对应回归，因此不被该数字覆盖。

## 下一步顺序

1. 修复 F1，补充职责推进真正发生原生压缩后的计量与下一次预算判断回归；复用 Pi 原生用量事实，保持职责软预算合同。
2. 修复 F2/F3，统一活动用量与 Friend 时区语义；补自动压缩、分支摘要及服务端/浏览器/Agent 时区不同的覆盖。
3. 单独恢复或诊断隔离 Nano 依赖，并验收设置页明确显示“可管理 / 依赖不可用 / 调度待应用”；上线状态由健康与应用结果决定，不以菜单存在或 HTTP 200 决定。

模块事实源：[任务](../../modules/long-agents/tasks.md)、[职责](../../modules/long-agents/duties.md)、[交付](../../modules/long-agents/deliverables.md)、[群聊](../../modules/long-agents/group-chat.md)。本记录保存当前审计证据，不改写这些机制为已全面通过。

## 后续修复

本审计的原始发现保留。随后按用户确认的产品映射实施 [任务与导航统一](../../development/friend-task-navigation-plan.md)：移除 5 个冗余管理栏目，成果回归所属任务；F1/F2/F3 已由真实原生压缩与跨时区回归复现并修复。最终验证数字见对应后续验收记录，不修改本次审计当时的失败结果。
