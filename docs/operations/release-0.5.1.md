# Chat 0.5.1：Linux release 与 VS Code 调试交付

本版为 Chat `0.5.1`、Frontend `0.10.0`。从父仓库标签 `v0.5.1` 递归取得三个固定子模块；Pi 使用受管 Fork 的精确提交 `5b580155b`，基础包版本仍为 `0.85.1`，没有发布新的 Pi npm 包。NanoClaw 保持 `v2.5.0` 的固定提交 `c14d98d`。不要用子模块远端最新分支代替 gitlink。

Frontend 版本号会显示在页面上（侧栏标题、会话标题栏的 `web v0.10.0`），并作为 Service Worker 的缓存键；CLI 本版未改版。

## 本版变化

- Friend 会话顶栏按用途显示「任务与归档」动作，不再显示会话标题；会话名（`<agent> · <date>`）只出现在会话列表与历史里。
- 任务与归档区域重建为按日分块：今天恒定第一且不可移除、块头给该日会话与任务计数、会话直接列出名称·类型·时间、执行行可点开；历史日期在日历浏览后按需加入（最多 7 天，按 Friend 持久化），当天没有会话时给一行幂等的「打开这一天的日常会话」。
- 导航列表、项目资料、任务与归档三个侧面板共用一个停靠原语：同一条宽度过渡、内层固定宽不重排、class 开合（关闭时 `inert` 且不发起读取）。修复了此前任务与归档瞬现无过渡、以及相对宽度把内容压窄的缺陷；Compact 统一改为覆盖会话列滑入。
- 主导航、会话顶栏与分支导航动作默认只显示图标，名称由 Hint 与 `aria-label` 提供，设置可切为「图标与文字」；Compact 无 hover，保留可见名称。
- 动效统一到 Token：遮罩与浮层淡入淡出、按压态使用语义色；新增门禁覆盖停靠面板、工具栏动作、遮罩与动效 Token，避免同一效果分裂成多份实现。
- Backend 缓存长期 Agent 状态、日历重扫与日期格式化；Linux 浏览器回归修复 768–959px 媒体断点的深链接遮挡；调试启停修复僵尸进程组被误判为存活；CI 拆分具名验证阶段并给生命周期检查加上限；Pi 异步队列回归用例按实际完成时机固定（仅测试）。

升级已有数据前停止服务并备份，按 [Friend 迁移合同](./friend-migration.md)处理版本化索引和迁移标记。新机器空安装不需要搬迁旧电脑数据。

## 1. 安装 release

适用 Ubuntu/Debian Linux、x86_64/aarch64，PID 1 必须为 systemd。其他支持范围及 WSL2 前提见[安装指南](./installation.md)。以下安装命令不启动服务、不启用开机自启。

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
curl --fail --location https://raw.githubusercontent.com/later-3/Chat/v0.5.1/deploy/chatctl -o /tmp/chatctl-0.5.1
sudo bash /tmp/chatctl-0.5.1 install --ref v0.5.1 --with-nanoclaw
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
git clone --branch v0.5.1 --recurse-submodules https://github.com/later-3/Chat.git ~/Code/Chat
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

本地验证记录见[发布核对](../history/reviews/2026-09-29-release-0.5.1.md)。安装脚本会在目标平台执行 `pnpm verify`；无 Chrome 的纯服务器会明确跳过浏览器场景，不能把这种结果当作浏览器验收。安装 Chrome/Chromium 后由普通用户在开发 checkout 运行 `pnpm verify` 可补齐；自定义路径使用 `CHROME_BIN=/absolute/path/to/chrome pnpm verify`。生产服务本身不依赖浏览器。

新 Linux 上仍需记录：OS/架构、`git -C /opt/chat rev-parse HEAD`、`git -C /opt/chat submodule status`、release 与 debug 各两次启停、停止 debug 后 release 仍可访问，以及 Session/Memory 保留。真实 Provider 调用、真实渠道收发、Linux systemd 和 VS Code GUI 断点分别验收；本机假模型和服务适配器通过不能替代这些结果。

上一版交付步骤见 [0.5.0](./release-0.5.0.md)（历史记录；该版本的 `v0.5.0` 标签未推送，安装请用本文命令）。
