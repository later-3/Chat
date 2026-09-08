# Backend 与 Workflow 场景调试

## WF-01：收到 202 之后发生了什么

前置与输入同 WEB-01。按以下顺序打断点；每到一个节点记录输入和输出，先判断最后到达哪一步。

| 断点 | 关键变量 | 为什么看它 |
|---|---|---|
| [runs.post](../../../src/routes/runs.post.ts) 解析后 | `input.projectId/cwd/sessionId/workflow` | 浏览器输入是否正确进入可信 Project |
| [startChatWorkflow](../../../src/workflows/start-chat-workflow.ts) | 注册的 workflow、返回 runId | 启动成功不代表 Step 已执行 |
| [直接执行 Workflow](../../../src/workflows/minimal-pi-coding-agent/workflow.ts) | input | 特殊 Workflow Runtime 的入口 |
| [runPiCodingAgentPromptStep](../../../src/workflows/minimal-pi-coding-agent/step.ts) | chatSession、prepared.agents | 有无真正进入 Node Step；本轮能力是否冻结 |
| [createWorkflowAgentSession](../../../src/workflows/agent-definition.ts) | toolContext、agent | Workflow上下文包装，无第二套资源装配 |
| [createChatPiAgentSession](../../../src/agents/pi-agent-session.ts) | resourceLoader、created.session | 实際模型、Tool、Skill与上下文 |
| Step 的 `session.prompt()` 后 | observer、text | 模型完成与Step结果；空输出会报错 |
| Step 的 finally | observer.finish、dispose | 记录完成并释放资源，不漏订阅和句柄 |

观察 Backend 控制台：`[workflow] accepted` → `[pi] step starting` → `creating AgentSession` → `source/agentDir/sessionFile/model` → `agent started` → Tool事件 → `prompt completed` → `session disposed`。具体日志标签来自 [agent-session-log](../../../src/workflows/agent-session-log.ts)，不要假设所有Workflow/Long Agent使用相同标签。

`runPiCodingAgentPromptStep.maxRetries = 0` 是有意的：失败之前可能已经改文件或调用Tool。不要为了“自动恢复”直接给该Step增加重试。渠道重试使用另一套已实现的耐久事件与原生Turn恢复合同。

## 编译成功但 Step 断点不命中

先检查这 4 层，不要直接怀疑模型：

1. **启动的模块是否正确。** 普通Web走Workflow；长期同事和渠道走Long Agent，不会进入直接执行Workflow的Step。
2. **实际子进程是否附着。** VS Code Call Stack 中选择 Nitro/Workflow 子进程。当前源码会经过独立 Step bundle，只有启动器被调试并不够。
3. **开发产物是否可加载。** 专用目录是 `node_modules/.nitro-debug/workflow`；产品Workflow发现范围固定为`src/workflows`，Step可达依赖仍正常打包。Source Map需指回`src`；Pi dist需指回Pi src。不要在正常`node_modules/.nitro`的旧文件中找本次断点。
4. **Runtime是否真正执行。** 用 `pnpm debug:smoke` 验证完整链；常规门禁 `pnpm test:dev` 验证 Nitro CLI 开发路径。仅 Node import、类型检查、健康HTTP或生产构建通过都不足以证明开发Step可执行。

调试 Nitro 使用与 CLI 相同的公开 builder/dev-server API，禁用根 `.env` 自动读取。业务源代码由 builder 监听；修改 `nitro.config.ts` 后显式停止并重新F5。不要另写Agent执行循环来“方便调试”。

曾经发生的两类故障：[开发Step外置JSON](../../development-experiences/workflow-builder-json-import-attribute.md)、[隔离缓存被重复扫描](../../development-experiences/debug-build-directory-isolation.md)。`Node.js modules are not available in workflow functions` 也可能是产物重入，不等于所有报错的Pi模块都需要改写。

## WF-02：规划、审批与子 Workflow

学习基础链后再打开 `planning-execution`。该流程包括 Planner 交互、等待用户审核、批准后执行或委派；不能用假模型固定 `DEBUG_OK` 当作有效规划输出。

用自动化 Fixture 演练先运行 `pnpm test:dev`，它覆盖 Planner conversation、真实 Workflow调用与取消/恢复等已有场景；源码入口在 [规划执行目录](../../../src/workflows/planning-execution)、[Workflow调用框架](../../architecture/chat-subworkflow-design.md)。真实手工规划需显式配置有能力的开发模型。

手工断点路线：Planner Node输出 → review-state中的planRevision/phase → `POST /runs/:id/review` → 批准的revision → Executor/Coordinator → `workflow_call` 的start/wait/cancel → 子Run/子Session → 父Run聚合。观察父子workflowInvocationId、callId，不要把子Run的完成当作父Run已完成。

审核失败与模型失败应分开：waiting_review是等待用户，不是运行卡死；失效revision不能强行批准。停止按钮要检查服务端取消合同，关闭页面不表示Run已停止。

## Backend HTTP与错误练习

在调试浏览器 Network 中复制请求结构，移除Cookie/私有正文后用于测试。临时修改一个无效workflowId或不存在的Tool，预期在输入/配置边界收到明确错误，不应进入模型循环。不要手改Session JSONL或long-agent-state来制造“成功”。

查路由遵循 `src/routes` 的 Method 文件约定；Project解析在 [projects/request](../../../src/projects/request.ts)，Session操作锁在 [session-operation-lock](../../../src/session-operation-lock.ts)。响应字段变更同时检查 `frontend/lib` 的运行时parser。并发实验使用两个调试请求针对同一Session，观察现有锁/活跃Run检查；不要将不同Session可以并行推断为同Session可任意并行写。

开发前阅读 [Backend规范](../backend.md)、[测试指南](../../testing.md)。涉及Workflow/装配修改时，完成Builder单层、开发Step bundle、生产构建与真实Runtime四类验证。
