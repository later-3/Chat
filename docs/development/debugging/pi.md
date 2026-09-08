# Pi Agent 源码与断点练习

Pi 在 Chat Backend 进程体系内运行，不单独启动另一个 Pi CLI 来代替 Chat 执行。首先读 [Pi Agent设计与源码分析](../../architecture/pi-agent-design.md)，需要更细接口时读 [SDK文档](../../../pi/packages/coding-agent/docs/sdk.md) 与对应源码。

## PI-01：模型 → read → ToolResult → 模型

1. 启动 `Debug Chat`，打开 Debug Lab 普通Session。检查运行模型为debug-local/debug-model、Tool选择包含read。
2. 在公共装配的 `await createAgentSession()` 前后暂停。观察传给Pi的cwd、agentDir、sessionManager、model、resourceLoader与tools；路径必须落在本次调试Project/Chat Home。
3. 在 [Pi SDK createAgentSession](../../../pi/packages/coding-agent/src/core/sdk.ts) 和 [AgentSession](../../../pi/packages/coding-agent/src/core/agent-session.ts) 的 `prompt()` 处暂停。
4. 输入 `DEBUG_READ_SKILL`。在 [agent-loop](../../../pi/packages/agent/src/agent-loop.ts) 中观察模型响应里的toolCall；接着进入 [read Tool](../../../pi/packages/coding-agent/src/core/tools/read.ts)。参数path应指向调试Skill，不能指向正常Project。
5. 放行read，检查tool result含DEBUG_SKILL_LOADED。Agent再次请求假模型，最终返回同一标记；后台出现2个turn和1次read。
6. 在SessionManager的消息追加处观察原生User、Assistant toolCall、ToolResult和最后Assistant。刷新Web后相同记录仍可查询。

这是确定性协议实验：假模型明确要求读取固定练习文件，并不自行理解Skill摘要。资源是否被正确发现/选择需要另做[RES-01](./configuration-resources.md)；真实模型是否根据Skill完成任务需要开发模型验收。

## 分层阅读与关键对象

| 层 | 入口 | 观察点 |
|---|---|---|
| pi-coding-agent SDK | `core/sdk.ts#createAgentSession` | 模型、认证快照、默认/显式Tool及资源装配 |
| AgentSession | `core/agent-session.ts` | prompt、订阅、上下文转换、Skill调用、压缩与会话生命周期 |
| ResourceLoader | `core/resource-loader.ts#DefaultResourceLoader` | reload后的Skill、Extension、Prompt、Context来源及诊断 |
| SettingsManager | `core/settings-manager.ts` | 调试agentDir与Project兼容设置的优先级 |
| SessionManager | `core/session-manager.ts` | Session路径、append-only条目、leaf/parentId、分支上下文 |
| pi-agent-core | `packages/agent/src/agent.ts`、`agent-loop.ts` | 模型调用与Tool轮次；哪些Tool最终执行 |
| pi-ai | `packages/ai/src/providers` | 当前模型选择的协议、流式响应、错误和usage |

需要确认实际文件时用 `rg -n 'createAgentSession|async prompt|runAgentLoop' pi/packages`，不要把文档旧行号当作断点坐标。Chat产品元数据通过CustomEntry/读模型扩展保存，Pi原生消息格式不被另造的Chat消息数据库取代。

## Source Map与构建

Chat依赖的是`pi/packages/*/dist`。Backend日志`[pi] source=`应指向本checkout的coding-agent dist，而不是全局安装的CLI或其他仓库。

首次准备按根README运行`pnpm pi:prepare`；只修改Pi源码后通常用`pnpm pi:build`重建已有依赖。**重建会覆盖dist**，若正常Chat也用该dist，应在独立完整Chat checkout中工作。F5配置映射dist到src，修改源码却未重建会导致断点行错位或行为仍旧。

断点仍不命中时：核对source实际路径 → 确认dist及map时间 → 在JS dist同一函数临时定位实际执行 → 查看map中的sources → 检查VS Code是否附着到Step所在子进程。不要编辑dist解决业务Bug。

## 模型与错误

配置Provider时先确认ModelRuntime能找到provider/modelId并完成本地认证刷新。hasConfiguredAuth检查与联网模型请求不是同一步；401、429、服务不可达、模型无Tool能力、Tool参数校验失败应分别定位。

在开发模型请求处观察协议和错误类别，不把headers/API Key写进日志或截图。若要观察工具Schema，只查看脱敏的name、parameters结构。不同Provider的工具Schema限制可能不同；本地假模型通过不等于真实Provider兼容。

默认Prompt会包含可用Skill摘要，正文通常通过read按需读取；Extension还能注册Tool/钩子，因此“在目录里看到了文件”不足以证明执行中启用。检查`session.getActiveToolNames()`和ResourceLoader诊断，再看原生ToolResult。

## Pi改动的边界

改动前完整读 [pi/AGENTS.md](../../../pi/AGENTS.md)。可复用Agent/Tool/资源能力放Pi源码和测试；Project/Workflow/Long Agent身份留在Chat。先跑对应包的定向测试，再按Pi仓库门禁和父仓库`pnpm verify`验证生产装配。不要裸跑可能激活真实Provider端到端测试的测试集合；使用Pi文档规定的非e2e路径。
