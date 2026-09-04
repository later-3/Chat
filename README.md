# Chat：Pi Web前端与Pi Agent Workflow

Chat允许用户在同一个连续Session中逐轮选择Workflow。浏览器中的Pi Web派生前端把Prompt、Workflow和Agent配置选择提交给Chat，Chat启动对应的Vercel Workflow，并把Agent执行过程、Assistant回复和Pi Session展示在前端。

Chat以Workflow作为一级管理对象。每个Workflow目录归拢自己的Workflow定义、Stage、Agent定义、专用Prompt、上下文适配和测试；HTTP、Session、Workflow Runtime及Pi Agent运行能力由公共代码提供。

Chat新增需求必须先遵守[Agent第一性原理与架构约束](./docs/architecture/chat-agent-first-principles.md)，再进入具体需求和详细设计。Pi、Pi Web与Chat的源码分析、需求推导和详细设计按顺序维护在[架构、需求与详细设计文档](./docs/architecture/README.md)中。当前README只描述已经实现并验证的运行方式，不替代上游架构分析。

## 架构

```text
Chat/frontend（Pi Web纯浏览器前端子模块）
  → Chat Nitro HTTP API
    ├── Project与Session → ~/.chat/projects/<projectId>/sessions
    └── Vercel Workflow
          ├── Direct Workflow → Pi Coding Agent
          ├── Planning + Execution
                ├── Planner：无工具的Pi AgentSession，计划原生写入当前Chat Session
                └── Executor：Pi Coding Agent，继续当前Chat Session
          ├── Planner Orchestrator
                ├── Planner + 人工审核：冻结获批计划revision
                └── Coordinator：通过Pi Skill/Tool调用多个独立子Workflow Session
          ├── Memory与Rule Management Workflow
          ├── 配置与全局资源 → ~/.chat/agent
          ├── Workflow运行数据 → ~/.chat/runtime/workflow-data
          └── Session → ~/.chat/projects/<projectId>/sessions
```

前端可选择五个Workflow：

- `minimal-pi-coding-agent`（直接执行）：一个Step直接运行Pi Coding Agent。
- `planning-execution`（规划执行）：固定为`Planner Agent → 人工审核Task → Pi Coding Agent`。Planner先完整理解背景、目标、交付物、范围、约束、授权边界和验收标准；存在用户专属阻塞决策时只允许补充信息并继续规划，计划就绪后才允许批准。补充或拒绝时，用户原文、上一版完整文档和原始请求返回同一个Planner配置；批准后Executor接收带批准版本、最终计划和执行契约的任务书。全程只有一个持久Chat Session，计划、审核决定、Agent输入来源和Stage身份都作为可恢复事实记录其中。
- `planner-orchestrator`（规划协调）：`Planner Agent → 人工审核Task → Workflow Coordinator`。批准后Coordinator按`workflow-delegation` Skill通过Pi `workflow_call` Tool把独立工作包并行交给多个完整Workflow；调用前先读取目标各Agent可选的Tool/Skill，调用时由父Agent明确选择。每个子调用使用独立Pi Subsession并建立原生父子关系，但不复制父对话；父Session保留Tool Call/Result和调用终态，Child Session保留任务、冻结能力配置与完整执行历史。
- `memory`：通过普通Workflow Agent和原生Pi Tool管理个人或指定Project Memory。
- `rule-management`：通过普通Workflow Agent管理规则与经验Prompt资源及采用建议。

`workflow_call`是按Agent配置装配的通用Pi Tool，不限于Coordinator；Workflow只要声明`agentCallable: true`就可作为目标，包括当前Workflow自身和需要人工审核的Workflow。父会话按普通Tool Call展示，Child Session在左侧递归会话树中打开；若Child等待审核，侧栏显示可恢复的待确认提示，用户进入该Session后按普通会话完成确认。

Chat还会把已复盘且具有通用价值的开发问题归档为Personal `experience` Prompt资源。前端从现有规则与经验库自动发现；用户可在Workflow Agent配置中勾选，选中内容按统一装配路径进入Agent自定义System Prompt区域。案例原文与回归要求见[开发经验案例](./docs/development-experiences/README.md)。

Pi Web不再作为独立服务运行。它原来的Next.js后端、`app/api`、Agent RPC服务和Session文件读取代码都不属于运行架构。前端不能导入Pi SDK，也不能直接读取文件系统。

Pi Web现有功能全部属于Chat的目标能力。当前接入状态和后续必须迁移的接口见[Pi Web前端API迁移清单](./docs/pi-web-frontend-api-migration.md)。

## 源码位置

Chat仓库固定记录两个公开子模块的精确提交：

```text
Chat/
├── frontend/  Pi Web纯浏览器前端子模块
├── pi/        Pi Agent源码子模块
├── src/workflows/
│   ├── minimal-pi-coding-agent/  直接执行Workflow模块
│   ├── planning-execution/       规划执行Workflow模块
│   ├── planner-orchestrator/      规划、审核和子Workflow协调模块
│   ├── registry.ts               后端Workflow注册事实源
│   ├── agent-config.ts           Agent配置格式与校验
│   ├── agent-config-loader.ts    配置文件读取、合并与路径解析
│   └── agent-definition.ts       公共Pi AgentSession装配边界
├── src/resources/                Skill、Extension与Plugin管理
├── src/routes/                   Chat HTTP API
└── ...
```

| 目录 | 公开仓库 | 长期集成分支 | 职责 |
|---|---|---|---|
| `pi/` | <https://github.com/later-3/pi> | `codex/later-custom` | Pi Agent源码与构建产物 |
| `frontend/` | <https://github.com/later-3/chat-frontend> | `main` | Pi Web派生的纯浏览器前端 |

Chat通过以下依赖使用本地Pi源码构建：

```text
link:./pi/packages/agent
link:./pi/packages/coding-agent
```

`frontend/`的上游、提取基线和许可证记录在[frontend/UPSTREAM.md](./frontend/UPSTREAM.md)。Chat父仓库中的gitlink决定实际运行的Pi和前端版本；`.gitmodules`中的`branch`只供显式更新使用，不会让部署自动漂移到分支最新提交。

两个公开子仓库的开发、提交、回合官方上游修复以及更新Chat固定提交的操作见[子模块维护指南](./docs/managed-submodules.md)。

## Session语义

Chat按稳定`projectId`从以下目录管理Pi Session：

```text
~/.chat/projects/<projectId>/sessions
```

Session文件头中的`cwd`表示Agent实际操作的工作目录。浏览器只传`sessionId`：

- 没有`sessionId`：创建新Session。
- 有`sessionId`：Chat验证Session ID和`cwd`后打开已有Session。
- 浏览器不能指定Session文件或Session目录。

Chat不会扫描用户主目录下的`~/.pi`，也不会在项目仓库内保存Session。

用户、Assistant和Tool Result始终由Pi原生MessageEntry保存；Workflow、Stage、Agent、审核状态和Agent输入引用使用CustomEntry补充。完整约束、正例、反例和历史迁移规则见[Chat Session架构](./docs/architecture/chat-session-architecture.md)。Session列表的回退文本取第一条用户或Agent话语，不展示Pi的`(no messages)`哨兵；显式标题仍是独立能力。

## 本地开发

要求Node.js `>=22.19.0`和pnpm `10.13.1`。两个子模块均可通过公开HTTPS匿名读取。

```bash
git clone --recurse-submodules https://github.com/later-3/Chat.git
cd Chat
corepack enable
pnpm pi:prepare
pnpm install --frozen-lockfile
```

已有Chat工作目录只需执行一次：

```bash
git submodule update --init --recursive
pnpm pi:prepare
pnpm install --frozen-lockfile
```

`pnpm pi:prepare`先以Pi自己的锁文件安装依赖，再通过Pi提供的单一入口下载并校验固定Release模型快照，最后离线构建`pi/packages/*/dist`。模型数据位于Pi忽略的`packages/ai/src/providers/data/`，不提交Git；URL、版本和SHA256只由当前Pi Commit管理，Chat与部署脚本不复制这些常量。Chat运行时从构建产物加载代码，source map会把VS Code断点映射回`pi/packages/*/src`。

在VS Code中打开Chat目录，按`F5`选择：

```text
Debug Chat
```

它会启动：

- Chat Nitro与Workflow Runtime：`http://127.0.0.1:43112`
- Vite前端：`http://127.0.0.1:30145`

Vite只在开发环境提供页面热更新，并把`/api`和`/runs`代理到Chat。生产环境不运行Vite。

也可以分别启动：

```bash
pnpm dev
pnpm dev:frontend
```

## 当前调用链

```text
POST /runs
  → 校验请求；首轮先持久化Pi Session，再返回sessionId与Workflow Run ID
GET /runs/:runId/events
  → 按顺序流式返回Stage、Thinking、文本与工具执行事件
GET /runs/:runId
  → 查询状态、待审核计划和最终结果
POST /runs/:runId/review
  → 精确绑定计划版本与摘要，批准执行或携带审核原文要求重规划
DELETE /runs/:runId
  → 用户停止时取消Workflow
GET /api/sessions
  → 返回Chat管理的Session列表
GET /api/sessions/:sessionId
  → 返回Session消息和树
GET /api/sessions/:sessionId/export
  → 导出按Workflow、Stage和Agent整理的完整历史HTML
GET /api/workflows
  → 返回后端注册的Workflow、Stage和Agent定义
POST /api/workflows/:workflowId/agents/:agentId/resolve
  → 按实际Pi AgentSession装配过程返回Agent配置、最终Prompt、Tools和资源
GET/PATCH /api/skills
GET/POST /api/extensions
GET/POST /api/plugins
  → 管理Chat控制的Pi全局资源并供Workflow内Agent选择
GET /api/files/[...path]
  → 在Chat授权的工作目录内列出、读取、下载和预览文件
```

`POST /run`仍保留为阻塞式人工调试接口，前端不使用它；需要人工审核的`planning-execution`只允许通过异步`POST /runs`启动。

## 构建与运行

```bash
pnpm test
pnpm typecheck
pnpm build
```

一次运行全部单元、前端合同、构建和构建产物HTTP测试：

```bash
pnpm verify
```

`pnpm build`先生成`frontend/dist`，再由Nitro将其放入正式服务产物。生产环境只启动一个Chat进程：

```bash
HOST=127.0.0.1 \
PORT=43112 \
WORKFLOW_TARGET_WORLD=local \
node .output/server/index.mjs
```

访问：

```text
http://127.0.0.1:43112/
```

该地址同时提供前端静态文件和Chat API，不需要启动Pi Web服务。

网页默认启用登录。生产环境必须通过`CHAT_WEB_AUTH_USERNAME`和
`CHAT_WEB_AUTH_PASSWORD`设置自己的账号；Linux安装脚本会生成独立的
`CHAT_WEB_AUTH_SESSION_SECRET`。只在受信任的本地环境中才可以设置
`CHAT_WEB_AUTH_ENABLED=0`关闭登录，不存在可直接用于生产的默认密码。

服务器部署、公开域名和反向代理配置见[部署指南](./docs/deployment.md)。父仓库与两个公开Submodule的CI职责和阻断式检查见[CI说明](./docs/ci.md)。

## Chat Home运行数据

```text
~/.chat/devices.json                    可选的私有多设备目录
~/.chat/agent/                         Pi模型、设置、认证与全局资源
~/.chat/memory/personal/               个人Memory事实源与索引
~/.chat/projects/<projectId>/sessions/ 各Project的Pi Session
~/.chat/projects/<projectId>/memory/   各Project独立Memory事实源与索引
~/.chat/runtime/workflow-data/         进程级Workflow Run、Step和Event
~/.chat/cache/fastembed/               可重新下载的本地Embedding模型缓存
```

这些目录都不属于Chat源码仓库。新的Linux/systemd环境需要`root`/`sudo`以及访问GitHub、Node、npm Registry和依赖原生包CDN的网络，但不需要GitHub账号或Submodule凭证。脚本会自动创建`chat`用户，准备固定Node/pnpm、公开Submodule、经过SHA256校验的Pi模型快照、版本化构建、systemd服务和回滚点，只暂停等待用户填写Web密码、Provider凭证与默认模型；多设备目录是可选的`$CHAT_HOME/devices.json`。`WORKFLOW_LOCAL_DATA_DIR`必须位于`CHAT_HOME`内部。更新、诊断和回滚分别使用`chatctl update`、`chatctl doctor`和`chatctl rollback`。必须在目标操作系统和CPU架构上构建，不能复制其他机器的`.output`；完整步骤见[部署指南](./docs/deployment.md)。

# 启动脚本
```bash
# 默认：占用端口 → 报错退出，并提示可用 --kill
scripts/dev-start.sh

# 带上 --kill：自动终止占用端口的进程，然后正常拉起前后端
scripts/dev-start.sh --kill

# 选项可组合
scripts/dev-start.sh --kill --backend-port 44112 --frontend-port 31145
```
