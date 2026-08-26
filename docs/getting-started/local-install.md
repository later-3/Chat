# Chat 本地安装

第一次接手仓库先读[0–15分钟接手](./quick-context.md)；本文件只负责全新克隆、固定工件与
本地运行，不复制产品边界。

本文是全新克隆后的唯一安装入口。当前产品前端是固定DeepSeek Harness Web，后端由
Chat API、Vercel Workflow与可选Code Workbench组成；Memory Provider代码暂时保留但默认关闭。不要再安装
旧`apps/web`或Agent Canvas。当前开发阶段必须同时检出Later维护的Pi与DSH Fork稳定分支；不要检出官方上游替代它们。

Code Workbench当前为Beta：本地实现与固定工件继续保留，但不进入通用CI/CD，也不进入远程部署。
只使用Chat/PWA时，可在setup和启动阶段都传入`--workbench=off`，避免下载和运行code-server。

## 1. 支持范围

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS，或glibc ≥ 2.29的Linux（Alpine/musl暂不支持） |
| CPU | arm64或x64 |
| Node.js | Node 24（本仓库`.node-version`固定`24.8.0`，原生工件ABI为`137`） |
| pnpm | 精确`10.13.1`，由根`packageManager`与Corepack选择 |
| 本机工具 | Git、curl、tar、npm、Corepack/pnpm |
| 网络 | 首次准备需要访问GitHub和npm registry |

Windows与其他CPU架构目前不属于本地一键安装范围，`pnpm run setup`会在写入运行缓存前
失败关闭。推荐的`pnpm bootstrap`默认关闭Beta Workbench，不下载code-server；只有显式准备
Workbench时才会下载约211–239MB的固定压缩包。请预留至少1GB可用空间。工件缓存、运行数据
和私有配置都位于Git忽略的`.data`或`.env`中。

## 2. 克隆与工具链

```bash
git clone https://github.com/later-3/Chat.git
cd Chat
corepack enable
pnpm --version
pnpm bootstrap
```

`pnpm bootstrap`是全新机器的唯一安装入口：它取得并构建Manifest固定的Pi/DSH源码，使用
`--frozen-lockfile`安装Chat，再以Memory和Beta Workbench关闭的稳定配置准备核心运行工件。

`config/managed-sources.json`是两个Fork的唯一机器锁：它冻结origin、稳定分支、完整commit、
构建命令、能力marker和许可证位置。准备脚本从Chat父目录解析`../opc-os/pi`和
`../deepseek-harness-chat-trajectory`，按各自锁文件安装并构建，再安装Chat并断言4个`link:`
都指向预期源码。Pi官方仓库`earendil-works/pi`与DSH官方仓库
`deepseek-ai/deepseek-harness`只作为各Fork中的只读`upstream`，不能成为Chat运行依赖。

Pi Git源码按上游发布合同不跟踪生成的模型数据。Manifest额外锁定官方`v0.84.2` source
archive的URL、字节数与SHA-256，只在构建期间挂载其中的`providers/data`；构建后恢复已有本地
忽略数据。全部运行代码仍从Later Fork精确commit编译，不使用官方npm包或归档源码替代Fork。

已存在的checkout若有未提交改动或origin、分支、HEAD、marker漂移，脚本会失败关闭，不会
自动切分支或覆盖开发者改动。普通安装不要从文档手抄SHA；更新锁必须修改Manifest并重跑测试。
Manifest中的许可证、marker、Build Input与link source都必须是checkout内的安全相对路径；路径
穿越或symlink逃逸会失败关闭。临时Build Input使用恢复state与信号清理：异常退出后下次检查先
恢复原忽略目录，再判断Fork是否洁净，不把残留固定数据当成受管源码。

`pnpm --version`必须输出`10.13.1`。如果机器没有Corepack，可先按Node官方方式安装
Corepack，或直接安装精确`pnpm@10.13.1`；不要使用浮动`latest`替代锁定版本。

## 3. 安装与配置

```bash
pnpm managed-sources:verify
cp .env.example .env
```

`managed-sources:prepare`已经从精确Fork commit生成Pi `dist`与DSH `lib`，Chat随后通过
`link:`直接消费这些源码构建。这里再次运行`managed-sources:verify`，用于在创建私有配置前
确认运行marker与解析路径没有漂移。Fork没有检出、分支错误、构建缺失或能力标记不符时，
安装、构建或服务启动必须失败关闭；不得用
`pnpm patch`或官方npm包临时补洞。

已有完整安装、只需重新准备当前稳定核心服务时使用：

```bash
pnpm run setup --workbench=off
```

`pnpm run setup`是幂等准备命令，它会：

1. 校验平台、Node、pnpm、Git、tar与npm；
2. 仅在显式启用Beta Workbench时下载并校验固定`code-server@4.132.0`工件；
3. 校验[DSH插件登记表](../../config/dsh-plugins.json)、Fork分支、运行标记和许可证，构建Workflow
   Bundle与LifeOS Bridge，再准备固定DSH Web Profile；
4. 只生成可重建缓存，不启动任何服务。

当前不准备Memory；统一setup没有启用参数。固定commit/tree、lock和原生工件Hash代码继续
保留，未来决定恢复Memory时再重新接入组合根与启动图。

如果同一仓库已有本地服务或Workbench在运行，setup只报告占用并失败，不会替用户停止
进程，也不会修改活动Product Run；先显式运行`pnpm dev:stop`后再准备。

普通Chat安装必须检出上文两个Later Fork，但不需要克隆官方DeepSeek Harness、memmy、Tencent MemoryCore或code-server；Fork维护与汇合流程见[DSH前端派生与维护](../architecture/dsh-frontend-maintenance.md)和[Pi Coding Executor](../architecture/pi-coding-executor-service.md)。本机已有
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
pnpm dev --memory=off --workbench=off
```

参数直接跟在`pnpm dev`后面；当前pnpm不要额外插入一个`--`。看到
`[chat] ready: http://127.0.0.1:43110/`后打开该地址。该推荐配置产生1个Supervisor和
4个子进程（Pi Executor、Workflow、API、Web），共5个OS进程；Web进程同时监听Gateway
`43110`与DSH内部Host `43114`，不是两套前端。另一个终端可以检查或停止：

```bash
pnpm dev:status
pnpm dev:stop
```

若本机已经通过LaunchAgent常驻production，VS Code F5和命令行调试不需要停止它；使用隔离实例：

```bash
pnpm run setup --instance=debug --memory=off --workbench=off # 独立worktree首次准备
pnpm dev:debug
pnpm dev:debug:status
pnpm dev:debug:stop
```

debug入口固定为`http://127.0.0.1:44110/`，数据位于当前worktree的
`.data/instances/vscode-debug`。为同时隔离源码与构建产物，应在独立worktree中打开VS Code。
不要在LaunchAgent常驻时再运行普通`pnpm dev`，因为它仍是production实例。

默认`pnpm dev`仍兼容启用Beta Code Workbench；显式启用时使用：

```bash
pnpm dev --memory=off --workbench=code-server
```

这会增加code-server wrapper和child，基线共7个OS进程；每个Terminal另有子进程。
当前只使用Chat/PWA时保持前文的`--workbench=off`。

当前不启动或装配Memory。`18960`与`18970`在整个运行期间都应保持空闲；统一启动器
拒绝`--memory=all|memmy|memorycore`，避免环境变量或历史命令静默恢复Memory。

`431xx`只属于production；分支worktree、VS Code F5和测试不得占用。CLI/VS Code debug固定
使用`441xx`，Playwright真实浏览器门固定使用`451xx/452xx/453xx`。测试专属端口被占用时
失败关闭，不调用production的`debug:preclean`，也不停止LaunchAgent。

`dev:stop`完成后，production的43110、43111、43112、43114、43115与43119都应释放；
`dev:debug:stop`只释放debug的44110、44111、44112、44114、44115、44119、44120、44121、44122与44123，不影响production。
18960/18970与19960/19970应始终未被默认服务图占用，
code-server的Unix socket和Terminal子进程也应被受管回收。不要用`killall`、`pkill`或
直接删除`.data`替代停止命令；`.data`还可能包含产品数据和运行证据。

## 5. 常见问题

- `Provider not ready`：安装成功但未配置`DASHSCOPE_API_KEY`；填入`.env`后重启。
- `link:`目标不存在或Fork能力门失败：按第2、3节检出正确Fork稳定分支并重新构建；不要恢复package patch。
- `executor.workspace_not_allowed`：批准计划请求了Workspace工具，但Contract中的`rootId`不在服务端`CHAT_PROJECT_ROOTS_JSON`；修正Root配置后发起新Run，不要把绝对路径放进请求。
- 端口占用：先运行`pnpm dev:status`，再用`pnpm dev:stop`回收身份匹配的旧Chat进程。
  未知进程不会被自动终止。
- `43113`占用：这是已退役的无认证code-server端口，启动器只报告、绝不自动清理；
  需要人工确认占用者后处理。
- 固定工件校验失败：重新运行`pnpm run setup`。它会保留异常缓存证据并原子重建，不要手工
  修改固定工件目录。
- 需要断点、Trace或真实浏览器门：继续阅读[本地调试](../debug/local-debug.md)。
