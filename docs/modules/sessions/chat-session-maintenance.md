# Pi 原生会话维护合同

2026-09-27 工作区实现；未提交、未部署。此接口只适配原生维护操作，不接管 Workflow 对话执行。

## 场景与事实源

查看统计不启动 Agent、不加载扩展、不修改 Session。Pi `getSessionStats` 汇总全文件（含旧分支、压缩、分支摘要与工具 usage）；`getSessionContextUsage` 是当前分支占用，压缩后没有新有效模型响应时 tokens/percent 为 null，不能显示为零。两者不是同一口径。

手动压缩用于空闲可写普通会话与私有 Friend 会话。Backend 通过 `createChatPiAgentSession` 装配并调用 `compact(instructions)`，不发伪造 prompt、不运行工具循环、不创建新 Session。普通会话解析最近工作节点及当前配置，排除 remember；未显式选模型时使用最近工作模型。Friend 使用自身有效定义与最近装配的协作项目。维护装配将 tools 设为 none，因为摘要不执行工具且没有 Workflow 调用身份；保留资源与扩展压缩钩子，不伪造 Workflow invocation。

历史 GET 始终只读。显式继续选择 user 则分支到其父节点并返回编辑文本；选择完整 assistant 则分支到该节点。复用 Pi `branch/resetLeaf` 并追加纯元数据，使重开后的叶位置有效。原文和旧分支全保留。未结束响应、工具调用中间位置、群公开/参与/群工作及 Topic 的通用继续均拒绝。此版本不运行 CLI tree-navigation 扩展钩子，不自动生成 branch summary，不调用 `resumePendingTurn` 重放未知工具。

## HTTP

- `GET /api/sessions/:sessionId/maintenance?projectId=...`：schemaVersion=1，精确身份、leafId、capabilities、stats、operation、最近原生维护事件；no-store。
- `POST` 同地址：`{projectId,requestId,expectedLeafId,kind:"compact",instructions?}` 或 `{projectId,requestId,expectedLeafId,kind:"continue",entryId}`。说明最多 4000 字符。running 返回 202，已完成/重复请求返回 200。
- `DELETE` 同地址：query projectId、requestId，显式调用活动操作的 `abortCompaction`，返回当前快照。浏览器离开/刷新只停止观察。

POST 使用现有 Session 操作锁，检查 Workflow 活跃记录和 Friend 耐久队列；忙碌或 expectedLeafId 不匹配返回 409。精确 Project/Session、只读归属和原生群绑定在服务端检查，不信任浏览器 capabilities。群工作即使未在导航 roster 中出现也不能绕过原生绑定。

`chat.session-maintenance.v1` 原生 CustomEntry 保存 requestId、规范化输入和结果。相同 ID/输入只读取已有状态；相同 ID/不同输入拒绝。running 在受理前落盘，结束保存成功/失败/取消。Backend 中断后 GET 报 interrupted，不自动重发收费请求；成功 compaction 已落盘但收据未落盘时，可以紧邻的原生 checkpoint 确认完成。后续工作或另一次维护不能冒充此次成功。

## Web

历史继续只改变模型上下文分支，不撤销已经执行的文件操作或 Memory 写入。

`useSessionMaintenance` 观察后端事实。POST 失联时保留原 requestId 供显式重试；运行中轮询、刷新重读。压缩按钮、停止、`/compact [说明]`、`/session` 接通。浏览旧分支显示返回/继续提示并暂停发送；“编辑这里”仅在服务端切换成功后回填草稿。中英文文案随设置切换。

## 验证与边界

- `test/session-maintenance.test.mjs`：公共装配和本地 HTTP、统计无模型请求/文件写入、幂等、重开、退避取消、冲突、完整边界、群工作拒绝、中断不重放。
- `scripts/unified-session-runtime.test.mjs`：实际 Nitro/Workflow/Step/Pi 和维护 HTTP，截断/配额/取消/重启、手动压缩/统计/历史继续及同 Session 后续请求。
- `scripts/session-memory-switch-browser.test.mjs`：实际按钮、统计、草稿回填与刷新，并保留主题/语言/响应式门禁。
- Pi SDK/compaction retry/stats 与 Chat events、Frontend maintenance parser/run-activity 分别验证底层和消费边界。

不声称支持全部 Pi 扩展 UI、分支摘要生成、队列取回、任意工具中断恢复或全部供应商协议。成功摘要用量计入群预算；Provider 未报告/失败摘要未保存用量不能伪造为精确计费。
