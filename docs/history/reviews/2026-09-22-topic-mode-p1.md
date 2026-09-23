# 主题模式 P1（会话记忆底座）实施记录

日期：2026-09-22。状态：**已实施并完成检视 18–23 修复，待独立复检**。合同：[任务书](../../development/topic-mode-taskbook.md) §3.1；计划：[开发计划](../../development/topic-mode-plan.md) §1（含检视 01–17 收口）。

## 交付

| 交付 | 位置 |
|---|---|
| 存储与服务 | `src/long-agents/session-memory.ts`：统一 schema（`{schemaVersion, sessionId, orphan, revision, entries:[{entryId, purpose, author, content, originEntryId, supersedes, status, createdAt, updatedAt}]}`）、文件锁 + 原子写 + revision CAS、**追加式条目（无内容幂等；陈旧重试 = revision 冲突）**、`supersede` 追加式推翻（旧条目转 `superseded`）、purpose 五类 + 白名单自定义、`author` 只接受 agent/user、内容/条目上限、`markSessionMemoryOrphan` / `purgeSessionMemory` |
| 目标绑定 | `resolveSessionMemoryTarget`：可信绑定 `{storageProjectId, sessionId}` 优先，且校验该 storageProjectId 是 agent-kind 项目、会话存在；否则仅当 `projectId === longAgentId`（会话就在 agent home）才回退；**普通项目会话一律 403** |
| 历史读取 | `readSessionMemoryHistory`：只读**绑定会话自身**的分页条目（供投影后的 agent 按需读前文） |
| Agent 工具 | `src/tools/builtins/session-memory/{tool.json,index.ts}`，操作 `list / write / supersede / history`，注册进 `CHAT_SYSTEM_TOOL_PROVIDERS`，地址 `system:tool/session_memory`；默认 Long Agent 定义授予 |
| 工具上下文 | `ChatToolRuntimeContext.sessionMemoryTarget?: {storageProjectId, sessionId}`（可信绑定通道；模型参数不可自填） |
| 用户 API | `GET/PATCH /api/long-agents/[longAgentId]/sessions/[sessionId]/memory`；PATCH 的 `author` 由服务端固定为 `user`，编辑走 supersede |
| 生命周期 | `session-removal.ts`：`removeChatSession` → orphan（保留）；显式 `purgeRemovedChatSession` 与自动过期 purge → 删除记忆文件 |

## 证据

- 新增/修订 `test/long-agents/session-memory.test.mjs`，当前 **15 项全通过**（名称即证据）：
  1. `purpose-typed, append-only entries with revision CAS`：purpose 分类 / CAS 冲突 / 追加式（同内容再写 = 新条目）/ 非法 purpose 与 author；
  2. 目标只解析到 agent home（普通项目会话 403；可信绑定可用；不可验证的绑定被拒）；
  3. remove → orphan 且拒绝再写，purge → 文件删除；
  4. **真实公共装配 + 假模型工具调用**：模型发出 `session_memory` 工具调用 → 条目落在**实际执行该轮的会话**（不是任意会话）。
- 契约测试同步：`test/tools/tools.test.mjs`（工具清单）、`test/long-agents/long-agents.test.mjs`（默认定义授予全部系统 Tool）、`scripts/built-server.test.mjs`（生产构建工具目录）。
- 当时 `pnpm verify`：56 tooling / 543 Backend / 185 Frontend / 30 生产构建 / 8 dev Server（后续轮次继续演进，见文末最新证据）。

## 明确留到 P2（不在 P1 声称完成）

- **绑定的派发侧盖章**：`sessionMemoryTarget` 的字段、解析、校验已就绪，但"节点发起服务盖章并经 `workflow-call-tool → workflow-call → ChatWorkflowInput → step` 传递 + 嵌套继承"要随 P2 的节点会话 API/派发链一起接线（P1 已验证直连 agent home 会话与显式绑定两条路径）。
- 「会话记忆」workflow（`work`/`remember` 两 agent）、Skill 文件（属 workflow agent 的 prompt）、主题图、节点 API、前端。

## 检视 18–23 修复（2026-09-22 第二轮）

| ID | 修复 |
|---|---|
| 18 | 条目身份与去重分离：entryId 改为 **revision 基**（`smem-<revision>-<digest16>`），每次有效写入新 id；**删除内容相同即提前返回的幂等**（同一内容再写 = 新条目）；`write` 携带 `supersedes` 在服务层 400。探针 A→B→A：3 次写入 3 个唯一 id，旧条目状态不被追溯改动 |
| 19 | remove/purge 的记忆处理**纳入生命周期完成条件、不再吞异常**：主路径在锁内、index 写之前执行，失败即中止（会话文件已移走的场景由 removed-index 恢复路径兜住，重试会补齐）；`markSessionMemoryOrphan` 不再吞读取错误；早返回路径（重试/恢复/tombstone）同样确保 orphan/删除；purge 后并发写入被锁内"会话仍 active"核验拒绝，不会重建文件 |
| 20 | `restoreRemovedChatSession` 同步 `clearSessionMemoryOrphan`（orphan 清除 + revision 推进），恢复后可写 |
| 21 | PATCH 严格解析：`operation` 必须是 `write|supersede`（缺失/非法 400）；`write` 携带 `supersedes` 400；服务层同样拒绝（双层） |
| 22 | 历史读取：支持字符串 content 与 `chat.*` CustomMessage（如整合摘要）；**无效游标 400**（不再从头返回）；条目带 `parentId` 保留分支信息 |
| 23 | 计划/记录同步实际范围：P1 = 底座部分交付（含 PL1 绑定合同与解析、PL2 语义确认）；**来源绑定在业务 workflow 派发链上的盖章与嵌套继承移到 P2 门槛**；工具地址统一 `system:tool/session_memory` |

新增/修订回归（检视者给的最小回归集全覆盖）：A→B→A 三唯一 id、purge 失败可重试（目录占位→修复→成功）、restore 清 orphan 后可写、purge 后并发写被拒且不重建文件、自动过期 purge（经 `listRemovedChatSessions` 过期路径）、PATCH 非法 operation 400、历史读取字符串 content/CustomMessage/无效游标 400、并发 CAS。

`pnpm verify`：56 tooling / **560 Backend** / 185 Frontend / 30 生产构建 / 7 dev Server（唯一失败项为真实模型账户额度不足 429，见文末）。

## 检视 24–29 修复（2026-09-22 第三轮）

**根因**：记忆事实与会话生命周期索引是两个耐久对象；此前的顺序把记忆变更放在索引写之前，产生“相反顺序”的半完成状态，且一次设计失误（收敛探测用了错误的会话文件名）导致每次收敛都误删记忆文件；另有一处嵌套索引锁导致挂起。

**最终顺序（每个生命周期操作一致）**：`intent（pending 索引写，耐久）→ 移动会话文件（rename/unlink）→ 变更记忆（mark orphan / clear orphan / 删文件）→ complete`。

| ID | 修复 |
|---|---|
| 24 | 自动过期 purge 与显式 purge 的记忆删除都在 **pending 意图之后、complete 之前**；失败抛错（不假性完成），记录仍在 `index.sessions`，下次过期扫描重试 |
| 25 | restore 的 orphan 清除在 pending 意图与文件回迁之后；中断的 restore 由**恢复回调**收敛（会话回 active、orphan 清除），重试会报告“移除区找不到”（已恢复的预期结果）而两侧事实已一致 |
| 26 | 合同定稿：**只承诺 CAS，无内容幂等**；代码与注释已同步（陈旧重试 = revision 冲突） |
| 27 | 工具地址统一 `system:tool/session_memory`；验证记录按实际测试名与结果重写 |
| 28 | 索引写失败不再产生半完成状态：pending 写失败 → 会话与记忆都未改动；pending 后的中断 → `readRecoveredRemovedSessionIndex` 的**恢复回调**按类型收敛（remove→orphan、restore→clear、purge→删除），`convergeSessionMemoryWithLifecycle` 由调用方给出生命周期状态（不再按 `<sessionId>.json` 探测——那会误删记忆） |
| 29 | purge 先持久化意图，再删会话文件与记忆；索引写失败时记忆完好、会话仍可恢复 |

**新增回归（名称即证据）**：`review 18` 三唯一 id；`review 19` purge 失败可重试；`review 20` restore 清 orphan；`review 24` 自动过期 purge 失败可重试；`review 22` 历史读字符串/CustomMessage + 无效游标 400；`review 25` restore 中断与恢复；`review 21 (route)` 非法 operation 400；`review 28` remove/restore 索引写失败无半完成状态 + 收敛自愈；`review 29` purge 索引写失败后会话可恢复且记忆完好。

**门禁**：`pnpm verify` 56 tooling / **560 Backend** / 185 Frontend / 30 生产构建 全通过；`scripts/group-real-model.test.mjs` 当时因真实模型账户返回 `429 余额不足或无可用资源包,请充值` 失败（外部额度）。**2026-09-23 已把默认模型切到 Command Code 的 `command/deepseek-v4.1-flash`**（全局 `~/.chat/agent/settings.json` + 6 个 Long Agent 的 `definition.json`，workflow agents 无模型钉住、继承默认），该测试复跑通过（7.9s）。

## 检视 31–33 修复（2026-09-22 第四轮）

| ID | 修复 |
|---|---|
| 31 | 恢复收敛改为**由 index 模块自己完成**：`recoverPendingOperation` 从传入的 Project 上下文（只要有 `chatHome/projectId/kind=agent`）构建 `lifecycleConvergence` 并在恢复后调用 `convergeSessionMemoryWithLifecycle(..., state)`；所有**触碰移除索引**的入口（`listRemovedChatSessions`、`purgeExpiredRecords`、生命周期操作，以及未命中 active 时的状态查询 `findInactiveChatSessionState`）都自动获得同一收敛。**准确边界**：状态查询若先命中 active 会话则直接返回、不触碰索引，此时中断 restore 留下的陈旧 `orphan` 由**合法写入自愈**（会话 active 时写入不误拒）或**下一次索引读取**收敛——不是“任何查询都会收敛”。**没有能力收敛的调用者（只带 `sessionDir`）不再完成 pending**，避免“两个耐久对象只改一个”。另外，写入路径在锁内判定生命周期：会话 active 但 `orphan` 陈旧（中断的 restore 留下）时**自愈**而不是误拒合法写入（顺序：生命周期判定 → CAS → 自愈） |
| 32 | 恢复流程**先收敛记忆、成功后才写完成索引**；收敛失败则保留 pending 意图，显式与自动 purge 下次都能重试（文件操作幂等，可安全重放）。新增只读原样读取入口 `readRemovedSessionIndexState` 供调用方/测试观察 pending |
| 33 | 新增 4 项“保留真实记忆内容”的中断恢复回归（把 session-memory 目录设为只读触发记忆写失败，不再删除原文件）：中断 remove / restore / 显式 purge / 自动过期 purge 各自断言**pending 保留 + 会话位置 + orphan + 条目完整**，修复后由一次恢复读取收敛并清空 pending；既有收敛测试补上遗漏的生命周期状态参数并覆盖 active/removed/purged 三态。**检视 34 表述修正**：测试名与记录都改为“触碰索引时收敛；active 会话的合法写入可自愈”，不声称任意状态查询都会收敛 |

**当前门禁**：`test/long-agents/session-memory.test.mjs` **19/19**、`test/session-removal.test.mjs` 7/7；完整 `pnpm verify` exit=0：56 tooling / **564 Backend** / 185 Frontend / 30 生产构建 / 8 dev Server（真实模型测试在切换 `command/deepseek-v4.1-flash` 后通过）。

**修复过程中顺带发现并修掉**：非 agent 项目（无会话记忆）被“无收敛能力就不完成 pending”误伤 → 明确区分（非 agent 项目 = 无需收敛的空操作；`kind` 未知的窄上下文才不完成）；写入路径的服务顺序改为 **生命周期判定 → CAS → 自愈**，避免把“会话已移除”误报成 revision 冲突。
