# Chat Workflow CLI

基于 Pi 原生 TUI 组件的 Chat Workflow 客户端。Node.js >=22.19.0。

```bash
npm install -g ./later-chat-cli-0.3.1.tgz
chat tui --url https://chat.example.com --project my-project
```

`/workflow` 选择 Workflow，`/resume` 恢复 Session，`/fork` 从用户消息前分叉，`/history` 查看完整历史，`/approve`、`/revise` 审核计划，`/cancel` 取消 Run，`/help` 查看全部命令。`/quit` 退出客户端，已接受的 Run 在后端继续。

所有模型、配置、执行和历史属于目标 Chat Backend。Web 与 TUI 共用同一 Session；客户端不运行 Agent，不需要模型密钥。目标 Backend 必须支持 Workflow TUI v1 transcript/fork 合同。

默认地址 `http://127.0.0.1:43110`，可用 `CHAT_SERVER_URL` 覆盖；远程地址要求 HTTPS。`--theme light` 使用亮色主题。

本期支持普通 Workflow 与文字输入，不接入 NanoClaw / Long Agent、本机附件上传或 Pi 本地运行命令。Fork 将所选输入文字恢复成草稿，图片需要在 Web 重新附加。包采用 tarball 分发，尚未发布到 npm。
