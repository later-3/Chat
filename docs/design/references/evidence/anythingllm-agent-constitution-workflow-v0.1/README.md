# AnythingLLM Agent Constitution / Workflow 视觉证据 v0.1

> 捕获日期：2026-08-12。来源是 AnythingLLM 当前官方文档中实际加载并由 Codex 检查的产品 UI 图片；本机官方源码固定在 commit `4af22f8`，用于核对路由、组件和可见控件。它们不是本机完整运行实例，因此只把画面直接可见的结构标为 `O`；依赖官方文字说明的能力仍标为 `D`，未实际操作的状态保持 `U`。

## 1. 证据索引

| 文件 | 可直接观察的产品事实（O） | 不能由本图证明 |
|---|---|---|
| `01-memory-chat-settings-menu.webp` | Chat settings 中有 Memories 入口 | 记忆实际注入模型的内容 |
| `02-memory-sidebar.webp` | Chat 右侧 Memory sidebar；Personalization 开关；Workspace / Global tabs、配额和记忆卡 | 自动抽取流程、第三方模型实际接收范围 |
| `03-agent-skills-settings-entry.webp` | Agent Skills 设置入口与页面位置 | 运行时工具实际选择 |
| `04-agent-skills-intelligent-selection.webp` | Max Tool Calls、Intelligent Skill Selection、Max Tools 作为显式控制 | 是否真的节省特定比例 Token；每轮选择结果 |
| `05-agent-flow-new.png` | 独立 Flow Builder；Flow name / description、variables、Flow Start / Complete、Add Block、Save | Flow 版本历史、发布审批、真实执行 |
| `06-agent-flow-info-node.png` | Flow identity/description node | 版本绑定 |
| `07-agent-flow-variables.png` | Flow variables | 变量校验与密钥处理 |
| `08-agent-flow-add-block.png` | Add Block 控件 | 完整 block 类别与错误状态 |
| `09-agent-flow-list.png` | 已保存 Flow 列表 | Flow 调用成功率 |
| `10-mcp-management-ui.png` | Agent Skills、Custom Skills、Agent Flows、MCP Servers 同页；server 状态、tools、startup command、Stop/Delete | MCP server 真实连接、权限与调用结果 |
| `11-scheduled-job-run-history.webp` | Run History 列出 status、started、duration、error | 失败与 timed out 的具体详情 |
| `12-scheduled-job-running-stop-control.webp` | running row 有 Stop 控件 | Stop 后是否可恢复 |
| `13-scheduled-job-run-detail-stop.webp` | Run detail 有 Stop Job | 暂停/恢复语义；它只证明终止入口 |
| `14-scheduled-job-run-detail-sections.webp` | 单个 Run 同屏包含 Prompt、Thinking steps、Tool Calls、Files、Response、Metrics 和 Continue in Thread | 隐藏推理合法性、Evidence 验证、产品写回 |
| `15-scheduled-job-tool-calls.webp` | Tool Calls 展示工具、参数、时间和结果展开入口 | 每个工具调用的授权与副作用对账 |
| `16-scheduled-job-files.webp` | Run 生成文件区 | Artifact 评论、修订、接受/拒绝 |
| `17-scheduled-job-response.webp` | Run 最终回复区 | 正式完成门与结果质量 |
| `18-scheduled-job-create.webp` | 创建 Job 时配置 Name、Prompt、Schedule、allowed Tools | 事件触发、对象变化触发、版本发布 |
| `19-scheduled-job-list.webp` | Job 列表显示 schedule/status/last/next run；提供 edit/run now/enable-delete controls | 并发、重试、跨用户可见性 |
| `20-agent-survey-settings.webp` | Agent Survey 设置 | 每个 Agent 的独立启用范围 |
| `21-agent-survey-multiple-choice.webp` | 澄清问题以内嵌多题卡片呈现；有进度、选项、Other、Skip | 回答是否进入 Plan 假设与版本绑定 |
| `22-agent-survey-saved.webp` | Survey 回答保存后的界面状态 | 长期记忆/项目事实写回 |
| `23-workspace-agent-configuration.webp` | Workspace Agent Configuration 选择 Agent LLM provider/model，并链接 Agent Skills | 完整 Agent identity/role/profile |
| `24-workspace-agent-skills.webp` | Workspace 配置进入 Agent Skills | workspace-specific tool permission 的完整边界 |
| `25-chat-tools-menu.webp` | Chat composer 中显式选择可用工具 | 工具调用审批、写回 scope |

## 2. 当前能支持的交互结论

1. **Agent Configuration 是独立工作面，不只是聊天输入框旁的设置图标**（O）。Workspace 可选 Agent 模型；全局 Agent Skills / Flows / MCP 另有集中管理表面。
2. **Memory 是 Chat 内可见、可管理的上下文副表面**（O）。Workspace 与 Global scope 明确分开；记忆内容可见，不是完全隐藏的模型状态。
3. **Agent Workflow Definition 与 Workflow Run 是两个独立产品表面**（O）。Flow Builder 定义可复用能力；Scheduled Job 定义触发和 allowed tools；Run detail 呈现一次执行。
4. **澄清是对话内结构化 Checkpoint**（O）。Survey 卡片保持在 Conversation 中，不需要跳到设置页面。
5. **长任务结果可从 Run 回到 Conversation**（O）。`Continue in Thread` 明确提供运行结果到对话的返回路径。

## 3. 必须保留的未知

- 没有一个画面证明“耐久 Agent Profile”把身份、职责、能力、记忆、权限、当前任务和历史贡献统一在一起（U）。
- Flow Builder 画面没有证明 version / publish / approval（U）。
- Scheduled Jobs 证明 Stop，不证明 Pause / Resume（O/U）。
- Run detail 的 Thinking 区不能作为 Chat 保存或暴露隐藏推理的依据；Chat 仍只保存可观察步骤、工具、Evidence 与显式说明（F）。
- AnythingLLM 的 Files 只有结果展示，不能替代 Orca 式锚定评论与 Chat 正式 Evidence 完成门（O/F）。

## 4. 官方与源码位置

- 官方文档：`https://docs.anythingllm.com/features/memories`
- 官方文档：`https://docs.anythingllm.com/features/agent-surveys`
- 官方文档：`https://docs.anythingllm.com/agent/setup`
- 官方文档：`https://docs.anythingllm.com/agent/intelligent-tool-selection`
- 官方文档：`https://docs.anythingllm.com/mcp-compatibility/overview`
- 官方文档：`https://docs.anythingllm.com/agent-flows/getting-started`
- 官方文档：`https://docs.anythingllm.com/scheduled-jobs/getting-started`
- 官方文档：`https://docs.anythingllm.com/scheduled-jobs/viewing-runs`
- 本机官方源码：`/Users/xulater/Code/opc-os/anything-llm`，commit `4af22f8`
- 关键路由：`/settings/agents`、`/settings/agents/builder`、`/settings/scheduled-jobs`、`/settings/scheduled-jobs/:id/runs`、`/settings/scheduled-jobs/:id/runs/:runId`
