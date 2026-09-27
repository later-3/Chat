# 业务上下文投影撤销了 Pi 压缩

## 现象与根因

核对 Pi 会话特性时发现，Session Memory Writer 的 transformContext 每次从 Session 原始分支提取本轮 user/work 消息，并完全替换传入的上下文。Pi 已把长文本压缩为摘要后，这段投影会再次注入原文；长轮次可能反复超过窗口，摘要失效。

本轮归属与当前上下文是两个问题。原始分支是归属与溯源依据，不是每次模型请求的有效消息列表。Pi `buildContextEntries` 才决定摘要、保留区间与当前分支。另一个接缝是隐藏 handoff：先删这些 Entry 再遍历会留下缺失的 parentId，切断前文。

## 修正与边界

先用完整父链找本轮首个 user；让 Pi 选择有效上下文；再与本轮 Entry ID、Chat 上下文过滤允许的 ID 取交集，最后执行 Workflow 控制消息投影。没有本轮 user 则拒绝记忆写入。保留 JSONL 原文和分支，绝不修改 compaction 来迎合业务过滤。

本轮生成的摘要可能覆盖早期背景，Writer 仍只负责本轮结论。原始资料按需通过受权读取获取，不能自动把全文重新加回。原生压缩结束事件的计数、失败/取消也必须进入 Web；估计令牌量不能当计费事实。

## 原验证为何漏掉

旧 Writer 单元测试使用没有真实父链和 compaction Entry 的消息数组，只证明“移除前轮”；原生压缩测试只证明普通 AgentSession 可恢复。两者都没有检查压缩后 Writer 的真实 Provider 请求。前端仅检查压缩开始阶段，没有核对结果字段被公共事件适配丢弃。

## 自动化门禁

- `test/workflows/session-memory-writer-runtime.test.mjs`：真实 SessionManager、压缩 Entry、切分支、隐藏 handoff、原文仍保留。
- `scripts/unified-session-runtime.test.mjs`：真实 Nitro 开发 Step 和 Workflow SDK，经 HTTP 受控模型触发 Pi 自动压缩，进入 remember 后检查实际模型请求含摘要而无归档原文，读 API 仍恢复同一 Session。
- `test/workflows/chat-run-events.test.mjs`、`frontend/lib/run-activity.test.mjs`：压缩计数、失败/取消及畸形响应。

以上加入 `pnpm verify`。对应 experience Prompt 资源为 `writer-compaction-boundary`，按既有资源机制显式选择，不自动全局注入。
