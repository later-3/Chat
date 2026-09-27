# 合并控件时保留领域策略事实

2026-09-27 全面更新将主题会话的重复记忆入口合并到 ChatWindow。真实浏览器回归发现：普通会话开关只控制发送偏好，主题节点开关还必须更新服务端节点策略。仅搬动控件会造成 UI 改了、刷新又恢复的功能回退。

修复由 ChatWindow 的 useTopicMemoryControl 统一读取节点策略，使用既有节点 PATCH/revision 更新；主题地图、日期记录和直接 Session 链接共用同一个控制器。加载失败展示重试，不以普通浏览器偏好伪装节点事实。值同时进入展示与发送参数，错误贴近开关；冲突读回新版本。会话加载依赖稳定的 Session 身份，不依赖整个节点详情对象，避免更新开关时卸载会话、丢失弹层状态。异步结果只写回原目标。

门禁：`scripts/topics-browser.test.mjs` 从共享记忆入口切换策略，核对真实节点 API，再直接打开同一 Session 验证关闭状态、重新开启和刷新恢复；同时覆盖记忆编辑冲突保稿和后续分叉/补充整合。`scripts/session-memory-switch-browser.test.mjs` 继续核对普通会话实际发送对记忆节点的控制。

浏览器验收的恢复步骤先等待刷新产生新文档，再等待控件跨布局帧稳定后发出真实指针事件；旧文档的按钮存在不能被当成刷新恢复成功。审核恢复超时保留页面截图、可见文本与对应 API 诊断，不放宽业务断言。

以下是可显式导入的 experience Prompt，不自动注入任何 Agent：

```json
{
  "schemaVersion": 1,
  "id": "shared-control-server-policy",
  "revisions": [{
    "schemaVersion": 1,
    "id": "shared-control-server-policy",
    "revision": 1,
    "kind": "experience",
    "title": "共用控件必须保留原领域的持久化合同",
    "purpose": "合并重复 UI 或复用配置控件时防止只改浏览器状态。",
    "content": "合并控件前列出每个使用场景的事实源、写入 API、revision 和生效时点。视觉共用不代表领域语义相同。服务端策略通过受控值进入共用控件及实际发送；临时偏好不得冒充持久策略。使用稳定身份决定会话挂载，保存一个字段不能卸载整个会话。真实浏览器门禁必须核对服务端值和刷新恢复，并包含不同入口、冲突、快切和草稿保留。",
    "tags": ["development", "frontend", "state", "regression"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/shared-control-server-policy.md", "capturedAt": "2026-09-27T09:47:00.000Z" }],
    "author": { "type": "agent", "agentId": "codex" },
    "createdAt": "2026-09-27T09:47:00.000Z"
  }]
}
```
