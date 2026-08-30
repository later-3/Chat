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
                ├── Planner：无工具的Pi AgentSession，使用当前Chat Session的内存副本
                └── Executor：Pi Coding Agent，继续当前Chat Session
          ├── Memory与Rule Management Workflow
          ├── 配置与全局资源 → ~/.chat/agent
          ├── Workflow运行数据 → ~/.chat/runtime/workflow-data
          └── Session → ~/.chat/projects/<projectId>/sessions
```

前端可选择四个Workflow：

- `minimal-pi-coding-agent`（直接执行）：一个Step直接运行Pi Coding Agent。
- `planning-execution`（规划执行）：Planner Agent先生成计划，Executor再按计划运行Pi Coding Agent。Planner使用从当前Chat Session复制出的内存Session，不创建第二个持久Session文件；Planner输出、Executor输入来源和两个Stage的Agent身份都记录在同一个Chat Session中。Executor收到用户原话和Planner输出，但持久对话仍保留用户原始消息。
- `memory`：通过普通Workflow Agent和原生Pi Tool管理个人或指定Project Memory。
- `rule-management`：通过普通Workflow Agent管理规则与经验Prompt资源及采用建议。

Pi Web不再作为独立服务运行。它原来的Next.js后端、`app/api`、Agent RPC服务和Session文件读取代码都不属于运行架构。前端不能导入Pi SDK，也不能直接读取文件系统。

Pi Web现有功能全部属于Chat的目标能力。当前接入状态和后续必须迁移的接口见[Pi Web前端API迁移清单](./docs/pi-web-frontend-api-migration.md)。

## 源码位置

Chat仓库固定记录两个私有子模块的精确提交：

```text
Chat/
├── frontend/  Pi Web纯浏览器前端子模块
├── pi/        Pi Agent源码子模块
├── src/workflows/
│   ├── minimal-pi-coding-agent/  直接执行Workflow模块
│   ├── planning-execution/       规划执行Workflow模块
│   ├── registry.ts               后端Workflow注册事实源
│   ├── agent-config.ts           Agent配置格式与校验
│   ├── agent-config-loader.ts    配置文件读取、合并与路径解析
│   └── agent-definition.ts       公共Pi AgentSession装配边界
├── src/resources/                Skill、Extension与Plugin管理
├── src/routes/                   Chat HTTP API
└── ...
```

| 目录 | Later私有仓库 | 长期集成分支 | 职责 |
|---|---|---|---|
| `pi/` | <https://github.com/later-3/pi> | `codex/later-custom` | Pi Agent源码与构建产物 |
| `frontend/` | <https://github.com/later-3/pi-web> | `codex/chat-frontend` | Pi Web派生的纯浏览器前端 |

Chat通过以下依赖使用本地Pi源码构建：

```text
link:./pi/packages/agent
link:./pi/packages/coding-agent
```

`frontend/`的上游、提取基线和许可证记录在[frontend/UPSTREAM.md](./frontend/UPSTREAM.md)。Chat父仓库中的gitlink决定实际运行的Pi和前端版本；`.gitmodules`中的`branch`只供显式更新使用，不会让部署自动漂移到分支最新提交。

两个私有Fork的开发、提交、回合官方上游修复以及更新Chat固定提交的操作见[子模块维护指南](./docs/managed-submodules.md)。

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

## 本地开发

要求Node.js `>=22.19.0`和pnpm `10.13.1`，并且当前GitHub身份有权读取两个私有子模块。

```bash
git clone --recurse-submodules git@github.com:later-3/Chat.git
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

`pnpm pi:prepare`先以Pi自己的锁文件安装依赖，再从Pi配置的公开模型目录生成本地Provider数据，最后离线构建`pi/packages/*/dist`。首次准备需要访问模型目录；生成的数据位于Pi忽略的`packages/ai/src/providers/data/`，不提交Git。Chat运行时从构建产物加载代码，source map会把VS Code断点映射回`pi/packages/*/src`。

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
  → 校验workflow字段并返回Workflow Run ID
GET /runs/:runId/events
  → 按顺序流式返回Stage、Thinking、文本与工具执行事件
GET /runs/:runId
  → 查询状态和最终结果
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

`POST /run`仍保留为阻塞式人工调试接口，前端不使用它。

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

网页默认启用登录，初始账号为`later / 123456`。生产环境通过
`CHAT_WEB_AUTH_USERNAME`、`CHAT_WEB_AUTH_PASSWORD`和
`CHAT_WEB_AUTH_SESSION_SECRET`覆盖；只在受信任的本地环境中才可以设置
`CHAT_WEB_AUTH_ENABLED=0`关闭登录。

服务器部署和`https://chat.ai4child.asia`域名配置见[部署指南](./docs/deployment.md)。

## Chat Home运行数据

```text
~/.chat/agent/                         Pi模型、设置、认证与全局资源
~/.chat/memory/personal/               个人Memory事实源与索引
~/.chat/projects/<projectId>/sessions/ 各Project的Pi Session
~/.chat/projects/<projectId>/memory/   各Project独立Memory事实源与索引
~/.chat/runtime/workflow-data/         进程级Workflow Run、Step和Event
~/.chat/cache/fastembed/               可重新下载的本地Embedding模型缓存
```

这些目录都不属于Chat源码仓库。部署到其他环境时，使用`--recurse-submodules`克隆Chat，准备两个私有子模块的Git读取凭证，安装依赖、构建Pi、准备`~/.chat/agent`私有配置并执行`pnpm verify`。必须在目标操作系统和CPU架构上构建，不能把其他机器的`.output`直接复制过去。Pi Web不再作为独立后端或独立服务启动；完整的可移植部署步骤、私有配置清单和验收命令见[部署指南](./docs/deployment.md)。
