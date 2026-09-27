# Pi 会话能力盘点与压缩适配验收

## 基线与结论

Chat 工作分支 `codex/unified-session-performance`，父仓库起点 `fe296a63a1cf40f82e2cce425471840cbfeffa6a` 加工作区改动；Pi gitlink 与实际检出均为 `0343d486d8d8c4622384fa18e93c7f1398cbd749`，版本 0.85.1。Pi/NanoClaw 无本轮修改。未提交、推送或部署正式服务。

[完整能力账本](../../modules/pi/chat-pi-session-capabilities.md)共 49 项：13 项保留、11 项业务适配、2 项本轮修复、22 项完整或局部缺口、1 项端形差异。不是 49 项都已完整验收，也不是 22 个相互独立的运行故障。

## 本轮已修复

1. Session Memory Writer 重投影原始本轮消息会撤销 Pi 压缩。改为完整父链识别本轮、原生有效上下文选择、再过滤本轮与隐藏控制 Entry。保留原文和分支；明确摘要中的早期背景不能自动视为本轮结论。
2. 公共事件适配丢弃压缩结果，前端只显示压缩中。现在传递原生计数并校验，显示成功/失败/取消和估计令牌量；沿用原轮次完成摘要，不重复显示完成状态。重试结束清除旧倒计时。文案同时覆盖 en/zh-CN。

架构复核：沿用 `createChatPiAgentSession`、Pi SessionManager/压缩算法和既有事件读模型，没有第二套 Session、模型循环或历史库，没有改变业务 Session 归属。

## 仍需适配

手动压缩/取消、上下文与全 Session 统计、旧节点原地继续、普通 Workflow 的 steer/followUp/队列、扩展启动与 UI、命令、部分导入导出和运行策略面板保持开放。不能把空函数/null 返回、旧节点只读浏览或 SDK 方法存在当作产品支持。

摘要预算探针另确认：普通请求 2 次/gate 2 次，一次压缩产生摘要请求 2 次/gate 0 次。摘要 usage 落盘与 Chat 的请求准入是两个不同事实；这一缺口尚未修复。探针仅使用隔离本地 HTTP 模型，没有真实供应商请求。

## 验证结果

- 最终 `pnpm verify` 退出 0：56 项工具脚本、663 项 Backend、221 项 Frontend、30 项生产构建服务、12 项开发 Runtime/浏览器，共 **982 项通过、0 失败**。包含 Builder/Step 装载、生产构建与实际 Workflow SDK 执行。
- Writer 的额外定向回归 8 项通过。实际 Runtime 验证 work 自动压缩后 remember 发给模型的是摘要，未重新注入归档原文，Session ID 不变。
- 真实浏览器通过压缩反馈、估计标注与 5 种视口的完整输入/工具区域；人工检查最新截图，没有重复完成提示。
- `git diff --check`、`git -C frontend diff --check` 通过。
- 隔离预览 63291 已恢复并检查健康 JSON、首页、JS/CSS 状态与 MIME；不是正式部署。

本机证据位于 `.data/verification/pi-capabilities/`：`verify.log`、`writer-tests.log`、`native-compaction-feedback.png`、`summary-budget-probe.json`。自动化用例在源码，证据目录不提交。
