# Chat 0.5.0：Linux release 与 VS Code 调试交付

本版为 Chat `0.5.0`、Frontend `0.9.1`。从父仓库标签 `v0.5.0` 递归取得三个固定子模块；Pi 使用受管 Fork 的精确提交，基础包版本仍为 `0.85.1`，没有发布新的 Pi npm 包。NanoClaw 保持 `v2.5.0` 的固定提交。不要用子模块远端最新分支代替 gitlink。

## 本版变化

- Friend、后台工作、群参与和主题的新轮次通过 Backend 接受记录启动 Workflow，继续使用公共 Pi AgentSession；既有 Session 的归属不因导航改变。
- 接通手动压缩、取消、原生统计和历史继续；摘要请求进入公共预算准入，覆盖失败、取消和恢复。
- 日期直接进入当日工作区，任务产物回到对应任务，后台任务通过对话创建；共用返回、按钮和模态组件。默认英语，设置可切换完整中文界面。
- Linux 浏览器回归可发现 PATH 中的 Chrome/Chromium，或通过绝对路径 `CHROME_BIN` 指定；CI 无浏览器时明确失败。

升级已有数据前停止服务并备份，按 [Friend 迁移合同](./friend-migration.md)处理版本化索引和迁移标记。新机器空安装不需要搬迁旧电脑数据。

## 1. 安装 release

适用 Ubuntu/Debian Linux、x86_64/aarch64，PID 1 必须为 systemd。其他支持范围及 WSL2 前提见[安装指南](./installation.md)。以下安装命令不启动服务、不启用开机自启。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
curl --fail --location https://raw.githubusercontent.com/later-3/Chat/v0.5.0/deploy/chatctl -o /tmp/chatctl-0.5.0
sudo bash /tmp/chatctl-0.5.0 install --ref v0.5.0 --with-nanoclaw
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
git clone --branch v0.5.0 --recurse-submodules https://github.com/later-3/Chat.git ~/Code/Chat
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

本地验证记录见[发布核对](../history/reviews/2026-09-27-release-0.5.0.md)。安装脚本会在目标平台执行 `pnpm verify`；无 Chrome 的纯服务器会明确跳过浏览器场景，不能把这种结果当作浏览器验收。安装 Chrome/Chromium 后由普通用户在开发 checkout 运行 `pnpm verify` 可补齐；自定义路径使用 `CHROME_BIN=/absolute/path/to/chrome pnpm verify`。生产服务本身不依赖浏览器。

新 Linux 上仍需记录：OS/架构、`git -C /opt/chat rev-parse HEAD`、`git -C /opt/chat submodule status`、release 与 debug 各两次启停、停止 debug 后 release 仍可访问，以及 Session/Memory 保留。真实 Provider 调用、真实渠道收发、Linux systemd 和 VS Code GUI 断点分别验收；本机假模型和服务适配器通过不能替代这些结果。
