# Chat

Chat 是一个以对话为入口、以耐久Workflow为执行骨架、由用户持续介入和审核的个人Agent协作产品。

它把自然语言输入转化为上下文、计划、人工决定、执行、结果、证据和可恢复的长期状态，而不只是显示模型消息。

## 当前技术基线

- 唯一前端：固定版本DeepSeek Harness Web。
- DSH集成：本仓库的`@chat/dsh-lifeos-bridge` Host/Client插件。
- 产品API：REST Query/Command；Product Store拥有权威事实。
- HTTP：Node.js + TypeScript + Hono。
- 耐久执行：Vercel Workflow。
- Agent Runtime：`pi-agent-core`与`pi-ai`。
- Memory：固定memmy与Tencent MemoryCore Sidecar；默认`off`不准备、不占端口、不装配，显式`memorycore / memmy / compare`才启动并通过统一Query/Write/Reconcile Port接入。memmy当前限定单Principal专属数据库；本地无模型MemoryCore只承诺`accepted_only`。
- 开发工作台：固定版本code-server，以独立Hosted Workbench接入。

```text
Browser -> LifeOS Web Gateway (127.0.0.1:43110)
         -> DeepSeek Harness Web -> LifeOS Bridge
         -> Code Workbench (localhost虚拟Host -> code-server)
LifeOS Bridge
-> Chat Query / Command API
-> Product Application + Product Store
-> Vercel Workflow
-> pi Agent Node / Governed Tool
-> Product Commit
-> DSH原生会话投影
```

DSH Session、Product Session、Product Run、Workflow Run、Checkpoint、pi Session和浏览器连接始终是不同对象。

## 全新克隆与本地运行

```bash
corepack enable
pnpm managed-sources:prepare
cp .env.example .env
pnpm run setup --memory=off --workbench=off
pnpm dev --memory=off --workbench=off
```

看到`[chat] ready: http://127.0.0.1:43110/`后打开该地址。上面是当前推荐的“只启动
Chat/PWA”前台命令：Memory保持关闭，Beta Workbench也不启动。参数直接写在`pnpm dev`
后面；当前pnpm不需要、也不能再额外插入一个`--`。

状态和停止命令：

```bash
pnpm dev:status
pnpm dev:stop
```

### 已安装LaunchAgent的本机

`431xx` production由`com.later.chat.production`唯一拥有。先检查：

```bash
scripts/service/install-chat-production.sh status
```

若显示`loaded`且健康，服务已经由LaunchAgent常驻，**不要再运行`pnpm dev`**。安装或恢复
常驻服务使用`install-chat-production.sh install`；它固定以`--memory=off --workbench=off`
的等价配置启动完整Chat栈。`pnpm dev:stop`只会停止当轮进程，`KeepAlive`仍会再次拉起；
要长期停用应使用该服务脚本的`uninstall`。

### 分支开发、worktree与VS Code F5

production常驻时，命令行调试与VS Code F5使用独立debug实例，不需要停服：

```bash
pnpm dev:debug          # http://127.0.0.1:44110/
pnpm dev:debug:status
pnpm dev:debug:stop
```

VS Code中的“Chat：调试应用”调用的就是同一个`dev:debug`合同；这是Node/Chrome调试入口，
不会另起一套占用production端口的GDB服务。debug的端口、Product Store、Workflow、Runtime、
Trace、DSH状态、PID与浏览器Profile均位于当前worktree的隔离边界。一个时刻只运行一个
`441xx` debug实例；为避免源码和构建产物互相影响，必须在独立worktree中打开VS Code。

### 端口所有权

| 端口族 | 唯一用途 | 规则 |
|---|---|---|
| `431xx` | LaunchAgent/手动production | 固定保留；分支、worktree、VS Code F5与测试禁止占用 |
| `441xx` | 交互式CLI/VS Code debug | 与production并行；一次只允许一个debug worktree |
| `451xx/452xx/453xx` | Playwright真实浏览器门 | 测试专属；占用时失败关闭，不清理production进程 |
| `18960/18970`、`19960/19970` | 显式Memory production/debug Sidecar | `off`不检查也不占用；`memmy / memorycore / compare`只检查并启动所选端口 |
| `8088/8443` | 独立Plane CE Docker入口 | 不属于Chat启动器或上述三组实例 |

production服务固定为：`43110` Gateway、`43114` DSH内部Host、`43111` API、`43112`
Workflow、`43115` Pi Executor、`43119` Workbench互斥租约；`43120..43123`只为同族
Inspector保留且production不监听，退役的`43113`必须始终空闲。debug使用一一对应的
`44110/44114/44111/44112/44115/44119/44120..44123`，绝不回落到`431xx`。

### 启动参数与进程数

| 命令/参数 | 结果 |
|---|---|
| `pnpm dev --memory=off --workbench=off` | 推荐；1个Supervisor + Pi/Workflow/API/Web 4个子进程，共5个OS进程 |
| `pnpm dev --memory=memorycore|memmy --workbench=off` | 显式增加1个固定Memory Sidecar wrapper及其child；API/Workflow冻结同一Provider |
| `pnpm dev --memory=compare --workbench=off` | 同时启动memmy与MemoryCore，只建立双Provider运行基础，不自动合并查询结果 |
| `pnpm dev --memory=off --workbench=code-server` | 显式启用Beta Workbench；基线增加wrapper和code-server child，共7个OS进程；每个Terminal另有子进程 |
| `pnpm dev` | 兼容默认值，等价于Memory关闭、Workbench开启；日常体验建议显式写出参数 |
| `pnpm dev:debug [--memory=off|memorycore|memmy|compare]` | 固定`instance=debug`和Workbench关闭；Memory缺省off，显式启用时使用`19960/19970` |

Web Gateway与DSH内部Host由同一个Web子进程监听两个端口，所以不是两套前端。Pi Executor、
Workflow与API是3个职责独立的后端子进程，也不是重复后端。`pnpm dev:status`显示的PID和
监听者必须与这张图一致；未知端口占用会失败关闭，禁止使用`pkill`或`killall`清场。

`pnpm run setup`会按仓库固定证据自动准备DSH Profile、Workflow Bundle和code-server；Pi与DSH
定制源码分别直接来自`later-3/pi@codex/later-custom`和
`later-3/deepseek-harness-chat@codex/chat-trajectory-location-rc6`，不使用下游package patch。
当前默认不下载或准备Memory工件；显式Memory模式才从固定commit/tree准备所选Sidecar，也不需要另外克隆
官方DeepSeek Harness、memmy、Tencent MemoryCore或code-server。没有配置
`DASHSCOPE_API_KEY`时服务仍可启动和浏览，但真实规划/执行会明确显示Provider not ready。
支持平台、工具链、首次下载、配置与故障处理以[本地安装指南](./docs/getting-started/local-install.md)为唯一入口。

统一启动器始终启动Pi Executor、Workflow、API和DSH/Gateway；Memory缺省`off`，此时即使存在遗留
endpoint或凭据也返回空Registry。显式`--memory=memorycore|memmy|compare`才准备并启动对应Sidecar，
API与Workflow在Store/恢复前冻结同一Provider描述集合。debug实例同时固定关闭Beta Workbench。code-server只监听
受管0600 Unix socket，浏览器只能经Gateway访问；扩展市场默认离线，不连接Open VSX或自动
查询Copilot。

### Plane CE（独立Docker服务）

Plane Community Edition 1.4.1是可选项目管理Provider，不是`pnpm dev`的子进程，也不随
LaunchAgent自动启动。普通聊天不需要Plane；要体验“创建项目”纵向，先确认Docker Engine/
Docker Desktop可用，再显式执行：

```bash
pnpm plane-ce:prepare
pnpm plane-ce:config
pnpm plane-ce:up
pnpm plane-ce:status
```

固定Compose声明13个服务：通常12个长驻容器，`migrator`为一次性任务。Plane Web入口是
`http://127.0.0.1:8088`（HTTPS保留位`8443`）。首次还要在Plane中完成管理员、Workspace和
API Token配置，再按[本地安装指南](./docs/getting-started/local-install.md#31-可选plane-ce项目管理)
配置Chat。停止使用`pnpm plane-ce:down`；它只停止容器，不删除Plane数据。

完整固定端口与断点入口见[本地调试](./docs/debug/local-debug.md)。

## 文档入口

编码Agent必须先从[项目协作规则](./AGENTS.md)开始；阶段计划不是自动开工授权，非核心能力在实现前必须先完成“直接复用、窄Adapter、拒绝或自研”的证据化选择。

1. [项目协作规则](./AGENTS.md)
2. [项目上下文](./PROJECT_CONTEXT.md)
3. [当前状态](./PROJECT_STATE.md)
4. [当前计划](./PROJECT_PLAN.md)
5. [技术与所有权合同](./docs/architecture/technology-contract.md)
6. [DSH前端与Chat后端交互](./docs/architecture/frontend-backend-interaction.md)
7. [Agent管理](./docs/architecture/agent-management-as-built.md)
8. [Prompt Studio与组装](./docs/architecture/prompt-studio-as-built.md)
9. [Session、轨迹与Trace](./docs/architecture/session-architecture.md)
10. [Workflow运行设计](./docs/architecture/runtime-workflows.md)
11. [安全边界](./docs/architecture/security-boundaries.md)
12. [仓库地图](./docs/architecture/repository-map.md)
13. [状态与运行时边界](./docs/architecture/system-boundaries.md)
14. [产品设计准则](./docs/product/design-guidelines.md)
15. [工程规范](./docs/engineering-standards.md)
16. [本地安装指南](./docs/getting-started/local-install.md)

当前树不保存旧前端、上游源码副本、历史UI原型或归档目录；需要历史时直接使用Git。
