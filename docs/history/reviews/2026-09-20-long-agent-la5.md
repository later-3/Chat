# LA5 群聊与多 Friend 协作验收记录

阶段：[LA0–LA6 计划](../../development/long-agent-functionality-plan.md)；任务书：[LA5 任务书](../../development/long-agent-la5-taskbook.md)；模块合同：[群聊与多 Friend 协作合同](../../modules/long-agents/group-chat.md)。

状态：**LA5 已验收**（本地单 Backend 群聊范围；最终结论、独立复跑与证据见 [LA5 验收记录](./2026-09-21-long-agent-la5-acceptance.md) 顶部“最新结论”与末节“最终收尾复核”）。本文件是实施过程记录：下方各轮进展为**历史快照**，其中“未验收/待复核”表述不构成当前阻塞。外部渠道、24h 自然运行与 Friend 项目选择记忆归 LA6，不在 LA5 验收范围内。

## 工作包 A：合同与权限基础（完成）

按 2026-09-21 开工检查的 6 项修正收口；证据为 `test/long-agents/scope.test.mjs`（7 项）与全量门禁。

1. **`social_manage` 不再默认进入群参与**：移出默认集并给出理由（可发布/评论/以 Friend 身份读 self 动态），需要显式授权 + 操作/受众受限的同源服务才接入。
2. **工具身份与真实注册入口对齐**：使用注册表真实地址 `system:tool/<name>`；`applyScopeToCapabilities` 同时覆盖 Chat 系统 Tool、原生 Pi Tool、`pi-default`(inherit) 与 Extension/MCP 名称；装配在创建会话前过滤，并在创建后校验"实际注册集 ⊆ 授权集"，越权即中止。
3. **只读≠可共享**：`project_read`/`project_search` 与其他能力一样默认拒绝，理由写入排除清单；范围校验实现前不开放。
4. **散列不是认证**：scope 由 Backend 从可信输入解析（Friend/Session/群/参与期/授权修订/存储 Project），并新增**授权承诺 `grantsDigest`**：由可信记录计算、随执行传入，工厂校验；伪造的"内部自洽且重算校验和"的扩大 scope 被拒绝。
5. **A 完成证据齐备**：装配快照 v2 + v1 兼容；contextFiles/Personal 资源在**读取前**裁剪；注册级强制；`inspectLongAgentTurnCapabilities` + `GET /api/long-agents/[id]/capabilities` 读取与执行同一份冻结选择，发现不一致即报错（检查=执行）。
6. **真实 Pi 装配哨兵**：真实工厂 + 假模型捕获实际请求——conversation 轮次中 Personal/Project/Standing Instructions 哨兵均不出现、活动工具为空、模型发起的 `read` 工具调用无法读取 Personal 哨兵文件；direct 轮次仍注入 Personal 与 Agent Group 上下文且 `read`/`write` 正常（回归）。

## 工作包 A：原始完成记录（保留）

已完成：

1. **模块合同与短设计**：`docs/modules/long-agents/group-chat.md`（场景→对象→状态转移→调用链→验证、对象与存储、默认拒绝的权限模型、六种发言策略与预算、写入入口表、状态机、入口、验证映射），已登记进 [Long Agent 模块索引](../../modules/long-agents/README.md) 与 [文档索引](../../README.md#按任务进入)。
2. **服务端 scope 模型**：`src/long-agents/scope.ts`
   - `direct` / `background` / `conversation` 三类 scope，由 Backend 从可信执行信封解析，**不来自模型、浏览器或任意 sessionId/projectId**；
   - `conversation` **默认拒绝**：不注入日终交接、Agent Group/Standing Instructions、Personal 上下文文件、Personal Prompt 资源与 Agent 私有 Memory；工具地址只保留 `project_read`、`project_search`、`social_manage` 默认允许集；
   - `excludedCapabilities[]` 对每项排除给出 `kind/id/reason`（能力检查可解释），`revision` 为内容校验和，`parseLongAgentScope` 拒绝未知字段、未知类型与校验和不符的篡改。
3. **装配层裁剪**：`prepareLongAgentAssembly` 接受可选 scope；提供 scope 时按 `include` 决定是否注入 Agent Group 上下文与日终交接，注入 `<chat_authorization_scope>` 说明块，并按 scope 收窄 `tools.addresses`（未提供 scope 的既有调用行为不变）。

证据：`test/long-agents/scope.test.mjs` 3 项——(1) 三类 scope 的默认值与排除原因；(2) 冻结 scope 的往返、revision 与篡改拒绝；(3) 真实 fixture 装配下 **direct 仍带 "Stable identity" 哨兵，conversation 不含该哨兵、含 scope 块、工具地址收窄为默认允许集**。

门禁：`pnpm verify` exit=0（44 tooling + **446** Backend + 179 Frontend + 30 生产构建 + 1 Nitro 开发 Runtime）；`pnpm check:architecture` exit=0；父仓库/Frontend/Nano 三处 `git diff --check` 通过。

未完成（A 待续，不得按已完成使用）：将 scope 冻结进公共装配快照（schema v2 + v1 兼容）、按 scope 过滤 `contextFiles` 与 Personal 资源目录、Tool 注册级强制与能力检查查询接口（V3 需要检查**实际模型请求**，不只是本层的指令与地址集合）。

## 工作包 B：公共根与参与 Session、可信绑定（基础完成，进行中）

已实现（`src/long-agents/conversations/{contract,storage,service}.ts`，门禁 `test/long-agents/conversations.test.mjs` 5 项）：

1. **Conversation 注册表**：`conv-<hash(requestId)>` 稳定身份、固定存储 Project、**公共根原生 Session**（创建时预留，不运行共享 Agent loop）、生命周期 active/archived、策略与预算（含上限校验）、成员与授权修订、CAS `revision`；创建按 requestId 幂等，成员必须是存在且启用的 Friend。
2. **参与期与独立参与 Session**：每位成员按需绑定自己的参与 Session（`bindParticipationSession`，同成员稳定、不同成员不同）；**撤权**清空 Session 绑定与授权、**重新加入**提升 `participationEpoch` 并创建新 Session（旧 Session 不能复活、不能带回旧上下文）；归档后拒绝新发言。
3. **配置写入统一 CAS**：成员/策略/授权变更提升 `authorizationRevision`（标题变更不算授权变更），旧 revision 的调用被拒绝；撤销/改成员不会悄悄被在途运行继承。
4. **可信 scope 解析**：`resolveParticipationScope` 从记录读出参与期/授权修订/显式授权，产出冻结 scope 与**授权承诺 `grantsDigest`**；已用 `verifyLongAgentScope` 交叉验证（默认拒绝、授权后放宽、跨 Session 拒绝、非成员拒绝）。

门禁：`pnpm verify` exit=0（44 tooling + **455** Backend + 179 Frontend + 30 生产构建 + 1 Nitro 开发 Runtime）；`check:architecture` exit=0；三处 `git diff --check` 通过。

B 已追加：**发布与投影**（`src/long-agents/conversations/publication.ts`，门禁 `test/long-agents/conversation-publication.test.mjs`）——公共根按源 Session/Entry 追加引用（不复制正文、不公开 thinking/tool 结果）；`publicationId` 幂等，重复发布返回既有记录（**丢回执只补发布，不重新调用模型**）；发布前从存储重读并复核成员参与期、授权修订、源条目存在与摘要一致（**不信任调用方传入的散列**）；撤权后迟到结果被拒（`参与期已结束`），已发布历史保留；未发布的草稿不进入公共流；公共投影仅成员可读，源缺失/变化显示不可用引用而不回退私有历史。

B 未完成：群参与 Session 的普通详情/历史/事件流入口的受权守卫、实时流投影、派发（工作流）与恢复/中断语义、并发合同落地。原计划中的公共消息追加与 **publication**（按源 Session/Entry 幂等、崩溃恢复）、受权投影与实时流、发言派发（用可信 scope 经公共工厂在其参与 Session 执行）、恢复/中断与并发合同落地。

## 后续工作包

B（执行与发布）、C（编排与委派）、D（Web 与管理）、E（集成验收）尚未开始；每个包完成后在本记录追加“通过/失败/未测 + 证据”，全部必验项（V1–V12）通过后提交审核，不自动进入 LA6、不提交、不推送、不部署。

## 工作包 B：读取入口守卫与发布（进展记录，未验收）

按用户校正更新结论：**B 尚未完成，授权闭环未达成**。已实现的部分：

1. **发布（`publication.ts`）**：公共根按源 Session/Entry 追加引用（不复制正文、不含 thinking/工具结果）；`publicationId` 幂等（丢回执只补发布、不重调模型）；发布前从存储重读并复核成员参与期/授权修订/源 Session 归属/源条目存在与摘要一致；撤权后迟到结果被拒；未发布草稿不进入公共流；公共投影仅成员可读，源缺失或变化显示不可用引用而不回退私有历史。
2. **参与 Session 读取守卫（`access.ts` + 读取入口接线）**：参与 Session 绑定会写入 `chat.group-participation.v1` 标记；`assertParticipantSessionReadable` 每次读取都**重读群记录**判定——同一位 Friend 仅在"仍是成员 + 参与期一致 + 该 Session 仍是其当前参与 Session"时可读；**撤权后原参与者不能再读**，重新加入（新 epoch）后旧 Session 也不再开放；猜测其他参与者 Session ID 被拒；`readChatSession` 对带绑定标记的 Session **默认拒绝**，只有显式声明阅读身份的入口可用（owner 面向的 HTTP 路由传 `{kind:"owner"}`）。
3. 语义校正：**历史保留给仍有权限的读者**（owner/当前授权执行者），而不是"曾参与即可继续读"。

证据：`test/long-agents/conversations.test.mjs`（6 项，含"猜测他人 Session ID 被拒""撤权后同一 Friend 读取被拒、owner 仍可读""重新加入后旧 Session 被拒、新 Session 可读""读取时权限变化立即生效"）、`test/long-agents/conversation-publication.test.mjs`（幂等补发/草稿隔离/成员投影/撤权阻断/旧授权拒绝）。

门禁：`pnpm verify` exit=0（44 tooling + **457** Backend + 179 Frontend + 30 生产构建 + 1 Nitro 开发 Runtime）；`check:architecture` exit=0；三处 `git diff --check` 通过。

B 已追加：**统一增量消息合同 + 公共流每 tick 鉴权**（`src/long-agents/conversations/{publication,stream}.ts`，门禁 `test/long-agents/conversation-publication.test.mjs` 3 项）。

- **统一增量合同**：用户消息与 publication 进入同一条 append-only 公共顺序，各自带**稳定 ID**（原生 entry id / publicationId）与持久游标 `cursor`；连接建立后**新到的用户消息也会增量送达**（不再有“只在首 tick 投递用户消息”的写法）；重复投递由游标去重；游标失效（墓碑/重建）返回 `reset` 全量快照而不是静默跳漏。
- **每 tick 鉴权**：撤权/归档后**服务函数**返回 `revoked` 且不再返回受限数据；重连/补历史同规则（未授权 403）；owner 可读、陌生 Friend 被拒；私有推理与工具结果不入流。
- **表述校正**：这些是**服务端语义与门禁**；SSE **HTTP 传输尚未接线**，因此**不能宣称真实连接已被关闭**——真实长连接的断流仍需接线后用 HTTP 长连接验收。
- 协议约定：publication 与源 Session/Entry 的对应关系以本文件为准。

B 仍未完成：**SSE HTTP 路由接线 + 真实长连接验收**（连接中的新消息增量、撤权断流、重连补齐）、**逐读取入口核对**（事件流、引用、附件与普通详情/历史/上下文一起）、**owner 身份不可由请求参数或群工具伪造的服务层门禁**、**发言派发**（可信 scope 经公共工厂在参与 Session 执行）、**确定性撤权/发布交错**（提交顺序）与**中断恢复**、发言派发（可信 scope 经公共工厂在参与 Session 执行）、恢复/中断与并发合同落地、群 HTTP/Tool 管理表面。C（策略 Workflow、预算、请教、群内任务来源）、D（API/Tool/Web）、E（S1–S9、V1–V12 真实模型与浏览器联合验收）未开始。**LA5 未验收，A 完成待独立复核。**

### 下一步施工顺序（可直接执行，无需重新设计）

1. **SSE HTTP 路由接线**：新增 `src/routes/api/long-agents/[longAgentId]/conversations/[conversationId]/stream.get.ts`，请求身份由**服务端入口**决定（owner 面向 HTTP 视为 owner；群 Tool 走服务函数并传自身 Friend 身份，禁止构造 owner）；循环调用 `readConversationStreamTick({afterCursor})`，把 `message`/`reset`/`revoked` 写成 SSE 事件；收到 `closed` 立即结束响应流。
2. **真实长连接验收**（必须用 HTTP，不得只用服务函数）：建立连接 → 追加用户消息与发布 → 断言增量送达；`revokeMember` → 断言既有连接收到 `revoked` 且连接关闭、之后不再有数据；用最后 `cursor` 重连 → 断言补齐且不重复；未授权重连 → 403。
3. **逐读取入口守卫**：对事件流（`turns/[turnId]/events.get.ts`）、引用解析、附件/文件读取逐项确认参与上下文拒绝；owner 身份只能在 owner 入口构造。
4. **真实发言派发**：`resolveParticipationScope` 产出的 scope 必须由服务端在同一调用栈内获得并写入 `ChatAgentInvocation`，经公共工厂在成员自己的参与 Session 执行；执行前后各做一次 `assertConversationAuthorization`。
5. **确定性交错与恢复**：用锁内暂停点构造"发布提交中 / 撤权同时发生"，断言提交顺序（撤权先 → 发布被拒且公共根无条目；发布先 → 条目存在但不再广播）；重启后 queued 恢复、running 缺终态标 interrupted，不重放未知副作用。
6. 之后 C（策略 Workflow/预算/请教/群内任务来源）→ D（API/Tool/Web）→ E（S1–S9、V1–V12 真实模型+浏览器验收与独立复核证据）。

## 工作包 B：SSE 路由、读取守卫、派发、恢复与提交顺序（2026-09-21 进展，未验收）

按上节“下一步施工顺序”1–5 施工，B 的服务端闭环已可执行。以下只记录**已有测试证据**的部分，不代表 B 或 LA5 已验收。

1. **SSE HTTP 路由**（`src/routes/api/long-agents/[longAgentId]/conversations/[conversationId]/stream.get.ts`）：**身份是入口属性，不来自请求**。该路由是 owner 面（与其余本地 owner API 同一信任级，产品无浏览器登录），不接受任何身份参数：未知查询参数（包括任何 viewer 提示）在流建立前直接 400，因此“省略参数”不能选中 owner、“传入成员 ID”也不能冒充成员。owner viewer 只由 `ownerConversationStreamViewer()` 构造（静态门禁断言只有该路由引用它）。Friend 侧读取不经此路由，而由服务函数用 Backend 已解析的群作用域构造 `memberConversationStreamViewerFromScope(scope)`：viewer 带 `{kind:"member", longAgentId, conversationId}`，绑定到已解析的群，每次 tick/重连重验成员资格，跨群作用域被拒。循环调用 `readConversationStreamTick`，把 `message`/`reset`/`revoked` 写成 SSE 事件（带 `id:` 游标，支持 `Last-Event-ID`），收到 `closed` 立即结束；归档在流建立前返回 403。群 Tool 路径仍走服务函数并传 scope 派生身份。
2. **真实长连接验收（HTTP，非仅服务函数）**：新增 `scripts/conversation-stream-http.test.mjs`，启动真实 Nitro dev Server + 隔离 `CHAT_HOME`，断言：连接 → 增量送达（连接后新增的用户消息与 publication 都经同一 cursor）→ 带身份参数的请求 400（尝试冒充成员/省略参数均被拒）→ 用最后 cursor 重连只补齐新消息、不重复 → `archiveConversation` 后所有已建立连接收到 `revoked` 并关闭、之后无数据 → 未授权重连 403。已接入 `pnpm test:dev`（与既有 dev E2E 同跑真实 dev Server）。成员撤权断流在服务层由 `test/long-agents/conversation-publication.test.mjs` 覆盖。
2b. **身份边界独立门禁**：`test/long-agents/conversation-identity-boundary.test.mjs` 断言（静态）`ownerConversationStreamViewer` 只被 owner 路由引用、路由不读任何身份参数且拒绝未知查询键、viewer 联合类型无 `string|null` owner 形式、Agent 侧代码（dispatch/publication/tools/workflows）不构造 owner viewer；并断言（运行时）成员 viewer 只能由已解析的 conversation scope 构造、跨群/非成员/非群 scope 均被拒，且群 scope 默认零工具。
3. **逐读取入口守卫**：`session-read-model.ts` 抽出 `assertSessionFileReadable`/`assertChatSessionReadable`；`readChatSession`、`readChatToolResultImage`（附件）、`readSessionTranscript`（历史）、`export.get.ts`（导出）都在读取前应用同一守卫；owner 入口显式传 `{kind:"owner"}`，其它调用必须声明 Friend 身份，无身份默认拒绝。证据：`test/long-agents/conversation-read-guards.test.mjs`（含撤权后立即拒绝、owner 仍可读、猜测他人 Session 被拒）。引用解析沿用 publication 投影（源缺失/变化显示不可用引用，不回退私有历史）；`turns/[turnId]/events.get.ts` 为 Friend turn 事件流，不按 sessionId 读取参与 Session（其 `openChatSession` 用 `projectId=longAgentId`），群派发不写入该反馈路径。
4. **真实发言派发**（`src/long-agents/conversations/{discussions,dispatch}.ts`）：`dispatchConversationAttempt` 在同一调用栈内读群、校验参与期与授权修订、解析成员参与 Session、调用 `resolveParticipationScope` 取得 scope + 授权承诺，写入 `ChatAgentInvocation` 后经**公共工厂** `createChatPiAgentSession` 在该成员自己的参与 Session 执行，模型返回后在**发布前再做一次 `assertConversationAuthorization`**，通过才发布；失败/撤权记为终态尝试且不发布。证据：`test/long-agents/conversation-dispatch.test.mjs`（真实装配与假模型，含执行中撤权阻断发布、失败不发布）。
5. **发布与撤权的提交顺序**：`publishConversationSpeech` 的授权复核移动到**公共根 Session 锁内**（追加前重读群记录并重验参与期/授权修订/源 Session 绑定），因此锁外撤权不会被在途发布继承。证据：`conversation-dispatch.test.mjs` 的 ordering 用例（锁内暂停点：撤权先 → 拒绝且公共根无条目；发布先 → 条目保留但已撤权 viewer 的流关闭）。
6. **确定性恢复/中断**（`recoverDiscussionState` + `drainConversationAttempts`）：`running` 且缺终态的尝试标记为 `interrupted` 且**不重放**；`queued` 保持可重新派发。证据：同文件 recovery 用例（interrupted 不再次调用模型；queued 依次 published）。

门禁：`npx tsc --noEmit` exit=0；`pnpm check:architecture` exit=0；`pnpm test:backend` 465 项通过（较 B 上轮 +8：`conversation-read-guards` 1、`conversation-dispatch` 5，及既有调整）；`scripts/conversation-stream-http.test.mjs` 通过。

B 层本身未完成项：实时流中“生成中草稿”状态、成员 viewer 的产品侧入口（当前仅服务函数由 D Tool 调用）与独立复核证据。这些不妨碍后续 C/D/E 进展，但不得按已验收使用。

## 工作包 C/D/E：编排、管理面与 HTTP 全流程（2026-09-21 进展，未验收）

### 身份边界修正（先于 C）

按复核要求，先把 SSE 身份从“默认 owner + viewer 提示”改为**入口属性**：

- `ConversationStreamViewer` 改为判别联合 `{kind:"owner"} | {kind:"member", longAgentId, conversationId}`，删除 `string|null` 形式；owner viewer 只由 `ownerConversationStreamViewer()` 构造，成员 viewer 只由 `memberConversationStreamViewerFromScope(scope)` 从已解析的群作用域构造（带 conversationId，跨群即拒）。
- HTTP 路由**不读任何身份参数**，未知查询键（含任何 viewer 提示）在建流前直接 400；归档在流建立前 403。
- 门禁：`test/long-agents/conversation-identity-boundary.test.mjs`——静态断言只有 owner 路由引用 owner 构造器、路由不含 `viewerLongAgentId`、Agent 侧代码（dispatch/publication/tools/workflows）不构造 owner viewer；运行时断言跨群/非成员/非群 scope 均被拒、群 scope 默认零工具。`scripts/conversation-stream-http.test.mjs` 真实 HTTP 断言冒充成员/省略参数均被拒。
- 诚实边界：本产品无浏览器登录，owner = 本地 owner API 入口（与其余 owner 路由同一信任级）；进程内 Extension 与 Backend 同属 TCB，本修正保证的是“不因省略参数或传入 ID 而改变读者、成员身份只能来自已解析作用域”，不是跨进程认证。

### C 编排（部分完成）

`src/long-agents/conversations/orchestrator.ts` 是唯一编排入口，五策略共享：mention（只发给显式目标，无目标不广播）、round-robin（每轮每人一次，多轮读前轮已提交消息）、parallel（同轮同 cutoff，并发上限）、moderator（主持在自己的公开发言里给出 `<next>成员ID</next>`，非法选择有界重试后停止）、free（允许 `<silent/>` 沉默，沉默记 skipped 不入公共流）。预算：`discussions.ts` 新增 `modelCalls`/`startedAt` 与 `discussionBudgetStopReason`，`dispatchConversationAttempt` 在超限时把尝试标 `skipped` 且不再调模型，每次实际模型调用计数。请教：`runConversationConsultation` 实现 A→B→A，B 独立参与 Session，A 的回答以 B 的公开结果为带来源输入，深度受 `maxDelegationDepth` 约束。耐久编排：`src/workflows/group-discussion/{workflow,step,index}.ts`（`"use workflow"`/`"use step"`，`maxRetries=0`；确定性 attemptId 使步骤重试不重复发言）。证据：`test/long-agents/conversation-orchestrator.test.mjs` 7 项。

C 未完成：**群内任务来源扩展（S8）**——`work.ts:startFriendWork` 仍只接受 Friend daily 来源且存在 Friend Home，未接受群参与 Session 来源；主持/自由的选择决策未单独计入预算审计。

### D 管理面（后端完成，Tool/Web 未开始）

新增 owner 面向路由（严格拒绝未知字段）：`POST/GET /api/long-agents/[id]/conversations`（创建/列表）、`[conversationId]` GET/PATCH（详情/配置 CAS）、`/[conversationId]/{members,archive,messages,discussions,consult,stop}`（成员 revoke/rejoin/setGrants、归档、公共投影、幂等用户消息追加、启动讨论、启动请教、停止）。用户消息追加 `public-root.ts:appendConversationUserMessage` 在公共根锁内按 `clientMessageId` 幂等（丢回执不重复追加、不重触发）。启动讨论/请教先同步校验归档并返回 202 + runId，再交给耐久 Workflow。

D 未完成：Agent 侧只读+提议的 `conversation_manage` Tool；Frontend 群管理面板/顶栏状态/事件流展示。

### E 验收（部分）

`scripts/group-conversation-http.test.mjs`（已入 `pnpm test:dev`）在真实 Nitro dev Server + 隔离 `CHAT_HOME` + **真实 Pi + 假 Provider（OpenAI 兼容 SSE）**上跑通：建群 201 → 用户消息 201 且重复 clientMessageId 幂等 200 → 带身份字段的启动请求 400 → 启动 mention 讨论 202 → 轮询到 discussion completed（attempt published、modelCalls≥1）→ 公共投影含真实模型回复与用户原消息 → owner SSE reset 一致 → 启动 A→B→A 请教 202 → 轮询到 completed（speakers [friend2, friend] 且 A 的 causationId 指向 B）→ 投影含 B_ANSWER/A_FINAL → CAS 冲突 409 → 改名 200 → revoke 成员 200 → archive 200 → 归档后启动 409、归档后流 403。

E 未完成：浏览器联合验收、S1–S9/V1–V12 全矩阵、付费真实模型。

### 门禁（本轮）

`pnpm verify` exit=0：tooling + **474 Backend**（+9：identity-boundary 2、orchestrator 7）+ 179 Frontend + 30 生产构建 + 3 真实 dev Server（dev E2E、SSE 长连接、群 HTTP 全流程）；`pnpm check:architecture` exit=0；`git diff --check` 通过。

**状态：B 记为“实施者报告服务端闭环完成，待独立复核”；C/D/E 部分完成，未验收；不提交、不推送、不部署。**

## 2026-09-21 续：C 完成、D 后端与 Web、E 部分（未验收）

按复核意见：先补“实际获准工具也不能越权”的运行时证明，再完成 S2/S8、D Tool 与 Web、E 的 HTTP 真实链路。

### 授权工具的边界（不是只靠默认零工具）

- **硬拒绝未受范围约束的能力**：`scope.ts` 新增 `assertConversationGrantsAllowed` 与 `CONVERSATION_SAFE_NATIVE_TOOLS`（仅 `read/write/edit/ls/find/grep`，均已按本轮项目/自身工作空间裁剪）。`bash`、Extension/MCP Tool、任何 Chat 系统 Tool（包括只读的 `conversation_manage`，它跨该 Friend 的多个群）都不可授权：写入授权时（`setMemberGrants`）直接拒绝，`resolveLongAgentScope`/`parseLongAgentScope` 拒绝，`applyScopeToCapabilities` 在注册点再次过滤（纵深防御）。
- **运行时证明**：`test/long-agents/scope.test.mjs` 的 “a granted file tool cannot read private Sessions or another group's public root” 用真实 Pi + 假模型给出**已注册** `read`，让模型尝试读取另一个群的参与 Session 文件与 Personal 文件；工具结果不含任何哨兵正文，而是范围拒绝信息。另有无授权 `read` 绕过尝试失败的既有用例。
- **存储归属与协作目标分离**：`Conversation.collaborationProjectId`（默认 `null`）取代“存储 Project 即协作目标”的隐式假设；群回合的 `cwd` 在未配置协作项目时为成员自身工作空间，不自动继承存储 Project 文件。
- **诚实边界**：owner 是本地 owner API 入口（与其余 owner 路由同一信任级，无浏览器登录）。本项保证“身份不来自请求、成员身份只能来自已解析作用域、未受范围约束的工具不可注册”，不是跨进程认证。

### S2 多群并行与容量排队

- 同一 Friend 在两个群有独立参与 Session 与独立上下文：`conversation-orchestrator.test.mjs` 断言两个群的公共投影互不泄露、第二群的指令不含第一群回复。
- 容量：并行/自由策略只立即运行 `maxConcurrentSpeakers` 位，其余尝试保持 `queued` 并记录 `排队：等待并发容量（上限 N）`，discussion 进入 `waiting`；`drainConversationAttempts` 用同一 worker 恢复，无丢失、不重复，完成后标 `completed`。证据：同文件 “a parallel round over capacity queues the rest with a reason and resumes without loss”。

### S8 群内后台任务

`src/long-agents/conversations/work.ts` + `work-store.ts`：来源条目必须是该成员**有权读取的公共条目**（否则 409）；任务在成员自己的参与 Session 执行、不占讨论预算、不持群写锁；完成后经二次授权校验只发布**授权结果引用**；成员被撤销或任务被取消即不执行/不发布。证据：`conversation-work.test.mjs` 3 项 + `scripts/group-conversation-http.test.mjs` 的真实 HTTP 任务链路。

### D Tool 与 Web

- `conversation_manage`（read-only）：`list/read/propose`。身份取自 `toolContext.longAgentId`，只列/读该 Friend 是成员的群；`propose` 返回 `applied:false` 的建议且不写任何状态。证据：`test/tools/conversation-manage.test.mjs`。
- Frontend：`lib/friend-conversations.ts`（运行时结构校验、绝不发送身份参数）+ `components/LongAgentConversationsPanel.tsx`（群列表/建群/成员与撤权/公共消息 SSE 实时投影/发消息/五策略发言/请教/后台任务/状态与终止原因/归档），接入 Coworker 设置面板“群聊”页签。证据：`frontend/lib/friend-conversations.test.mjs`、`frontend` 182 项测试 + typecheck + build。

### 修复的一处真实缺陷

新增 `conversation_manage` 后，Workflow step bundle 出现循环初始化（`init_pi_agent_session is not a function`）。原因是工具注册表被 Pi 装配引用，而工具又间接导入 Pi 装配。修复：把群任务的**读取/存储**拆到 `work-store.ts`（不含 Pi 运行时），只读工具与读取路由改用它；执行侧仍留在 `work.ts`。`scripts/group-conversation-http.test.mjs` 重新通过，证明四链路中的 Step bundle 与真实 Runtime 可用。

### S1–S9 状态（本轮后）

| 场景 | 状态 | 证据 |
|---|---|---|
| S1 建群+@A | 可用（HTTP/Web） | `group-conversation-http.test.mjs`、`conversation-orchestrator.test.mjs` |
| S2 同 Friend 多群/容量 | 可用（服务） | `conversation-orchestrator.test.mjs`（跨群隔离、容量排队恢复） |
| S3 圆桌 | 可用（服务） | `conversation-orchestrator.test.mjs` |
| S4 并行同 cutoff | 可用（服务） | 同上 |
| S5 主持/自由 | 可用（服务，模型决策计入预算） | 同上 |
| S6 无观看继续/终止 | 部分（预算/容量/无进展有终态；无长期后台调度） | 同上 |
| S7 请教 A→B→A | 可用（HTTP/服务） | 同上 + `group-conversation-http.test.mjs` |
| S8 群内任务 | 可用（HTTP/服务） | `conversation-work.test.mjs` + `group-conversation-http.test.mjs` |
| S9 改配置/撤权/归档 | 可用（HTTP/Web） | `group-conversation-http.test.mjs`、Web 面板 |

V1–V12：V2/V3/V4/V5/V7/V8/V9/V10/V11 已有服务/装配/迁移层证据；V1/V12 的外部平台投递归 LA6；**V6 已由后续“真实进程 SIGKILL/重启”测试补齐**（见下节）。本节状态已被下方“二次续”取代。

### 门禁（本轮）

`pnpm verify` **exit=0**：44 tooling + **481 Backend** + **182 Frontend** + 30 生产构建（含 built server 的默认 Tool/装配套件）+ 3 真实 dev Server（dev E2E、SSE 长连接、群 HTTP 全流程：建群→mention→A→B→A 请教→群内后台任务→公共投影→SSE→CAS→撤权→归档→403/409）。父仓库与 Frontend `git diff --check` 通过。

## 2026-09-21 二次续：预算归属、中央群聊、真实浏览器/模型、kill-restart（未验收）

按复核意见纠正两处并补齐 E：

1. **预算归属（不得逃逸根预算）**：`ConversationWork.source` 区分 `discussion` 与 `user`。讨论派生的子工作必须提供 `discussionId`，`executeConversationWork` 在运行前检查根讨论的 `discussionBudgetStopReason`（耗尽即 `failed` 且不调用模型），每次真实模型调用通过 `recordDiscussionModelCall` 计入根讨论；`user` 任务只能由 owner HTTP API 创建，拥有独立预算。同一参与 Session 的模型轮次由 `turn-lock.ts` 串行化，避免讨论与任务交错。证据：`conversation-work.test.mjs` 的“charged to its root budget and never escapes it”“adds its model call to the root discussion”。
2. **中央聊天而非仅设置页**：交流区工作区导航新增“群聊”入口（`useWorkspaceView`/`workspace-view.ts`/`WorkspaceNavigation`/`AppShell`），中央 `LongAgentGroupChatView` **复用公共 `MessageView`**，读取公共历史并用 SSE 实时投影、发送用户消息、@一轮并发起；设置页 `LongAgentConversationsPanel` 专管成员/策略/预算/归档。证据：`scripts/group-browser.test.mjs`。
3. **真实浏览器验收（无新增依赖）**：环境已有 Chrome 153 与 Playwright chromium（仅浏览器），因此新增 `scripts/cdp.mjs` 用 Node 内置 WebSocket 直连 Chrome DevTools Protocol。`group-browser.test.mjs` 在真实浏览器里断言：工作区导航“群聊”入口存在并可点击 → 中央群聊视图渲染 → 公共历史与实时模型回复经公共消息组件显示 → 中央输入框发送的消息出现 → 资源请求中无任何身份参数。
4. **真实模型验收**：既有 `~/.chat/agent` 配置（默认 `deepseek/deepseek-flash`）经最小直连验证 HTTP 200（仅输出状态/模型，不输出密钥）。`group-real-model.test.mjs` 用隔离 Home 通过 **symlink** 接入该配置（不复制/不输出/不改正式配置），经实际 Chat 装配与公共工厂跑通一次真实群回合，断言公开回复非空且讨论 `completed`。
5. **真实进程 kill/重启**：`group-recovery-restart.test.mjs` 在真实 dev Server 上发起群回合并让模型调用挂起，`SIGKILL` Backend，再以同一 Chat Home 重启；断言 `running` 尝试变为 `interrupted` 且**不重放、不发布**，队列中的独立任务恢复并完成（模型调用总数为 2，中断调用未被重放）。启动恢复接入 `runtime-initialization`（`recoverConversationsOnStartup`）。

门禁：`pnpm verify` exit=0 → 44 tooling + **483 Backend** + 182 Frontend + 30 生产构建 + **6 真实 dev Server 测试**（dev E2E、SSE 长连接、群 HTTP 全流程、真实浏览器、真实模型、kill/restart）。父/Frontend `git diff --check` 通过。

**状态：B/C/D 为实施者报告完成待独立复核；E 由实施者报告完成待独立复核（含真实浏览器、真实模型与真实进程重启）；LA5 未验收（待独立复核）；不提交、不推送、不部署。**

## 2026-09-21 三次续：独立复核 P1 修复（待复核）

独立复核（[记录](./2026-09-21-long-agent-la5-independent-review.md)）复现 3 项 P1；本轮按记录修复并把不变式固化为永久门禁 `test/long-agents/conversation-execution-protocol.test.mjs`（8 项，含原独立探针的 3 项）。

### P1-1 群后台任务复用参与 Session

- 修复：`ConversationWork.sessionId` 为每个 work 建立**独立、耐久**的 Task Session（`ensureWorkSession`，标记 `chat.group-work-session.v1`）；`resolveConversationWorkScope` 以成员资格/参与期为准，但作用域 Session 是该 work 的 Task Session；执行 turn-lock 以 Task Session 为键，不再占用参与 Session。
- 发布：`publishConversationSpeech` 新增 `workId`，在授权复核内校验源 Session 的 work 标记（conversation/成员/参与期/workId 全匹配）后才接受；参与 Session 仍是其余发言的源。
- 读取守卫：`participationBindingOf` 同时识别参与与 work 标记；work Task Session 对 Friend 的通用读取默认拒绝，owner 仍可在复核授权后读取。
- 门禁：原探针 `sourceSessionId !== bound.sessionId`；新增“运行中只持有自己的 Session 锁、参与 Session 空闲”（`withParticipationTurnLock` 探测）与“任务提示/结果不进入参与 Session 历史、任务后可继续发言”。

### P1-2 运行中取消仍发布且覆盖终态

- 修复：`cancelConversationWork` 先以 CAS 置 `cancelled`，再对在途 Pi 会话 `abort()`；执行侧在**提交前**重读 work，任何非 `running` 终态（取消/失败/恢复）都不发布、不追加；`finishWork(expectedStatus)` 仅当仍为 `running` 才写入 completed/failed。
- 门禁：取消后模型返回正文 → `cancelled` 且公共投影不含正文；取消后模型返回错误 → 仍 `cancelled`；排队中取消 → 不执行；真实崩溃恢复后的迟到结果 → 不发布。

### P1-3 根预算检查与计量分离

- 修复：新增 `claimDiscussionModelCall`，在 discussions 文件锁内原子“检查+递增”，在**真实模型调用边界**执行；讨论发言与 `discussion` 来源子工作及并行成员共享同一根预算；prompt 内由工具引起的额外 assistant 轮次按事件追加计量。独立 `user` work 不占用根预算（仅 owner API 可创建）。
- 门禁：原探针“讨论与子工作并发、`maxModelCalls=1` 时实际仅 1 次模型调用”；新增“两个并行成员共享一次预算”（1 次请求，1 published + 1 skipped）。

### 启动恢复

`recoverConversationsOnStartup` 同时恢复 work：`running` work 标记 `failed`（不重放），`queued` 保持可恢复；`scripts/group-recovery-restart.test.mjs` 的真机 kill/重启继续通过。

### 门禁（本轮）

`pnpm verify` exit=0 → 44 tooling + **491 Backend** + 182 Frontend + 30 生产构建 + 真实 dev Server 测试（dev E2E、SSE、群 HTTP 全流程、真实浏览器、真实模型、kill/restart）。`conversation-execution-protocol.test.mjs` 8/8。

**状态：实施者报告 P1 已修复、待复核；LA5 仍未验收。**

## 2026-09-21 四次续：第二轮复核 P1 修复（待复核）

第二轮独立复核（[记录](./2026-09-21-long-agent-la5-independent-review.md)）保留 2 项 P1；已修复并把两项探针纳入永久门禁 `test/long-agents/conversation-execution-protocol.test.mjs`（现 10 项）。

### R2-P1-1 取消后仍可公开发布

- 修复：`publishConversationSpeech` 新增锁内 `assertStillAuthorized`，在**公共根 Session 锁内**、追加之前重读 work 状态；work 任务只有在仍为 `running` 时才允许 append。取消先成功则发布被拒；发布先成功则条目保留但任务终态仍为 `cancelled`（语义已明确）。
- 门禁：复刻复核探针——持有公共根锁、等到发布进入 `assertSourceSessionAuthorized`、此时取消、再放锁 → `{status:"cancelled", published:false}`。

### R2-P1-2 工具后续模型轮次突破根预算

- 修复：使用公共 Pi 装配已有的 `providerRequestGate`（`createAgentSession` 的 fail-closed 请求门）——`createChatPiAgentSession` 透传该门，讨论发言与 `discussion` 来源子工作在**每次 provider 请求前**（包括工具续轮）调用 `claimDiscussionModelCall` 原子准入；被拒即以错误中止该请求，不再有“事后补计数”。移除了 prompt 前单次预留与 assistant 事件的 fire-and-forget 计量。
- 门禁：复刻复核探针——`maxModelCalls=1`、显式授权原生 `read`、首次模型返回工具调用 → HTTP 模型服务实际只收到 **1** 次请求。

### 门禁（本轮）

`pnpm verify` exit=0 → 44 tooling + **493 Backend** + 182 Frontend + 30 生产构建 + 真实 dev Server 测试（dev E2E、SSE、群 HTTP 全流程、真实浏览器、真实模型、kill/restart）；`conversation-execution-protocol.test.mjs` 10/10。

**状态：实施者报告两轮 P1 均已修复并纳入永久门禁，待独立复核；LA5 仍未验收。**

## 2026-09-21 五次续：第三轮复核 P1 修复（待复核）

第三轮独立复核（[记录](./2026-09-21-long-agent-la5-independent-review.md)）保留 1 项 P1：锁内重读仍非取消/发布原子仲裁。

### R3-P1 取消与发布必须共享仲裁

- 根因：取消只取 works 文件锁，发布在公共根 Session 锁内重读 works.json；发布在“重读已取得旧内容→取消成功→恢复返回”的交错下仍会 append。
- 修复：新增 `work-commit-lock.ts`。发布路径在**公共根锁内**先取得 work commit 锁，再做“重读状态→决策→append”，并把同一个 release 覆盖到 append 完成（`publishConversationSpeech` 的 `assertStillAuthorized` 返回 release）。`cancelConversationWork` 取同一把锁后再写 `cancelled`（锁只覆盖状态写，不覆盖模型等待或 abort）。锁序固定 public-root → work-commit，两路径不成环。
- 线性化语义：谁先取得 work commit 锁谁先成立。取消先获锁 → 发布锁内重读见 `cancelled` 而拒绝；发布先获锁 → 取消排队，发布提交保留，取消在其后生效。
- 门禁（永久，`conversation-execution-protocol.test.mjs` 12/12）：新增
  - “取消在在途提交后排队、不可绕过”（暂停提交锁内的状态读取，断言取消排队而非 race；释放后提交线性化优先，投影含提交结果，任务终态非 running）；
  - “先成功取消阻止迟到发布”（取消后 drain 不调用模型、不发布）。
  第三轮原始探针在提交方合法持有锁时会**排队**（不再出现 stale-read 绕过）；按复核说明，永久门禁在释放暂停点后验证排队与线性化，不要求取消越过正确持有的锁。

### 门禁（本轮）

`pnpm verify` exit=0 → 44 tooling + **495 Backend** + 182 Frontend + 30 生产构建 + 6 真实 dev Server（串行，避免并发资源导致浏览器冒烟抖动）。`conversation-execution-protocol.test.mjs` 12/12。

**状态：三轮 P1 均已修复并纳入永久门禁，待独立复核；LA5 仍未验收。**

## 2026-09-21 六次续：收口验收记录所列剩余边界（待复核）

按 [LA5 直接修复与第一轮整体实测](./2026-09-21-long-agent-la5-acceptance.md) 末节的剩余边界整批收口。

### 预算合同补全

- **Token 软预算**：`Discussion.tokensUsed` 与 `ConversationWork.tokensUsed` 按 provider 回报的每个 assistant 消息累计；`discussionBudgetStopReason` / `workBudgetStopReason` 在下一个 provider 请求前以“累计 Token ≥ `maxTokensSoft`”拒绝准入（Token 只能事后精确计量，按软限制处理）。
- **独立 user work 预算**：`ConversationWork` 新增 `budget`（创建时快照）、`modelCalls`、`tokensUsed`、`startedAt`；`claimWorkModelCall` 在 works 文件锁内原子“检查+递增”，与 discussion 同级的耐久计量。`discussion` 来源仍计根讨论，`user` 来源计自身，二者互不串。
- 门禁：`conversation-execution-protocol.test.mjs` 新增“`maxTokensSoft` 在已观测用量后拒绝下一次请求”“独立 user work 用自己的耐久预算并阻止续轮，且不产生 discussion 预算”；该文件现 14/14。

### V9 引用与重复执行

`conversation-references.test.mjs`（2/2）：发布引用在 `appendCompaction` 后仍可解析；在参与 Session `branch` 后不重发旧块、草稿不公开；同源重发保持幂等；源 Session 删除时显示 `unavailableReason` 且不回退私有历史；引用解析不产生模型调用。

### V11 多次迁移读写交替

`conversation-migration-cycles.test.mjs`（1/1）：`migrateLegacyProjectLayout` + `migrateAgentHomeNormalization` 连续 3 次读写交替后，`id`/`storageProjectId`/成员/参与 Session 绑定/授权修订/群 revision/成员 grants/讨论集合均不变，`conversations.json` 字节不变，迁移不自行启动讨论。

### V12 外部入口窄合同

`conversation-channel-contract.test.mjs`（2/2）：用户消息按 `clientMessageId` 幂等，重复入站不重复 append、不再次调用模型；`publicationId` 由可信 attempt+源条目确定性推导并在重读后稳定；`channel_send`、Extension/MCP、`bash` 等外部投递能力在群参与被显式拒绝（写入即报错且不改授权）。外部平台真实群投递仍按用户决定归 LA6。

### 浏览器组合

`scripts/group-browser.test.mjs` 扩展为“两群 + 五策略 + 后台任务”（真实 Chrome/CDP）：群一/群二列表与切换、消息隔离、发送、后台任务状态；中央控制上依次启动 `round-robin`/`parallel`/`moderator`/`free` 并等待各自讨论到达 `completed`（`mention` 已在历史中）。真实模型扩展验收 `CHAT_LA5_EXTENDED_ACCEPTANCE=1` 独立通过：四种策略各 `completed`、各 2 次模型调用。

### 门禁（本轮）

`pnpm verify` exit=0 → 44 tooling + **506 Backend** + 182 Frontend + 30 生产构建 + 6 真实 dev Server（dev E2E、SSE、群 HTTP 全流程、真实浏览器两群五策略+后台任务、真实模型、kill/restart）。父/Frontend `git diff --check` 通过。

**状态：验收记录所列 LA5 剩余边界已收口，并由独立复核确认；LA5 已在本地单 Backend 群聊范围验收通过（见验收记录）。**
