# Chat Web 与 Frontend 场景调试

前置：按[环境章节](./environment.md)启动 `Debug Chat`，使用 F5 打开的独立 Chrome，登录后打开 `.data/debug/chat-home/workspaces/debug-lab`。初始使用 `debug-local/debug-model`，Workflow 选“直接执行”对应的 `minimal-pi-coding-agent`。

## WEB-01：从点击发送到最终回复

1. 在 [useAgentSession](../../../frontend/hooks/useAgentSession.ts) 的 `runChatWorkflowPrompt()` 调用处打断点；在 [chat-workflow-browser](../../../frontend/lib/chat-workflow-browser.ts) 的同名函数打断点。
2. 输入 `DEBUG_HELLO`，点击发送。观察 `session.owner` 是否 ordinary、projectId 是否 debug-lab、workflow 是否 minimal-pi-coding-agent，以及是否带了旧 Session/Agent 配置。
3. Chrome DevTools → Network → Fetch/XHR，找到 `POST /runs`。请求应访问 `35145`，由 Vite 转发到 `45112`；页面不直接请求模型端口。
4. 在 Backend [runs.post.ts](../../../src/routes/runs.post.ts) 的 `parseChatWorkflowHttpInput()` 后和 `startChatWorkflow()` 前暂停。对比请求与解析后的 `input`，特别是 projectId、cwd、sessionId 和 agentConfigs。
5. 放行 Backend，记录返回的 runId、workflowInvocationId、sessionId。再按[Backend章节](./backend-workflow.md)进入 Step/Pi。
6. 最后应显示 `DEBUG_OK`，`GET /runs/:id` 为 completed。刷新页面或重新打开此 Session，结果仍在。

**判断：** 没有 POST → 页面事件/输入校验；请求到错端口 → 启动配置/代理；401 → 当前调试登录；400 → 请求合同/Project/配置；已202但未进入Step → Workflow开发产物/队列；Pi完成但页面没更新 → 事件流/parser/React状态。

注意实际发起请求和终态更新都可能很快。先在 Frontend 暂停，再把断点补到对应 Backend 路径，避免一次性暂停所有 Worker 后误判超时。

## WEB-02：流、刷新与“消息丢了”

普通 Workflow 的实时输出使用 `GET /runs/:runId/events?startIndex=...`，`Content-Type` 是 `application/x-ndjson`。每行是一个 JSON 事件；不要按 SSE 的 `data:` 或 WebSocket frame 来解析。

断点放在 `consumeRunEvents()`、`followChatWorkflowRun()` 和 `resumeChatWorkflowRun()`。观察：

| 层次 | 观察对象 | 正常情况 |
|---|---|---|
| Network | HTTP状态、Content-Type、响应内容 | 事件流可读，未被代理替换成HTML登录页 |
| Parser | 单行JSON与事件类型 | 严格解析，非法响应显式报错 |
| Hook | 当前Session/Run引用 | 事件应用到发起执行的Session，切换会话不串内容 |
| 持久层 | Run状态、重新GET Session | 刷新能恢复历史，不靠草稿或消息正文补历史 |

实验：在 Backend 的模型响应前暂停，刷新浏览器，再放行。检查是否恢复同一个 Run/Session，而不是创建第二个 Run。恢复入口当前使用 `startIndex=-1`；不要假设所有增量都可完整重放，最终状态应以重新读取的 Run 和 Pi Session 为准。

在调试专用浏览器中使用 Network Offline 可模拟断线；恢复后检查请求重附着和Session重读。取消浏览器 stream 不代表取消后端执行，点“停止执行”应检查是否调用 `DELETE /runs/:id`。相关合同测试：[chat-workflow-contract.test](../../../frontend/lib/chat-workflow-contract.test.mjs)。

## LA-01：Web 长期同事入口

先按[渠道章节](./channels.md)准备 Nano Group 与 Chat Registry，启动 `Debug Chat + NanoClaw`。在当前 Project 切换“长期同事”，点击 Debug Agent。

1. 观察 `POST /api/long-agents/:id/start`，它应创建或打开该 Project 的专属主 Session。
2. 检查 Session 返回 `owner: { type: "long-agent", ... }`，发送时 `useAgentSession` 应走 `sendLongAgentMessage()`，不再调用普通 `/runs`。
3. 在 [long-agents-browser](../../../frontend/lib/long-agents-browser.ts)、[messages路由](../../../src/routes/api/long-agents/%5BlongAgentId%5D/messages.post.ts)、[executeLongAgentTurn](../../../src/long-agents/runtime.ts) 暂停。
4. 输入 `DEBUG_HELLO`，确认同一个 Project/Long Agent/Session 到达公共 Pi 装配。当前请求等待本轮完成，然后重读原生 Session；它不是普通 Workflow 的 NDJSON 全局流。
5. 刷新后仍显示长期同事归属，普通 Session 的输入区与长期同事入口不互相替换。

若配置页能看到同事，但发送失败，应分别检查 Personal enabled、Project active、默认Project、Gateway鉴权/Group存在、模型认证。当前每个 ProjectLongAgent 只有一个 primarySessionId；不要用目标中的多主题Session或独立Daily解释现有行为。

## Frontend 代码修改练习

选择一个纯展示改动：例如调整某条错误的说明文字。从页面组件找到 `lib/i18n` 文案入口；若涉及响应解析，在 `frontend/lib` 修改 parser 并增加合同测试，不把解析散落到组件。

修改数据流前完整阅读 [Frontend 开发指南](../../../frontend/docs/development.md)。UI/交互改动另读 [UI/UX规范](../../../frontend/docs/ui-ux-guidelines.md)。用 Frontend 定向测试验证失败响应、缺字段和刷新恢复；验证时避免覆盖正常实例使用的 `frontend/dist`。发布顺序见[维护章节](./maintenance.md)。

浏览器断点为空心时，检查当前调试会话是否 `Debug Browser`、访问是否 `35145`、webRoot 是否 frontend、实际加载文件是否新版本。在专用 Chrome 中检查 Sources 和 Source Map；不要靠给 Vite 的 Node 进程打断点来调 React 事件。
