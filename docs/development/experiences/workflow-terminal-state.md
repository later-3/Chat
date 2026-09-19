# Workflow 正常结束与开发中断收尾

## 现象、原因与边界

2026-09-18，Web 最后一条工具结果已显示，红色“停止”仍长期存在。只读检查发现本地 Step 在工具成功后的下一 turn 遇到 Nitro 热重建与 `ECONNRESET`，Run/Step 留在 running，没有终态。这不是正常完成，也不能由转圈推断仍健康执行。

另一条独立风险是浏览器收到 completed 后仍无期限等待 NDJSON 结束；Session 同步也没有网络期限。前端清理只在这些 await 后的 finally 执行。旧有完成测试关闭了事件流，开发重启测试手动取消旧 Run，因而没有守住这两条用户可见边界。

后续复现明确了自修改触发条件：Agent成功修改承载自己的Backend源码后，Nitro watcher重建并结束旧worker，下一turn请求断开。正确收尾只解决永久running，不提供跨热重建执行连续性；`Run Backend`仍使用dev watcher。自修改须隔离服务实例和被编辑源码，不能用自动重跑掩盖中断。工具参数生成也属于模型输出，顶部token估算增长与此阶段一致，前端文案应明确说明。

## 修复

- Local World 的单实例 Backend 在新 worker 首次请求前，通过公开 World API 检查旧 running Step，并以原子 run_failed 事件收尾，保留消息和工具结果。已有工具副作用不重放；当前 worker 的慢执行、断点暂停、排队 Step 和持久审核不因无输出而失败。非 Local World 跳过此策略。
- Web completed 分支最多排空200ms事件流；状态请求/Session重读采用10秒网络期限，模型执行没有人为时限。运行被接受后失败不再撤回用户消息或把已执行提示自动变回草稿。
- 取消通过 Runtime runId 对应的本进程 Pi abort 句柄传递，等待服务端取消响应，不把取消 fetch 冒充停止执行。句柄在 Step 清理时移除，不承担持久状态或调度职责。
- 最后一轮终态通过 Session workflowOutcome 安全投影恢复，刷新仍能看到失败或完成；运行阶段与30秒无进展说明仅是前端事实展示。转圈、最近状态读取与模型推进分别表达。

## 自动回归

`frontend/lib/chat-workflow-browser.test.mjs` 覆盖流永不关闭但 Run 已完成、失败/取消、断流后状态完成、网络失败不重发、取消确认；`run-activity.test.mjs` 覆盖连续阶段计时、并行工具、重试、压缩与取消；`workflow-outcome.test.mjs` 覆盖刷新终态边界。Backend `local-run-recovery.test.mjs` 覆盖旧 Step、当前暂停 Step、审核、队列、终态竞争、持久化错误和 Pi 取消归属。

真实 `scripts/dev-server.test.mjs` 在本地假模型等待时取消，验证模型连接实际关闭；杀死并重启 Backend 后验证旧 Run 自动为 failed，Session 不再暴露 activeWorkflowRun，保留 child call 结果并允许后续回合使用原 child 身份。不可使用用户模型或删除 runtime 目录来验证。

## Experience Prompt 资源

以下资源供显式导入，不自动注入 Agent。

```json
{
  "schemaVersion": 1,
  "id": "workflow-terminal-state",
  "revisions": [
    {
      "schemaVersion": 1,
      "id": "workflow-terminal-state",
      "revision": 1,
      "kind": "experience",
      "title": "Workflow终态不能依赖流关闭或界面动画",
      "purpose": "修复任务已结束或开发中断后仍显示运行的问题。",
      "content": "先核对原生Run、Step和Session事实。completed必须有界收尾并重读Session，不能无限等待事件流；网络超时不等于模型执行失败。Local World单实例重启后旧running Step可能失去执行者，应通过原生事件合同记录中断，不能手改JSON、凭无输出计时判失败或自动重放工具。取消fetch只断开客户端；真正停止需要Runtime确认并传到Pi abort。回归必须包含不关闭的流、真实后端重启、模型取消连接、刷新终态和并发终态保护。",
      "tags": [
        "development",
        "incident",
        "workflow",
        "frontend"
      ],
      "status": "active",
      "sources": [
        {
          "type": "manual",
          "entryIds": [],
          "context": "docs/development/experiences/workflow-terminal-state.md",
          "capturedAt": "2026-09-19T00:00:00.000Z"
        }
      ],
      "author": {
        "type": "user"
      },
      "createdAt": "2026-09-19T00:00:00.000Z"
    }
  ]
}
```
