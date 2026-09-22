# LA6 合入前独立检视简报（给另一个 Agent）

## 0. 一句话

这是一批**尚未提交**的 Friend 长期 Agent 功能线（LA3–LA6 混合在工作区）的收尾改动，重点在 LA6：真实渠道闭环（B）、24h 采集与耐久事实（D）、整体验收（E）。请判断**能否合入**，不要只看 `pnpm verify` 全绿。

## 1. 交付面（工作区，全部未提交）

- 父仓库 `83b469ce9`（工作区 85 M / 3 D / 101 ??，含 LA3–LA6 全部改动与文档）。
- `frontend` 子模块 `5d3524c` 工作区 19 M / 23 ??（新增好友职责/产物/群聊/会话面板等）。
- `nanoclaw` 子模块 `4c79e473` 工作区 10 M / 5 ??（LA6 会话渠道适配、任务投影等）。
- `pi` 子模块 `0343d486d` 未改动。
- **父仓库 submodule 指针仍指向旧 commit**：只合父仓库不会带上 frontend/nanoclaw 改动；必须先在两个子模块提交，再更新父仓库指针。

## 2. LA6 核心机制（检视重点）

### B 真实渠道闭环
- 出站短锁协议：领取 attempt（写 `pending` + `attemptToken` + `claimedAt`）后**释放锁再做 HTTP**，结果按 `attemptToken` CAS 写回；回执走短锁，可在网关 HTTP 返回前完成，无循环等待。
- 状态机：`queued` = Nano 持久化（非平台送达）；只有可信回执能到 `delivered`；`delivered` 终态不可回退；崩溃/超时 `pending` → `unknown` 不自动重发。
- 回执版本化：Nano 侧 `version`/`accepted_version`，Ack 按冻结版本 CAS，升级事实（failed→delivered）必定重发，旧 Ack 不确认新版本。
- 完整地址路由：`agent_group_id + instance + channel_type + platform_id/messaging_group_id + thread_id` 精确匹配，`threadId=null` 表示“无话题”不通配。
- 绑定同步：Chat `syncRevision`/`syncedRevision` CAS 确认；Nano `revision` 条件写；未知 binding 的 unbind 留耐久墓碑，迟到旧 bind 不能复活。

### D 采集与耐久事实
- 候选指纹覆盖 parent + 三子模块 `HEAD/dirty/dirtyHash`（含未跟踪源码正文，排除运行数据/凭据）。
- 真实健康探测（Backend `/api/health`、Nano `/v1/health`）；只统计运行区间内样本，尾部空洞、非全存活采样、区间外/未来记录均判失败。
- `resolveDurableFacts` 支持 `delivery/duty/task/discussion/artifact`；`requireVerified` 要求与耐久对象一致的终态、区间内时间、非空来源；新增只读 `occurrences` 导出关联 `expectedId→durableRef`。

## 3. 已有证据

- `pnpm verify` exit=0：54 tooling（含账本 10）/ **543 Backend** / 185 Frontend / 30 生产构建 / 8 真实 dev Server。
- `scripts/la6-joint-acceptance.test.mjs`：真实 Chat Nitro + 真实 Nano 网关进程 + 隔离适配器，全链 1/1；`scripts/la6-joint-real.test.mjs`：同链走**真实模型**，连续 3 次通过。
- 真实平台（生产栈，用户授权部署）：Telegram 私聊出站 `delivered` `8651741012:1267`；Telegram 群**双向** `delivered` `-5233196776:1273`。
- Nano `tsc --noEmit` + `src/modules/chat-integration`/delivery 83 项通过；B 已 6 轮独立复核通过。
- 记录：`docs/history/reviews/2026-09-21-long-agent-la6.md`、`...-la5-acceptance.md`。

## 4. 已知边界 / 未测（不要当成通过）

- **24h 自然运行未做**：用户明确豁免，记为“未测”。采集器与账本已就绪，可随时启动。
- 微信真实收发未做；真实入站只覆盖 Telegram。
- 联合测试的准确边界：Nano 用测试宿主（复用生产网关/模块/投递/回执钩子，但非生产主入口）；`/test/inbound` 走生产共享 `routeInboundToConversation`，**未经过平台 adapter 实际入站回调/完整 router**；群轮次由测试显式启动，不证明外部消息自动开讨论。
- 生产已从工作区部署并重启，Nano 升级 tripwire 已用其文档命令记录；**未 commit / push**。

## 5. 合入注意事项

1. 先提交 `frontend`、`nanoclaw` 子模块，再提交父仓库并更新指针；核对三处 `git diff --check`。
2. 重新 `pnpm build`（Chat）与 `cd nanoclaw && pnpm build`；Nano 启动若报 tripwire，用 `pnpm exec tsx scripts/upgrade-state.ts set`。
3. `test:tooling` 已加 `--test-concurrency=1`（真实 launchd 门禁并行会超时）；`test:dev` 已含联合验收（缺 Nano 依赖时显式 skip）。
4. 真实模型联合测试不在默认门禁（避免每次 verify 消耗额度），需手动跑。

## 6. 建议 reviewer 重点确认

- 出站短锁 + attemptToken CAS 在“回执先于 HTTP / 旧 Ack 在途 / 崩溃恢复 / 并发重入”下是否真的无重发、无回退；`recordDeliveryResult` 与 `confirmConversationDelivery` 的锁与 CAS 是否覆盖所有写入口。
- `threadId`/`instance` 精确匹配是否严格无通配、无跨实例误配；未命中是否安全拒绝。
- unbind 墓碑与 `revision` 条件写是否在所有乱序下成立；Chat `syncedRevision` CAS 是否会漏同步或误确认。
- D 账本是否真的 fail-closed（候选完整指纹、逐样本存活、区间外记录、`requireVerified` 来源），是否存在“人工声明即通过”的旁路。
- 群讨论流程因 `deliverConversationPublication` 被 await 是否有对既有行为的回归（锁持有、超时、失败传播）。
- 执行关联绑定（P1 修复）：任务事实必须绑定同 `workId` 下最早接受的原始 turn（`sequence` 升序、`acceptedAt` 兜底），后续同 work 的聊天轮不能替代原任务结果（双向：原失败+后成功→failed；原成功+后失败→success）；`resolveDurableFacts` 与 `collectDurableOccurrences` 须共用 `resolveTaskOccurrenceFact`，导出与核验不得分叉。
- `settledAt` 终态写入口（P2 修复）：`cancelFriendTurn`（queued 取消）、`controlQueuedRequest` 的 cancel 分支要写 `settledAt`；retry 分支重新排队时要清空旧完成时间（`settledAt: null`）；重启恢复的 interrupted/completed 走 `updateTurnStatus` 覆盖；账本 `requireVerified` 对 success 缺 `settledAt`（`at=null`，如未部署新构建期间产生的 turn）必须 fail-closed。
- 子模块边界：Nano 改动是否最小、是否遵守其 AGENTS；Chat 是否只通过窄接口调用 Nano。
- **（2026-09-22 第二轮检视已覆盖）** 任务 occurrence 绑定**原始执行 turn**（同 workId 下最早 sequence，非最新轮次），`resolveDurableFacts` 与 `collectDurableOccurrences` 共用 `resolveTaskOccurrenceFact`；`settledAt` 覆盖全部终态写入口（`updateTurnStatus`/`cancelFriendTurn`/`controlQueuedRequest` cancel 与 retry 清空），且 `parseAcceptedTurn` 拒绝非终态携带完成时间、兼容历史缺省。
