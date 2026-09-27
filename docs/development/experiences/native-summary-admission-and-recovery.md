# 原生摘要准入与取消恢复

## 现象与根因

Chat 为群讨论/群工作配置了 providerRequestGate，但旧 SDK 将它绑定在 Agent.onPayload。Pi 压缩和分支摘要直接调用 agent.streamFunction，不经过普通 Agent 循环，所以摘要实际 HTTP 未经过预算准入。原生摘要 usage 能落盘不能证明请求受预算控制。

真实取消还揭示另一个接缝：摘要退避/transport 把 abort 包装为普通 Error，原生自动压缩根据错误类型生成 aborted=false。执行确实停止，但产品错误地呈现为失败。

## 修正与边界

gate 与 Provider payload/response 钩子放在 SDK 共用 stream 边界，先调用本次 callback、扩展转换，再执行不可吞错的准入；普通请求只执行一次 gate。取消根据所属 AbortController.signal 判断，半份/截断/取消摘要不得生成成功 checkpoint。群讨论/群工作把成功摘要 usage 加入既有持久预算链，下一请求必须等待记录完成。

手动维护必须持有现有 Session 锁、核对 Workflow/Friend 队列和原生群绑定；导航 roster 没有列出群工作，不代表可通过普通入口执行。维护 requestId 和结果进入原生 CustomEntry。读恢复不重发未知收费请求，只有原生 checkpoint 能证明压缩完成。统计使用 Pi 只读 helper，不为看数字加载扩展。

## 原验证为何漏掉

普通 prompt 的 gate 单测没有调用 compact/navigateTree；成功摘要测试只验证落盘。人为构造 aborted 事件没有经过实际 transport/backoff，无法发现包装错误。历史 GET 正常也不证明显式继续已改变持久 leaf。

## 自动化门禁

- Pi `sdk-stream-options`、`6647-compaction-retries-transient-stream-drop`、`agent-session-stats`。
- Chat `test/agents/compaction-recovery.test.mjs`：真实本地 HTTP，普通/分段/分支/重试准入、预算拒绝、失败/取消后重开。
- `test/long-agents/summary-budget.test.mjs`：群根/独立工作额度拒绝与成功摘要计量。
- `test/session-maintenance.test.mjs`、`scripts/unified-session-runtime.test.mjs`：互斥、CAS、幂等、真实 Backend 重启无重放及同会话继续。
- `scripts/session-memory-switch-browser.test.mjs`：按钮、刷新、原生统计及编辑回填；Frontend parser/run-activity 校验边界。

相应 experience 资源 `native-summary-admission-and-recovery` 按既有机制显式选择，不自动全局注入。全部测试使用隔离数据和本地模型，不代表真实供应商全部协议均已验收。
