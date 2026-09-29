# Chat 0.5.2：Linux release 与 VS Code 调试交付

本版为 Chat `0.5.2`、Frontend `0.11.0`。从父仓库标签 `v0.5.2` 递归取得三个固定子模块；Pi 使用受管 Fork 的精确提交 `5b580155b`，基础包版本仍为 `0.85.1`，没有发布新的 Pi npm 包。NanoClaw 保持 `v2.5.0` 的固定提交 `c14d98d`。不要用子模块远端最新分支代替 gitlink。

本版修复 `v0.5.1` 的阻断缺陷：那版把「已停止发送 `interactionRevision`」的 Frontend 0.10.0 与仍强制该字段的后端捆在一起，Friend 私聊发消息会 409「私聊消息必须携带 Friend 项目关联 revision」。**不要安装 `v0.5.1`**，使用本页命令。

## 本版变化

- **统一项目合同生效**：LA6-A 的 per-Friend 协作项目关联整体退役——`interaction.json` 存储、`GET/PUT /api/long-agents/[id]/interaction-project`、Chat 系统 Tool `collaboration_project`、私聊头部的独立项目下拉、`interactionRevision` 必填与 409 分支全部移除。每轮执行项目按入口唯一确定并在受理时冻结：Web 私聊取顶栏选中的注册项目（无选中为 Agent 容器）、群聊取会话 `storageProjectId`、后台工作/任务/职责沿用创建时冻结的目标、IM 与定时轮次在 Agent 容器执行。
- **旧数据只读兼容**：旧 scope 仍以历史 checksum 校验后按新键重算，旧群记录读时剥离 `collaborationProjectId`，旧 Agent 定义里被退役的 Tool 读时剥离，`interactionRevision` 仅保留给旧轮次重试的摘要比对（新受理恒为 `null`）。
- **会话宽度滑杆（Frontend 0.11.0）**：会话顶栏右侧可拖动调整会话阅读宽度，消息列、运行状态、输入框与正文共用一个 `--conversation-measure`，可达上限跟随当前会话列并保留两侧余量；宽度滑杆基于既有 Radix 原语，不改变鼠标指针样式。
- **对齐与正文修复**：消息列与输入框曾各自硬编码像素宽度而错位；assistant 正文另有 42rem/800px 静态上限，拉宽后不跟随。两处已统一到同一变量并加门禁。
- **停靠面板统一**：导航列表、项目资料、任务与归档区域共用同一个开合原语（同宽度过渡、内层固定宽、class 开合），Compact 统一覆盖滑入。
- 文档：UI/UX 规范 3.7（§20.6 停靠面板、§20.7 会话宽度、§20.8 门禁）、机制合同 §10 标注 LA6-A 已退役。

升级已有数据前停止服务并备份，按 [Friend 迁移合同](./friend-migration.md)处理版本化索引和迁移标记。新机器空安装不需要搬迁旧电脑数据。

## 1. 安装 release

适用 Ubuntu/Debian Linux、x86_64/aarch64，PID 1 必须为 systemd。其他支持范围及 WSL2 前提见[安装指南](./installation.md)。以下安装命令不启动服务、不启用开机自启。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
curl --fail --location https://raw.githubusercontent.com/later-3/Chat/v0.5.2/deploy/chatctl -o /tmp/chatctl-0.5.2
sudo bash /tmp/chatctl-0.5.2 install --ref v0.5.2 --with-nanoclaw
```

脚本安装固定 Node/pnpm、拉取子模块、恢复 Pi 固定模型快照、验证并构建 Backend/Web，另准备 Nano Host。只用普通 Workflow 可以去掉 `--with-nanoclaw`；使用 Friend、助手记忆或群聊时保留它。

## 2. 拉起、检查与关闭 release

```bash
sudo /opt/chat/deploy/chatctl start
sudo /opt/chat/deploy/chatctl status
# 使用结束或更新之前：
sudo /opt/chat/deploy/chatctl stop
# 下次拉起，无需重新安装：
sudo /opt/chat/deploy/chatctl start
```

页面在 `http://127.0.0.1:43110`。远程机器先做[SSH 转发](./network.md)，不要为调试直接开放服务端口。Web 没有产品登录密码；在设置中单独配置模型与 Provider 认证。首次完成模型配置后执行 `sudo /opt/chat/deploy/chatctl doctor`。没有凭据时可以打开设置，不代表 Agent 已可调用真实模型。

开机自启用 `chatctl enable`，取消用 `chatctl disable`；两者不立即启动/停止。日志用 `sudo journalctl -u chat -u nanoclaw-chat -n 100 --no-pager`。停止顺序为 Nano → Backend，保留数据；在途任务可能中断，目前没有跨服务排空保证。

## 3. 准备独立 VS Code 源码

以日常开发用户在自己的目录准备第二份 checkout，不在 `/opt/chat` 中编辑或运行调试。Node ≥22.19.0 与 Corepack 由开发用户环境提供；release 的私有工具链不会自动加入开发用户 PATH。完整依赖准备见[新源码环境](../development/debugging/first-install.md)。

```bash
mkdir -p ~/Code
git clone --branch v0.5.2 --recurse-submodules https://github.com/later-3/Chat.git ~/Code/Chat
cd ~/Code/Chat
git switch -c codex/linux-development
corepack enable
corepack prepare pnpm@10.13.1 --activate
pnpm pi:prepare
pnpm install --frozen-lockfile
pnpm debug:prepare
pnpm debug:prepare:nanoclaw
code .
```

本机 Linux 桌面安装 VS Code 和 Chrome 后，在“运行和调试”选择 `Debug Chat + NanoClaw`，按 **F5**。它启动 Backend、Web、假模型与隔离 Nano；使用 TUI 时选择 `Debug Chat Web + TUI + NanoClaw`。只调普通 Workflow 使用 `Debug Chat`。命令面板快捷键在 Linux/Windows 为 **Ctrl+Shift+P**，macOS 为 **Command+Shift+P**。逐模块调试与断点见[环境说明](../development/debugging/environment.md)。

无桌面的远程 Linux：通过 VS Code Remote SSH 打开开发 checkout，转发 `35145` 和 `45112`；终端运行 `pnpm debug:start -- --nanoclaw` 后，在本地浏览器访问转发的 `35145`。需要后端断点时先 `pnpm debug:stop`，用 F5 分别启动 `Run Local Model`、`Debug Backend`、`Run NanoClaw`，在终端运行 `pnpm debug:frontend`。这一组合避免在远程无桌面主机自动打开 Chrome；浏览器前端断点需在本机 VS Code 单独附着。不要把桌面 F5 的自动浏览器行为视作 Remote SSH 已验收。

## 4. 检查与关闭调试

```bash
# 开发 checkout 的另一个终端：
pnpm debug:smoke -- --long-agent
pnpm debug:stop
pnpm debug:stop -- --check
```

`Debug Chat…` 快捷组合的停止按钮会停止整组；`Run Chat (full environment)` / `Debug Backend (full environment)` 只停止选中的模块，全部关闭仍用 `pnpm debug:stop`。关闭浏览器不会关闭服务。

| 项目 | release | VS Code / debug |
|---|---|---|
| 源码 | `/opt/chat`，由 chatctl 管理 | `~/Code/Chat`，开发用户管理 |
| Backend / Web | `43110`，同一个构建服务 | Backend `45112`，Vite `35145` |
| Nano / 假模型 | Nano `3000`；真实模型需配置 | Nano `45300`；本地假模型 `45401` |
| Chat 数据 | `/home/chat/.chat` | 开发 checkout 的 `.data/debug/chat-home` |
| Nano 数据 | `/opt/chat/nanoclaw` 下私有目录 | `.data/debug/nanoclaw` 下私有目录 |
| 启停 | `sudo /opt/chat/deploy/chatctl start/stop` | F5 或 `pnpm debug:start`；`pnpm debug:stop` |

## 5. 验收边界

本地验证记录见[发布核对](../history/reviews/2026-09-29-release-0.5.2.md)。安装脚本会在目标平台执行 `pnpm verify`；无 Chrome 的纯服务器会明确跳过浏览器场景，不能把这种结果当作浏览器验收。安装 Chrome/Chromium 后由普通用户在开发 checkout 运行 `pnpm verify` 可补齐；自定义路径使用 `CHROME_BIN=/absolute/path/to/chrome pnpm verify`。生产服务本身不依赖浏览器。

新 Linux 上仍需记录：OS/架构、`git -C /opt/chat rev-parse HEAD`、`git -C /opt/chat submodule status`、release 与 debug 各两次启停、停止 debug 后 release 仍可访问，以及 Session/Memory 保留。真实 Provider 调用、真实渠道收发、Linux systemd 和 VS Code GUI 断点分别验收；本机假模型和服务适配器通过不能替代这些结果。

上一版交付步骤见 [0.5.1](./release-0.5.1.md)（该标签的前后端字段契约错配会使 Friend 私聊 409，仅作历史记录）。
