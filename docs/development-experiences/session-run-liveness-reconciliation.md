# durable Run 记录是意图不是存活信号：崩溃窗口造成 Session 永久"运行中"

## 现象与影响

2026-09-02 用户删除一个 Session 时永远报"Session正在运行Workflow"：该 Session 的 planning-execution Run 在 19:31 被接受（planning record `phase: "starting"`、runtime status `"running"`、binding 已写入），随后 dev 进程在第一个 Step 执行前退出。重启后三处 durable 记录全部冻结，删除、改名、发起新 Run 三个操作被 `assertChatSessionIsIdle` / `assertSessionHasNoActivePlanningRun` 永久拦截，前端表现为无限"等待模型"。

## 直接根因

Chat 的 Session 活跃守卫把 **durable 记录当存活信号**用：

- runtime `getRun(runId).status` 读的是 accept 时物化的 `"running"`，不是"此刻有 executor 在执行"；
- planning record 的 phase 只由正常执行事件推进，进程死亡后没有任何事件能把它推到终态；
- binding 在 Run 启动时写入，完成后也不清理（设计上靠运行时状态判断）。

死进程无法自证死亡，三处账本无人收敛，守卫无条件信任它们 → 死锁。这是 Workflow SDK 的公开 API 缺口：`workflow/api` 没有"列出活跃 Run"或 liveness 查询，`getRun().status` 无法区分"正在执行"与"被记录为 running"。

## 正确姿势

1. **liveness 真源必须在执行发生的进程里**。Chat 在四个 `"use workflow"` 函数体首尾通过 `src/workflows/execution-registry.ts`（globalThis 单例 Map）登记执行边界：进入登记、返回或抛出注销、崩溃随进程消失。workflow 函数（而非 step 函数）是正确接线点——`waiting_review` 通过 `await decisionHook` 挂起，此时没有 step 在栈上，包 step 边界会误判"等待审核"为空闲。
2. **durable 记录降级为意图账本，由对账收敛**：`reconcileStaleChatSessionRuns` 只在"进程内登记表无条目 + 记录非终态 + 已过宽限期（10s，关闭 accept→pickup 竞态）"时判定为崩溃残留，binding 走 `getRun(runId).cancel()` 公开 API 写 `run_cancelled` 事件，planning record 推进到 `failed`。不手改 SDK 存储文件。
3. **`waiting_review` 是合法可恢复状态**（hook 是 durable 的，重启后 `resumeHook` 仍可用），对账必须跳过它，守卫继续拦截。
4. 守卫先对账再判定，删除/改名/发起新 Run 三个入口共用同一套逻辑，僵尸自愈一次后永久解除。
5. 回归门禁：`src/session-activity.test.mjs` 覆盖注册表生命周期、运行中拦截、宽限期保守拦截、僵尸对账放行、waiting_review 不被误杀。
6. 排查同类问题时，`~/.chat/runtime/workflow-data/runs/<runId>.json` 的 `status` + `steps/` 里是否有 `attempt` 事件能区分"接受后从未执行"（僵尸）与"执行中崩溃"。
