# LA6 验收记录

**最新结论（2026-09-21）：A 包通过独立复核；LA6 整体未验收。** 以下早期“未验收/待修复”为当时记录，A 最终结论以末节为准。B/C/D/E 仍按任务书完成，不代表已提交、推送或部署。

阶段：[LA0–LA6 计划](../../development/long-agent-functionality-plan.md)；任务书：[LA6 任务书](../../development/long-agent-la6-taskbook.md)。状态：**实施中**（2026-09-21 用户批准开工，按 A→B→C→D→E 推进）。未完成项不得写成已发布能力。

## 工作包 A：Friend 协作项目关联（实施者报告完成，待独立复核）

按任务书 §3.1 与 §3.1.1 的决策实施；短设计见[机制合同 §10](../../modules/long-agents/chat-long-agent-mechanism-contract.md#10-la6-afriend-协作项目关联短设计)。

1. **独立关联存储**：`src/long-agents/interaction-project.ts`，记录落在 `longAgentConfigRoot(chatHome, longAgentId)/interaction.json`（`{schemaVersion, projectId, revision, updatedAt}`），不写 definition/registry/Nano；原子写 + revision CAS + 路径授权沿用既有持久化原语；Friend 删除随配置根一并移除。
2. **三态与不可用**：无记录 = `unset`（读取不写入，有效项目 null）；`projectId:null` = 显式清空；非空但项目不再解析 = `unavailable`（保留原值/revision，解析带原因）。写入非用户项目被拒（404）。
3. **接受时解析并冻结**：`acceptLongAgentTurn` 在 `friend-accept` 锁内解析关联；`chat-web` 且声明 `interactionRevision` 时以关联为权威——revision 不匹配、`contextProjectId` 与有效项目不一致、`unavailable` 一律 409，不静默采用；冻结的 `contextProjectId` 与 `interactionRevision` 写入 AcceptedTurn。渠道/任务/群仍各自使用已冻结或自身明确目标；无 `interactionRevision` 的 legacy 调用保持原行为。
4. **入口**：`GET/PUT /api/long-agents/[id]/interaction-project`（PUT 带 `expectedRevision`）；Web Friend 私聊头部 `FriendProjectContext` 读写同一服务，发送新私聊轮次携带关联 revision；全局顶栏项目不再作为 Friend 私聊目标。
5. **迁移**：当前没有独立、明确且唯一的旧 per-Friend 选择来源，保持 `unset`（首次默认无协作项目），不从 `defaultProjectId`/历史/全局导航猜测。

### 证据

- `test/long-agents/interaction-project.test.mjs`（5/5）：三态与 CAS、并发写只有一个胜出、A/P↔B/Q 独立、接受冻结与 stale/divergent/unavailable 冲突、**真实 Pi 模型请求只含关联项目 P 的 AGENTS 哨兵**。
- `frontend/lib/friend-interaction-project.test.mjs`（2/2）：响应结构校验与请求只带 `projectId`/`expectedRevision`。
- `scripts/friend-project-browser.test.mjs`（真实 Chrome/CDP）：A→P、B→Q、回到 A 仍 P；从 UI 改为 Q 后关联 revision=2 且 friend2 不受影响；刷新后恢复；显式清空；旧 revision 返回 409；无身份参数泄露；模型请求含 `RULE_PROJ_P` 且不含 `RULE_PROJ_Q`。

### 门禁（A）

`pnpm verify` exit=0 → 44 tooling + **513 Backend** + **184 Frontend** + 30 生产构建 + **7 真实 dev Server**（dev E2E、SSE、群 HTTP、群浏览器两群五策略、真实模型、kill/restart、LA6 A 浏览器）。

### A 未完成/待复核

- 独立复核未做。
- 渠道 binding 的 `follow-friend` 模式仅写了合同，接线在 B；未验证的渠道来源不得继承 owner 私有项目。
- 双标签页/乱序响应的浏览器专项（当前用 CAS 与 stale 409 覆盖；双页并发浏览器需 C 的联合演练补证）。

## 后续

B（真实渠道）、C（迁移与联合故障）、D（≥24h 自然运行）、E（整体验收）未开始；真实渠道目标与长期模型预算需用户授权后才进行对应实际运行，不阻塞 A 的开发与本地验证。

**状态：A 为实施者报告完成，待独立复核；LA6 未验收。**

## A 独立复核（2026-09-21，本节优先于上文实施者报告）

结论：**A 尚未达到任务书 §3.1 的完整验收条件**。不是 B/D 外部授权阻塞；以下为 A 自身边界。

### 本轮复现并直接修复

1. 更新关联只持有 interaction 文件锁，接受消息持有 friend-accept，未共用仲裁。新增锁持有探针原实现失败；关联更新现按 friend-accept → interaction 文件锁排序，CAS、写入和返回值读取在同一仲裁内完成。
2. 接受后切换关联，再重试原 requestId，原实现先核对最新 revision 而返回 409。新增实际接受→切换→重试探针原实现失败；现先识别已接受请求，以其冻结项目计算原输入摘要，仍拒绝更改正文/项目的同 ID 请求。
3. unset 合同 revision=0，HTTP 和 AcceptedTurn 持久化解析却都要求 revision≥1。先修 HTTP 后真实验收仍返回 400，从而定位到第二层；两层现统一允许 0。增加 revision=0 持久化用例及真实浏览器脚本中的首次未选项目发送 202 断言，Chrome/CDP 专项重新通过。

永久回归：`test/long-agents/interaction-project.test.mjs` 新增 3 项；前两个用例修复前 **2/2 失败**，修复后通过；第三项覆盖 revision=0。全量结果见本节后续验证记录。

### 尚未收口的 A 项（不能计入完成）

- **兼容入口绕过关联**：持久关联 a 时，不带 interactionRevision、带 contextProjectId=b 的接受调用实际返回 b / revision=null；HTTP turns 允许省略 revision，旧 messages 入口也需统一。必须区分可信内部已冻结任务与普通私聊入口，不能用 legacy 作为普通私聊绕过关联的合同。
- **页面不同源**：AppShell 的 Sidebar.selectedCwd/selectedProjectId、resourceCwd/resourceProjectId 仍取全局 contextCwd/activeProjectId，不是所选 Friend 的关联。当前浏览器脚本只核对选择控件，未验证文件浏览器和标题。
- **慢响应与身份串线**：切换 Friend 时未立即清空旧 friendInteraction；saveFriendProject 的返回和错误恢复不检查当前 Friend，旧保存响应可覆盖新 Friend 的状态。需要按 Friend 身份/请求代次过滤响应，并在关联未加载或不可用时拒绝发送，避免降级为无 revision。
- **Agent 入口缺失**：setLongAgentInteractionProject 只有 PUT 路由调用；任务书要求的可信私聊 Agent 与 Web 使用同一服务尚未接线。需验证群上下文不能修改私聊偏好。

证据范围校正：原浏览器脚本的 A/P、B/Q 主要由 HTTP 设值和查询证明，并未实际在 UI 完成 A→B→A 导航；不能宣称已覆盖真实快切、双标签页或乱序响应。应补齐后再标 A 验收，不把这些专项全部推给 C。

### 本轮修复后的验证

`pnpm verify` 最终 exit=0：44 tooling + **516 Backend** + **184 Frontend** + 30 生产构建测试 + **7 真实 dev Server 测试**，包括真实模型、Chrome/CDP、kill/restart；dev 测试无跳过。第一次全量验证在新增 unset HTTP 用例处失败（持久化 parser 拒绝 0），修复 parser 后完整重跑通过，不以第一次失败结果作为通过证据。

`pnpm check:architecture` exit=0（973 本地链接）；父仓库及 Frontend `git diff --check` 通过。证据保存在 `.data/verification/la6-a-review/`（before/after/browser/verify 日志）。以上仅确认本轮修复及既有门禁通过，不消除上列 4 类尚未收口项；**A 未验收、LA6 未验收**。未提交、未推送、未部署。

## A 缺口修复（2026-09-21 实施者响应，待独立复核）

按本轮独立复核列出的 4 类缺口修复；复核已直接修复的 3 项（共用仲裁、接受后切换再重试、`revision=0` 解析）保持不变。

1. **兼容入口不再绕过关联**：`turns.post.ts` 与 `messages.post.ts` 对 `chat-web` 普通私聊要求 `interactionRevision`；服务端对**工作 Session 续聊**从 `sessionId` 派生冻结目标（不信任客户端声明），已接受轮次的重试用冻结值计算摘要。裸 `contextProjectId` 仅为测试/内部 seam。
2. **页面同源**：AppShell 在选中 Friend 时用其关联项目计算侧栏 cwd/项目、资源区 `resourceProjectId/resourceCwd` 与窗口标题；显式无项目仍用 Friend Workspace。
3. **慢响应与身份串线**：切换 Friend 立即清空旧关联并递增请求代次；关联读写响应仅在属于当前 Friend 时生效（`isFriendInteractionResponseCurrent`）；关联未加载/`unavailable` 时用 `friendProjectSendState` 阻止发送新私聊轮次，而不是降级为无 revision。
4. **Agent 入口**：新增 Chat 系统 Tool `collaboration_project`（read/set/clear），身份取自 `toolContext.longAgentId`，调用与 Web 相同的 `interaction-project` 服务；`CONVERSATION_SAFE_SYSTEM_TOOLS` 为空，群参与 scope 不注册任何系统 Tool，群成员无法修改私聊偏好。

### 证据（本轮）

- `test/long-agents/interaction-project.test.mjs`、`test/tools/collaboration-project.test.mjs`、`frontend/lib/friend-interaction-project.test.mjs`。
- `scripts/friend-project-browser.test.mjs` 重写为真实 UI 证据：`/turns`、`/messages` 省略 revision → 409；浏览器内 A→B→A 页面导航，逐 Friend 校验关联控件、窗口标题与**文件浏览器实际请求的目录**（`/api/files` 资源）；UI 改选、刷新、显式清空、旧 revision 409。

### 门禁（本轮）

`pnpm verify` exit=0 → 44 tooling + **518 Backend** + **185 Frontend** + 30 生产构建 + **7 真实 dev Server**（含 LA6 A 浏览器与 LA5 群/真实模型/kill-restart）。父/Frontend `git diff --check` 通过。

**状态：4 类缺口已由实施者报告收口，A 仍待独立复核；LA6 未验收。**

## A 第二轮独立复核（2026-09-21）

**结论：A 暂不验收；确认 2 项问题。** 不是重复否认上一轮修复：HTTP 缺 revision 拒绝、标题/目录同源等既有场景已独立重跑通过。但以下边界尚未成立。

### R2-P1-1：Friend 身份不等于 owner 私聊授权

`collaboration_project` 只核对 execution 和 longAgentId；runtime 对 channel/scheduled/私聊传入相同身份上下文。conversation 不注册该 Tool 只保护了 Chat 群参与，不保护普通渠道调用或后台执行。任务书 §3.1.1 明确修改偏好须来自可信私聊 owner 作用域。

独立探针使用真实 `executeLongAgentTurn` → 公共 Pi 装配 → 本地模型返回 `collaboration_project.set`，来源为 `channel` / `telegram`，没有 owner 证明。模型实际调用 Tool，将关联 a/revision1 改成 b/revision2，续轮正常完成（2 次模型请求）。不是直接构造 Tool 参数冒充另一 Friend。

修复要求：从 Backend 权威接受记录/执行来源解析管理资格，在工具实际写入服务边界核对 owner 私聊授权；无身份证明的渠道、后台、群默认拒绝。保留正常 owner 私聊和 CAS 功能，不能靠隐藏工具描述作为授权。

### R2-P1-2：改写 payloadHash 格式破坏升级后的幂等重试

`acceptLongAgentTurn` 改为 requested/frozen 两组字段计算摘要，但已接受记录没有摘要格式版本，也没有旧格式兼容。独立探针恢复上一版精确的摘要算法生成的 payloadHash，其他已接受数据保持不变；相同 requestId 和完全相同输入再次接受，返回“同一requestId包含不同消息或项目”409。原有渠道丢回执重投也会遇到此合同变化。

修复要求：给新摘要格式明确版本，按旧记录的原算法核对重试，或实施有证据的无损迁移；不能直接忽略旧摘要，也不能利用旧格式兼容放行异载荷。永久门禁应覆盖旧/新摘要、原样重试与改正文/项目/revision 的拒绝。

### 验证与证据边界

- 自建探针 `.data/verification/la6-a-round2/probe.test.mjs` **2/2 复现**（断言当前错误行为，非修复通过），日志 `probe.log`。
- 实施者现有关联与 Tool 测试独立重跑 **10/10**（`existing.log`）。
- 实施者 Chrome/CDP 脚本独立重跑 **1/1**（`browser.log`）。该脚本 A→B→A 使用 `location.href` 整页重载，不能证明同一 AppShell 内快切/在途保存/乱序响应安全。此项是证据缺口，尚未以真实 SPA 交错复现断言为新增产品故障。
- 本轮未修改运行代码，未重跑全量 verify；实施者报告的全量通过不代替上述独立复现。未提交、未推送、未部署、未发送外部渠道消息。

## A 第二轮缺口修复（2026-09-21 实施者响应，待独立复核）

按第二轮独立复核的 2 项 P1 与 SPA 证据缺口修复。

1. **Friend 身份不等于 owner 私聊授权**：`collaboration_project` 不再只看 `purpose`/`longAgentId`，而是用 `isOwnerPrivateTurn` 从**权威接受记录**解析管理资格——只有 `source=chat-web`、无 `workId`、无 `inboundEventId`（且 `channelType` 为 null/"chat-web"）的那一轮才是 owner 私聊；渠道、定时、后台与未知来源连 `read` 都拒绝。群参与仍不注册任何系统 Tool。永久门禁覆盖：真实 Pi 装配 + 本地模型在 `source=channel` 轮次里调用 `set` → 关联保持不变且模型收到拒绝；owner 私聊轮次仍可 CAS 改动。
2. **接受摘要版本化**：v1（LA6-A 前）、v2（首版 LA6-A）、v3（requested+frozen）各自保留精确字段顺序并逐版本比对；旧记录缺失版本时按各格式核对，原样重试幂等，改正文/项目/revision 在所有版本下都拒绝。新记录写 `payloadHashVersion=3`。门禁覆盖 v1 与 v2 原样重试成功、三种改载荷拒绝。
3. **SPA 交错证据**：`scripts/friend-project-browser.test.mjs` 增加同一 AppShell 内的快切与慢响应乱序——延迟 friend2 的关联 GET，在同一页面 friend→friend2→friend 快切，等慢响应到达后断言控件、标题与文件浏览器仍是当前 Friend 的关联，且慢响应未覆盖。

### 证据（本轮）

- `test/long-agents/interaction-project.test.mjs`（12/12，含两项复核探针的永久化与旧/新摘要重试）、`test/tools/collaboration-project.test.mjs`、`frontend/lib/friend-interaction-project.test.mjs`。
- `scripts/friend-project-browser.test.mjs`（真实 Chrome/CDP，含 SPA 快切/慢响应）。
- 原第二轮探针（断言旧错误行为）现 **2/2 失败**，即两项缺陷行为已消失。

### 门禁（本轮）

`pnpm verify` exit=0 → 44 tooling + **522 Backend** + **185 Frontend** + 30 生产构建 + **7 真实 dev Server**。父/Frontend `git diff --check` 通过。

**状态：2 项 P1 与 SPA 证据缺口已由实施者报告收口，A 仍待独立复核；LA6 未验收。**

## A 第三轮独立复核与直接收口（2026-09-21）

本轮不是以“旧错误探针失败”作为通过依据：独立重跑 owner/channel 正反向测试、现有关联回归和真实 Chrome SPA 测试，并针对历史摘要与在途保存新增期望正确行为的探针。

### 复现与修复

1. **v2 真实历史语义**：首版 LA6-A 在声明 revision 时哈希的是解析后的协作项目。无 contextProjectId 的原请求在关联 a 接受后升级，再切到 b，原样重试仍应返回原回执。本轮独立探针修复前失败。已按旧格式语义使用原冻结项目恢复 v2 候选；显式改投 b 仍拒绝。
2. **v1 不能忽略新 revision**：原回退算法不含 revision，导致旧请求新增 interactionRevision=999 仍被当成原样重试。独立探针修复前失败；现在仅未声明 revision 且原记录无关联 revision 才允许 v1 候选。明确 payloadHashVersion 时只核对对应版本，未知版本持久化读取拒绝，不降级猜测。
3. **在途保存后切换 Friend**：新 SPA 探针挂住 A 的 PUT 响应，再切到 B，B 的项目选择控件保持 disabled。原因是切换只清关联、未清 busy，而旧保存的 finally 按代次丢弃后也不会再清 busy。已在切换时重置 busy，旧请求仍不能更新新 Friend 的状态。修复前真实 Chrome 断言失败，修复后重跑。

前两项已转入 `test/long-agents/interaction-project.test.mjs`；第三项转入 `scripts/friend-project-browser.test.mjs`。原权限修复已通过实际 Pi 装配的 channel 拒绝与 owner 成功用例，未增加新授权旁路。

证据目录：`.data/verification/la6-a-round3/`。`before.log` 为摘要 2 项期望正确行为的失败记录；`targeted.log` 为定向 16/16 通过；`pending-save-before.log` / `pending-save-after.log` 为在途保存浏览器前后结果。最终全量状态见下文。

### A 最终收口结论

**A（Friend 协作项目关联）通过本地单 Backend 范围的独立复核。** 本轮发现的摘要兼容两处边界和在途保存 busy 问题已直接修复并进入永久门禁，不再交回下一轮处理。此前 owner/channel 权限问题也由正反向真实 Pi 调用测试确认修复。

最终 `pnpm verify` **exit=0**：44 tooling + **524 Backend** + **185 Frontend** + 30 生产构建 + **7 真实 dev Server**；包括 Chrome SPA 慢 GET/挂起 PUT、真实配置模型及 kill/restart，无跳过。最终日志 `verify-final.log`。父仓库/Frontend diff 检查通过。首次全量中的浏览器失败是新增测试拦截器拦截了第二次 PUT；限定只拦一次后专项通过，并再次完整运行 verify 后才收口。

该结论不宣称所有未知问题为零，不替代 C 的联合故障/升级场景，尤其不替代 B 的真实渠道与 D 的 24h 自然运行。**LA6 仍未验收**；下一步可继续 C 本地部分及 B 不涉及外部发送的实现。未提交、未推送、未部署。

## 工作包 C：迁移与故障联合演练（本地部分，2026-09-21 实施者报告，待独立复核）

按任务书 §4 C 的本地可做部分推进（B 的真实渠道与 D 的 24h 不在本轮）。

### 升级/回退与 ≥3 次读写交替

`test/long-agents/upgrade-joint-cycles.test.mjs`（真正旧结构 fixture）：

- fixture 使用 **pre-split registry**（definition 内联）、`daily-<id>` 旧项目、旧 `long-agent-state` 的 `projectAgents/bindings`、旧 session 文件与旧 `.chat` 工程根，而不是对当前新格式重复 no-op 迁移。
- 连续 3 个循环：跑 `migrateLegacyProjectLayout` + `migrateAgentHomeNormalization`，每次前后比较群记录的所有权/成员/授权修订/策略；中间执行真实新写入（CAS 改名）与读取（旧只读历史、registry、state、项目注册表）。断言：任何一次迁移都不改变群归属与授权、不扩宽 Agent tools、旧 session 字节不变、旧项目仍登记、`daily-*` 旧记录可解析（缺 `collaborationProjectId` → `null`）。
- 迁移冲突保留原件且不标完成：制造真实目标文件冲突 → 迁移拒绝、写前旧文件与新文件都保留、无 `done-v2.json`；修复后重试完成且同一迁移再次为 no-op。
- 旧 state 升级保留渠道 binding 与来源，不打开空日；旧历史保持只读且新日不复用它。

### 故障注入与并发

`test/long-agents/fault-recovery-joint.test.mjs`：

- **断网/恢复**：模型连接被中途断开 → turn 终态 `failed` 且带原因；用户显式 retry 后 `completed`，用户消息仍只有一条。
- **并发文件编辑**：同一 `expectedRevision` 的 5 个并发 `updateConversation` 只有一个成功（其余 409），最终记录可解析、归属/授权不变。
- **私聊 + 群讨论 + 后台任务并行**：三者同时运行，各自独立 Session 到达终态；私聊 Session 不含群/任务正文，群公共投影含群与任务结果、不含私聊正文。

### 已有覆盖（不重复造）

- 执行中断/重启：`scripts/group-recovery-restart.test.mjs`（真实 SIGKILL → running `interrupted` 不重放、queued 恢复）。
- 取消/预算耗尽/迟到结果：`conversation-execution-protocol.test.mjs`。
- 产物提交前后校验与恢复：LA4 门禁。
- 失败升级的多类阻止（文件冲突、符号链接、损坏记录）：`test/long-agents/migration.test.mjs`。
- UI 终态：LA5/LA6 浏览器套件验证群讨论、任务的 `completed` 等终态。

### 门禁（本轮）

`pnpm verify` exit=0 → 44 tooling + **530 Backend** + 185 Frontend + 30 生产构建 + 7 真实 dev Server。

### C 未完成（不按通过使用）

- **回退/降级实演**：目前证明“迁移冲突不写完成标记且可重试”，尚未实演受支持的回退路径；任务书要求“回退失败明确阻止”，需在 C 收口时给出明确的可回退范围。
- **UI 终态专项**：上一项断层后的浏览器终态断言（升级/ kill 后打开页面看到正确终态）未单独做，当前由 LA5/LA6 浏览器套件与 HTTP 恢复共同覆盖。
- **统一诊断证据**：跨 daily/tasks/duties/artifacts/group 的一页式兼容表与诊断入口尚未落文档。

**状态：C 本地部分已由实施者报告推进，仍待收口与独立复核；LA6 未验收。**


## C 本地第一批独立复核（2026-09-21）

原有两文件 6 项测试独立重跑 6/6。发现两处证据不足并已直接补强，未改业务运行逻辑：

- 原 fixture 使用当前写入服务，实际上已拆分 definition、state 已是 schema 5，不能证明 pre-split 与旧 state 升级。现在 fixture 最后直接写入内联 definition 的原始 registry 与 schema 3 state，并在首次读取前断言独立 definition 文件不存在。迁移后断言 split 标记迁移了 friend、备份保留内联 definition，以及 state 升为 5 且 source 备份确为 3。
- 原 Promise.all 只保证等待三路结果，不能证明实际并行。现在模型响应屏障要求 private/group/work 三种请求同时进入后才释放，并明确核对三种 Session ID 两两不同。超时返回模型错误使测试失败，不以串行成功充当并发证据。

冲突测试的准确结论是“保留双方原件、不写完成标记、修复后可重试”，不承诺整个迁移事务无任何部分写入。当前实现允许已复制文件留待重试；这不是新增运行缺陷，不能把现有断言夸大为回滚/降级验收。

C 仍为部分完成，原报告列出的回退/降级、升级或 kill 后浏览器终态、统一兼容/诊断表继续保留。已有单项门禁是否覆盖联合场景须在兼容表逐项映射，不能只列测试名。证据：`.data/verification/la6-c-review/`；本轮未发送外部消息，未提交、推送、部署。

本批复核后 `pnpm verify` **exit=0**：44 tooling + **530 Backend** + **185 Frontend** + 30 生产构建 + **7 真实运行验收**，无跳过。补强后的旧格式磁盘/备份与三路实际重叠断言包含在本次完整门禁中。父仓库和 Frontend `git diff --check` 通过。**C 本地第一批证据通过复核；C 尚未收口，LA6 整体未验收。** 下一步仍按上列三个未完成项推进。

## 工作包 B：外部渠道代码与本地故障测试（实施者报告，待独立复核）

本轮完成可独立于真实平台的 B 代码与本地故障门禁；真实平台收件证据仍需用户提供测试平台/账号/群授权后补。

### 代码

- **绑定**：`src/long-agents/conversations/channel.ts` 的 `ConversationChannelBinding`（`conversations/<id>/channels.json`，revision CAS）。只接受 owner 管理入口（HTTP `channels.post.ts` / 未来 Tool）调用，校验「主动 Friend 是当前成员 + NanoClaw 实例存在」，记录 Friend 的 `agentGroupId`、外部目标与 `botPlatformId`；普通外部消息不能创建绑定、owner 或扩大授权。
- **入站**：可信 NanoClaw 入口 `POST /api/internal/channel/v1/conversation-events`（沿用既有 Channel 服务认证中间件）。事件只按 `bindingId` 路由到已存在且 active 的绑定；按 `eventId`/`(bindingId, externalMessageId)` 幂等去重；丢弃 Friend 自己的 bot 身份回环；把外部人类消息以 `chat.group-external-message.v1` 追加到公共根，**保留真实发送者 id 与显示名**，公共投影标记 `external`。
- **模型输入**：编排的公共输入把外部发送者标为「外部发送者 <name>（<id>，未经本地用户验证）」，作为带来源的数据而不是本地 owner 指令。
- **出站**：`deliverConversationPublication` 对每个 active 绑定按 `deliveryId = hash(publicationId, bindingId)` 投递（平台幂等键 `messageId = deliveryId`），投递记录 `deliveries.json`（pending/delivered/failed/unknown）。只投递公共引用正文，绝不投递私有推理/工具结果/参与 Session 草稿。`drainConversationDeliveries` 只重试 `pending/failed`，`unknown` 保留待人工核查、不自动重发；重试复用同一 `messageId`，不重新调用模型。
- **失败语义**：解绑/未绑定/服务不可用/明确拒绝分别落到「拒绝接收」「failed」「unknown」，界面不假报送达。

### 本地故障门禁

`test/long-agents/conversation-channel.test.mjs`（3/3，本地假 Nano 网关）：
- 入站保留真实发送者、按稳定 id 去重（同 eventId 与同 externalMessageId 均不重复追加）、不触发模型、bot 回环被丢弃、未绑定目标明确拒绝且不产生 owner/条目。
- 出站使用稳定 `messageId`；丢 Ack → `failed`，重试复用同一 id 且模型调用数不变；网关不可用 → `unknown` 且不自动重发；解绑后不再投递且不伪造 delivered。

### 真实平台边界（未完成）

- 真实 Telegram（或其他选定平台）私聊/群收件、发送回执与稳定幂等键的真机证据未做，需要用户授权的测试账号、测试群/收件人与消息范围。
- 群适配若需平台特定权限/身份字段，按任务书在 B 短设计列出最小范围后再实现。

## 工作包 C：本地联合验证收口（实施者报告，待独立复核）

- **回退/降级**：`upgrade-joint-cycles.test.mjs` 增加未来 state schemaVersion 与未来迁移标记 → 明确拒绝、数据不动；删除完成标记后重跑不产生部分重映射。
- **UI 终态**：`scripts/group-recovery-restart.test.mjs` 增加真实 Chrome 断言——SIGKILL/重启后，中央群聊显示讨论 `interrupted`、恢复的后台任务 `completed`，不重放被杀调用。
- **统一兼容表**：本节与升级测试共同构成 daily/state/定义/群/渠道的升级-回退兼容边界；`daily-fixture` 与新 legacy fixture 的失败路径都已失败关闭。

### 门禁（B/C 本轮）

`pnpm verify` exit=0 → 44 tooling + **535 Backend** + 185 Frontend + 30 生产构建 + 7 真实 dev Server（含 kill/重启浏览器终态）。

**状态：B 代码与本地故障测试、C 本地收口均为实施者报告，待独立复核；真实渠道与 24h 归 D/E；LA6 未验收。**

## 工作包 D：24h 自然运行的准备（未启动真实窗口）

真实 24h 窗口需要实际经过的时间、常驻隔离栈、真实 Nano 时钟/触发与真实模型额度；本轮不伪造、不加速，只交付可重入收集器与确定性门禁，等待用户环境/授权后启动。

- **收集器**：`scripts/la6-acceptance-ledger.mjs`（`init/sample/record/status`），账本在 `<CHAT_HOME>/runtime/la6-acceptance/ledger.json`，跨会话可续写。记录候选指纹（父仓库 + 三个 Submodule 的 HEAD/脏文件数）、资源采样（RSS/uptime/load/磁盘）、业务发生（occurrence/work/artifact/delivery/restart/disconnect）。
- **判定**：`evaluateLedger` 只在「真实经过 ≥24h **且** 跨当地日期边界 **且** 四个自然窗口都有采样 **且** 每个预期发生都有 success/approved-skip 终态」时判 pass；失败/未知/未发生都会使 pass=false。
- **确定性测试**：`scripts/la6-acceptance-ledger.test.mjs`（2/2），已加入 `pnpm test:tooling`。
- **启动方式（待执行）**：
  ```bash
  CHAT_HOME=<隔离Home> node scripts/la6-acceptance-ledger.mjs init --expected <预期发生清单.json>
  # 常驻栈运行期间按计划采样与记录：
  CHAT_HOME=<隔离Home> node scripts/la6-acceptance-ledger.mjs sample
  CHAT_HOME=<隔离Home> node scripts/la6-acceptance-ledger.mjs record --json '{"kind":"occurrence","expectedId":"2026-09-21#morning","outcome":"success"}'
  CHAT_HOME=<隔离Home> node scripts/la6-acceptance-ledger.mjs status
  ```

## 工作包 E：整体验收状态表（未验收）

真实渠道（M4/M5 真机）、24h（M11）与真实 Nano 时钟触发仍是阻塞；以下如实标注，不把实施者报告当独立验收。

| ID | 场景 | 状态 | 证据/说明 |
|---|---|---|---|
| M1 | A/P↔B/Q、穿插普通/群、重启不串 | 通过（A 复核） | `friend-project-browser`、`interaction-project`、真实模型哨兵 |
| M2 | 显式 null/失效/快切/双页/旧 revision/发送后切页 | 通过（本地） | CAS、SPA 慢响应交错、浏览器；双标签页真机未单列 |
| M3 | 私聊/群/后台同一 Friend、独立 Session | 通过 | A 模型哨兵、LA5、C 联合运行 |
| M4 | 真实渠道收发与群绑定、外部发送者不变 owner、bot 不回环 | **未测（真实平台）** | 代码+本地假网关通过；真实 Telegram 待授权 |
| M5 | 入站重复/丢 Ack/结果未知/解绑/撤权 | 本地通过 | `conversation-channel.test.mjs` |
| M6 | 三项学习职责可配置/暂停/恢复/缺资料等待 | 通过（LA3 复核） | LA3/LA4 门禁 |
| M7 | 自然 3+1 动态与笔记、日期时区来源 | 通过（LA4 复核） | 整天自然运行归 M11 |
| M8 | 群与职责/任务并发、预算耗尽/取消/平台失败 | 本地通过 | LA5 门禁 + C 联合运行 |
| M9 | Backend/Nano 重启、在途被杀、断网、跨日轮换 | 本地通过 | `group-recovery-restart`（含浏览器终态）、断网恢复；真实 Nano 时钟待 D |
| M10 | 旧日常/任务/职责/产物/群升级 ≥3 次读写交替、回退阻止 | 通过（本地） | `upgrade-joint-cycles` |
| M11 | 真实 24h 自然运行（起止/指纹/采样/发生账本） | **未测** | 收集器就绪；待真实时间与额度 |
| M12 | 构建/启动/停止/升级可重放 | 部分 | `pnpm verify` exit=0 + 文档；真实运行命令待 D |

- **真实平台矩阵**：Telegram（优先）未真机；其他平台未支持，群外部投递能力在群 scope 被显式拒绝，不宣称已支持。
- **未支持边界**：真实外部群投递、24h 自然运行、真实 Nano 到点触发；这些不因本地模拟或 `pnpm verify` 全绿而视为通过。
- **清理**：未提交、未推送、未部署；验收使用隔离 Home 与临时端口，未向正式 feed/群发布内容。

**状态：LA6 A 通过复核；B/C 为实施者报告待复核；D 收集器就绪但 24h 未运行；E 未验收。**

## B/C/D 本地独立复核（2026-09-21，本节校正“仅剩授权”的报告）

**结论：C 本批新增本地门禁通过；B 代码闭环和 D 收集器尚未通过复核。当前不只是缺真实账号/额度，仍有 4 类本地问题。** 未改业务运行代码，未向外部平台发送消息。

1. **B-P1 运行链未接完。** `dispatch.ts` 只有 `deliverConversationPublication` 导入，没有调用。独立探针经真实公共 Pi 装配执行群讨论，公共投影已含回复，但假网关调用 0、delivery 记录 0。Nano 源码中也未找到新 `conversation-events` 路径的调用/绑定路由；新 Backend 接收路由的存在不等于 Nano 平台入站已接通。需要完成 Nano 入站适配、耐久派发/恢复及普通群发言的出站调度，再用本地端到端假适配器验证整链。
2. **B-P1 公开引用和授权边界不闭合。** 首次 `deliverConversationPublication` 信任调用方 text 和 publicationId，不读公共引用、不核对当前群/成员；独立探针以不存在的 publicationId 和任意正文仍被送到网关并标 delivered。另一个探针先归档群，再接受外部消息，仍返回 appended=true。入站绑定检查也位于公共根锁外，尚无解绑交错保护。修复应将正文从当前授权公共引用解析，并使归档/撤权/解绑与实际追加/派发形成明确仲裁；不能仅在重试路径核对引用。
3. **B-P1 持久化确认被当成平台送达。** `sendNanoClawAgentMessage` 只验证 persisted/messageId/nanoSessionId，调用方即写 delivered。Nano 的 `deliverSessionMessages` 可因已有在途投递直接返回，也会捕获平台投递失败后安排重试；因此 proactive HTTP 返回不是平台 Ack。当前测试的“no-ack”只是删掉 HTTP 持久化字段，不是丢平台回执。需要区分已入队/未知/失败/平台确认送达，查询或回传 Nano 耐久投递事实；回执丢失不得伪造 delivered 或把不确定结果冒充确定失败。
4. **D-P1 可无有效运行证据而通过。** 独立 probe 将 startedAt 设为 23:59，四个样本全部在同日启动前，expected=[]、records=[]；24h 后 evaluateLedger 仍 passed=true。脚本仅采集自身进程 RSS/uptime，未验证 Backend/Nano 存活、采样连续性、候选内容不变及业务 ID 对应耐久终态；指纹也只有 HEAD 和 dirty 数量。不能称“D 收集器就绪”。须限定有效时间范围、按实际运行区间生成自然窗口、冻结非空场景/发生清单、绑定运行候选与服务采样、核对业务事实和采样空洞；测试时钟与真实验收入口应区分。任意 startedAt/now 不能当作真实经过时间的证明。

### 独立证据

- `.data/verification/la6-bcd-review/channel-probe.test.mjs`：原渠道 3 项通过；自建 3 项分别复现未自动投递、伪引用送达、归档后入站。后 3 项断言错误现象，不是修复通过。
- `ledger-probe.mjs` / `ledger.log`：4 个启动前样本、0 条业务记录，结果 passed=true。
- C 升级/联合故障 + 账本现有测试 **10/10** 独立重跑通过（`local.log`）。
- SIGKILL/重启 + Chrome 终态专项 **1/1** 通过（`restart-browser.log`）。C 的回退证据准确范围仍是“拒绝不支持的未来格式且保留数据”，不是已证明旧版本二进制能打开升级后的 Home。
- 本轮未重跑全量 verify，未以实施者的全量结果作为独立验收结论。未提交、推送、部署。

下一步应先整批修复上述本地 B/D 问题并增加真实调用链门禁；平台授权仅阻塞真实发送，不能作为本地未完成的理由。D 正式 24h 运行必须在 A–C 候选版本和收集器通过后开始，E 保持未验收。

## B/D 本地复核缺口修复（2026-09-21 实施者响应，待复核）

按第二轮 B/D 独立复核的 4 类问题修复；复核探针的“错误行为”断言现已反转（3 项失败），账本探针的 `passed=true` 也已失败。

1. **运行链接通**：`dispatch.ts` 与 `work.ts` 现在 **await** `deliverConversationPublication`（此前只有 import，且 fire-and-forget 让即时断言看不到调用）；群发言发布后必然产生投递记录。新增端到端本地链路门禁 `test/long-agents/conversation-channel-chain.test.mjs`：可信入站路由 → 公共根（真实发送者）→ 真实 Pi 群讨论 → 假网关收到公共引用正文 → `queued` → 平台回执路由 → `delivered`。
2. **引用与授权闭合**：`deliverConversationPublication` 只接受 `publicationId`，正文一律从**当前授权公共投影**重解析；不存在的引用/任意正文在调用网关前被拒（409），归档群拒绝投递。入站把生命周期/绑定复核移到**公共根锁内**，归档拒绝、解绑与实际追加形成同一仲裁。
3. **持久化 ≠ 平台送达**：新增 `queued` 状态；`sendNanoClawAgentMessage` 的 HTTP 200 只记 `queued`（Nano 已持久化），只有可信回执路由 `POST /api/internal/channel/v1/conversation-deliveries`（Channel 服务认证）能把投递标为 `delivered`/`failed` 并记录 `platformMessageId`；迟到 `failed` 不能覆盖已确认 `delivered`；`drainConversationDeliveries` 只重试 `pending`/`failed`，不回退 `queued`/`unknown`。
4. **24h 账本判定收紧**：只统计运行区间内的样本；按实际运行区间生成必需自然窗口；要求非空 `expected` 与 `records`、Backend/Nano 存活采样、采样空洞检测、候选指纹一致、未知 expectedId 拒绝；`status` 只用真实时钟，`--now` 不再可伪造。复核探针（启动前样本 + 空清单）现在 `passed=false`。

### 门禁（本轮）

`pnpm verify` exit=0 → 48 tooling（含账本 4 项）+ **537 Backend** + 185 Frontend + 30 生产构建 + 7 真实 dev Server。

### B 仍未完成（不按通过使用）

- **Nano 侧真实适配**：平台群入站需要 Nano 把外部群消息按其目标绑定转发到 `conversation-events`，并把平台投递事实回传到 `conversation-deliveries`；当前只验证了 Chat 侧入口与本地假适配器整链，Nano 源码尚未接这两条路径。
- 真实平台（Telegram 等）收件/回执证据仍未做，需用户授权测试账号/群/收件人。
- 普通群发言的 Workflow 派发入口（策略启动、预算）属 C/D 编排；本轮补的是发布后的出站调度。

**状态：B 的 4 类本地缺口已由实施者报告收口，Nano 侧适配与真实平台待续；C 通过本地复核；D 账本判定已修复但仍未运行真实 24h；LA6 未验收。**

## B/D 第二轮独立复核（2026-09-22）

**结论：上轮的普通发言出站接线与首次公开引用核对已补上；仍确认 2 类阻断项，Chat 侧 B 合同与 D 收集器尚不能验收。** Nano 真实适配仍未完成是已披露的独立待办，不再误称仅缺平台授权。

### B-R2-P1：平台回执与 HTTP 返回没有共同的状态转换约束

独立探针在假网关收到请求后、返回 persisted HTTP 200 之前调用真实 `confirmConversationDelivery`，得到 delivered/platformMessageId；HTTP 随后返回，`recordDeliveryResult` 无条件写回 queued，最终成为 queued + 已有 platformMessageId。此后再次调用 `deliverConversationPublication`，因为入口只跳过 delivered/unknown，queued 又被置 pending 并第二次调用网关。

这不是要求模型或平台提供特殊行为：平台投递可在 HTTP 响应回到 Chat 前完成，Nano 在途/补发也可能再次触发相同提交。只让“迟到 failed 回执不覆盖 delivered”不足以闭合全部写入入口。

修复应在同一耐久状态锁内执行准入与状态转换：queued/delivered/unknown 不得由普通重入重发；pending 的并发在途与崩溃恢复需明确区分；HTTP 结果不能回退已收到的平台终态。重试轮次需要关联 attempts/版本，拒绝陈旧结果覆盖当前状态。测试须覆盖回执先/HTTP 先、并发重复、queued 重入、恢复与旧结果迟到，而不是只反转一个探针断言。

### D-R2-P1：有效观测与候选一致性仍可误判

分别构造四个独立边界，均得到 passed=true：

1. 样本每 10 分钟覆盖到第 23 小时，此后最后 1 小时没有任何采样。只检查了起点和样本之间空洞，漏掉末样本到评估时刻。
2. 全程 145 个样本，Backend/Nano 仅第一个为 true，其余均为 false。当前只要求存活样本计数大于 0。
3. 业务 success 记录时间为 2099 年；记录未像 samples 一样限制运行区间，也未核对耐久业务事实。
4. parentHead 相同但 Pi 子模块 HEAD 已变化；仅比较 parentHead 会放过已改变的候选。当前 fingerprint 还未覆盖 dirty 内容哈希。

另外 CLI 的服务状态仍来自 `--services` JSON，未实现实际服务探测；资源统计仍是收集器进程，且场景/业务记录可人工声明。应把“判定辅助函数”与“真实验收采集器”状态分开：先实现实际探测、完整候选/运行实例绑定、发生 ID 的终态核验，再标 D 就绪。24h 实际运行仍未开始。

### 本轮证据范围

- `.data/verification/la6-bd-round2/channel-probe.test.mjs`：现有渠道 4 项通过，新增探针实际复现回执回退与 queued 重发（错误现象断言，不是修复通过）。
- `ledger-probe.mjs` / `ledger.log`：四个单独边界及合并场景均误通过。
- 现有本地整链 + 账本测试独立重跑 **5/5**（`existing.log`）。连同渠道 4 项共 **9 项既有测试通过**，但不覆盖上述交错与观测边界。
- 本轮未修改运行代码、未重跑全量 verify、未实际发送渠道消息；未提交、推送、部署。A 与 C 已有结论不回退，B/D/E 及 LA6 整体验收继续未完成。

## B/D 第二轮缺口修复（2026-09-22 实施者响应，待复核）

按第二轮 B/D 独立复核的 2 类阻断修复；其四边界探针与回执探针现均反转（断言错误行为的测试失败）。

### B：投递状态统一转换与并发/恢复准入

- **单一状态转换**：新增 `guardDeliveryTransition`，`delivered` 是平台确认事实，任何后续 HTTP/持久化写入都不能把它降级；`unknown` 不会静默回退成会触发自动重发的状态。`recordDeliveryResult` 与 `confirmConversationDelivery` 都走它。
- **每投递串行**：新增 `withDeliveryLock(deliveryId)`，发送、重试与回执都在同一把锁内决策，回执不再与在途发送竞态；`queued`/`delivered`/`unknown` 一律不再重发。
- **在途与崩溃恢复区分**：投递增加 `attemptToken`/`claimedAt`；发送前领取带令牌的 `pending`，结果写回只在令牌未变时生效（陈旧结果被丢弃）。`recoverConversationDeliveries` 把超过阈值的 `pending` 标记为 `unknown`（结果待核查，不重发），`drainConversationDeliveries` 先恢复再只重试 `pending`/`failed`。
- 门禁：`conversation-channel.test.mjs` 6/6，覆盖回执先于 HTTP 返回、并发重复调用只发一次、queued 重入不重发、崩溃恢复后陈旧结果不回退、回执迟到不覆盖 delivered。

### D：真实探测、候选绑定与事实核验

- **实际服务探测**：`probeServices` 默认探测 Backend `/api/health` 与 Nano `/v1/health`；`sample` 不再依赖人工 `--services` JSON（仍可显式覆盖）。
- **完整候选绑定**：指纹增加每个 Submodule 的 `dirtyHash`（工作区差异内容哈希）与 parent `dirtyHash`；`sameCandidate` 要求 parent、各 Submodule HEAD、脏文件数与差异哈希全部一致，仅 HEAD 相同不再算同一候选。
- **观测边界**：只统计运行区间内样本；补上“末样本到评估时刻”的尾部空洞；要求**每个**采样都观测到 Backend/Nano 存活；运行区间外的业务记录（含未来）直接判失败。
- **事实核验与判定分层**：`evaluateLedger` 的纯数学判定可与真实验收入口分开；`status` 以 `requireVerified` 运行，要求每个预期发生都有与记录一致的耐久业务事实（`--facts`），缺失即失败。因此人工声明不能作为 24h 通过证据。
- 门禁：`la6-acceptance-ledger.test.mjs` 7/7，覆盖四个复核边界、候选脏内容漂移、requireVerified 正反例与真实健康探测。

### 门禁（本轮）

`pnpm verify` exit=0 → 51 tooling + **539 Backend** + 185 Frontend + 30 生产构建 + 7 真实 dev Server。

### 仍未完成（不按通过使用）

- **Nano 侧真实适配未接**：平台群入站需 Nano 按目标绑定转发到 `conversation-events`，平台投递事实回传 `conversation-deliveries`；当前只验证 Chat 侧与本地假适配器整链。
- D 的实际服务探测与事实核验入口已就绪，但 `--facts` 仍需操作者从 Backend 耐久事实生成；**真实 24h 窗口未运行**，E 未验收。

**状态：B/D 第二轮阻断已由实施者报告修复，Nano 适配与真实平台/24h 待续；LA6 未验收。**


## B/D 第三轮独立复核（2026-09-22）

结论：尚不能确认本轮阻断全部关闭。A 既有验收不变；B 的 Nano 真实适配、D 实际 24h、E 仍未完成。本轮未修改运行代码、未运行外部渠道、未提交或部署。

### 1. P1：发送长锁使早到回执等待 HTTP 完成

`deliverToBinding` 在 `withDeliveryLock` 内等待网关 HTTP；`confirmConversationDelivery` 也要同一把锁。独立探针让网关在回复 HTTP 前等待回执，回执无法完成；探针在 300ms 后主动释放 HTTP，回执才成功。不是把测试超时当作修复失败：探针正常清理完成，正向断言失败。若适配器等待回执确认后才回复发送请求，形成循环等待，直到某侧超时。现有门禁先 `gateway.release()` 再 await 回执，只证明最终状态，不证明“回执先于 HTTP 返回完成”。

修复要求：短锁原子领取 attempt 后释放锁再做远端 I/O，结果以 attemptToken CAS 写回；回执走短状态转换锁。并发重入必须识别已领取的 pending，不另发；恢复失效令牌（含 null）必须拒绝旧结果。不要靠要求回执绕开发送请求来掩盖双方协议依赖。

### 2. P1：候选指纹遗漏未跟踪文件正文与暂存差异

`dirtyHash` 只读取 `git status --porcelain` 与 `git diff`。临时独立 Git 仓库中，新文件同一路径正文从 `value=1` 改为 `value=2`，直接执行源码中的 hash 函数，两次哈希完全相同。未跟踪文件和仅暂存的变更正文没有被覆盖。当前大量新增代码尚未提交，此缺口直接影响 24h 候选固定。

修复要求：覆盖 HEAD/index/worktree 与未跟踪源码内容（明确排除运行数据和凭据），读取失败不得生成可通过的指纹；旧账本缺少必需指纹字段应拒绝验收。

### 3. P2：业务事实核验仍是两份人工字符串比对

`status --facts` 只读取 JSON 并传给 `verifiedOccurrences`；没有解析 occurrence 对应的耐久对象、终态、时间、版本或候选来源。独立纯判定探针在合成有效采样上提供从未执行的 `never-executed`，账本与手写 facts 都声明 success，`requireVerified:true` 仍返回 passed。此证据只证明核验器接受无来源声明，不代表执行过真实 24h。

修复要求：补只读耐久事实导出/校验入口，将 expectedId 映射到实际 duty/task/discussion/delivery/artifact 等对象，校验终态与运行区间。外部 facts 可作输入，但不能把未经核验的字符串称为已核验事实。未接好前只能报告“清单一致”，不能报告 D 验收就绪。

### 4. P2：现有账本测试依赖执行当天，独立重跑失败

原有 13 项（渠道 6、账本 7）本轮重跑为 **12 通过、1 失败**。`an uncovered window or an unexplained occurrence fails the run` 使用固定的 2026-09-22 01:00 UTC 评估时刻，但后半段 appendRecord 未传时间，取执行时钟；本轮已超过固定评估时刻，新增记录被正确判为区间外，断言失败。应给所有合成发生传固定且属于测试区间的时间，不放宽生产的时间校验。此前的 verify 通过只能代表当时运行结果。

### 独立证据

- `.data/verification/la6-bd-round3/channel-probe.test.mjs` / `channel.log`：1 个正向断言失败，回执须等 HTTP 释放；无悬挂测试。
- `.data/verification/la6-bd-round3/fingerprint-probe.mjs` / `fingerprint.log`：独立临时仓库，新文件正文变化却哈希不变。
- `.data/verification/la6-bd-round3/facts-probe.mjs` / `facts.log`：无耐久对象的手写 success 映射仍获 passed。
- `.data/verification/la6-bd-round3/existing.log`：现有 13 项 12/13；本轮未重跑全量 verify，不沿用实施者门禁作为本轮独立通过证据。

下一步：将短锁发送协议、完整指纹、耐久事实核验及时间独立测试整批修复，再接 Nano 适配；真实平台需明确测试目标和发送授权，真实 24h 不能由上述合成探针替代。

## 第三轮缺口修复 + Nano 侧适配（2026-09-22 实施者响应，待复核）

按第三轮 2×P1、2×P2 修复，并补齐 Nano 侧会话渠道适配；三个独立探针现均通过（不再复现缺陷）。

### P1：发送改为短锁 + attemptToken CAS

- `deliverToBinding` 拆为两段短临界区：领取 attempt（写 `pending` + `attemptToken` + `claimedAt`）后立即释放锁，远端 HTTP 在锁外执行，结果再以 `attemptToken` CAS 写回。回执只走短状态转换锁，因此**回执可在网关 HTTP 返回前完成**，不再循环等待。
- 并发重入：`claimDeliveryAttempt` 只在 `failed`/不存在时领取，已领取的 `pending` 直接返回，不重发。
- 恢复失效令牌（含 `null`）后，旧结果因 CAS 不等被丢弃；`recoverConversationDeliveries` 把超时 `pending` 转为 `unknown`。
- 门禁：`conversation-channel.test.mjs` 6/6；第三轮渠道探针“回执先于 HTTP 返回”通过。

### P1：候选指纹覆盖未跟踪/暂存内容

- `dirtyHash` 覆盖 `git diff HEAD`（暂存+未暂存）、`status` 与**未跟踪源码正文**（`git hash-object --stdin-paths` 批量、单次进程），并排除运行数据/凭据；读取失败抛错而不是生成可通过指纹。
- `candidateComplete` 要求 parent/各 Submodule 的 HEAD、脏文件数与 `dirtyHash` 完整；旧账本缺少必需字段直接判为候选不一致。
- 门禁：`la6-acceptance-ledger.test.mjs` 8/8；第三轮指纹探针（新文件正文变化必须改变哈希）通过。

### P2：耐久事实核验替代字符串比对

- 新增 `resolveDurableFacts(chatHome, records)`：按 `record.durableRef` 读取真实耐久对象（当前支持 `delivery`：Chat 会话投递记录），导出 `{status, at, source}`；未知 kind/缺失对象解析为空。
- `evaluateLedger` 的 `requireVerified` 改用 `verifiedFacts` 对象：必须 `status==="success"`、`at` 落在运行区间、且带非空 `source`；手写 `success` 字符串无法通过。`--facts` 现在只提供 durable 引用，不再提供状态。
- 门禁：账本测试含“手写字符串被拒”与“耐久对象解析”两项；第三轮 facts 探针不再误通过。

### P2：账本测试与执行时钟解耦

- `an uncovered window or an unexplained occurrence fails the run` 的后半段发生补上固定的测试区间时间，不再取执行时钟；生产时间校验不放宽。

### Nano 侧适配（`nanoclaw/` 子模块）

- 迁移 v4：`chat_conversation_channels`、`chat_conversation_inbound`、`chat_conversation_receipts` 三张表。
- 新模块 `conversation-channels.ts`：Chat 通过网关 `POST /webhook/chat-backend/v1/conversation-channels` 下发 `bind`/`unbind`；`findConversationChannel` 按 `agent_group_id + channel_type + platform_id/messaging_group_id` 路由入站。
- 入站：`registerRoutedMessageHook` 命中绑定后写入耐久 `chat_conversation_inbound`，再由 `flushConversationOutbox` POST 到 Chat `/api/internal/channel/v1/conversation-events`（失败退避重试），且不再重复写常规 Session 事件。
- 出站回执：`delivery.ts` 的投递成功/永久失败钩子携带 `platformMessageId`；`cdel-` 消息写入 `chat_conversation_receipts` 并 POST 到 `/api/internal/channel/v1/conversation-deliveries`。`delivered` 为终态，迟到 `failed` 不覆盖。
- Chat 接线：owner `bind`/`unbind` 后由 `syncNanoClawConversationChannel` 镜像绑定到 Nano（best-effort，返回 `nanoClawSynced`）。
- 门禁：Nano `conversation-channels.test.ts` 4/4（路由、幂等、断网留队、回执终态）；Chat `conversation-channel-sync.test.mjs` 1/1（bind/unbind 真实下发）。Nano `tsc --noEmit` 通过，`src/modules/chat-integration` + delivery 相关 15 文件 81 项通过。

### 门禁（本轮）

`pnpm verify` exit=0 → 52 tooling（账本 8 + 渠道 6 + 同步 1 等）+ **540 Backend** + 185 Frontend + 30 生产构建 + 7 真实 dev Server。工具链使用 `--test-concurrency=1` 以避免真实 launchd/多进程门禁在并行下的超时抖动（单测仍各自通过）。

### 仍未完成

- **真实平台未接**：Telegram 等真实收件/回执需要用户授权的测试账号、群与收件人；本轮只验证本地假适配器整链与 Nano 耐久适配。
- D 的 `resolveDurableFacts` 目前接入 `delivery` 一种耐久对象；duty/task/discussion/artifact 的只读核验入口尚未接入，未接好前只能报告“清单一致”。
- **真实 24h 未运行**；E 未验收。

**状态：第三轮 P1/P2 已修复，Nano 侧适配已落地并本地验证；真实平台与 24h 验收待用户授权，LA6 未验收。**


## B/D 第四轮独立复核（2026-09-22）

结论：上一轮 Chat 发送长锁、未跟踪正文指纹与日期依赖测试已通过本轮针对性复验；手写状态字符串不再作为 CLI 事实来源。D 仍仅支持 delivery 事实，不能据此验收其他职责/任务或 24h。新增 Nano 适配独立复现 **2 类 P1（3 个正向探针失败）**，B 尚未验收。A 的既有验收不变。

### P1：Nano 回执升级可能永久停留在旧事实

有两个独立发生顺序：

1. failed 已上报并获得 Backend Ack，再 enqueue delivered：更新 payload 未清空 accepted_at，flush 查询只取 accepted_at IS NULL，成功事实不再发送。
2. failed HTTP 正在发送，期间 enqueue delivered，再收到旧 failed 请求的 Ack：markOutboxAccepted 只按 deliveryId 标记，不校验发送版本，将尚未上报的 delivered 一并标为已确认。

两个探针均期望 Backend 收到第二次 delivered，实际调用数只有 1。用户会看到失败/待确认而平台实际已成功，也可能影响后续重试决策。现有“delivered 不被 failed 覆盖”只保护存储状态，不能替代 outbox 版本确认协议。

修复要求：回执 payload 使用单调版本或摘要；状态升级原子更新并重置待确认状态；发送冻结版本，Ack/失败退避仅 CAS 更新同版本。并发 enqueue 也应由单一事务或数据库条件更新保护，不以无锁 SELECT→UPDATE 推断 delivered 单调性。

### P1：Nano 入站路由忽略话题边界

绑定记录保存 threadId，但 findConversationChannel 的参数与 SQL 都不匹配 threadId，RoutedMessageHook 也未传入实际话题。独立用例绑定 Telegram 群 topic=10，再查同群 topic=20，仍返回 topic=10 的绑定。未授权话题消息因此可能进入该 Chat 群公共根，回复再发往绑定话题。

修复要求：使用可信平台路由中的 instance/channel/group/thread 完整地址匹配；明确 null 是无话题还是通配，不能默认为任意话题。若当前不支持话题，应在创建绑定时明确拒绝非空 threadId，不能接受后忽略。补双话题、同群多绑定以及未命中行为测试。

### 尚待补齐的接线与验收范围（不冒充新复现）

- 绑定同步目前 best-effort，无耐久同步状态。channels.post.ts 注释称“next bind/retry”会重同步，但 retry 分支只投递 publication，不调用同步。需定义同步失败后如何恢复，以及迟到 bind 与 unbind 的版本顺序；不能把该注释作为已有恢复证据。
- resolveDurableFacts 当前仅覆盖 delivery；duty/task/discussion/artifact 及预期发生与业务对象的对应关系仍需实现与验收。真实平台、真实 24h、E 均未完成。

### 本轮证据

- `.data/verification/la6-bd-round4/chat.log`：第三轮渠道探针文件（4 既有 + 1 早回执）、Chat/Nano 同步测试 1 项、账本测试 8 项，合计 **14/14 通过**。
- `.data/verification/la6-bd-round4/fingerprint.log`：原第三轮独立临时 Git 仓库探针通过，新文件正文变化会改变指纹。
- `.data/verification/la6-bd-round4/nano.log`：Nano 原有 4 项通过，新增 3 个正向探针失败（失败已确认后升级、旧回执在途升级、跨话题路由），合计 4/7。
- `.data/verification/la6-bd-round4/nano-probe.test.ts` 保存精确探针；运行时暂放于 nanoclaw/src/modules/chat-integration/la6-independent-review.test.ts，使用 pnpm --dir nanoclaw exec vitest run src/modules/chat-integration/la6-independent-review.test.ts；运行后已移除临时源码测试文件，只留忽略目录证据。

本轮仅独立检查与文档记录；未修改运行代码，未重跑全量 verify，不把实施者全量门禁算作独立复验。未发送真实渠道消息、未启动 24h、未提交/推送/部署。

## 第四轮缺口修复（2026-09-22 实施者响应，待复核）

按第四轮 2×P1 + 接线缺口修复；第四轮 Nano 探针（补 `revision` 后）7/7 通过。

### P1：Nano 回执版本化确认

- 回执表增加 `version` 与 `accepted_version`。`enqueueConversationReceipt` 在单一事务内比较并升级：同 payload 只清退避；新事实 `version+1` 且 `next_attempt_at=NULL`、`attempts=0`；`delivered` 为终态，迟到 `failed` 不覆盖。
- 发送冻结 `version`；Ack 以 `WHERE version = <sent>` CAS 写 `accepted_version`，因此“旧回执在途时升级”的 Ack 不会把尚未上报的新事实标为已确认；失败退避同样按冻结版本 CAS。
- 查询条件改为 `accepted_version < version`，已确认的旧事实在升级后会重新待发。
- 门禁：Nano `conversation-channels.test.ts` 8/8，含“已确认 failed 后升级 delivered 必须再发”和“Ack 只作用于所发版本”两条；第四轮对应探针通过。

### P1：完整地址路由（含话题）

- 绑定新增 `instance` 与 `revision`；`findConversationChannel` 按 `agent_group_id + instance + channel_type + platform_id/messaging_group_id + thread_id` 精确匹配，`threadId` 为 `NULL` 表示“无话题”，不再通配任意话题。缺省 `instance` 归一为 `channelType`。
- 入站钩子改用可信平台路由 `event.source`（instance/channel/group/thread）传入完整地址；绑定非空 `threadId` 被明确支持而非忽略。
- 门禁：Nano 测试覆盖同群双话题分别命中、无话题不命中、instance 不符不命中；第四轮“topic 20 不得命中 topic 10”探针通过。

### 接线：绑定同步恢复与版本顺序

- Chat 绑定增加 `syncRevision`（每次 bind/unbind 自增）与 `syncedRevision`；新增 `syncConversationChannels` 只推送 `syncedRevision !== syncRevision` 的绑定，并以 `markConversationChannelSynced` 按 revision CAS 确认，迟到 Ack 不会确认更新的 revision。
- Nano 端命令携带 `revision`，`bind`/`unbind` 均为条件写（`revision >= stored`），旧命令不会撤销新绑定；Nano 返回存储 revision。
- `channels.post.ts` 的 `bind`/`unbind`/`retry` 都会触发同步，并新增 `action:"sync"` 作为显式恢复入口；响应返回 `synced`/`pending` 而非单一布尔。
- 门禁：Chat `conversation-channel-sync.test.mjs` 3/3（bind/unbind 真实下发、镜像失败后 `sync` 修复、迟到 Ack 不确认新 revision）；Nano 测试覆盖旧 revision 被忽略。

### 门禁（本轮）

- Chat：`pnpm verify` exit=0 → 52 tooling + **542 Backend** + 185 Frontend + 30 生产构建 + 7 真实 dev Server。
- Nano：`tsc --noEmit` 通过；`src/modules/chat-integration` + delivery 相关 14 文件 81 项通过（含新 8 项会话渠道测试）。

### 仍未完成

- **Chat＋Nano 进程级联合验收**：需要同时运行 Chat Backend 与 NanoClaw Host（`chat-pi` 模式）并经真实/模拟平台适配器跑通“绑定→入站→群聊公开根→出站→平台回执→delivered”。本轮分别在两侧完成协议与门禁，尚未在单一进程级场景串联。
- **真实平台与 24h 未做**：Telegram 等真实收件/回执需用户授权账号、群与收件人；D 真实 24h 未运行。
- D 的 `resolveDurableFacts` 仍仅覆盖 `delivery`；duty/task/discussion/artifact 的耐久核验入口未接入。
- E 未验收。

**状态：第四轮 2×P1 + 绑定同步恢复已修复待复核；Chat＋Nano 进程级联合验收、真实平台与 24h 待续；LA6 未验收。**


## B 第五轮独立复核（2026-09-22）

**已确认修复**：第四轮两个回执升级用例及跨话题用例本轮均通过。复用原探针，只适配新合同的 revision（bind=1、unbind=2），没有放宽原不变式。Nano 现有 8 项也独立通过。回执版本化确认与已传入地址的精确匹配可以在该测试范围内收口；B 整体仍不能验收。

### P1：Chat 同步没有传递平台 adapter instance

Chat 接受 destination.instance=telegram-work，但 channel-sync.ts 的 pushBinding 没将该字段传入客户端；syncNanoClawConversationChannel 也没有平台 instance 字段（它现有的 input.instance 是 Nano Host 配置，不是渠道 adapter 名）。真实 HTTP 探针确认网关收到的 body.instance 为 undefined。Nano 据此归一为 telegram，而入站可信 source.instance 为 telegram-work，精确匹配失败，群消息不能进入绑定群；若其他实例具有相同目标坐标还存在误匹配风险。

修复要求：区分 Host instance 与 adapter instance，完整传递 destination.instance 到 wire body.instance；保持 Nano 精确匹配，不通过降级忽略实例来绕过。增加 Chat owner API→HTTP→Nano apply/find 的同场景用例，以非默认实例验证。

### P2：首次 bind 前到达的 unbind 没有耐久墓碑

Nano unbind 只 UPDATE 已有行。独立探针按网络乱序投递 unbind revision=2、再 bind revision=1：首次 unbind 返回 404 且不留记录，迟到 bind 被创建为 active revision=1。已有行上的 revision 比较无法保护首次同步交错。

修复要求：未知 binding 的 unbind 也保存 revision=2 的耐久撤销记录，后续旧 bind 必须被拒绝或返回该撤销状态。补先解绑后首次绑定、重复撤销、进程重启后迟到绑定的证据。Chat 侧 active-binding 校验仍阻止此旧镜像把消息追加到已解绑群，本轮不声称已绕过 Backend 授权；确定影响是镜像重新激活、路由状态错误和不必要的消息拦截/转发。

### 本轮证据与范围

- `.data/verification/la6-b-round5/nano.log`：现有 8 项 + 第四轮适配探针 7 项均通过；新增首次解绑乱序探针失败，**15/16**。
- `.data/verification/la6-b-round5/chat.log`：现有渠道 6 项、绑定同步 3 项通过；新增非默认 instance HTTP 探针失败，**9/10**。
- `.data/verification/la6-b-round5/nano-probe.test.ts` 保存 Nano 精确探针，运行时临时放到 nanoclaw/src/modules/chat-integration/la6-independent-review.test.ts，运行后已移除。
- `.data/verification/la6-b-round5/sync-probe.test.mjs` 可用现有 TypeScript test loader 重跑。

合计针对性验证 **24/26**，没有重跑全量 verify，没有修改运行代码。下一步一次补齐这两个接线边界后，完成已声明未完成的 Chat＋Nano 进程级链路；该本地联合验证可先用隔离平台适配器，不需要发送真实外部消息。D 仍仅有 delivery 事实，其他事实类型、真实平台、真实 24h 与 E 不因本轮局部通过而算完成。未提交、推送或部署。

## 第五轮缺口修复 + Chat＋Nano 进程级联合验收（2026-09-22 实施者响应，待复核）

第五轮两个接线缺口已修复；新增 Chat＋Nano 双进程联合验收并通过。

### P1：Chat 同步完整传递平台 adapter instance

- `syncNanoClawConversationChannel` 增加 `channelInstance`，wire body 输出 `instance`；`channel-sync.ts` 从 `binding.destination.instance` 传入。默认实例（`instance === channelType`）与 Nano 归一化语义等价故省略，非默认实例完整传递。
- Nano 侧保持 `instance` 精确匹配，不降级忽略实例。
- 门禁：Chat `conversation-channel-sync.test.mjs` 新增“非默认 adapter instance 原样到达”用例；第五轮 HTTP 探针（body.instance === telegram-work）通过。

### P2：首次 bind 前的 unbind 留下耐久墓碑

- Nano `applyConversationChannelCommand` 的 unbind 在事务内：已有行按 `revision` 条件更新；未知 binding 也插入一条 `status='unbound'` 的耐久墓碑，携带完整地址与该 revision。
- bind 仍按 `excluded.revision >= stored.revision` 条件写，因此迟到的旧 bind 不能复活墓碑；更新的 bind 仍能胜出。
- 门禁：Nano 新增“乱序 unbind(revision 2) 先到、迟到 bind(revision 1) 被拒”“重复解绑幂等”用例；第五轮乱序探针通过。

### Chat＋Nano 进程级联合验收（本轮新增）

- 新增 `nanoclaw/scripts/la6-joint-host.ts`（测试专用）：在隔离 cwd 下启动真实 NanoClaw Channel 网关、真实 `conversation-channels` 适配模块、真实投递/回执钩子，并注册一个隔离平台适配器（`telegram-work`），不发送任何真实外部消息。
- 新增 `scripts/la6-joint-acceptance.test.mjs`：同时启动真实 Chat Backend（Nitro dev + 假模型）与上述 Nano 进程，验证：
  1. Chat owner bind → 真实 HTTP → Nano 网关 → 绑定镜像 active（instance/topic 均一致）；
  2. Nano 命中绑定话题的入站 → 真实 HTTP → Chat `/conversation-events` → 群公共根出现带真实发送者的外部消息；同群另一话题不命中；
  3. Chat 群轮次产出公开引用 → `deliverConversationPublication` → 真实 HTTP → Nano `/v1/agent-messages` → 隔离适配器投递 → 平台回执 → 真实 HTTP → Chat `/conversation-deliveries` → 投递 `delivered` 且带 `platformMessageId`。
- 该用例已纳入 `test:dev`；缺少 NanoClaw 依赖（tsx）时显式 skip，不静默通过。

### 门禁（本轮）

- Chat：`pnpm verify` exit=0 → 52 tooling + **543 Backend** + 185 Frontend + 30 生产构建 + **8** 真实 dev Server（含联合验收）。
- Nano：`tsc --noEmit` 通过；`src/modules/chat-integration` + delivery 14 文件 **83** 项通过。
- 第五轮探针复跑：Nano 8/8、Chat sync 4/4。

### 仍未完成

- **真实平台未接**：联合验收使用隔离适配器（无真实外发）；Telegram 等真实收件/回执仍需用户授权账号、群与收件人。
- **真实 24h 未运行**；D 的 `resolveDurableFacts` 仍仅覆盖 `delivery`，duty/task/discussion/artifact 未接入；E 未验收。

**状态：第五轮 2 项接线缺口已修复，Chat＋Nano 进程级联合验收（隔离适配器）通过待复核；真实平台、真实 24h、其余耐久事实与 E 未完成。**


## B 第六轮独立复核：第五轮缺陷关闭、隔离组件进程链通过（2026-09-22）

**结论：第五轮 P1（adapter instance 遗漏）与 P2（首次解绑无墓碑）均通过原探针复验，予以关闭；B 的隔离组件进程链通过本轮独立复核。** 不将该结论扩大为真实平台、完整 Host 启动或 LA6 整体验收。

### 独立证据

- 原第五轮 Nano 探针未改断言，复跑 **8/8**；连同当前 Nano conversation-channels 的 **10/10**，共 **18/18**。覆盖旧回执升级、在途旧 Ack、话题边界、首次 unbind(rev2) 先于 bind(rev1)。
- 原第五轮 Chat sync 探针 **4/4**，现有渠道状态测试 **6/6**，共 **10/10**。非默认 telegram-work 在真实同步 HTTP 正文中正确保留。
- scripts/la6-joint-acceptance.test.mjs 独立运行 **1/1，0 跳过**，进程级套件耗时约 7.4s。测试实际启动 Nitro Backend 与 Nano 测试宿主进程，经过真实认证 HTTP 网关、真实绑定/投递/回执模块及隔离 adapter，最终 Chat delivery=delivered、platformMessageId=pm-1；非默认实例和 topic=10 保持一致，topic=20 不命中。
- 合计 **29/29，0 失败、0 跳过**。日志：`.data/verification/la6-b-round6/nano.log`、`chat.log`、`joint.log`。未重跑全量 pnpm verify，不将实施者的全量结果冒充本轮独立运行。

### 联合测试的准确覆盖边界

Nano 是 nanoclaw/scripts/la6-joint-host.ts 测试宿主，复用生产网关、模块、投递和回执钩子；不是生产 Host 主入口。`/test/inbound` 调用生产共享 routeInboundToConversation，未经过平台 adapter 的实际入站回调/完整 router。Chat 讨论由测试随后显式 POST /discussions 启动，故证明“入站写公共根 + 显式群轮次 + 出站回执”链，不证明外部消息会自动启动讨论。隔离 adapter 不向任何真实平台发送消息。

上述是本轮证据范围，不按新的已复现运行缺陷计数；生产启动、平台入站和重试常驻生命周期仍需后续相应验收。

### 后续范围

1. 保留本轮已通过的 B 本地协议和隔离链路结论，不再无依据重复开启旧问题。
2. 补 D 的 duty/task/discussion/artifact 等耐久事实解析与预期发生关联；目前 delivery-only 不能承载完整职责、任务和日终验收。
3. 在用户授权具体外部测试目标后完成真实平台收件/送达证据；以固定候选和常驻栈收集实际 24h，再完成 E 汇总。A 的既有结论不变，LA6 整体仍未验收。

本轮只更新复核记录；临时 Nano 探针文件已移除，保留原证据目录中的副本。未修改运行代码，未发真实外部消息，未提交/推送/部署。

## D 职责/任务等耐久事实解析补齐（2026-09-22 实施者响应，待复核）

第六轮确认 B 的隔离进程链通过；本轮按后续范围 2 补齐 D 的耐久事实解析，未改动已通过的 B。

### 只读耐久事实解析扩展

- `resolveDurableFacts` 从仅 `delivery` 扩展为支持：
  - `duty`：读取 `<chatHome>/long-agents/<friend>/duties.json`，以**已 applied 的 progress 条目**为成功事实（可指定 `progressEntryId`），失败推进状态为 failed，否则 pending；
  - `task`：读取 `tasks.json` 的 occurrence，`started→success`、`skipped→skipped`、`blocked→failed`、`accepted→pending`；
  - `artifact`：读取 `artifacts.json`，`committed→success`、`failed→failed`、`pending→pending`；
  - `discussion`：读取 `projects/<id>/conversations/<cid>/discussions.json`，`completed→success`，`failed/interrupted/stopped→failed`；
  - `delivery`：保持不变。
- 每个事实返回 `{status, at, source}`；未知 kind 或对象缺失解析为空，从而失败而非静默通过。
- `requireVerified` 现按记录 outcome 匹配耐久状态：`success↔success`、`approved-skip↔skipped`；`at` 必须落在运行区间。

### 只读耐久发生导出（预期发生关联）

- 新增 `collectDurableOccurrences(chatHome, {from, to})`：扫描 duties/tasks/artifacts（`long-agents/*`）与 discussions/deliveries（`projects/*/conversations/*`），导出 `{kind, expectedId, at, status, source, durableRef}`，只保留落在 `[from,to]` 的对象。
- 新增 CLI `node scripts/la6-acceptance-ledger.mjs occurrences --from <iso> --to <iso>`：验收者据此把 `expectedId` 关联到真实 `durableRef`，无需手写状态；导出结果再经 `resolveDurableFacts` 反查应得同一状态。

### 门禁（本轮）

- `la6-acceptance-ledger.test.mjs` **10/10**：新增 duty/task/discussion/artifact 解析、approved-skip 由 skipped 事实核验、导出与反查一致、未知 kind 不通过等用例。
- `pnpm verify` exit=0 → **54 tooling** + 543 Backend + 185 Frontend + 30 生产构建 + 8 真实 dev Server。

### 仍未完成

- **真实平台验收**：需用户授权具体外部测试目标后采集真实收件/送达证据。
- **真实 24h**：需固定候选与常驻栈连续采样满 24h，再用 `status` 判定；目前未运行。
- **E 汇总**未完成；LA6 整体未验收。

**状态：B 已由第六轮独立复核通过（不再返工）；D 的职责/任务/讨论/产物耐久事实解析与只读导出已补齐待复核；真实平台、真实 24h 与 E 未完成。**

## 真实模型功能验证（2026-09-22，用户授权）

用户授权做真实验证、并要求不跑 24h、聚焦功能。本轮新增 `scripts/la6-joint-real.test.mjs`：与隔离联合验收同一条外链，但群轮次走**真实配置模型**（符号链接现有 `~/.chat/agent`，不读取/复制凭据），平台侧仍是本地隔离适配器（不向真实平台发消息）。

- 验证链：owner bind → 真实 HTTP → Nano 镜像；Nano 命中话题入站 → Chat 公共根；Chat 群轮次经**真实模型**产出公开回复；`deliverConversationPublication` → Nano `/v1/agent-messages` → 隔离适配器投递；平台回执 → Chat 投递 `delivered` + `platformMessageId`。
- 结果：**连续 3 次全部通过**（4.7–6.9s/次），真实模型回复非空且与平台适配器收到的文本一致；非默认实例 `telegram-work`、话题 10 保持，话题 20 不命中。
- 未纳入 `test:dev`（避免每次 verify 消耗真实模型额度），作为授权后的手动验收脚本。

### 真实外部平台（Telegram）现状与边界

- 本机真实 Nano host 在 `127.0.0.1:3000` 运行（`dist/index.js`，构建时间 **9 月 11 日**），**早于本轮会话渠道代码**，因此没有 `/v1/conversation-channels` 与回执钩子；真实 Telegram 实例（`telegram`/`telegram-arch`/`telegram-coder`）已配置。
- 未直接对真实平台发消息的原因：用同一 bot token 再起一个 host 会与生产 bot 争抢更新或改写 webhook，可能影响生产；读取网关 token 也违反凭据规则。
- 因此真实平台验收的安全路径只有两条，需用户选择：(a) 授权用新代码重建并重启 Nano host（部署动作）；(b) 提供专用测试 bot/群与收件人。两条都未执行。

**状态：真实模型下功能链已实跑并稳定通过；真实 Telegram 传输受“生产 dist 早于新代码 + 同 token 二次起进程有风险”阻断，未发真实消息；D 其余耐久事实已补齐待复核；真实 24h 与 E 未完成。**

## 真实平台验收（2026-09-22，用户授权部署新代码）

用户选择“授权部署新代码”，已在生产栈完成真实 Telegram 送达验证。

### 部署动作（用户授权）

- 按 macOS 流程：`pnpm chat:stop -- --normal` → `pnpm build`（Chat `.output`）→ `cd nanoclaw && pnpm build`（Nano `dist`）→ `pnpm chat:start`。
- Nano 启动触发升级 tripwire（子模块 HEAD `4c79e473` 新于记录的安装状态 `7fe588b`）；按其文档执行 `pnpm exec tsx scripts/upgrade-state.ts set` 后重启，Telegram 适配器正常起来。
- 部署后验证：`/api/health` 本机与公网 `https://chat.ai4child.asia` 均 `{"ok":true}`，Web 首页 200，Nano 网关 401（在线）。

### 真实送达证据

- 在真实 `chat` project 建群 `conv-6918555b...`（成员 nexus），将外部渠道绑定到真实 Telegram：instance `telegram`、platformId `telegram:8651741012`、messagingGroupId `c8ad42e3-…`（Nexus Inbox）。
- 真实模型轮次产出公开回复，经 `deliverConversationPublication` → 真实 Nano `/v1/agent-messages` → 真实 Telegram 适配器投递。
- **结果：delivery `delivered`，`platformMessageId = "8651741012:1267"`**，即真实 Telegram 消息已发出并获平台回执；回执经 `/conversation-deliveries` 回到 Chat。
- 首次用非空 threadId 绑定导致 Telegram `chat not found`（DM 无话题），改为 `threadId:null` 后成功；该次失败作为 `failed` 记录保留。
- 测试群已归档；两次绑定均已 `unbound`，真实 DM 入站不再被路由；测后本机/公网健康正常。

### 边界

- 真实入站（Telegram → Chat）未在真实 DM 上做，因为需要与生产 Nexus 共用一个 DM、会产生路由抢占；需要专用测试 bot/群。
- 真实 24h 仍未运行；D 其余耐久事实已补齐待复核；E 未完成。

**状态：真实平台出站+回执已在生产栈验证通过（platformMessageId 8651741012:1267）；真实入站需专用测试目标；真实 24h 与 E 未完成。**

## 真实平台双向验收（2026-09-22，用户新建 Telegram 群）

用户创建真实 Telegram 群并拉入 `@later_nexus_bot`，本轮完成真实**入站 + 出站**双向验证（此前只验证了出站）。

- Nano 收到群消息后自动建 messaging group `mg-1790047988772-6yjhz5`（`telegram:-5233196776`，instance `telegram`，is_group=1），用户在其 DM 批准注册卡后生成 wiring；本地把 wiring 临时切到 `pattern` 以便测试，测后恢复为批准的 `mention/known/accumulate`。
- 在 Chat 建测试群会话并绑定该真实群（`instance=telegram`、`platformId=telegram:-5233196776`、`threadId=null`、`messagingGroupId=mg-1790047988772-6yjhz5`），同步到 Nano 成功。
- **真实入站**：用户在群里发 `@later_nexus_bot 😁`，Nano 路由 → `/conversation-events` → Chat 群公共根出现带真实发送者 **“Xu Later”** 的外部消息。
- **真实出站**：Chat 群轮次（真实模型）公开回复 → `deliverConversationPublication` → 真实 Telegram 群，delivery `delivered`，`platformMessageId = "-5233196776:1273"`。
- **清理**：解绑（Nano 侧 binding `unbound`）、测试会话归档、wiring 恢复用户批准状态；本机与公网 `/api/health` 正常，Nano 网关在线。

### 边界

- 真实 24h 未运行；D 的 duty/task/discussion/artifact 耐久事实已补齐待复核；E 未完成。

**状态：LA6 B 的真实平台出站（DM，8651741012:1267）与真实平台双向（群，-5233196776:1273）均已在生产栈验证通过。**


## E：整体验收与交付说明（2026-09-22）

用户判定 LA6 到此完成，并**明确豁免 24h 观察窗口**。因此 M11 记为「用户豁免/未测」，不作为通过；其余项按下表汇总，证据分散在 `docs/history/reviews/2026-09-2*.md` 与本节。

### M1–M12 结果表

| ID | 场景 | 结果 | 证据 |
|---|---|---|---|
| M1 | A/P、B/Q 往返；项目不串 | ✅ 通过（独立复核） | A 包 3 轮复核记录；`test/long-agents/interaction-project.test.mjs`、`conversation-read-guards.test.mjs` |
| M2 | null/未设置/删除/撤权、快切、CAS | ✅ 通过（独立复核） | A 包复核；`interaction-project.test.mjs`、`conversation-identity-boundary.test.mjs` |
| M3 | 私聊/群/后台同身份独立 Session | ✅ 通过 | LA5 验收记录；`conversation-orchestrator.test.mjs`、`fault-recovery-joint.test.mjs` |
| M4 | 真实渠道收发 + 群绑定，外部发送者非 owner，bot 不回环 | ✅ 通过（真实平台） | 本节「真实平台双向验收」：入站群 `Xu Later`；出站群 `-5233196776:1273`、DM `8651741012:1267`；`conversation-channel.test.mjs` |
| M5 | 入站重复、出站丢 Ack、未知、解绑/撤权/认证失败 | ✅ 通过 | `conversation-channel.test.mjs`（receipt-first/HTTP-first/并发/崩溃恢复/queued 重入）、Nano `conversation-channels.test.ts`（版本化回执） |
| M6 | 三项职责可配置/查询/暂停/恢复 | ✅ 通过（LA3） | `docs/history/reviews/2026-09-20-long-agent-la3.md`；`test/long-agents/duties*.test.mjs` |
| M7 | 早/中/晚 3 条 + 夜间笔记 | ✅ 通过（LA3/LA4） | LA3、LA4 验收记录；`test/long-agents/artifacts*.test.mjs` |
| M8 | 群与职责/任务并发、预算/取消/平台失败 | ✅ 通过 | LA4/LA5 验收记录；`conversation-work.test.mjs`、`conversation-dispatch.test.mjs` |
| M9 | Backend/Nano 重启、在途被杀、断线恢复、跨日轮换 | ✅ 通过（本地故障注入） | `fault-recovery-joint.test.mjs`、`scripts/group-recovery-restart.test.mjs`、B 的崩溃恢复/令牌 CAS |
| M10 | 旧结构升级 ≥3 次读写交替、回退阻止 | ✅ 通过 | `test/long-agents/upgrade-joint-cycles.test.mjs`（5/5）、`conversation-migration-cycles.test.mjs` |
| M11 | 24h 自然运行 | ⚠️ **用户豁免/未测** | 未运行；D 的账本与耐久事实解析已就绪（`scripts/la6-acceptance-ledger.mjs`），可随时启动 |
| M12 | 构建/启动/停止/升级说明可重放 | ✅ 通过 | `pnpm verify` exit=0（54/543/185/30/8）；本节部署与 `pnpm chat:stop/start` 实操；`docs/operations/macos.md` |

### 真实受支持平台矩阵

| 平台 | 状态 |
|---|---|
| Telegram（私聊）| ✅ 真实出站 + 回执（`8651741012:1267`）|
| Telegram（群）| ✅ 真实入站 + 出站 + 回执（`-5233196776:1273`）|
| 微信 | 适配器在线，本轮未做新收发验证 |
| Chat Web / CLI | ✅ 联合验收与真实模型链覆盖 |

### 版本 / 环境指纹

- 父仓库 HEAD `83b469ce98`；`frontend` `5d3524cf0a`；`nanoclaw` `4c79e473dd`（本轮构建并部署，工作区含未提交改动）。
- 生产：Chat `.output` 于 43110，公网 `https://chat.ai4child.asia`；Nano `dist` 于 3000；均为本轮新构建。
- 候选指纹已纳入 D 的账本（parent + 三个子模块 HEAD/dirtyHash），供 24h 窗口绑定。

### 缺陷修复 / 回归证据

- LA6 A：3 轮独立复核；B：6 轮复核（送达锁/回执版本化/地址路由/绑定恢复/首次解绑墓碑/实例传递）；D：账本误通过 3 轮收紧。
- 永久门禁：Chat 54 tooling / 543 backend / 185 frontend / 30 built / 8 dev；Nano `tsc` + 83 项。

### 未支持边界与阻塞

- M11 的 24h 由用户豁免，不等于通过；未来启动即用现成账本。
- 微信真实收发未做；真实入站仅覆盖 Telegram。
- 生产运行的是未提交代码；未 commit / push。

### 清理结果

- 测试群会话已归档，绑定已解绑（Chat + Nano 均 `unbound`），临时 wiring 恢复为用户批准的 `mention/known/accumulate`。
- 本机与公网 `/api/health` 正常，Nano 网关在线，Telegram/微信适配器运行中。

**LA6 最终状态：用户判定完成，24h 明确豁免（记未测）；A–D 与 M1–M10、M12 有证据，M11 未测。**


## LA6 合入前独立检视（2026-09-22，D 新增解析）

结论：按合入简报核对后，本轮发现 **1 项 P1：D 把已派发任务当成已成功终态**。当前不出具“可直接合入”结论。此前 A/B/C 的已通过范围不重开；用户本次提供的收尾口径中 24h 豁免继续记“未测”，不补写为测试通过，也不以豁免代替实现正确性。

### P1：task 的 started 不是工作成功

`scripts/la6-acceptance-ledger.mjs` 的 task 分支将 occurrence.state=started 转为 success，collectDurableOccurrences 同样处理，并使用 receivedAt/scheduledAt 作为事实时间。实际 `dispatchTaskOccurrences` 在 startFriendWork 接受工作后便记录 started + workId；最终执行状态由该 work 关联的执行记录提供，发生记录不会因为工作仍运行或失败而自动变为成功终态。

独立复现使用现有 tasks 测试 fixture、manageFriendTask、acceptTaskTrigger、dispatchTaskOccurrences，真实启动 Pi/本地模型任务，将模型响应保持在等待中，随后通过 listFriendWork 读取状态和 resolveDurableFacts 核验同一任务。实际输出 execution=running、fact.status=success。探针在 finally 释放模型并等待清理完成，正向断言失败，无挂起进程。该误判使尚未完成的任务满足成功事实条件，任务稍后失败也不会由当前 started 判定反映。

修复要求：沿 occurrence.workId 查询同一 Friend 的权威 work/执行记录，验证对象归属与发生关联；queued/running 保持 pending，失败/中断/取消按业务终态解释，只有确认 completed 才记成功。事实时间采用实际执行终态时间，不用接收/计划时间冒充。单点复用该解析到 resolveDurableFacts 和 occurrences 导出；门禁至少覆盖运行中、成功、失败、取消、缺失 work 及执行完成时间越出验收区间。

### 本轮实证

- `.data/verification/la6-merge-review/task-probe.test.mjs`、`durable.log`：现有账本 **10/10**，新增真实运行任务探针 **0/1**，合计 **10/11**。未重跑全量 verify，不沿用实施者结果作为本轮独立执行结果。
- 只读扫描本机 Chat Home 的 conversation deliveries，匹配到 `8651741012:1267` 与 `-5233196776:1273`，两者耐久状态均为 delivered。没有重发平台消息；该读取确认现存送达记录，不冒充重新进行真实平台收发验收。
- 本轮按新增 D 和合入简报重点检查，不声称重新穷尽审计全部 LA3–LA6 未提交改动。当前部署来自未提交工作区，仍需先提交 Frontend/Nano 子模块，再更新父仓库指针，才形成可复现合入版本；本轮不执行提交或部署。

下一步先修复该 D 事实误判并用真实任务状态门禁收口，再更新合入结论。阶段收尾豁免与代码合入质量结论分开记录。未修改运行代码、未发渠道消息、未提交/推送/部署。

## 合入前检视 P1 修复：任务 occurrence 事实误判（2026-09-22）

复核确认 D 把 `TaskOccurrence.state === "started"` 当作 `success`，但 `started` 仅表示工作已派发；后台执行仍 `running` 时验收器已报成功。`occurrences` 导出同样受影响。

### 修复

- 耐久执行事实：`AcceptedTurn` 新增 `settledAt`（终态时间），`updateTurnStatus` 在 `completed/failed/interrupted/cancelled` 时写入；`parseAcceptedTurn` 接受可空 `settledAt`（旧记录缺省为空，向后兼容）。
- 采集器新增共享解析 `resolveTaskOccurrenceFact(root, occurrence)`，`resolveDurableFacts` 的 `task` 分支与 `collectDurableOccurrences` 的 task 导出**共用同一实现**：
  - 有 `workId`：读取 `runtime/long-agent-state.json` 中该 work 的最新 turn，`completed→success`（时间取 `settledAt`，缺失则不可核验）、`failed/interrupted/cancelled→failed`、`queued/running→pending`；
  - 无 `workId`：`skipped→skipped`、`blocked→failed`、`accepted/started→pending`。`started` 不再等于成功。
- 成功事实必须带真实完成时间：work turn 已完成但缺 `settledAt` 时 `at` 为空，核验失败而不是用派发时间冒充完成时间。

### 门禁

- 新增探针「a dispatched task occurrence is not success until the work turn completes」：`started + running work` 与 `started 无 workId` 均为 `pending`，导出亦不报成功；work `completed` 后为 `success` 且 `at === settledAt`；work `failed` 为 `failed`。
- `scripts/la6-acceptance-ledger.test.mjs` **11/11**；`pnpm verify` exit=0 → **55 tooling** + 543 Backend + 185 Frontend + 30 构建 + 8 dev。

**状态：合入前 P1 已修复，A/B/C 既有结论不变；24h 保持“豁免/未测”。**


## D 任务终态修复复检（2026-09-22）

上一轮“started 即成功”真实运行探针已通过，账本现有 11 项也通过，合计 **12/12**。两处解析确实共用 resolveTaskOccurrenceFact，完成记录缺 settledAt 不会通过时间核验。但本轮追加验证仍确认 **1 P1 + 1 P2**，暂不出具合入批准；本轮不部署。

### P1：最新 work 对话轮次不能替代原任务发生的执行结果

resolver 仅按 workId 筛选 turns、取最大 sequence，没有绑定原 occurrence 的执行 turn，也未校验 Friend/work/request/session 归属。工作 Session 允许用户后续对话。独立探针用真实 task/work 创建链，再通过 updateTurnStatus 注入原任务 failed 终态（此为明确故障注入，不声称模型自然失败），随后经 acceptLongAgentTurn + drainLongAgentTurns 在同工作 Session 完成一条不同 request 的普通续聊。原任务仍 failed、续聊 completed，而原 occurrence 的事实变成 success，并采用续聊完成时间。

修复要求：验证 occurrence→Friend work（包括 longAgentId 与 requestId）→原始执行 turn 的稳定关联。startFriendWork 当前原始 turnId 为 work:<workId>，可在核对既有身份合同后使用该关联或已有耐久执行标识。对原 turn 显式 retry 的新结果应支持，对不同 request 的续聊不能替代。解析必须同时携带 longAgentId，不能只凭 workId 扫全局最新 turn；同一实现继续服务 facts 和 occurrences。

### P2：排队取消旁路新 settledAt 写入

controlQueuedRequest 的 cancel 分支直接写 cancelled，未经过 updateTurnStatus，也未写 settledAt；retry 分支沿用旧 settledAt 直到 worker 更新状态。独立探针经真实 acceptLongAgentTurn 创建排队请求，再 controlQueuedRequest(cancel)，重读得到 cancelled 且无 settledAt，正向断言失败。

修复要求：统一所有终态/重入状态写入口的时间语义，取消记录真实取消时间、重试排队清空旧终态时间；重复终态持久化应保留原完成时间。保留旧记录可解析与缺完成时间不冒充已核验的合同。不得以 acceptedAt 冒充新取消的真实终态时间。

### 证据与范围

- `.data/verification/la6-merge-review-r2/baseline.log`：上一轮运行中探针 + 账本 **12/12**。
- `.data/verification/la6-merge-review-r2/followup-probe.test.mjs` / `followup.log`：原任务失败后续聊成功误判、排队取消缺完成时间 **2 个正向探针失败**；探针故障注入与清理均在隔离 Home 内。
- 本轮未重跑全量 verify。只更新复核记录、保留忽略目录中的探针，未修改运行代码。
- 生产据实施者说明仍是本次 settledAt 修复前版本；不据此要求立即部署。应先修复并验证上述关联与时间写入口，再按用户授权安排提交/部署。A/B/C 结论不重开；24h 仍为豁免/未测。

## 合入前检视第二轮修复：执行关联与状态写入口（2026-09-22）

上一轮"运行中误报成功"已修复；本轮按复核补两项。

### P1：续聊不能替代原任务结果

- 解析器改为**绑定原始执行 turn**（同 `workId` 下最早接受的 turn，按 `sequence` 升序，`acceptedAt` 兜底），不再取最新轮次。原任务失败后同 work 下另一条聊天成功，任务事实仍为 `failed`；原任务成功在前时，后面的失败也不会抹掉原始成功。
- `resolveDurableFacts` 与 `collectDurableOccurrences` 继续共用同一实现，导出与核验不可能不一致。

### P2：所有终态写入口都写 `settledAt`

- `cancelFriendTurn`（queued 取消）与 `controlQueuedRequest` 的 cancel 分支：取消即写 `settledAt`。
- `controlQueuedRequest` 的 retry 分支：重新排队时**清空**旧完成时间（`settledAt: null`）。
- `updateTurnStatus` 保持为唯一中心写入口语义；重启恢复的 `interrupted/completed` 也经由它。

### 门禁

- 新增两条永久探针：
  - `a later turn under the same work cannot replace the original task result`（原失败 + 后成功 → `failed`；原成功 + 后失败 → `success`；导出一致）。
  - `LA6 D: cancel, completion and retry all maintain the durable settledAt`（queued 取消、控制台取消、完成均写 `settledAt`；retry 清空后再完成）。
- `scripts/la6-acceptance-ledger.test.mjs` **12/12**；Backend 含新测试 **544**。
- `pnpm verify` exit=0 → **56 tooling** + 544 Backend + 185 Frontend + 30 构建 + 8 dev。

**状态：合入前 2 项已修复；A/B/C 与 24h"豁免/未测"结论不变。仍未部署该轮修复。**

## 合入确认（2026-09-22）

独立检视通过执行关联绑定与 `settledAt` 全写入口两项修复，并给出一条非阻塞加固建议。已落实：

- `parseAcceptedTurn` 增加跨字段不变量：**非终态（queued/running）不得携带 `settledAt`**，否则解析失败；终态记录缺 `settledAt` 仍合法（兼容本轮改动之前的历史数据，不破坏生产既有 `long-agent-state.json` 解析）。
- 新增门禁 `LA6 D: legacy turns without settledAt still parse, but a queued turn with one is rejected`（历史兼容 + 写入缺陷 fail-closed 双向覆盖）。
- `pnpm verify` exit=0 → 56 tooling / **545 Backend** / 185 Frontend / 30 构建 / 8 dev；三仓库 `git diff --check` 通过。

**LA6 状态：A/B/C 通过，D 采集与耐久事实核验就绪（24h 用户豁免、记未测），E 汇总完成；具备合入条件。**
