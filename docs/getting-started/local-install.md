# Chat 本地安装

本文是全新克隆后的唯一安装入口。当前产品前端是固定DeepSeek Harness Web，后端由
Chat API、Vercel Workflow与可选Code Workbench组成；Memory Provider代码暂时保留但默认关闭。不要再安装
旧`apps/web`、Agent Canvas，也不要手工克隆DSH或其他上游源码到固定个人目录。

Code Workbench当前为Beta：本地实现与固定工件继续保留，但不进入通用CI/CD，也不进入远程部署。
只使用Chat/PWA时，可在setup和启动阶段都传入`--workbench=off`，避免下载和运行code-server。

## 1. 支持范围

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS，或glibc ≥ 2.29的Linux（Alpine/musl暂不支持） |
| CPU | arm64或x64 |
| Node.js | Node 24（本仓库`.node-version`固定`24.8.0`，原生工件ABI为`137`） |
| pnpm | 精确`10.13.1`，由根`packageManager`与Corepack选择 |
| 本机工具 | Git、tar、npm、Corepack/pnpm |
| 网络 | 首次准备需要访问GitHub和npm registry |

Windows与其他CPU架构目前不属于本地一键安装范围，`pnpm run setup`会在写入运行缓存前
失败关闭。首次默认准备会下载约211–239MB的固定code-server压缩包，不再拉取两套Memory
源码及其npm依赖；请预留至少1GB可用空间。工件缓存、运行数据和私有配置都位于Git忽略
的`.data`或`.env`中。

## 2. 克隆与工具链

```bash
git clone git@github.com:later-3/Chat.git
cd Chat
corepack enable
pnpm --version
```

`pnpm --version`必须输出`10.13.1`。如果机器没有Corepack，可先按Node官方方式安装
Corepack，或直接安装精确`pnpm@10.13.1`；不要使用浮动`latest`替代锁定版本。

## 3. 安装与配置

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm run setup
```

仅准备当前稳定核心服务时使用：

```bash
pnpm run setup --workbench=off
```

`pnpm run setup`是幂等准备命令，它会：

1. 校验平台、Node、pnpm、Git、tar与npm；
2. 下载并校验固定`code-server@4.132.0`工件；
3. 校验[DSH插件登记表](../../config/dsh-plugins.json)、锁定工件和许可证，构建Workflow
   Bundle与LifeOS Bridge，再准备固定DSH Web Profile；
4. 只生成可重建缓存，不启动任何服务。

当前不准备Memory；统一setup没有启用参数。固定commit/tree、lock和原生工件Hash代码继续
保留，未来决定恢复Memory时再重新接入组合根与启动图。

如果同一仓库已有本地服务或Workbench在运行，setup只报告占用并失败，不会替用户停止
进程，也不会修改活动Product Run；先显式运行`pnpm dev:stop`后再准备。

不需要另外克隆DeepSeek Harness、memmy、Tencent MemoryCore或code-server。本机已有
Git mirror只有通过`CHAT_MEMMY_SOURCE_REPO`或
`CHAT_TENCENT_MEMORYCORE_SOURCE_REPO`显式指定绝对路径时才会使用，默认安装绝不依赖
个人目录；mirror也必须通过同一commit/tree校验。

查看、校验或人工检查DSH插件更新使用：

```bash
pnpm dsh:plugins:list
pnpm dsh:plugins:verify
pnpm dsh:plugins:check-updates
```

最后一项只查询上游最新发布并报告，不修改依赖、profile或生产运行时，也不自动合并。

`.env`中的`DASHSCOPE_API_KEY`只在真实规划/执行时需要。Key为空时安装和服务启动仍应
成功，模型能力会明确报告`Provider not ready`，不会切换假模型。若要复用本机已有pi
配置，必须同时显式设置`CHAT_DEBUG_PI_KEY_READER`和
`CHAT_DEBUG_PI_PROVIDER_CONFIG`；配置一半会失败关闭。

## 4. 启动、检查与停止

```bash
pnpm dev
```

看到`[chat] ready: http://127.0.0.1:43110/`后打开该地址。另一个终端可以检查或停止：

```bash
pnpm dev:status
pnpm dev:stop
```

若本机已经通过LaunchAgent常驻production，VS Code F5和命令行调试不需要停止它；使用隔离实例：

```bash
pnpm run setup --instance=debug # 独立worktree首次准备
pnpm dev:debug
pnpm dev:debug:status
pnpm dev:debug:stop
```

debug入口固定为`http://127.0.0.1:44110/`，数据位于当前worktree的
`.data/instances/vscode-debug`。为同时隔离源码与构建产物，应在独立worktree中打开VS Code。
不要在LaunchAgent常驻时再运行普通`pnpm dev`，因为它仍是production实例。

默认命令仍可启用Beta Code Workbench；当前只使用Chat/PWA时建议关闭：

```bash
pnpm dev -- --workbench=off
```

当前不启动或装配Memory。`18960`与`18970`在整个运行期间都应保持空闲；统一启动器
拒绝`--memory=all|memmy|memorycore`，避免环境变量或历史命令静默恢复Memory。

`dev:stop`完成后，production的43110、43111、43112、43114、43115与43119都应释放；
`dev:debug:stop`只释放debug的44110、44111、44112、44114、44115、44120、44121与44122，不影响production。
18960/18970与19960/19970应始终未被默认服务图占用，
code-server的Unix socket和Terminal子进程也应被受管回收。不要用`killall`、`pkill`或
直接删除`.data`替代停止命令；`.data`还可能包含产品数据和运行证据。

## 5. 常见问题

- `Provider not ready`：安装成功但未配置`DASHSCOPE_API_KEY`；填入`.env`后重启。
- `executor.workspace_not_allowed`：批准计划请求了Workspace工具，但Contract中的`rootId`不在服务端`CHAT_PROJECT_ROOTS_JSON`；修正Root配置后发起新Run，不要把绝对路径放进请求。
- 端口占用：先运行`pnpm dev:status`，再用`pnpm dev:stop`回收身份匹配的旧Chat进程。
  未知进程不会被自动终止。
- `43113`占用：这是已退役的无认证code-server端口，启动器只报告、绝不自动清理；
  需要人工确认占用者后处理。
- 固定工件校验失败：重新运行`pnpm run setup`。它会保留异常缓存证据并原子重建，不要手工
  修改固定工件目录。
- 需要断点、Trace或真实浏览器门：继续阅读[本地调试](../debug/local-debug.md)。
