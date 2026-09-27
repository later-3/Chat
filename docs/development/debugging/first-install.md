# 新源码环境：准备与交付

生产机器从 [Linux / WSL2 安装](../../operations/installation.md)进入。本页只准备开发与调试，不安装或重启生产系统服务。

## 一次性准备

在 Linux/WSL 的 Linux 终端中，使用 Node ≥22.19.0、Corepack 和仓库锁定的 pnpm。先安装 Git、curl、lsof、Python、make、C/C++ 编译工具及 pkg-config；Ubuntu 可用：

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates lsof build-essential python3 pkg-config xz-utils
# 已有 Node >=22.19.0 + Corepack 可直接继续；没有则先按下节安装。
node --version
corepack enable
corepack prepare pnpm@10.13.1 --activate
git clone --recurse-submodules https://github.com/later-3/Chat.git
cd Chat
pnpm pi:prepare
pnpm install --frozen-lockfile
pnpm debug:prepare
# 需要 Friend/Nano 模块才执行；会安装并运行 Nano 自身验证。
pnpm debug:prepare:nanoclaw
```

无需在这里配置真实模型密钥：debug:prepare 生成隔离的本地假模型、项目与服务 Token。已有私有文件不覆盖。Nano 准备创建 `.data/debug/nanoclaw` 工作区，不复制生产 `.env`、数据库、Group 或渠道账号。

日常启动不重复执行依赖安装。调试 worktree 已存在时，prepare 不偷偷更新 Commit；升级流程见[环境说明](./environment.md#nanoclaw-独立工作区)。

### 开发用户尚未安装 Node

release 的工具链位于 `/var/lib/chat/runtime`，不应借用它的服务用户权限或私有目录。Linux 开发账号可使用自己的 Node 版本管理器；下面以与 chatctl 相同的官方 `22.19.0` 二进制为例，下载后核对 SHA256，全程不使用 sudo、不复制另一操作系统的原生包。

```bash
case "$(uname -m)" in
  x86_64) CHAT_DEV_ARCH=x64 ;;
  aarch64|arm64) CHAT_DEV_ARCH=arm64 ;;
  *) echo '仅支持 x86_64 / aarch64'; exit 1 ;;
esac
CHAT_DEV_ARCHIVE="node-v22.19.0-linux-$CHAT_DEV_ARCH.tar.xz"
CHAT_DEV_DOWNLOAD="$(mktemp -d)"
curl --fail --location "https://nodejs.org/dist/v22.19.0/$CHAT_DEV_ARCHIVE" -o "$CHAT_DEV_DOWNLOAD/$CHAT_DEV_ARCHIVE"
curl --fail --location https://nodejs.org/dist/v22.19.0/SHASUMS256.txt -o "$CHAT_DEV_DOWNLOAD/SHASUMS256.txt"
(cd "$CHAT_DEV_DOWNLOAD" && awk -v name="$CHAT_DEV_ARCHIVE" '$2 == name' SHASUMS256.txt | sha256sum --check --strict) && \
  mkdir -p "$HOME/.local/share/chat-node-22.19.0" && \
  tar -xJf "$CHAT_DEV_DOWNLOAD/$CHAT_DEV_ARCHIVE" --strip-components=1 -C "$HOME/.local/share/chat-node-22.19.0"
export PATH="$HOME/.local/share/chat-node-22.19.0/bin:$PATH"
node --version
corepack enable
corepack prepare pnpm@10.13.1 --activate
```

校验或下载失败时停止，不继续安装。把上面的 `export PATH=…` 一行加入自己的 shell 启动文件，然后重新打开终端；VS Code 集成终端也必须显示该 Node 与 `pnpm 10.13.1`。需要自动启动浏览器的桌面 F5 组合另安装 Chrome；无桌面 Remote SSH 的具体组合见 [0.5.0 交付步骤](../../operations/release-0.5.0.md)。

## 启动、检查、停止

```bash
pnpm debug:start -- --nanoclaw
# 另一终端：
pnpm debug:smoke -- --long-agent
pnpm debug:stop
```

不需要 Nano 时使用 `pnpm debug:start` / `pnpm debug:smoke`。TUI 要交互终端，用 `--tui` 加入整套，或 `pnpm debug:tui` 独立连接已有调试 Backend。F5 的单模块/任意组合与具体点击步骤只在[环境与 VS Code](./environment.md)维护。

Nano 启动器通过原生接口复用/初始化 Debug Agent、CLI Wiring、Memory 和缺失 Registry。`lab ready` 表示练习环境初始化完成，不表示真实 Telegram/微信已登录；平台验证使用独立测试账号。真实 Friend 的创建由 Web → Backend → Nano 管理 API 完成，不手写生产 Registry 或把 debug-agent 复制到生产。

## 交付检查

1. 记录四仓库版本、OS/架构、Node/pnpm；确认端口、数据、日志与生产隔离。
2. 至少完成两次启动/停止；身份和已写入的调试 Session/Memory 保留，未知端口占用不被误杀。
3. smoke 必须覆盖真正完成的 Run 和 Session 重读，端口存活不代表 Pi/Workflow 执行成功。
4. GUI 断点命中单独验收；自动测试的 Source Map 检查不能替代 VS Code 实际暂停。
5. 明确模型与渠道的验证范围：本地假模型无费用，不证明真实模型质量或 IM 收发。

详细故障定位见[排障](./troubleshooting.md)；生产运行与开机自启见[运行手册](../../operations/running.md)。
