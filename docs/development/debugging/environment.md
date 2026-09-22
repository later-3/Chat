# 环境、隔离与 VS Code

## 按需要选择启动入口

下面命令都从 Chat 根目录执行。首次先按根 README 准备依赖；需要 NanoClaw 时再执行一次 `pnpm debug:prepare:nanoclaw`（VS Code 任务为 `Chat Debug: prepare NanoClaw (install + verify)`）。之后日常启动不需要进入 Nano 目录手工拉起 Host。

如果要让 Web、Long Agent、TUI 都能用，但只给部分模块下断点，直接看[功能都可用，只调试选中的模块](#功能都可用只调试选中的模块)。下表是按模块范围启动的快捷方式；命令行启动不会自动连接 VS Code 调试器。

| 想启动什么 | 命令行 | F5 配置 |
|---|---|---|
| Web + Backend + 假模型 | `pnpm debug:start` | `Debug Chat` |
| 上述组件 + NanoClaw | `pnpm debug:start -- --nanoclaw` | `Debug Chat + NanoClaw` |
| 上述 Web 组件 + TUI | `pnpm debug:start -- --tui` | `Debug Chat Web + TUI` |
| Web + TUI + NanoClaw + Backend + 假模型 | `pnpm debug:start -- --nanoclaw --tui` | `Debug Chat Web + TUI + NanoClaw` |
| 只启动 NanoClaw 模块 | `pnpm debug:nanoclaw` | `Debug NanoClaw` |
| 只打开 TUI 客户端 | `pnpm debug:tui` | `Debug TUI` |
| 只启动 Backend/Pi | `pnpm debug:backend` | `Debug Backend` |
| 只启动 Web 开发服务 | `pnpm debug:frontend` | `Debug Frontend Server` |
| 只启动假模型 | `pnpm debug:model` | `Debug Local Model` |

单模块入口保留模块依赖：TUI 要连接已运行的 Backend；Nano 启动器初始化练习 Group/Memory 时也需要调试 Backend。纯 TUI 整套调试、不启动 Web 可用 F5 `Debug Chat TUI`。命令行组合里的 TUI 必须在交互终端运行；退出它会结束本次整套栈，单独 `debug:tui` 退出则只关闭客户端。

普通 dev、正式服务与 TUI 的选择统一见[启动场景与脚本](../../operations/running.md)。本表只管理隔离 debug，不能与普通 dev 直接混搭。CLI 切换到 F5 前先用 `pnpm debug:stop` 收回旧调试栈。

## ENV-01：让正常使用与调试并存

在一个 VS Code 窗口打开 Chat 根目录。Frontend、TUI、Backend 和 Pi 的断点放在原仓库；NanoClaw 调试使用自动建立的独立 Git worktree，断点放在 `.data/debug/nanoclaw/src`。可用 VS Code“打开文件夹/添加文件夹到工作区”查看该目录，也可用 Quick Open 输入完整路径；无需按模块分别打开多个窗口。

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

F5 使用独立 Chrome profile 隔离站点存储与调试偏好，不清理正常浏览器的数据。

源码仍是共享文件：调试时修改 Frontend/Backend 源码，会触发正在同一 checkout 上运行的普通 dev 热更新。若需要连“未提交源码变化”都不影响另一个开发实例，应另外建立完整 Chat checkout，并在该 checkout 使用本手册；端口和数据隔离不能隔离同一个源文件的修改。正常生产发布不要从正在修改的 checkout 重新部署。

## 首次准备

已有依赖和 Pi dist 时无需重复安装。全新源码按根 README 初始化固定 Submodule 和依赖；不要在正常 Nano 服务目录执行 setup/service。

```bash
# Chat 根目录；首次缺依赖时按 README 准备
pnpm debug:prepare
```

这个命令只新建缺失文件，保留已有私有修改。它生成独立服务 Token、假模型配置和练习 Project。Web 直接进入工作区，无需产品登录。

进程启动只继承必要 OS、代理和 VS Code 自动附着变量，不继承生产 `CHAT_*`、模型 API Key、Bot Token。Backend 从独立 `backend.env` 读取自己的私有变量，随后强制固定端口、Chat Home、Workflow 数据路径；Nitro 不自动加载仓库 `.env/.env.local`。Vite 使用空的专用 envDir。真实开发模型只能由你在调试 Chat Home 中显式配置。Nano在Node支持时开启原生环境代理；所有调试本机地址都加入NO_PROXY，避免服务互调经过外部代理。

## F5 选择什么

### 功能都可用，只调试选中的模块

运行哪些功能与给哪些模块挂调试器是两件事。下面两个入口都启动 Backend、Web、NanoClaw、TUI 和本地测试模型，使用同一套隔离调试环境；需先完成 NanoClaw 的首次准备。

- **只调后端，其余功能照常使用：** 选择 `Debug Backend (full environment)`，按 F5。Web 和 TUI 正常运行，Web Friend通过 NanoClaw Group 与 Backend/Pi 执行；只有 Backend 挂调试器。
- **按需调任意一个或多个模块：** 先选择 `Run Chat (full environment)`，按 F5。环境就绪后，用命令面板 `Debug: Select and Start Debugging` 逐个启动需要的 `Debug Backend`、`Debug Frontend Server`、`Debug NanoClaw` 或 `Debug TUI`。也可从“只调后端”入口继续增加其他调试目标。

#### 操作示例：后端与 NanoClaw 同时调试

以下操作都在同一个 VS Code 窗口完成。“添加调试目标”指再启动一个调试会话，不需要手改配置文件。

1. 用 VS Code 打开 Chat 根目录，点击左侧“运行和调试”。
2. 在顶部配置下拉框选 `Debug Backend (full environment)`，按 F5。等待 Backend ready、网页打开、TUI 出现输入框、Nano 输出 `[debug] lab ready`。此时只有 Backend 挂调试器。
3. 按 **Command＋Shift＋P**（macOS）打开顶部命令搜索框；也可以从菜单“查看 → 命令面板”进入。
4. 输入 **`Debug: Select and Start Debugging`**，选择该命令并回车。中文界面可搜索“选择并开始调试”。
5. 接下来出现配置列表，选 **`Debug NanoClaw`**，回车。等它重新就绪后，Backend 和 NanoClaw 都能停在各自断点上，Web、TUI 和模型服务继续运行。
6. 想同时调第三个模块，就重复第 3～5 步，最后改选 `Debug TUI` 或 `Debug Frontend Server`。左侧“调用堆栈（Call Stack）”会列出多个会话，点击对应会话或暂停的线程查看变量和调用栈。

若只想调 **Web + TUI**，第 2 步改用 `Run Chat (full environment)`，然后按第 3～5 步分别启动 `Debug Frontend Server` 和 `Debug TUI`；Backend、NanoClaw、模型保持正常运行。会话正在调试时，F5 也可能表示“继续执行”，所以新增目标使用上述命令面板操作。

完整环境只启动一次；增加调试目标时选单模块 `Debug ...`，不要再启动一个完整环境或 `Debug Backend + Web` 链式组合，否则会替换它包含的其他模块。两种以上的组合沿用同一操作，不必枚举所有排列。

这里的 `Run ...` 使用 VS Code 原生 `noDebug: true`；两个完整环境 compound 使用 `stopAll: false`，各模块复用现有启动器。切换 `Run` → `Debug` 会验证归属并**重启对应模块**，不是无缝附着；其他模块不停止。请在没有运行中任务时切换，暂停 Backend 时其他客户端仍在运行，但等待它的请求可能超时。停止某个调试会话不会自动补回运行进程，要继续使用可启动该模块的 `Run ...`。全部关闭用 `pnpm debug:stop`。

Frontend 调试请选择 `Debug Frontend Server`，它会重启 Vite 并将运行浏览器切换为调试浏览器，继续使用独立 profile。`Debug Browser` 适用于还没有打开这份 profile 的浏览器时，不要对同一个 profile 同时启动两份 Chrome。

Long Agent 的执行逻辑和 Pi SDK 在 `Debug Backend` 中下断点；NanoClaw 的 Group、渠道与调度在 `Debug NanoClaw` 中下断点。Long Agent 不是独立模型进程，不需要另加一个启动配置。当前 Chat TUI 仍只支持普通 Workflow 会话，启动完整环境不会给它增加 Long Agent 对话能力。

需要少量功能时，可以分别启动 `Run ...` / `Debug ...`；模块依赖仍适用。已有下面的全调试快捷组合继续保留，整组停止语义与这两个可自由组合的入口不同。原生多会话与 compound 行为见 [VS Code 文档](https://code.visualstudio.com/docs/debugtest/debugging-configuration)。

### 各个模块的入口与断点

| 模块 | 正常运行入口 | 调试入口 | 断点位置 / 依赖 |
|---|---|---|---|
| Backend、Workflow、Pi、Long Agent 执行 | `Run Backend` | `Debug Backend` | `src/`、`pi/packages/*/src`；需要模型的请求还依赖模型服务，Long Agent 依赖 Nano Gateway |
| Web（Frontend） | `Run Frontend Server`，自动打开 `Run Browser` | `Debug Frontend Server`，自动打开 `Debug Browser` | React 断点放在 `frontend/`，由浏览器调试会话命中；需要 Backend |
| NanoClaw Host | `Run NanoClaw` | `Debug NanoClaw` | `.data/debug/nanoclaw/src`，使用已准备的独立 worktree |
| Chat TUI | `Run TUI` | `Debug TUI` | `cli/src`；启动时构建 CLI，等待 Backend 并准备 Debug Lab |
| 本地测试模型 | `Run Local Model` | `Debug Local Model` | `scripts/debug-model.mjs`；普通业务调试通常只需运行它 |

`Run` 和 `Debug` 都使用隔离调试数据与端口；`Run` 不表示生产 / release。Pi 是 Backend 内的 SDK，Long Agent 是 Backend 中的执行路径，不存在需要另起的 `Pi Server` 或 `Long Agent Server`。

### 全调试快捷组合与独立入口

| 配置 | 用途 | 前置条件 |
|---|---|---|
| `Debug Chat` | 假模型 + Backend，Backend 就绪后 Vite → 调试 Chrome | `debug:prepare` 自动执行；本机安装 Chrome |
| `Debug Chat + NanoClaw` | 上述服务 + 独立 Nano Host | 先完成下文 Nano 准备；不是“渠道都已连通”的声明 |
| `Debug Chat TUI` | 假模型 + Backend + TUI，无浏览器 | 自动构建CLI并登记Debug Lab；交互终端 |
| `Debug Chat Web + TUI` | 假模型 + Backend + Vite/Chrome + TUI | 双端Session同步与断点 |
| `Debug Chat Web + TUI + NanoClaw` | 上述服务 + 独立 Nano Host | Nano 准备已完成；TUI仍接普通Workflow，Nano接长期Agent |
| `Debug TUI` | 只调终端客户端，无监听端口 | 专用Backend/模型已运行；自动等待Backend最多60秒 |
| `Debug Backend` | 只调 Backend/Pi | 模型服务按需另开 |
| `Debug Backend + Web` | Backend 带 Vite/浏览器 | 模型服务按需另开 |
| `Debug Frontend Server` | Vite 带调试浏览器 | Backend 已由另一个调试配置启动 |
| `Debug Browser` | 只开/调浏览器页面 | Vite 已运行在 `35145` |
| `Debug NanoClaw` | 独立 Host | Nano 准备已完成；Backend按场景另开 |
| `Debug Local Model` | 本地确定性响应 | 其他模型配置不会自动切到它 |

重复启动同一组件会替换旧调试实例；并发启动/停止同一角色会明确报操作进行中，稍后重试。若旧CLI整套启动器发现自己的组件退出，会收回它拥有的其他组件，所以切换CLI/F5时先运行`pnpm debug:stop`。调试面板会出现多个会话；通过 Call Stack 选择当前暂停的进程。跨 HTTP 调用不会形成一个跨进程调用栈，靠 ID 和两侧断点衔接。

原有 `Debug Chat...` compound 使用 `stopAll: true`，停止其中一个会停止整组；上述两个 `(full environment)` 入口使用 `stopAll: false`，只停止选中的模块。Backend→Frontend→Browser（全调试快捷入口）和 Frontend→Browser 的关联使用 `killOnServerStop`。脚本收到终止信号后只终止自己建立的进程组，5 秒后才清理仍存活的自有子进程。不会停止 launchd/systemd，也不会删除运行数据。该操作不保证在途模型、Tool 或外部投递完成；恢复语义见故障章节。

TUI入口使用 `integratedTerminal`，编译产物和Source Map为 `cli/dist`，断点放在 `cli/src`。终端与服务日志分开，不能将TUI输出pipe给日志工具。命令行整套启动用 `pnpm debug:start --tui`，已有调试服务时用 `pnpm debug:tui`；Project登记由启动器准备。步骤与验收见[Workflow TUI](./workflow-tui.md)。

## launch.json 如何组合运行与调试

配置事实源是根 [.vscode/launch.json](../../../.vscode/launch.json)，准备任务定义在 [.vscode/tasks.json](../../../.vscode/tasks.json)。这里只解释连接关系，不另维护一份完整配置副本。

| 配置项 / 机制 | 当前作用 |
|---|---|
| `configurations` | 每个 `Run ...` / `Debug ...` 是一个可独立启动的入口；Node 入口都执行 `scripts/debug-launch.mjs`，通过 `args` 选择 backend、frontend、nanoclaw、tui 或 model |
| `noDebug: true` | `Run ...` 启动程序但不挂断点调试；Node Run 入口同时设 `autoAttachChildProcesses: false` |
| `autoAttachChildProcesses: true` | Node Debug 入口让 VS Code 跟随启动器进入实际 Node 子进程；Backend 还需查看 Nitro Worker，配合已有 Source Map 设置定位 TS |
| `compounds` | 只引用已有配置名，组合启动多个入口。`Run Chat (full environment)` 引用 5 个 Run 模块；`Debug Backend (full environment)` 只把其中 Backend 换成 `Debug Backend` |
| `stopAll: false` | 两个完整环境入口中的模块独立停止，允许后续单独替换一个模块；没有“故障后自动补回服务”的含义 |
| `stopAll: true` | 原有 `Debug Chat...` 快捷组合整组关联停止，适合一次启动、一次收回全部调试会话 |
| `preLaunchTask` | Node 入口先执行 `Chat Debug: prepare`，幂等准备隔离目录与缺失配置；Nano 依赖安装/构建是单独的首次准备步骤 |
| `serverReadyAction` | Web 服务就绪后打开对应 Run / Debug 浏览器。`Debug Backend + Web` 还会等 Backend 就绪，再拉起 Web；单独 `Debug Backend` 没有这条关联 |
| `killOnServerStop` | 关闭触发该浏览器的 Frontend 会话时，也关闭关联浏览器。它与 compound 的 `stopAll` 是两层关系 |

compound 会并行发起各入口，不按数组顺序保证业务就绪。Backend 输出 ready、Vite 输出地址、TUI 等待 Backend、Nano 完成 Gateway 和练习环境初始化，各自负责自己的就绪条件；只看到进程或端口不代表全链路已可用。

Run 与 Debug 共用 [debug-launch.mjs](../../../scripts/debug-launch.mjs) 和 [debug-processes.mjs](../../../scripts/debug-processes.mjs)。启动器根据模块归属记录确认旧进程，再停止并替换同一角色，所以切换到调试模式会重启该模块。两个完整环境入口没有使用 CLI `debug:start` 的整组父进程，避免一个角色退出后 CLI 父进程回收整套环境。停止范围和等价脚本见[关闭手册](./stopping.md)。

## NanoClaw 独立工作区

```bash
pnpm debug:prepare:nanoclaw
```

首次从 `nanoclaw` 当前 HEAD 建立 `.data/debug/nanoclaw` detached worktree，安装锁定依赖，运行 format/typecheck/build 和全部 Vitest（2 workers，单测超时 30 秒），全部成功后才写原生 upgrade marker。它不安装/启动任何系统服务、不复制正常 Nano `.env`、Group、数据库或微信登录。

重复执行不会切换现有 worktree Commit，也不会覆盖你的修改。调试源码以这个 worktree 为准，原 `nanoclaw/src` 中尚未提交的修改不会自动进入它。要修改 Nano，请在此 worktree 创建自己的开发分支、编辑并提交；验证后按[维护章节](./maintenance.md)推送和更新父仓库 gitlink。版本升级先停止调试 Host，保留工作区修改，再按 Nano 原生升级约束处理；不要删除 upgrade marker 来跳过验证。

若健康检查成功但新建 Friend 报管理接口错误，先比较 `nanoclaw` 与 `.data/debug/nanoclaw` 的 Commit；旧工作区可能只有健康接口，没有新的 `agent-groups/provision`。停止调试 Nano、保留私有修改并同步目标版本后，重新执行上述准备门禁，再启动。仅重启旧源码不会补齐接口，不能删除或提前覆盖 upgrade marker。

生成的 `.data/debug/nanoclaw/.env` 默认 Telegram Token 为空、微信关闭。添加测试账号见[渠道章节](./channels.md)。这个文件与 `.data/debug/backend.env` 的服务 Token 必须一致。Nano 的固定运行模式为 `chat-pi`，不得改回原生容器 Runtime 试图绕过 Chat 错误。

Nano启动后自动通过原生ncl复用/创建Debug Agent和cli/local Wiring，通过资源Gateway补齐Memory，再仅在缺失时写调试`long-agents.json`。看到`[debug] lab ready`才表示初始化完成。已有Registry若不含预期debug-agent映射会明确报错并保留，不覆盖用户配置；可单独执行`pnpm debug:bootstrap`重试。CLI练习权限仅作用于0600的本机Socket，真实平台仍须单独授权。

本套调试无需Docker；`debug:prepare:nanoclaw`安装和构建的是Node Host，不构建Agent镜像。将来可选Docker工具环境的边界及无Docker生产部署步骤见[部署文档](../../operations/README.md)。本地read等宿主工具实验不代表容器隔离已启用。

## 命令行与验证

推荐一次拉起整套调试入口（前台运行）：

```bash
pnpm debug:start                    # Web + Backend + 本地模型
pnpm debug:start --tui              # 再打开Workflow TUI；/quit结束本次整套栈
pnpm debug:tui                     # 已有专用服务时，只打开独立TUI
pnpm debug:start -- --nanoclaw       # 再包含Nano，自动初始化本地练习Group/Memory/Registry
pnpm debug:stop                     # 仅专用调试，可从另一终端重复执行
pnpm chat:stop -- --debug           # 也关闭本checkout普通dev:all
```

正常服务关闭使用`pnpm chat:stop -- --normal`；加`--check`只检查。服务管理、自启动与恢复见[关闭手册](./stopping.md)。

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

启动 Web/Backend/假模型后执行 `pnpm debug:smoke`：通过真实 Vite 代理打开 Debug Lab、提交 2 个 Workflow Run、验证 Tool 读取与 Session 重读。它会在调试目录生成会话；不访问正常 URL，不使用真实模型。

```bash
curl --fail http://127.0.0.1:45112/api/health
lsof -nP -iTCP:45112 -iTCP:35145 -iTCP:45300 -iTCP:45401 -sTCP:LISTEN
```

`.data/debug/<模块>.lock`记录PID、OS启动时间、用户、进程组与随机归属标识；`.control`串行化启动/停止。重复F5或命令行启动先停止验证过的旧owner，再等端口释放。owner被SIGKILL但已记录的子进程组leader仍存活时，可回收该组；PID被复用、记录损坏或leader消失而仍有孤儿时，不猜测归属。旧版纯PID锁只在owner已退出且端口空闲时自动清理。

启动器本身被暂停时，先等12秒让它处理TERM，再核对身份并强制清理；因此恢复可能比普通停止更慢。过期control锁的删除也串行化；若回收过程自身崩溃留下`.control.recovery`目录，确认没有同角色控制操作后只删除该空目录再重试，不能批量删除所有归属记录。

`pnpm debug:stop -- backend`可只停止一个角色；`node scripts/debug-launch.mjs backend --no-replace`保留“已运行则报错”行为。无归属的端口占用会报错，先用lsof/服务管理器确认它属于哪个实例，再停止正确的服务；不能为了保证一次命令成功而误杀正常Chat。调试启动器不会修改KeepAlive/systemd服务。

修改 Pi 后需重建 dist。若正常运行的进程也从本 checkout 动态读取 Pi dist，使用独立完整 checkout 完成构建/验证，避免覆盖正在使用的产物。`pnpm verify` 会写 `frontend/dist` 和 `.output`，也必须遵守这条边界。

## Linux / WSL2 调试补充

使用 Windows VS Code 的 WSL 扩展打开 Linux 内的仓库（终端 `code .`），确认左下角为对应 WSL 发行版；Node、pnpm、依赖和终端进程都在 Linux 内。不要从 Windows 直接打开 `\\wsl.localhost` 路径后混用 Windows Node。参见 [VS Code 官方 WSL 指南](https://code.visualstudio.com/docs/remote/wsl)。

Backend/Pi/TUI/Nano 的 Node 调试入口沿用相同配置。浏览器调试另要求该 VS Code 调试环境能找到 Chrome；无桌面 Linux 或 WSL 找不到浏览器时，先用 `pnpm debug:start -- --nanoclaw` 启动服务，在宿主浏览器打开 `http://localhost:35145`。只调后端可分别运行 `pnpm debug:model`、`pnpm debug:frontend`，F5 选择 `Debug Backend`，需要时再开 `pnpm debug:nanoclaw` / `pnpm debug:tui`。这种手动浏览方式没有自动挂前端断点，不能称为完整 Chrome 调试。

F5 的 `Debug Backend (full environment)` / `Run Chat (full environment)` 会通过 Frontend 关联启动浏览器，因此也有 Chrome 前提。不要为了连接 Windows 浏览器把模型/Backend 端口改成生产端口。该开发调试路线无需 systemd；只有生产常驻安装要求 systemd。
