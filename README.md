# Chat：Pi Web前端与Pi Agent Workflow

Chat当前实现两条可运行纵向：浏览器中的Pi Web前端向Chat提交普通文本Prompt并选择Workflow，Chat启动对应的Vercel Workflow，最后将Assistant回复和Pi Session展示在前端。

## 架构

```text
Chat/frontend（Pi Web纯浏览器前端子模块）
  → Chat Nitro HTTP API
    ├── Session读取 → Chat/.pi/sessions
    └── Vercel Workflow
          ├── Minimal Pi Coding Agent → Pi Coding Agent
          └── Planning + Execution
                ├── Planner：无工具的Pi AgentSession，使用当前Chat Session的内存副本
                └── Executor：Pi Coding Agent，继续当前Chat Session
          ├── 配置 → Chat/.pi/agent
          └── Session → Chat/.pi/sessions
```

前端可选择两个Workflow：

- `minimal-pi-coding-agent`（直接执行）：一个Step直接运行Pi Coding Agent。
- `planning-execution`（规划执行）：Planner Agent先生成计划，Executor再按计划运行Pi Coding Agent。Planner使用从当前Chat Session复制出的内存Session，不创建第二个持久Session文件；Planner输出、Executor输入来源和两个Stage的Agent身份都记录在同一个Chat Session中。Executor收到用户原话和Planner输出，但持久对话仍保留用户原始消息。

Pi Web不再作为独立服务运行。它原来的Next.js后端、`app/api`、Agent RPC服务和Session文件读取代码都不属于运行架构。前端不能导入Pi SDK，也不能直接读取文件系统。

Pi Web现有功能全部属于Chat的目标能力。当前接入状态和后续必须迁移的接口见[Pi Web前端API迁移清单](./docs/pi-web-frontend-api-migration.md)。

## 源码位置

Chat仓库固定记录两个私有子模块的精确提交：

```text
Chat/
├── frontend/  Pi Web纯浏览器前端子模块
├── pi/        Pi Agent源码子模块
├── src/       Chat HTTP API与Workflow
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

Chat只从以下目录管理Pi Session：

```text
Chat/.pi/sessions
```

Session文件头中的`cwd`表示Agent实际操作的工作目录。浏览器只传`sessionId`：

- 没有`sessionId`：创建新Session。
- 有`sessionId`：Chat验证Session ID和`cwd`后打开已有Session。
- 浏览器不能指定Session文件或Session目录。

Chat不会扫描用户主目录下的`~/.pi`。

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

`pnpm pi:prepare`先以Pi自己的锁文件安装依赖，再使用仓库已经固定的模型目录离线构建`pi/packages/*/dist`。Chat运行时从这些构建产物加载代码，source map会把VS Code断点映射回`pi/packages/*/src`。

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

## 需要持久化但不能提交的目录

```text
Chat/.pi/agent/       Pi模型、设置和认证配置
Chat/.pi/sessions/    Pi Coding Agent Session
Chat/.workflow-data/  Workflow Run、Step和Event
```

部署到其他环境时，使用`--recurse-submodules`克隆Chat，准备两个私有子模块的Git读取凭证，安装依赖、构建Pi、准备`.pi/agent`私有配置并执行`pnpm verify`。必须在目标操作系统和CPU架构上构建，不能把其他机器的`.output`直接复制过去。Pi Web不再作为独立后端或独立服务启动；完整的可移植部署步骤、私有配置清单和验收命令见[部署指南](./docs/deployment.md)。
