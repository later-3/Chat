# 发送确认前的草稿保护

2026-09-19，Chat Web 第二步验收发现：输入框点击发送时清空 sessionStorage，若请求确认前刷新，尚未保存到服务端的文字会丢失；完成回调直接清草稿键还可能清掉用户后来写的文字。

原有测试覆盖正常发送、失败恢复和未发送草稿刷新，没有覆盖“点击发送后、收到确认前刷新”这个窗口，也未检查旧请求完成后新草稿的内容。

保持乐观输入体验，但在首次异步请求前以同一作用域保存独立的待核实输入。服务端明确确认后按提交记录 ID 清理，不清普通草稿。确认前刷新保留文字；用户核对会话后恢复或清除，处理前不能再次发送。不得通过正文匹配推断服务端接收，不自动重发，不将浏览器记录当执行状态。

自动回归：`frontend/lib/pending-submission.test.mjs` 覆盖刷新、作用域、旧确认不能清新记录、确认不清后续草稿和非法数据。浏览器阻断发送确认后刷新，检查文字可恢复且没有新增请求；真实假模型确认后检查后续输入仍在。

## Experience Prompt 资源

供显式导入，不自动注入。

```json
{
  "schemaVersion": 1,
  "id": "submission-draft-recovery",
  "revisions": [{
    "schemaVersion": 1,
    "id": "submission-draft-recovery",
    "revision": 1,
    "kind": "experience",
    "title": "发送确认与输入清空必须分开",
    "purpose": "防止乐观提交和刷新丢失文字，或旧请求确认覆盖后续草稿。",
    "content": "输入框乐观清空不等于服务器接收成功。异步发送前按草稿作用域保留待核实输入，确认后按提交记录标识清理，不删除后来输入。刷新后结果不明时先核对会话，允许手动恢复，不自动重发、不以正文匹配冒充服务端确认。测试请求确认前刷新、后续草稿、旧响应和附件不可恢复提示。",
    "tags": ["development", "frontend", "draft"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/submission-draft-recovery.md", "capturedAt": "2026-09-19T00:00:00.000Z" }],
    "author": { "type": "user" },
    "createdAt": "2026-09-19T00:00:00.000Z"
  }]
}
```
