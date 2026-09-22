# 启动入口与运行维护

本页统一回答“什么场景用哪个脚本、怎么启动与停止”。命令默认在 Chat 源码根目录执行；安装、构建、启动是独立步骤。启动不会自动安装依赖或更新正式构建。

## 先选场景

| 场景 | 使用入口 | 实际范围 | 停止 |
|---|---|---|---|
| 新 Linux / WSL2 电脑安装 | `sudo bash deploy/chatctl install --with-nanoclaw` | 安装依赖、构建、配置 Backend＋可选 Nano 服务；不启动 | 无需停止新安装；完整前提见[安装指南](./installation.md) |
| Mac 正式日常使用 | `pnpm chat:start` | 已安装 Backend（含正式 Web）＋可选 Nano | `pnpm chat:stop -- --normal` |
| Linux / WSL 正式日常使用 | `sudo /opt/chat/deploy/chatctl start` | 已安装的同一套正式服务 | `sudo /opt/chat/deploy/chatctl stop` |
| 修改源码、看热更新 | `pnpm dev:all` | Nitro Backend＋Vite；不启动 Nano、TUI 或假模型 | 原终端 Ctrl+C；另终端可用 `pnpm chat:stop -- --debug` |
| 隔离调试普通 Web / Workflow | `pnpm debug:start` | 独立调试 Backend＋Vite＋本地假模型 | `pnpm debug:stop` |
| 隔离调试 Friend / Nano | `pnpm debug:start -- --nanoclaw` | 上述调试组件＋隔离 Nano Host | `pnpm debug:stop` |
| 终端交互 | `pnpm tui --url <Backend地址>` | 仅客户端，连接已有 Backend；当前只支持普通 Workflow | TUI 内 `/quit`，不停止 Backend |

**`dev:all` 的 all 只指前后端，不表示整个 Chat 系统。** 它等价于 `bash scripts/dev-start.sh`，保留现有名称兼容已有用法。正式 Web 已在 Backend 构建内；Pi 和 Friend 执行也在 Backend 内，没有另一个 Pi Server 或每 Friend 一个服务。

## 正式启动：统一入口

macOS / Linux / WSL 均可从源码根目录调用：

```bash
pnpm chat:start                         # 启动已安装服务
pnpm chat:start -- --only backend       # Backend 内含正式 Web
pnpm chat:start -- --only nanoclaw      # Backend 必须已就绪
pnpm chat:start -- --check              # 只检查，不启动
```

等价脚本为 `node scripts/chat-start.mjs`。Mac 使用当前登录用户的 launchd，不加 sudo；Linux/WSL 转发到当前 checkout 的 `deploy/chatctl`，仍需 root 权限，推荐直接用表中的 chatctl 命令，避免 sudo 环境缺少 Node/pnpm。自定义 Linux 环境文件可传 `--env-file PATH`，其他安装参数沿用 `CHAT_*`。

脚本先校验当前 checkout 的服务归属与配置，再按 Backend→Nano 启动；Backend 检查包含健康接口、Web 首页及其 JS/CSS 入口资源，Nano 检查服务认证。重复执行不重启已有进程；失败逆序回收本次新启动服务。未安装 Nano 时只启动 Backend；已经安装但配置错误会明确失败，不静默跳过。如果进程存活但首页/资源失败，会报告 Web 未就绪；不会把健康接口的 200 当成网页可用。常见原因是旧进程仍引用已被新构建替换的文件，需按平台更新流程停止、构建、再启动。Mac 的 `--check` 仅做配置/归属预检，不请求网页；Linux 转发 `chatctl status`；都不能证明模型凭据或真实 IM 收发有效。

Mac 首次安装和更新构建见[平台说明](./macos.md)。Linux 安装与更新使用 chatctl，见下文。正式配置和数据由安装时的环境指定，不借用 dev/debug 数据。

## 源码热更新与隔离调试

普通前后端热更新：

```bash
pnpm dev:all
# 需要自定义端口时，直接用同一个脚本
bash scripts/dev-start.sh --backend-port 43112 --frontend-port 30145
# 另开交互终端，连接已经启动的普通开发 Backend
pnpm dev:tui
```

前两条是两种调用方式，选一条运行。默认 Backend `43112`、Web `30145`、数据 `.data/dev/chat-home`；可显式设置 `CHAT_HOME`。这里使用该开发 Home 的模型配置，不自动准备假模型。`dev:tui` 等价于 `bash scripts/dev-start.sh tui`，不启动 Backend。需要 Friend 或独立断点环境时使用下面的 debug 入口。

```bash
pnpm debug:prepare                     # 首次准备隔离配置；整套启动也会自动调用
pnpm debug:prepare:nanoclaw             # 首次需要 Nano 时准备其隔离工作区/依赖
pnpm debug:start -- --nanoclaw --tui    # 按需去掉 --nanoclaw 或 --tui
```

隔离调试默认使用 `.data/debug/chat-home` 和本地假模型，与普通 dev 分开。TUI 必须在交互终端运行；随整套 debug 启动的 TUI 退出会结束该次整套栈，独立客户端退出只断开连接。单模块 `debug:backend/frontend/nanoclaw/model/tui`、F5 组合与专用端口只在[环境与 VS Code](../development/debugging/environment.md)维护。`Run Chat (full environment)` 也使用隔离调试环境，Run 不代表正式 release。

停止时区分范围：`debug:stop` 只收回专用调试栈；`chat:stop -- --debug` 还包括普通 dev；`chat:stop -- --normal` 只针对已安装正式服务。完整归属、失败检查和 F5 停止语义见[停止手册](../development/debugging/stopping.md)。

## 脚本分工与兼容入口

| 脚本 / 命令 | 职责 |
|---|---|
| `scripts/chat-start.mjs` / `pnpm chat:start` | 正式启动入口；Mac 原生服务管理、Linux 转发 chatctl |
| `deploy/chatctl` | Linux/WSL 安装、版本构建、服务启停与运维；统一入口复用它，不另写一套部署逻辑 |
| `scripts/chat-services.mjs` | 正式服务发现、归属和控制锁；启动/停止共用的内部模块，不手动运行 |
| `scripts/chat-stop.mjs` / `pnpm chat:stop` | 按 normal/debug 范围停止；`dev-start.sh stop release/debug` 是兼容转发 |
| `scripts/dev-start.sh` / `pnpm dev:all` | 普通前后端热更新；`tui` 子命令只启动客户端 |
| `scripts/debug-start.mjs` / `pnpm debug:start` | 组合隔离调试组件；实际模块都复用 `debug-launch.mjs`，F5 也调用同一模块入口 |
| `scripts/debug-stop.mjs` / `pnpm debug:stop` | 停止专用调试进程；`dev-stop.mjs` 是普通开发回收的内部模块 |
| `pnpm build` / `pnpm start` | 前者只构建；后者只在前台运行已有 Backend 产物，不管理 Nano 或常驻服务 |

`pnpm dev` / `pnpm dev:frontend` 是单进程底层入口，不提供整套生命周期；尤其单独 `pnpm dev` 不自动选择 `.data/dev/chat-home`。日常优先使用上表场景入口。调试 Lab 的 `debug:bootstrap` 由 Nano 启动流程调用，`debug:smoke` 用于启动后的验证，都不是另一种整套启动器。

## Linux / WSL 服务维护

以下命令在 Linux / WSL2 内执行，默认安装在 `/opt/chat`。不需要重新安装依赖。自定义安装必须沿用同一组 `CHAT_ROOT`、`CHAT_RUNTIME_ROOT`、`CHAT_RUN_USER`、`CHAT_SERVICE` 和 `--env-file`，不能让运维命令猜另一个实例。

```bash
sudo /opt/chat/deploy/chatctl start
sudo /opt/chat/deploy/chatctl status
sudo /opt/chat/deploy/chatctl restart
sudo /opt/chat/deploy/chatctl stop
```

按模块操作：

```bash
sudo /opt/chat/deploy/chatctl start --only backend
sudo /opt/chat/deploy/chatctl start --only nanoclaw
sudo /opt/chat/deploy/chatctl restart --only backend
sudo /opt/chat/deploy/chatctl stop --only nanoclaw
```

单独启动 Nano 需要 Backend 已就绪。停止顺序 Nano → Backend，交给 systemd 发送信号和执行停止期限；当前没有跨组件业务排空保证，先结束重要任务再停机。关闭浏览器、退出 TUI 与停止服务不同；TUI 退出不会关 Backend。

TUI 参数、会话共享与安装方式见[Chat TUI](../modules/tui/README.md)，不把客户端装成后台服务。

## 开机自启与日志

```bash
sudo /opt/chat/deploy/chatctl enable   # 不立即启动
sudo /opt/chat/deploy/chatctl disable  # 不立即停止
sudo journalctl -u chat -n 100 --no-pager
sudo journalctl -u nanoclaw-chat -n 100 --no-pager
```

start/stop 不修改开机策略。WSL 仍须先启动 Linux 发行版；这些命令不配置 Windows 计划任务。`status` 展示 systemd 状态及本地健康；健康通过不等于模型凭据或真实渠道有效。

```bash
sudo /opt/chat/deploy/chatctl doctor
```

doctor 检查配置、模型目录与已配置认证、离线 AgentSession 装配、Release、服务和本机健康；不发计费模型请求。首次尚未配置模型时 doctor 失败是明确待办，不表示安装程序必须重跑。

## 更新与回退

安装/更新不会自动停止或启动正在运行的服务。维护时明确分步：

```bash
sudo /opt/chat/deploy/chatctl stop
sudo /opt/chat/deploy/chatctl update --ref <目标父仓库提交或标签>
sudo /opt/chat/deploy/chatctl start
sudo /opt/chat/deploy/chatctl doctor
```

已安装 Nano 时 update 自动重新准备父提交固定的 Nano 版本；新加 Friend 功能用 `install --with-nanoclaw`，也需要先 stop。保留配置、数据库和 Group，不复制正常环境为 debug 环境。

仅 Backend 的安装可在停止后执行 `chatctl rollback` 选择上一份保留 Release，然后单独 start；它不回退 Chat Home。回退后 doctor 的源码/Release 检查可能提示不同版本，必须核对对应源码。

安装了 Nano 时，Backend 与 Nano 版本需要配对，不能只切 Backend 符号链接。使用 `update --ref <上一版本的父提交>` 完成锁定构建、验证，再 start。旧提交从 `/var/lib/chat/runtime/releases/<release>/release-commits.txt` 查 Chat 行；不删除原生升级收据来强行启动旧版本。数据迁移回退需按对应版本的兼容规则和私有备份处理。
