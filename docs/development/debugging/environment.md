# 环境、隔离与 VS Code

## ENV-01：让正常使用与调试并存

在一个 VS Code 窗口打开 Chat 根目录。Frontend、Backend 和 Pi 的断点放在原仓库；NanoClaw 调试使用自动建立的独立 Git worktree，断点放在 `.data/debug/nanoclaw/src`。可用 VS Code“打开文件夹/添加文件夹到工作区”查看该目录，也可用 Quick Open 输入完整路径；无需为了 4 个模块开 4 个窗口。

| 项目 | 正常使用/普通开发默认值 | 本手册调试专用值 |
|---|---|---|
| Backend HTTP | 生产 `43110`；普通 dev `43112` | `127.0.0.1:45112` |
| Vite HTTP/HMR | `30145` | `127.0.0.1:35145` |
| NanoClaw Gateway | `3000` | `45300`，继承 Nano 原生 `0.0.0.0` 监听；仅本机连接它，不配置公网转发 |
| 本地假模型 | 无 | `127.0.0.1:45401` |
| Chat Home | `~/.chat` 或显式部署目录；普通一键开发 `.data/dev/chat-home` | `.data/debug/chat-home` |
| Workflow Run/队列数据 | 当前实例 Chat Home | `.data/debug/chat-home/runtime/workflow-data` |
| Nitro 构建缓存 | `node_modules/.nitro` | `node_modules/.nitro-debug` |
| Vite 依赖缓存 | Frontend 默认缓存 | `.data/debug/vite` |
| Nano 数据、Group、Socket、微信登录 | 正常 Nano checkout 下 | `.data/debug/nanoclaw/{data,groups,store}` |
| Nano OS 用户级配置 | 正常用户 Home | `.data/debug/nano-home` |
| 浏览器资料 | 日常 Chrome/PWA | `.data/debug/browser` |
| 日志 | 各原进程/服务输出 | `.data/debug/logs/<时间-PID-模块>.log` |

不要把调试端口改回表格第二列，也不要把调试目录软链接到正式目录。脚本拒绝占用端口，不执行杀进程、服务重启或自动换端口。调试 Node Inspector 由 VS Code 自动分配，不要求复用固定 `9229`。Workflow 可能拥有自己的内部临时监听，应以当前进程日志为准；HTTP 回调必须落在 `45112`。

**Cookie 不按端口隔离。** 普通 Chrome 同时访问两个 `127.0.0.1` 端口可能互相覆盖同名 Cookie，所以 F5 使用独立 Chrome profile 和独立签名密钥。不要把调试网页安装进日常 PWA，也不要在原浏览器里清空正常站点数据。

源码仍是共享文件：调试时修改 Frontend/Backend 源码，会触发正在同一 checkout 上运行的普通 dev 热更新。若需要连“未提交源码变化”都不影响另一个开发实例，应另外建立完整 Chat checkout，并在该 checkout 使用本手册；端口和数据隔离不能隔离同一个源文件的修改。正常生产发布不要从正在修改的 checkout 重新部署。

## 首次准备

已有依赖和 Pi dist 时无需重复安装。全新源码按根 README 初始化固定 Submodule 和依赖；不要在正常 Nano 服务目录执行 setup/service。

```bash
# Chat 根目录；首次缺依赖时按 README 准备
pnpm debug:prepare
```

这个命令只新建缺失文件，保留已有私有修改。它生成独立服务 Token、网页登录签名密钥、假模型配置和练习 Project。默认调试登录是 `chat / 123456`，只供本机使用；需要更改时编辑 `.data/debug/backend.env`，随后重启调试 Backend。

进程启动只继承必要 OS、代理和 VS Code 自动附着变量，不继承生产 `CHAT_*`、模型 API Key、Bot Token。Backend 从独立 `backend.env` 读取自己的私有变量，随后强制固定端口、Chat Home、Workflow 数据路径；Nitro 不自动加载仓库 `.env/.env.local`。Vite 使用空的专用 envDir。真实开发模型只能由你在调试 Chat Home 中显式配置。Nano在Node支持时开启原生环境代理；所有调试本机地址都加入NO_PROXY，避免服务互调经过外部代理。

## F5 选择什么

| 配置 | 用途 | 前置条件 |
|---|---|---|
| `Debug Chat` | 假模型 + Backend，Backend 就绪后 Vite → 调试 Chrome | `debug:prepare` 自动执行；本机安装 Chrome |
| `Debug Chat + NanoClaw` | 上述服务 + 独立 Nano Host | 先完成下文 Nano 准备；不是“渠道都已连通”的声明 |
| `Debug Backend` | 只调 Backend/Pi | 模型服务按需另开 |
| `Debug Backend + Web` | Backend 带 Vite/浏览器 | 模型服务按需另开 |
| `Debug Frontend Server` | Vite 带调试浏览器 | Backend 已由另一个调试配置启动 |
| `Debug Browser` | 只开/调浏览器页面 | Vite 已运行在 `35145` |
| `Debug NanoClaw` | 独立 Host | Nano 准备已完成；Backend按场景另开 |
| `Debug Local Model` | 本地确定性响应 | 其他模型配置不会自动切到它 |

同一组件不要同时单独启动又放进 compound。调试面板会出现多个会话；通过 Call Stack 选择当前暂停的进程。跨 HTTP 调用不会形成一个跨进程调用栈，靠 ID 和两侧断点衔接。

F5 停止 compound 会停止关联调试会话；Backend→Frontend→Browser 的关联使用 `killOnServerStop`。脚本收到终止信号后只终止自己建立的进程组，5 秒后才清理仍存活的自有子进程。不会停止 launchd/systemd，也不会删除运行数据。该操作不保证在途模型、Tool 或外部投递完成；恢复语义见故障章节。

## NanoClaw 独立工作区

```bash
pnpm debug:prepare:nanoclaw
```

首次从 `nanoclaw` 当前 HEAD 建立 `.data/debug/nanoclaw` detached worktree，安装锁定依赖，运行 format/typecheck/build 和全部 Vitest（2 workers，单测超时 30 秒），全部成功后才写原生 upgrade marker。它不安装/启动任何系统服务、不复制正常 Nano `.env`、Group、数据库或微信登录。

重复执行不会切换现有 worktree Commit，也不会覆盖你的修改。调试源码以这个 worktree 为准，原 `nanoclaw/src` 中尚未提交的修改不会自动进入它。要修改 Nano，请在此 worktree 创建自己的开发分支、编辑并提交；验证后按[维护章节](./maintenance.md)推送和更新父仓库 gitlink。版本升级先停止调试 Host，保留工作区修改，再按 Nano 原生升级约束处理；不要删除 upgrade marker 来跳过验证。

生成的 `.data/debug/nanoclaw/.env` 默认 Telegram Token 为空、微信关闭。添加测试账号见[渠道章节](./channels.md)。这个文件与 `.data/debug/backend.env` 的服务 Token 必须一致。Nano 的固定运行模式为 `chat-pi`，不得改回原生容器 Runtime 试图绕过 Chat 错误。

本套调试无需Docker；`debug:prepare:nanoclaw`安装和构建的是Node Host，不构建Agent镜像。将来可选Docker工具环境的边界及无Docker生产部署步骤见[部署文档](../../deployment.md#docker是可选环境能力)。本地read等宿主工具实验不代表容器隔离已启用。

## 命令行与验证

不使用 VS Code 时，在独立终端运行：

```bash
pnpm debug:model
pnpm debug:backend
pnpm debug:frontend
# 可选，先准备：
pnpm debug:nanoclaw
```

这些是各自的前台命令，命令行不会自动开浏览器或把多个终端组成整套启停。F5 使用同一启动器并提供关联启停。

启动 Web/Backend/假模型后执行 `pnpm debug:smoke`：通过真实 Vite 代理登录、打开 Debug Lab、提交 2 个 Workflow Run、验证 Tool 读取与 Session 重读。它会在调试目录生成会话；不访问正常 URL，不使用真实模型。

```bash
curl --fail http://127.0.0.1:45112/api/health
lsof -nP -iTCP:45112 -iTCP:35145 -iTCP:45300 -iTCP:45401 -sTCP:LISTEN
```

发生端口占用时先辨认 PID/工作目录，退出重复调试会话；不要使用按端口强杀。若硬崩溃留下 `.data/debug/<模块>.lock`，先检查文件中的 PID 是否还存在、相关端口是否释放，以及 VS Code 自有子进程是否退出，确认之后只删除该 stale lock。脚本不会自动抢锁。

修改 Pi 后需重建 dist。若正常运行的进程也从本 checkout 动态读取 Pi dist，使用独立完整 checkout 完成构建/验证，避免覆盖正在使用的产物。`pnpm verify` 会写 `frontend/dist` 和 `.output`，也必须遵守这条边界。
