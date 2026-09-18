# Workflow 命令行

`chat tui` 使用 Pi 原生终端组件操作 Chat Backend 中的普通 Workflow。模型、工具执行、Project 和 Session 都在目标后端，终端与 Web 共享同一份历史。当前不接入 Long Agent / NanoClaw。

## 开发启动

先按开发文档启动 Backend，再从仓库运行：

```bash
pnpm dev:all                 # 终端一：Backend + Web
pnpm dev:tui                 # 终端二：连接开发Backend
pnpm dev:tui --project my-project
# 通用入口仍可连接任意实例
pnpm tui --url http://127.0.0.1:43112
```

`dev:tui`默认连接 `43112`，Cookie保存在 `.data/dev/client`；不启动后端。隔离假模型调试用 `pnpm debug:start --tui`，F5配置与断点见[TUI调试](./development/debugging/workflow-tui.md)。通用 `pnpm tui` 和安装后的 `chat tui` 仍使用下文的默认地址/凭据目录。

首次进入会提示输入该 Chat 实例的用户名和密码。后端关闭认证时不要求登录。`--project` 是后端登记的稳定 Project ID；省略时采用后端最近打开的可用普通 Project（与现有普通 Workflow 入口一致），状态栏显示实际 ID。终端当前目录不会改变后端 Project。

## 安装到其他环境

客户端需要 Node.js >=22.19.0 和交互终端；可在本机终端或 SSH 中运行。先在开发仓库生成可分发包：

```bash
pnpm pack:cli
# 输出 .data/cli-packages/later-chat-cli-0.3.1.tgz
```

把 tarball 复制到使用机器，然后安装；安装过程需要访问 npm Registry 下载固定版本的 Pi 依赖：

```bash
npm install -g ./later-chat-cli-0.3.1.tgz
chat login --url https://chat.example.com
chat tui --url https://chat.example.com --project my-project
```

这是本地 tarball 分发方式，尚未发布 npm 包。Backend 必须同时包含本轮新增的 transcript、fork 和活跃 Run 恢复合同；旧服务需要按[部署指南](./deployment.md)升级。安装 CLI 不启动另一个 Backend，不迁移服务端数据。远程连接要求 HTTPS；本机 loopback 可以用 HTTP。

`CHAT_SERVER_URL` 可替代 `--url`；默认 `http://127.0.0.1:43110`。`CHAT_CLI_HOME` 默认 `~/.chat-client`，按服务地址保存登录 Cookie，目录权限 0700、文件 0600，与服务端 `CHAT_HOME` 分开。`chat logout --url URL` 删除本机凭据。自动化登录可通过 `CHAT_CLI_USERNAME` 和 `CHAT_CLI_PASSWORD` 注入账号；命令参数不接受密码。

## 日常操作

输入文字并回车会提交当前 Workflow。多行编辑、Markdown、Thinking、工具输出与选择器由 Pi 原生组件显示；`--theme dark|light` 选择主题。

| 操作 | 命令 |
|---|---|
| 选择 Project / 下一轮 Workflow | `/project`、`/workflow`，也可追加 ID |
| 新建草稿 / 恢复 Session | `/new`、`/resume`，后者也可追加 Session ID |
| 从某条用户输入前分叉 | `/fork`，选择消息后创建新 Session，并恢复文字草稿 |
| 看完整持久历史 / 查看历史分支 | `/history`、`/tree`；历史分支只读 |
| 审核计划 | `/approve`、`/revise 修改意见` |
| 取消当前 Run | `/cancel` 或 Escape |
| 强制刷新 / 显示 Web 链接 | `/refresh`、`/web` |
| 帮助 / 退出 | `/help`、`/quit` 或空输入时 Ctrl+D |

选择器用上下方向键和回车，Escape 关闭；Ctrl+O 展开工具输出，Ctrl+T 切换 Thinking。退出或断开网络不会取消已接受的 Run，再用 `--session ID` 或 `/resume` 接续；客户端不会因超时自动重新提交 Prompt。活跃 Run 与审核由后端校验，运行中不能 Fork 或同时提交另一个 Prompt。

TUI 每 2 秒重读持久状态；Web 可见的空闲会话每 3 秒同步，侧栏也按原有周期刷新。因此同一个 Project 下，TUI 创建和 Fork 的会话可在 Web 列表中找到，Web 的新增消息也会进入 TUI 历史。浏览历史期间暂停自动替换画面；TUI 用 `/history` 返回。

## 当前边界

直接复用 Pi 的公开编辑器、消息、工具和布局组件，替换其绑定本地 AgentSession 的命令路由；不直接启动 Pi 的 `InteractiveMode`。Pi 的本地 `/model`、`/login`、扩展命令和本地文件补全不属于此 Workflow 客户端。模型与 Agent 能力仍通过 Chat 配置管理。

首版提交文字 Prompt；可读取持久消息中的图片，但不提供本机附件上传。Fork 恢复所选输入的文字，图片需要在 Web 重新附加。编辑工具只显示服务端返回的 diff，不读取客户端文件生成预览。超长历史通过 API 分页取得，终端内仍完整渲染；大规模历史的虚拟列表属于后续性能优化。

客户端、API 和持久化边界见[接入设计](./architecture/chat-workflow-tui.md)，验证命令见[测试指南](./testing.md)。
