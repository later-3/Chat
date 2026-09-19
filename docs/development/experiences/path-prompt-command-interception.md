# 路径开头的消息被命令处理静默拦截

## 现象与根因

2026-09-18，Web 输入框中以 `/Users/example/...` 开头的普通消息，发送按钮可点击但没有提交请求，文字保留，看起来像页面卡住。Backend 与 Vite 代理健康检查正常。

存在两层错误：`ChatInput.runBuiltinCommand()` 将所有 `/` 前缀交给命令回调，`useAgentSession.handleBuiltinSlashCommand()` 无条件返回 `handled: true` 和错误字符串，却没有显示 Notice；即使绕过第一层，`handleSend()` 仍按 `/` 首字符拒绝普通消息。只改按钮禁用状态或只放行其中一层都不能修复。

## 修复与回归

菜单、输入组件与 Session Hook 共用 `lib/builtin-slash-commands.ts` 的已登记命令定义，只匹配完整命令名。普通路径和未登记的斜杠前缀文字进入原消息 API；已登记但不支持的命令显示 Notice 并保留草稿。保留原有 Shell 快捷入口限制，没有新增命令执行能力。

此前常规文本与按钮状态测试没有覆盖路径前缀，也没有验证命令回调返回错误是否可见。自动门禁 `frontend/lib/builtin-slash-commands.test.mjs` 覆盖 Unix 绝对路径、含空格路径、单层目录、命令同名前缀目录、网络路径、中文、未知命令样式文字，以及登记命令的完整名称和参数匹配。

浏览器验收应在 1440、768、390 像素下点击发送路径消息，并用 Enter 再提交；验证确实进入 `/runs`、服务端拒绝后草稿保留、`/compact` 显示提示且不提交。验收拦截请求并返回测试错误，避免把用户截图中的指令或诊断消息交给真实模型与工具。健康检查不能替代这条前端提交验证。

本次上述 3 个宽度的点击、Enter 提交、失败恢复和命令提示均已通过浏览器验收；所有测试 Run 请求被拦截，未调用模型或工具。Frontend 133 项测试及类型检查通过。隔离 checkout 的完整 `pnpm verify` 通过，包括 27 项 tooling、298 项 Backend、133 项 Frontend、29 项生产构建测试和 1 项真实 Nitro dev 测试；没有覆盖正在使用的生产构建产物。

## Experience Prompt 资源

以下资源供显式导入，不自动注入任何 Agent。

```json
{
  "schemaVersion": 1,
  "id": "path-prompt-command-interception",
  "revisions": [{
    "schemaVersion": 1,
    "id": "path-prompt-command-interception",
    "revision": 1,
    "kind": "experience",
    "title": "发送入口应区分文件路径与已登记命令",
    "purpose": "排查发送按钮有响应但没有请求，避免首字符启发式误拦普通消息。",
    "content": "先核对点击、输入命令处理、Session Hook、HTTP提交四层，不能用按钮颜色或后端健康代替提交证据。命令菜单与处理器共用已登记名称，按完整命令名识别，不能把所有斜杠开头的路径当成命令。不支持的命令必须显示可见错误并保留草稿。用路径消息、命令同名前缀目录、点击和键盘提交做回归；诊断时拦截提交，避免执行用户截图中的操作。",
    "tags": ["development", "incident", "frontend", "input"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/path-prompt-command-interception.md", "capturedAt": "2026-09-18T00:00:00.000Z" }],
    "author": { "type": "user" },
    "createdAt": "2026-09-18T00:00:00.000Z"
  }]
}
```
