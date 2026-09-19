# 远程 TUI 的原生渲染副作用

## 现象与根因

2026-09-18 接入 Workflow TUI 时，源码审核发现 Pi 原生 `ToolExecutionComponent` 使用内置 edit renderer：当 `argsComplete` 为 true 时，renderer 会调用 `computeEditsDiff(path, edits, cwd)` 读取本机文件生成预览。远程客户端即使从未调用 Tool execute，也可能把服务器路径解释成客户端路径；传入 `/` 作为 cwd 不能阻止绝对路径读取。这是原生本地交互的合理行为，复用到远程入口时必须调整，不代表发生过正式数据泄露。

只测试 HTTP 或最终消息文本不会覆盖该行为；TypeScript 和构建也不会发现渲染副作用。另一个被真实 dev 门禁发现的问题是新增通用忙碌守卫改变了既有审核中的 HTTP 错误合同（400 变 409），已保留原检查顺序与合同。

## 修复与门禁

远端 edit 不设置触发预览的 `argsComplete`，仍复用原生工具渲染和后端 ToolResult 的 diff；客户端只补应用快捷键与 HTTP 命令，保持本地文件补全关闭。不能通过复制 Pi renderer 或启动本地 AgentSession 回避适配。

`test/workflow-tui.test.mjs` 用客户端临时文件、读取探针和虚拟终端验证：edit 显示服务器 diff，本机文件读取次数为 0。该文件还覆盖中文输入、选择器、缩放、认证和断流；`scripts/dev-server.test.mjs` 保留审核冲突合同回归。Registry 安装包另做仓库外安装，确认公开接口实际存在。

对应 `remote-tui-renderer-boundary` experience 通过现有 Personal Prompt 资源初始化机制发现，必须显式选择后才装配，不新增全局注入。
