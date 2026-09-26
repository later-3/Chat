# 主题会话接入公共聊天的验收接缝

2026-09-25，主题模式收口浏览器检查暴露了三类真实故障：新节点刷新后不能恢复运行中的轮次；记忆阶段的回执替代了主回答；窄屏存在按钮但实际不可点击、聊天被资料区挤没。之前的 API 成功与页面文案断言不足以证明用户可完成会话。

直接根因与修复：

- 公共 Session read 只从旧 owner 索引判断 Friend 执行，节点虽有耐久 turn 绑定却未返回 `friendExecution`。恢复必须按真实存储归属与节点 turn 读取已有执行引用；前端新节点身份来自后端解析的 `topicNode`，不新增身份状态源。
- 最后一个 assistant 不一定是用户问题的答案。writer 的 remember 回复是阶段记录；显示层按既有阶段元数据选工作答案，把整理记忆过程保留在可展开区。新 work 的 running 标记必须清除上轮阶段标签。
- 窄屏的导航隐藏会连带裁掉嵌套审核弹窗；停止入口又藏在设置面板。审核与资料复用公共页面层弹窗，停止放在主工具栏；主题布局占满宽高，导航按需打开。验收不能仅用 DOM click 绕过可见性。
- 首屏主题深链接被默认 Friend 自动选会话带回聊天，旧测试随后点击“主题”掩盖了问题。显式全局视图暂停默认选择；真实浏览器直接打开带节点目标的 URL，等首屏异步读取完成后仍断言保留该视图，不做补救性点击。

自动回归已进入 `pnpm verify`：`test/long-agents/topic-api.test.mjs` 检查公共读取恢复执行引用；`frontend/lib/message-display.test.mjs` 检查工作答案不被回执替代；`scripts/topics-browser.test.mjs` 以真实指针/键盘执行审核修改、运行中刷新与断线重连、停止、图片、fork、记忆 CAS，并检查 390/768/1440 与缩放等效视口。

## Experience Prompt 资源

供显式导入，不自动注入。

```json
{
  "schemaVersion": 1,
  "id": "topic-session-public-chat-closeout",
  "revisions": [{
    "schemaVersion": 1,
    "id": "topic-session-public-chat-closeout",
    "revision": 1,
    "kind": "experience",
    "title": "新增 Session 身份时验证完整公共聊天链",
    "purpose": "避免 API 和静态页面通过但真实会话、恢复或窄屏交互不可用。",
    "content": "在既有 Session 上新增业务身份时，复用公共聊天并逐段核实身份、输入能力、接受、观察、刷新恢复与结果投影。恢复从服务端耐久绑定读取同一执行引用，不能重发。多阶段最后一条 assistant 可能是记忆回执，按阶段保留工作答案。浏览器验收用实际指针命中和键盘操作，检查尺寸、裁剪、焦点与落库；覆盖运行中刷新/断线/停止、窄屏导航、审核弹窗和输入区域。API completed 或 DOM 中存在按钮都不等于用户链完成。",
    "tags": ["development", "session", "frontend", "verification"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/topic-session-public-chat-closeout.md", "capturedAt": "2026-09-25T00:00:00.000Z" }],
    "author": { "type": "user" },
    "createdAt": "2026-09-25T00:00:00.000Z"
  }]
}
```
