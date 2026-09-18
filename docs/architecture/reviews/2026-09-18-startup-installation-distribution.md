# Chat 启动、调试、安装与发行梳理

状态：2026-09-18 源码与上游公开资料核查；收敛方案为建议，尚未实施。本文提供一次跨模块评审输入，不替代[部署指南](../../deployment.md)、[调试环境](../../development/debugging/environment.md)或已确认的[系统生命周期合同](../chat-system-lifecycle.md)。

后续范围收敛：当前只补必要的按需启动入口与说明。Nano/TUI 已有根目录单模块和组合命令，新增 F5 `Debug Chat Web + TUI + NanoClaw` 复用现有模块启动器；入口表放在调试环境手册开头。下文整套安装控制、跨组件排空、升级回滚和发行包仍是后续建议，不属于这次实施。

入口补充验证：`pnpm test:tooling` 27/27 通过；既有 TUI 进程测试在并行执行时两次超过 5 秒就绪等待，单独执行通过，故将其等待上限调为 15 秒、整项超时 30 秒，保留实际 HTTP 就绪、stdin 隔离及退出断言。整组复测该项耗时约 5.8 秒并通过。真实 PTY 执行 `pnpm debug:start -- --nanoclaw --tui` 成功，`debug:smoke -- --long-agent` 完成 2 条 Workflow 和 1 条长期 Agent 执行，TUI 提交 `DEBUG_HELLO` 的 Run 为 completed。`/quit` 后启动器退出码为 0，45112/35145/45300/45401 全部释放。本次使用隔离调试目录及本地假模型，未启用真实消息渠道；F5 组合引用已检查，未操作 VS Code GUI 验证断点。未修改 Backend/Frontend 业务代码，按启动配置门禁验证，未运行完整 `pnpm verify`。

## 1. 结论与问题归类

Chat 已有源码开发、隔离调试、生产构建、Linux 安装升级、macOS 服务模板、远程终端客户端分发。问题是入口的范围和完成标准不一致：`dev:all` 管前后端，`debug:start` 可加 NanoClaw，生产 Chat 与 NanoClaw 分别安装启动；完整实例的启动、状态、收尾、升级与回滚还没有贯通。

应分别回答 5 个问题：

| 维度 | 要回答什么 | 当前混用现象 |
|---|---|---|
| 安装与发行 | 从源码构建，还是获取已经构建的包？ | 把启动脚本当成发行方式，把客户端 tarball 当成完整服务包 |
| 运行形态 | 开发热更新，还是运行生产构建？ | 将一切分成 debug/release，遗漏普通 dev 和本地产物验证 |
| 实例 | 用哪套数据、端口、凭据、服务身份？ | 裸 `pnpm dev` 与一键 dev 的数据默认值不同 |
| 范围 | 启动 Backend、Web、Nano、TUI 中哪些组件？ | `all` 听起来是整套系统，实际只启动 Web/Backend |
| 控制方式 | 终端前台、VS Code 附着，还是系统服务常驻？ | 将 `launch.json` 当作与脚本平行的一套启动规范 |

Debug 是调试能力，也可以用于已构建程序；release 是可追踪的发行版本；production 是运行配置与服务方式。三者不应被当作同一维度的开关。目前仓库的 `stop release` 只是“关闭正常生产服务”的别名，并不选择一个 release 构建。

## 2. 上游原本怎样安装和运行

上游资料核查于 2026-09-18；在线 main 用于比较发行方式，Chat 的实际依赖仍以父仓库固定 gitlink 为准。不能用上游最新 npm 包直接替换本仓库 Fork。

| 项目 | 普通用户入口 | 开发入口 | 常驻与发行特点 |
|---|---|---|---|
| Pi | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` 后运行 `pi`；也提供安装脚本和独立可执行发行包 | 源码安装、构建，`./pi-test.sh` 运行源码入口 | CLI 可前台运行；SDK 可嵌入应用，不要求为 SDK 另起服务 |
| Pi Web | `npx @agegr/pi-web@latest`，或全局 npm 安装后运行 `pi-web` | `npm install`、`npm run dev`；发行时构建 | npm 包包含 Next.js 构建产物，CLI 拉起 Web 服务；用户首次使用无需克隆源码构建 |
| NanoClaw | 克隆源码，运行 `bash nanoclaw.sh` 安装向导 | `pnpm dev` 执行 TypeScript；`pnpm build` / `pnpm start` 执行构建结果 | 原生 Setup 安装 launchd/systemd 服务；源码安装与定制是主路线，并非以 npm 全局包作为主入口 |
| Chat 当前 | Linux `deploy/chatctl install`；macOS 源码构建及服务模板 | `pnpm dev:all`、`pnpm debug:start`、根目录 F5 | 服务端仍是源码安装；`pnpm pack:cli` 只生成远程 Workflow 终端客户端包 |

来源：[Pi Quick Start](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#quick-start)、[Pi 构建与独立发行](https://github.com/earendil-works/pi#building-standalone-binaries-from-release-source)、[Pi Web README](https://github.com/agegr/pi-web#quick-start)、[Pi Web 包文件与脚本](https://github.com/agegr/pi-web/blob/main/package.json)、[NanoClaw Quick Start](https://github.com/nanocoai/nanoclaw#quick-start)、[NanoClaw 服务安装](https://github.com/nanocoai/nanoclaw/blob/main/setup/service.ts)。

因此，“他们一般是直接安装包吗”的答案是：Pi/Pi Web 有成熟的包安装入口，NanoClaw 主推源码安装。包解决交付代码的问题，服务管理解决后台运行和重启的问题，两者可以同时使用。

NanoClaw 原生向导还准备 Docker、OneCLI 和 Agent 容器。Chat 应复用其 Host 安装、Channel、Group 和服务管理，并按自己的 `chat-pi` 集成合同裁剪；不能直接执行上游全套向导来代替 Chat 安装。当前 Chat 中所有模型执行归 Backend/Pi，基础使用不要求 Docker。

Pi Web 上游是 Next.js 前后端一体应用；Chat 的 `frontend/` 已改成 Vite + React 纯浏览器客户端。可借鉴其“构建后发布、用户安装即运行”的体验，不能把它的 Next.js 后端重新装回来。当前边界见[Pi Web 分析](../pi-web-design.md)和[Frontend README](../../../frontend/README.md)。

## 3. 模块数量与实际运行拓扑

| 模块 | 开发时 | 生产时 | 是否独立启动 |
|---|---|---|---|
| Chat Backend / Workflow / Long Agent 执行 | Nitro dev；调试版用同一 Builder 并隔离缓存 | `.output/server/index.mjs` | 是，核心服务 |
| Pi Agent SDK | 构建 `pi/packages/*/dist`，由 Backend 装配；断点映射到源码 | 随 Backend 执行 | 无需单独 Pi 服务；改 Pi 后需重建 dist |
| Chat Web | Vite 提供页面和开发代理 | 静态资源打入 `.output`，由 Backend 提供 | 开发单独起，生产不单独起 |
| NanoClaw Host | 独立调试 worktree，`tsx src/index.ts` | Node 执行 `dist/index.js`，系统服务管理 | 启用 Long Agent/IM 时需要 |
| Workflow TUI | 本地源码/CLI 构建入口，连接 Backend | 可安装到其他机器，连接 Backend | 按需启动的客户端，无监听端口 |
| 本地假模型 | 调试 Fixture，独立进程 | 不属于生产组件 | 仅调试按需启用 |
| 模型 API、代理/隧道 | 按模型与网络需要配置 | 按部署需要配置 | 外部依赖或可选基础设施，不计入默认 Chat 服务数 |

```text
生产普通使用：浏览器 / TUI ──HTTP──> Chat Backend ──> 内嵌 Pi SDK
                                            ↑
启用长期 Agent：IM ──> NanoClaw Host ──认证 HTTP──┘

开发 Web：浏览器 ──> Vite ──代理──> Chat Backend
```

普通生产是 **1 个逻辑服务**；长期 Agent/IM 是 **2 个逻辑服务**。开发 Web 为 Backend + Vite；默认隔离调试再加假模型，共 3 个组件；加 Nano 为 4 个。这里不计算 Nitro worker、模型/工具子进程、浏览器进程等 OS PID。

“单模块拉起”不等于依赖消失：Frontend 需要 API，TUI 需要 Backend，Nano 的 Chat 执行需要 Backend；单独调 Pi 算法可以用 Pi 原生测试入口，验证 Chat 装配必须回到 Backend。当前 Web 长期同事读取 Nano Group/Memory，也需要正确的 Nano Gateway。

## 4. 现在到底有哪些入口

以下均是现有命令；完整参数、登录与私有配置以链接手册为准。

| 场景 | 入口 | 真正管理范围 / 注意事项 |
|---|---|---|
| 普通开发 Web | `pnpm dev:all` | Backend `43112` + Vite `30145`；默认 `.data/dev/chat-home`；不含 Nano |
| 单独 Backend | `CHAT_HOME="$PWD/.data/dev/chat-home" pnpm dev` | Backend；裸 `pnpm dev` 未指定时会使用正常 Chat Home |
| 单独 Frontend | `pnpm dev:frontend` | Vite；Backend 另起 |
| 开发 TUI | `pnpm dev:tui` | 连接已有 `43112` Backend，不替用户启动它 |
| 隔离调试 Web | `pnpm debug:start` | Backend `45112` + Vite `35145` + 假模型 `45401` |
| 隔离调试加 Nano | `pnpm debug:start -- --nanoclaw` | 再加 `45300` Nano、本地 Group/Memory/Wiring/Registry 初始化 |
| 调试加 TUI | `pnpm debug:start -- --tui` | 仍包含 Web；TUI 为前台，退出 TUI 会结束本次整套栈；可同时加 `--nanoclaw` |
| 调试单模块 | `pnpm debug:backend` / `debug:frontend` / `debug:nanoclaw` / `debug:model` / `debug:tui` | 分别前台运行同一模块启动器；其依赖按场景另起 |
| F5 | `Debug Chat`、`Debug Chat + NanoClaw`、`Debug Chat TUI`、`Debug Chat Web + TUI` | 根 `.vscode/launch.json` 调用同一 `debug-launch.mjs`，增加断点、source map、浏览器与关联停止 |
| 生产构建 | `pnpm build` | Frontend → Backend → CLI；**不包含 Pi 初次准备，也不构建 Nano** |
| 生产前台运行 | `pnpm start` | 仅启动已构建 Backend，环境须预先设置；不安装服务、不启动 Nano |
| Linux 安装/更新 | `sudo ./deploy/chatctl install` / `update` | 准备工具链、固定源码、验证构建、Chat systemd 服务及 Release；不完成 Nano 安装与业务初始化 |
| macOS 常驻 | `deploy/macos` 模板 + launchd | Chat 手工渲染服务；Nano 用自己的 Setup |
| 远程终端分发 | `pnpm pack:cli` | `.data/cli-packages/*.tgz`；安装得到 `chat login` / `chat tui`，不包含 Backend |

首次调试 Nano 须先 `pnpm debug:prepare:nanoclaw`；通用调试准备是 `pnpm debug:prepare`。Nano worktree 从子模块 HEAD 建立，不自动包含 `nanoclaw/` 未提交改动，也不在每次启动时自动切到新的 HEAD。见[调试环境](../../development/debugging/environment.md)。

停止也有不同范围：

| 入口 | 当前范围 |
|---|---|
| `dev:all` 的 Ctrl+C | 本次创建的 Backend/Vite 进程组 |
| `pnpm debug:stop` | 专用调试栈 |
| `pnpm chat:stop -- --debug` | 专用调试栈及本 checkout 的普通开发进程 |
| `pnpm chat:stop -- --normal` | 经归属检查的正常 Backend/Nano 服务 |
| `scripts/dev-start.sh stop release\|debug` | 上面正常/调试停止入口的别名 |

停止操作的 `--check` 只检查。进程退出不等于跨组件在途模型、Tool、消息投递已经完成；当前没有完整业务排空。服务模式须由实际管理者停止，不能靠杀 PID 对抗 KeepAlive。恢复命令见[关闭手册](../../development/debugging/stopping.md)。

源码证据：[package.json](../../../package.json)、[dev-start](../../../scripts/dev-start.sh)、[debug-start](../../../scripts/debug-start.mjs)、[模块启动器](../../../scripts/debug-launch.mjs)、[F5](../../../.vscode/launch.json)、[Nitro 配置](../../../nitro.config.ts)、[chatctl](../../../deploy/chatctl)、[CLI 包](../../../cli/package.json)。

## 5. 别人在新环境上现在怎样安装

### 5.1 开发者：需要源码和断点

从根 README 初始化即可：Node >=22.19.0、根 pnpm 10.13.1，克隆固定的三个 Submodule，`pnpm pi:prepare`，`pnpm install --frozen-lockfile`，然后选择普通 dev 或隔离 debug。Pi 自己使用 npm 锁文件；Nano 使用自身 pnpm/锁文件，当前 `packageManager` 为 pnpm 10.34.5；根 pnpm workspace 只包含 Frontend，根 install 不能代替 Nano 的依赖安装。

学习普通 Workflow 的最短链是 `pnpm debug:start` + `pnpm debug:smoke`。学习长期 Agent 则先准备 Nano，再 `pnpm debug:start -- --nanoclaw`，另一个终端 `pnpm debug:smoke -- --long-agent`。假模型证明工程路径，真实模型/平台账号另行配置验收。首次步骤见[README](../../../README.md#本地开发)、[调试环境](../../development/debugging/environment.md)。

### 5.2 普通用户自建 Linux 服务

当前正式路线是**源码安装器**，不是下载完整 Chat 二进制：

1. 使用 systemd 的 Linux，x86_64 或 aarch64，apt/dnf/yum，有 sudo/root 和依赖下载网络。
2. 下载 `deploy/chatctl` bootstrap 并执行 install；脚本创建用户、固定 Node 22.19.0/pnpm 10.13.1、克隆公开源码和父提交固定子模块。
3. 首次生成配置后停下，用户填写 Web 密码、Provider 凭据和默认模型；再次执行 install 继续。
4. 安装器执行完整 `pnpm verify`，生成版本化 `.output` Release，安装 Chat systemd 服务，健康通过才切换成功。
5. 需要 Long Agent 时，以目标运行用户单独配置 Nano `chat-pi`、服务认证、Backend/Gateway 地址与渠道，通过原生 service 步骤安装 Host。
6. 复用/创建 Group、用户权限和 Wiring，登记 Chat Long Agent/Project，检查 Memory 和 Session，再做所需真实渠道闭环。

准确命令见[部署指南的首次安装](../../deployment.md#首次安装)，业务初始化完成标准见[新环境交付清单](../../development/debugging/first-install.md)。`chatctl doctor` 的健康检查不代表模型调用和真实消息验收完成。

普通用户只用 Web 时，不需要安装 VS Code、启动 Vite、全局安装 Pi CLI 或运行 Pi Web npm 包。只需要远程 TUI 时，安装客户端 tarball 并连接已有服务即可；无需在客户端机器部署完整 Chat。

### 5.3 macOS 与其他环境

macOS 当前是源码准备/构建 + Chat launchd 模板 + Nano 原生 service，尚无与 Linux `chatctl install` 对等的一体化安装器。Windows、Docker/Kubernetes 未建立 Chat 的生产支持合同；上游 Pi 支持某平台，不意味着整个 Chat 已支持。平台支持详见[部署矩阵](../../deployment.md#跨环境支持矩阵)。

本地验证生产产物可在已准备依赖的 checkout 构建后，以隔离的 `CHAT_HOME`、实际环境变量运行 `pnpm start`；这只是前台产物验证，不能当成开机自启动安装。生产端口以私有配置为准，不把手册里的本机端口当成跨机器身份。

### 5.4 安装后日常运行与升级

Linux 的 Chat 使用 systemd；Nano 按 Setup 输出的真实 unit/运行用户操作。macOS 按真实 LaunchAgent label 操作；已卸载的服务需要先 bootstrap。日常 start/restart 不应重复创建 Group、Token 或 Session。

Chat 当前 `update`/`rollback` 只保证 Chat Release 切换及健康回退；用户数据不会随代码回滚。父版本变更涉及 Nano gitlink 时，还要履行 Nano 停机备份、依赖安装、验证、构建、迁移/升级标记和服务更新。**记录了 4 个 Commit，不等于已经具备 4 个仓库的原子升级与回滚。** 当前 Nano 数据仍跟随稳定 checkout，不能删除源码目录当作无损重装。详见[已有 Nano 安装升级](../../deployment.md#已有nanoclaw安装升级)。

## 6. 应优先消除的具体不一致

| 问题 | 证据 / 影响 | 建议 |
|---|---|---|
| 完整启动名义不准确 | `dev:all` 只有 Nitro/Vite；生产 Nano 另起 | 显示启用组件和实际范围，区分普通 Web 与包含长期 Agent 的实例 |
| dev/debug/prod 默认值分散 | 根 scripts、debug 环境、服务模板各有入口；裸 dev 可能用正常数据 | 统一实例解析，端口不是实例身份；保持各环境数据隔离 |
| 部分 CLI/F5 组合不对等 | CLI `debug:start --tui` 包含 Vite；F5 `Debug Chat TUI` 不含 Web | 明确同名场景的组件清单；IDE 消费同一清单 |
| 两套重复启动策略 | debug 验证 owner 后替换；`dev-start.sh --kill` 按端口向占用者发 TERM | 收敛到可验证的实例/进程归属；未知占用应报冲突 |
| “全部构建/验证”容易误读 | 根 build 不构建 Nano、不准备 Pi；根 verify 不运行 Nano 的完整验证组 | 安装/发行层明确哪些依赖需准备及各子模块门禁 |
| 生产启停不对称 | 正常服务可组合 stop，启动仍是 Chat/Nano 两套管理入口 | 复用两种原生服务管理，补完整实例 start/status/restart |
| 生产整套升级仍是人工衔接 | chatctl 同步子模块，但 Nano 服务升级另走原生步骤 | 升级前识别 Nano 变更，规划备份、兼容性和分阶段恢复 |
| 发布产品尚不完整 | 根 Chat 和 Frontend 是 private 包；只有 CLI 本地 tarball | 先稳定服务与安装合同，再提供完整运行发行物 |

这些是本轮核查发现与后续输入；没有通过修改文档把实现缺口认定为正确行为，也没有在本轮修改启动脚本。

## 7. 建议怎样收敛

### 7.1 共用机制，保留适合不同人的入口

延续已确认的生命周期设计：安装/升级仍复用 `chatctl` 和 Nano Setup，常驻仍由 systemd/launchd 管理，开发前台仍管理自己的进程组。公共层只负责解析同一实例、选定组件、核对归属、就绪检查、启停和汇总结果。

对用户的命令界面建议按职责分成：安装/初始化、启动/停止/重启、状态/日志/诊断、更新/回滚；对开发者再提供 dev 和 debugger attach。可以在现有 `chatctl` 上扩展这些能力，具体命令拼写及配置 Schema 留给详细设计，本文不创造可复制但不存在的命令。

`launch.json` 继续保留，负责 Inspector、source map、浏览器、终端和断点。它调用公共启动动作，不再拥有独立的端口、数据根、准备和清理规则。调 Pi 时通过 Backend 的真实装配链进入；调 Nano 时使用隔离 Host，所有模型仍交 Chat 执行。

### 7.2 完整启动的完成条件

按既有[生命周期合同](../chat-system-lifecycle.md#5-启动顺序与部分失败)落实：配置与归属预检 → Backend 基础就绪 → Nano/开发前端启动 → 认证关联与所选渠道检查 → 报告实例可用或部分可用。独立 TUI/浏览器可以按需连接，不是生产后台服务必须依赖的组件。

正常停止沿用同一合同：关闭新工作入口 → 有界等待执行及投递 → 保存中断/待处理事实 → 关闭实例拥有资源 → 外部确认退出。首次安装未填渠道凭据应显示等待配置；明确未启用 Nano 的 Web 实例可正常可用，不用强迫每个人配置 Bot。

### 7.3 是否做安装包

建议保留两条交付路线：贡献者源码安装，普通用户版本化运行包。前者已有基础，后者应在统一安装/生命周期之后实施。

| 发行形式 | 合适用途 | Chat 尚需解决 |
|---|---|---|
| 源码 + 安装脚本 | 现在即可用，适合自建与定制 | 统一 Chat/Nano 初始化、状态、升级和恢复 |
| npm/npx 应用包 | Node 用户快速体验，借鉴 Pi Web | 正式 package/bin、固定 Fork 依赖、构建资源、原生模块安装、离开源码仓库后的启动验证 |
| 按平台运行压缩包 | 更可控的生产交付，用户免本机编译 | OS/CPU/Node ABI 与 Linux libc 兼容矩阵、原生依赖、校验和、版本清单、资源寻址、服务安装和升级验证 |
| 独立可执行程序 | 更少运行时前置，借鉴 Pi 二进制 | 嵌入 Runtime、动态资源、SQLite/ONNX/工具依赖；不能仅套一个编译命令就声称支持 |
| Docker 镜像 | 后续容器部署需求 | Workspace/宿主工具访问、Nano 数据卷、权限、信号和迁移合同；当前无已支持方案 |

近期优先补源码安装的一致性；面向稳定生产发行，建议优先评估按平台运行包，CLI 可独立继续 tarball/npm 路线。包名、发布渠道、是否内置 Node、首批平台尚待产品选择，不能写成既定发布承诺。

目前禁止跨机器直接复制 `.output` 部署的规则继续有效。未来预构建发行必须先建立并验证兼容矩阵，才能改成下载匹配产物；不能把 macOS 构建直接交给 Linux，也不能假定同 CPU 就一定兼容。Backend 的原生 SQLite/ONNX 依赖可见 [Nitro traceDeps](../../../nitro.config.ts)；Nano 也有原生 SQLite。

运行包不能包含个人 Credential、历史 Session、Nano 数据库或测试 Bot 身份；这些应在首次初始化时建立或通过显式迁移恢复。打包也不应要求普通用户分别选择 Pi/Pi Web/Nano 最新版，版本组合由 Chat 发布方验证并固定。

## 8. 实施顺序、验收与本轮证据

建议分 3 个交付阶段：

1. **入口和实例收敛。** 固化场景/组件清单，共用 dev/F5 解析和所有权检查，统一 start/stop/status 语义及开发目录默认值，保留兼容入口。
2. **新机器整套交付。** Linux/macOS 安装流程接起 Chat + Nano 初始化与服务管理，补整套就绪、业务收尾、升级和恢复；验证首次安装、重复启动、部分失败、凭据缺失及服务断开。
3. **运行包发行。** 在干净目标机器验证无开发 checkout 的安装运行；固定版本及校验和，覆盖升级/回滚、资源装配、原生依赖、Web/TUI 和所需真实渠道。

各阶段遵守[贡献工作方法](../../development/agent-contribution.md)：场景 → 机制 → 架构/合同 → 方案 → 实施。实例配置变更前完整核对配置文档；不能先另建配置库或常驻管理平台再补审核。

最少验收组合：普通 Web、TUI 连接、Web + Nano、CLI/F5 切换、dev/prod 并存、重复启动、端口被其他实例占用、启动中失败、忙碌时停止、重启后 Group/Session/Memory 保持、含 Nano 版本变化的升级与失败恢复。假模型/本地 Channel 用于自动化，真实平台最后单独验收。

初次梳理核查父仓库 HEAD `032e47d2348b8f85c4757362f987c6bb3dc3cd7b` 及当前工作区，固定子模块为 Frontend `3482864`、Pi `0343d48`、NanoClaw `b86d3b7`。已有调试文档修改保留。初次仅新增本梳理及文档导航，未安装、启停、部署或发送渠道消息，也未执行运行时验收；后续入口补充及调试运行证据见本文开头。

2026-09-18 文档验证：`pnpm check:architecture` 通过（23 个入口、348 个本地链接）；本报告的 24 个本地链接目标全部存在；父仓库及 Frontend `git diff --check` 通过。本轮无代码/配置行为变更，未运行 `pnpm verify`；这些静态检查不证明新机器部署或建议中的生命周期机制已通过验收。
