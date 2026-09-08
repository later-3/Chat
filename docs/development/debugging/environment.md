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

不要把调试端口改回表格第二列，也不要把调试目录软链接到正式目录。脚本默认替换同一checkout、同一调试角色的旧进程：检查所有权后TERM，必要时KILL其自有进程组；无关占用者报错保留，不重启生产服务或自动换端口。调试 Node Inspector 由 VS Code 自动分配，不要求复用固定 `9229`。Workflow 可能拥有自己的内部临时监听，应以当前进程日志为准；HTTP 回调必须落在 `45112`。

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

重复启动同一组件会替换旧调试实例；并发启动/停止同一角色会明确报操作进行中，稍后重试。若旧CLI整套启动器发现自己的组件退出，会收回它拥有的其他组件，所以切换CLI/F5时先运行`pnpm debug:stop`。调试面板会出现多个会话；通过 Call Stack 选择当前暂停的进程。跨 HTTP 调用不会形成一个跨进程调用栈，靠 ID 和两侧断点衔接。

F5 停止 compound 会停止关联调试会话；Backend→Frontend→Browser 的关联使用 `killOnServerStop`。脚本收到终止信号后只终止自己建立的进程组，5 秒后才清理仍存活的自有子进程。不会停止 launchd/systemd，也不会删除运行数据。该操作不保证在途模型、Tool 或外部投递完成；恢复语义见故障章节。

## NanoClaw 独立工作区

```bash
pnpm debug:prepare:nanoclaw
```

首次从 `nanoclaw` 当前 HEAD 建立 `.data/debug/nanoclaw` detached worktree，安装锁定依赖，运行 format/typecheck/build 和全部 Vitest（2 workers，单测超时 30 秒），全部成功后才写原生 upgrade marker。它不安装/启动任何系统服务、不复制正常 Nano `.env`、Group、数据库或微信登录。

重复执行不会切换现有 worktree Commit，也不会覆盖你的修改。调试源码以这个 worktree 为准，原 `nanoclaw/src` 中尚未提交的修改不会自动进入它。要修改 Nano，请在此 worktree 创建自己的开发分支、编辑并提交；验证后按[维护章节](./maintenance.md)推送和更新父仓库 gitlink。版本升级先停止调试 Host，保留工作区修改，再按 Nano 原生升级约束处理；不要删除 upgrade marker 来跳过验证。

生成的 `.data/debug/nanoclaw/.env` 默认 Telegram Token 为空、微信关闭。添加测试账号见[渠道章节](./channels.md)。这个文件与 `.data/debug/backend.env` 的服务 Token 必须一致。Nano 的固定运行模式为 `chat-pi`，不得改回原生容器 Runtime 试图绕过 Chat 错误。

Nano启动后自动通过原生ncl复用/创建Debug Agent和cli/local Wiring，通过资源Gateway补齐Memory，再仅在缺失时写调试`long-agents.json`。看到`[debug] lab ready`才表示初始化完成。已有Registry若不含预期debug-agent映射会明确报错并保留，不覆盖用户配置；可单独执行`pnpm debug:bootstrap`重试。CLI练习权限仅作用于0600的本机Socket，真实平台仍须单独授权。

本套调试无需Docker；`debug:prepare:nanoclaw`安装和构建的是Node Host，不构建Agent镜像。将来可选Docker工具环境的边界及无Docker生产部署步骤见[部署文档](../../deployment.md#docker是可选环境能力)。本地read等宿主工具实验不代表容器隔离已启用。

## 命令行与验证

推荐一次拉起整套调试入口（前台运行）：

```bash
pnpm debug:start                    # Web + Backend + 本地模型
pnpm debug:start -- --nanoclaw       # 再包含Nano，自动初始化本地练习Group/Memory/Registry
pnpm debug:stop                     # 可从另一终端执行；重复停止安全
```

重复执行`debug:start`会先停止旧的同一调试栈，再依次检查模型、Backend、Vite、Nano；失败会回收本次子进程。此处ready表示Web/本地练习链的基础就绪，不代表真实Telegram/微信账号已完成收发验收。首次Nano依赖准备仍执行`debug:prepare:nanoclaw`；日常不重复安装依赖。

不使用 VS Code 时，在独立终端运行：

```bash
pnpm debug:model
pnpm debug:backend
pnpm debug:frontend
# 可选，先准备：
pnpm debug:nanoclaw
```

上面4个单模块命令各自前台运行；`debug:start`负责把它们组合起来。命令行不会自动打开调试浏览器。F5 使用同一启动器并提供关联启停。

启动 Web/Backend/假模型后执行 `pnpm debug:smoke`：通过真实 Vite 代理登录、打开 Debug Lab、提交 2 个 Workflow Run、验证 Tool 读取与 Session 重读。它会在调试目录生成会话；不访问正常 URL，不使用真实模型。

```bash
curl --fail http://127.0.0.1:45112/api/health
lsof -nP -iTCP:45112 -iTCP:35145 -iTCP:45300 -iTCP:45401 -sTCP:LISTEN
```

`.data/debug/<模块>.lock`记录PID、OS启动时间、用户、进程组与随机归属标识；`.control`串行化启动/停止。重复F5或命令行启动先停止验证过的旧owner，再等端口释放。owner被SIGKILL但已记录的子进程组leader仍存活时，可回收该组；PID被复用、记录损坏或leader消失而仍有孤儿时，不猜测归属。旧版纯PID锁只在owner已退出且端口空闲时自动清理。

启动器本身被暂停时，先等12秒让它处理TERM，再核对身份并强制清理；因此恢复可能比普通停止更慢。过期control锁的删除也串行化；若回收过程自身崩溃留下`.control.recovery`目录，确认没有同角色控制操作后只删除该空目录再重试，不能批量删除所有归属记录。

`pnpm debug:stop -- backend`可只停止一个角色；`node scripts/debug-launch.mjs backend --no-replace`保留“已运行则报错”行为。无归属的端口占用会报错，先用lsof/服务管理器确认它属于哪个实例，再停止正确的服务；不能为了保证一次命令成功而误杀正常Chat。调试启动器不会修改KeepAlive/systemd服务。

修改 Pi 后需重建 dist。若正常运行的进程也从本 checkout 动态读取 Pi dist，使用独立完整 checkout 完成构建/验证，避免覆盖正在使用的产物。`pnpm verify` 会写 `frontend/dist` 和 `.output`，也必须遵守这条边界。
