# Workflow TUI 接入

状态：2026-09-18 已实现并通过开发、生产 Runtime 和独立安装验证；验收与边界见[审核记录](../../history/reviews/2026-09-18-workflow-tui.md)。使用与安装见[命令行指南](./README.md)。

## 场景与所有权

`chat tui` 是独立可安装的 HTTP 客户端。`--url` 选择 Chat 实例，`--project` 选择该实例已经登记的 Project。远端路径和模型凭据属于服务端；客户端不把本机 cwd 当成远端 Project，不运行 AgentSession，不写服务端 JSONL，也不加载本地模型或 Skill。

链路：Pi 原生 TUI 组件 → Chat CLI 适配 → 已认证 HTTP → Workflow Registry → 公共 Agent 装配 → Pi AgentSession。直接复用 Pi 公开的 Editor、UserMessageComponent、AssistantMessageComponent、ToolExecutionComponent 和选择器；不复制渲染器源码。Editor 添加应用快捷键；CustomEditor 所需 Coding Agent KeybindingsManager 没有公开运行时导出，故使用其原生基类。Pi InteractiveMode 中直接操作本地 AgentSession 的命令由客户端命令映射替代。终端只是显示与操作适配，不是第二套运行时。远端 edit 不设置触发本地预览的 argsComplete，diff 由后端 ToolResult 提供。

```text
浏览器：frontend/ ──产品 HTTP──┐
终端：cli/ + Pi UI ─产品 HTTP─┼→ Chat Backend → Workflow / Long Agent 生命周期
IM：NanoClaw Host ─服务认证 HTTP──┘                        ↓
                                              公共装配 → Pi AgentSession
                                                        ↓
                                              Project 下的原生 Session
```

Web 与 TUI 是 Chat 产品的两种交互入口，不互相转发消息；通过同一 Backend 的 Project/Session ID 读写同一份事实。NanoClaw 是独立的长期 Agent Host 与 Channel Gateway，拥有 Group、Workspace、渠道与投递，通过 Long Agent 生命周期接入公共装配。当前 TUI 只操作普通 Workflow Session，不通过 NanoClaw，也不提供 Long Agent 命令。Workflow 组织执行，Pi 负责 Agent Loop；四者边界见[模块合同](../../architecture/chat-module-contracts.md)。

## 终端界面的来源

消息、Markdown、工具结果、编辑器、列表和布局基础来自 Pi SDK。`cli/src/tui.ts` 负责 Chat 页面组合、快捷键、提示行与状态栏，`controller.ts` 负责命令和后端状态适配。并非启动 Pi 完整 `InteractiveMode` 后换一个名字。

`/help 查看命令` 是提示行的初始内容，当前会保留到新的通知替换它，不按时间自动消失。底部格式为 `Project ID · Workflow ID · 执行状态 · Session ID/新会话`；例如 `chat · minimal-pi-coding-agent · idle · 新会话` 的第一个 `chat` 是 Project ID。这些文字和组合由 Chat 定义，状态取自客户端导航与后端读模型。提示仍在不表示正在执行 `/help` 或程序卡住。

## 启动与调试边界

安装后的 `chat tui` 是客户端进程，不监听端口，也不启动 Backend。开发脚本 `dev:tui` 连接 `43112`；隔离调试 `debug:tui` 固定连接 `45112`，在独立终端中运行，自动编译 CLI Source Map、登记 Debug Lab，不读取或保存产品登录凭据。F5 支持单独 TUI、Backend + TUI、Web + TUI 三种选择，具体启动与断点见[Workflow TUI 调试](../../development/debugging/workflow-tui.md)。

独立客户端退出不会取消 Run；整套调试启动器或 F5 compound 停止会收回它管理的 Backend 等进程，可能中断执行。这是调试进程管理行为，不是 TUI 命令新增取消语义。

## 命令合同

| 命令 | 合同 |
|---|---|
| `/project` | 选择后端 Project，清空当前会话导航，不移动原 Session |
| `/workflow` | 选择下一轮 Workflow；当前 Run 的配置不变 |
| `/new`、`/resume` | 新会话草稿、恢复后端普通 Session |
| `/fork` | 选择原生 User Entry，在该输入之前分叉并恢复其文字为草稿 |
| `/history`、`/tree` | 完整持久历史及只读分支浏览；浏览不修改执行叶子 |
| `/approve`、`/revise`、`/cancel` | 当前 Run 的版本化审核与取消 |
| `/refresh`、`/web`、`/help`、`/quit` | 重读、会话链接、帮助、断开客户端 |

退出终端不取消 Run；取消必须显式调用后端。未支持的 Pi 本地命令明确报错，不当作 Prompt 执行。运行中消息不悄悄变成 Steering。

## Session 与恢复

后端提供版本化的终端会话投影：原生消息、可读阶段标记、条目 ID/父 ID、当前叶子和现存活跃 Run。与模型上下文分开读取，压缩不会从历史删除原文。历史可以按叶子筛选；默认完整树按持久顺序显示，长历史分页。客户端直接连接所选服务地址，不保存登录 Cookie 或消息副本。恢复依赖服务器 Session/Run，网络失败显示未知状态，不重发 Prompt。

TUI 复用既有 Run NDJSON 并适配浏览器增量；完成后重读持久消息。恢复已有 Run 时从最新事件附着并用周期性快照校正。Web 可见页面周期性重读列表和空闲会话，发现外部 Run 后附着同一流，不覆盖未发送草稿。

## Fork

后端在请求锁与 Project Session 操作锁内检查普通 Session、目标 User Entry 和活跃执行。复用 Pi createBranchedSession/newSession，以同 Project 的临时目录准备文件，flush 后原子发布。客户端提供 UUID requestId；`session-operations/fork-<requestId>.json` 保存最小身份和准备文件引用，发布中断时重试完成同一文件，成功后清理准备目录。同一请求可重试，参数变化冲突；子会话移除或永久删除后旧请求明确拒绝，不重新创建。父子关系保留 Pi parentSession；来源 CustomEntry 记录请求与分叉点，不复制消息正文。

Fork 复制的 Workflow 记录保留为历史，来源标记之前的审核、子调用和 Subsession 关联不视为新会话拥有的运行状态。新 Run 使用新 Invocation；继承的配置和原生话语保持可读。当前不支持正在运行或等待审核时 Fork；先完成或显式取消。

## 验证与发布

覆盖命令/网络响应校验、跨 Project、普通会话归属、Fork 幂等与历史状态隔离、完整历史与压缩、Web 接续、认证过期、断流恢复及远程 URL 凭据边界。开发和生产 Runtime 使用隔离 CHAT_HOME 与本地假模型。CLI 打包后在仓库外安装并运行，验证原生终端交互及 --help；不发布 npm 或部署到未指定机器。

服务端继续使用现有 chatctl 部署。CLI 使用版本化 npm tarball 分发，运行环境 Node >=22.19；命令为 chat，不额外启动服务器。运行事实和认证仍由目标实例拥有。
