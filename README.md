# Chat：最小 Pi Coding Agent Workflow

当前系统只实现一条纵向：Pi Web 将新会话中的普通文本 Prompt 交给 Chat，Chat 启动 Vercel Workflow，Workflow 调用 Pi Coding Agent，并把最终 Assistant 文本返回 Pi Web。

## 外部源码位置

Pi 和 Pi Web 都是独立 Git 仓库，不复制到 Chat 仓库中。三个仓库的正式本地布局如下：

```text
<Code>/
├── Chat/       Chat 后端与 Workflow
├── pi-web/     Pi Web 前端及其原有 Next.js 服务
└── opc-os/pi/  Pi Agent 源码
```

本机 `<Code>` 是 `/Users/xulater/Code`，所以正式目录为：

| 项目 | 本地目录 | Later Fork | 稳定分支 | 只读上游 |
|---|---|---|---|---|
| Chat | `/Users/xulater/Code/Chat` | <https://github.com/later-3/Chat> | `main` | 无 |
| Pi Web | `/Users/xulater/Code/pi-web` | <https://github.com/later-3/pi-web> | `codex/later-custom` | <https://github.com/agegr/pi-web> |
| Pi | `/Users/xulater/Code/opc-os/pi` | <https://github.com/later-3/pi> | `codex/later-custom` | <https://github.com/earendil-works/pi> |

Chat 通过 `package.json` 中的以下依赖直接使用本地 Pi 源码构建：

```text
link:../opc-os/pi/packages/coding-agent
```

Pi Web 也通过相邻的 `../opc-os/pi/packages/*` 使用同一个 Pi checkout。不得把 Pi 源码复制进 Chat 或 Pi Web，也不得用 registry 包静默替代这个本地源码绑定。

## 正式运行目录

合入后的开发和运行只使用三个正式目录：

```text
/Users/xulater/Code/Chat
/Users/xulater/Code/pi-web
/Users/xulater/Code/opc-os/pi
```

带任务名称的 Git worktree 只用于隔离尚未合入的开发分支，不属于运行架构。分支合入后不得让启动配置继续依赖临时 worktree。

## 当前调用关系

```text
Pi Web 页面
  → POST Pi Web /api/chat-workflow
  → POST Chat /runs
  → GET Chat /runs/:runId
  → Vercel Workflow
  → Pi Coding Agent
  → 最终 Assistant 文本返回 Pi Web
```

用户停止时，Pi Web Adapter 调用 `DELETE /runs/:runId` 取消对应的 Workflow Run。图片、Slash Command、已有 Pi Web 会话及 Pi Web 的其他功能仍走原有实现，不由当前 Workflow Adapter 接管。

## VS Code 调试

当前从 Chat 侧调试时打开：

```text
/Users/xulater/Code/Chat
```

在 VS Code 中按 `F5`，选择：

```text
Debug Pi Web Workflow Integration
```

该配置调试 Chat Workflow（`127.0.0.1:43112`）和 Pi Web 服务端（`127.0.0.1:30145`），并在默认浏览器中打开 Pi Web 页面。浏览器不附加前端调试器，避免前端暂停影响 Workflow 调试操作。

## 在其他环境部署

### 部署边界

当前版本是单机部署：Chat、Pi Web 和 Pi checkout 必须位于同一台机器，并能访问同一个文件系统。Pi Web 会把用户选择的绝对工作目录作为 `cwd` 传给 Chat；如果两者位于不同机器，相同字符串不一定指向同一目录，当前版本不支持这种部署。

Workflow 使用 Local World，把运行、Step 和 Event 保存在 Chat 工作目录的 `.workflow-data/`。当前方式适合单进程部署，不提供多实例共享队列或高可用调度。

### 1. 准备源码目录

要求 Node.js `>=22.19.0`、Git、npm 和 Corepack。先把 `CHAT_CODE_ROOT` 设置为三个仓库的共同父目录；以下示例使用 `/opt/later`：

```bash
export CHAT_CODE_ROOT=/opt/later
mkdir -p "$CHAT_CODE_ROOT/opc-os"
cd "$CHAT_CODE_ROOT"

git clone --branch main https://github.com/later-3/Chat.git Chat
git clone --branch codex/later-custom https://github.com/later-3/pi-web.git pi-web
git clone --branch codex/later-custom https://github.com/later-3/pi.git opc-os/pi
```

私有环境可以把 URL 改为已经配置凭据的 HTTPS 或 SSH 地址，但目录结构不能改变。

### 2. 准备 Pi 源码

```bash
cd "$CHAT_CODE_ROOT/opc-os/pi"
npm ci
```

Pi Web 的 `pi:prepare` 会执行 Pi 的离线构建，并把全部 `@earendil-works/pi-*` 运行包链接到这个 checkout。

### 3. 准备 Pi Web

```bash
cd "$CHAT_CODE_ROOT/pi-web"
npm ci
npm run pi:prepare
npm run pi:verify
```

`pi:verify` 必须显示所有运行包都解析到 `$CHAT_CODE_ROOT/opc-os/pi`。缺少 Pi checkout、分支不正确、源码构建过期或链接被 registry 包覆盖时必须停止部署。

### 4. 准备 Chat 与私有配置

```bash
cd "$CHAT_CODE_ROOT/Chat"
corepack enable
pnpm install --frozen-lockfile
mkdir -p .pi/agent .pi/sessions
chmod 700 .pi .pi/agent .pi/sessions
```

Workflow 明确从用户所选工作目录下的 `.pi/agent/` 读取 Pi 配置。选择 `$CHAT_CODE_ROOT/Chat` 作为工作目录时，至少检查：

```text
$CHAT_CODE_ROOT/Chat/.pi/agent/settings.json
$CHAT_CODE_ROOT/Chat/.pi/agent/models.json
$CHAT_CODE_ROOT/Chat/.pi/agent/auth.json
```

只复制目标机器实际需要的配置；Provider 密钥应在目标机器重新配置或通过安全通道迁移。`.pi/`、密钥和 Session 文件不得提交到 Git。

### 5. 构建

构建 Chat：

```bash
cd "$CHAT_CODE_ROOT/Chat"
pnpm test
pnpm typecheck
pnpm build
```

构建启用 Workflow Adapter 的 Pi Web：

```bash
cd "$CHAT_CODE_ROOT/pi-web"
PI_WEB_DIST_DIR=.next-chat-workflow \
NEXT_PUBLIC_CHAT_WORKFLOW_ADAPTER=1 \
npm run build
```

`NEXT_PUBLIC_CHAT_WORKFLOW_ADAPTER=1` 是前端构建变量，必须在 `next build` 时设置；只在启动时设置不能修改已经生成的浏览器代码。

### 6. 启动两个服务

先启动 Chat：

```bash
cd "$CHAT_CODE_ROOT/Chat"
HOST=127.0.0.1 \
PORT=43112 \
WORKFLOW_TARGET_WORLD=local \
node .output/server/index.mjs
```

再启动 Pi Web：

```bash
cd "$CHAT_CODE_ROOT/pi-web"
CHAT_WORKFLOW_URL=http://127.0.0.1:43112 \
NEXT_PUBLIC_CHAT_WORKFLOW_ADAPTER=1 \
PI_WEB_DIST_DIR=.next-chat-workflow \
npm run start
```

生产启动时 Pi Web 默认监听 `127.0.0.1:30141`。需要从其他设备访问时，应由已有的反向代理和 HTTPS 暴露 Pi Web；Chat 的 `43112` 端口继续只监听 loopback，不直接暴露给浏览器或公网。

### 7. 验证

```bash
curl -i http://127.0.0.1:30141/
curl -i http://127.0.0.1:43112/runs/not-a-real-run
```

Pi Web 应返回页面或认证跳转；第二个请求应返回 `404 Workflow run ... not found`，它证明 Chat 服务和 Workflow Run 路由已经加载。`GET http://127.0.0.1:43112/` 返回 404 是正常的，因为 Chat 当前只有 API，没有根页面。

最后在 Pi Web 新会话中发送普通文本，并确认：

1. Chat 的 `.workflow-data/runs/` 出现新的 Run；
2. Run 状态最终为 `completed`；
3. `<cwd>/.pi/sessions/` 对应 Session 文件更新；
4. Pi Web 显示 Workflow 返回的 Assistant 文本。

### 8. 持久数据与升级

需要备份但不能提交 Git 的目录：

```text
<cwd>/.pi/agent/       Pi模型与认证配置
<cwd>/.pi/sessions/    Pi Coding Agent Session
$CHAT_CODE_ROOT/Chat/.workflow-data/  Local Workflow Run、Step和Event
```

升级时先停止 Pi Web 和 Chat，然后依次更新 Pi、执行 Pi Web 的 `npm ci && npm run pi:prepare`、更新 Chat 并重新构建，最后按照“先 Chat、后 Pi Web”的顺序启动。每次更新都重新运行 `npm run pi:verify`、Chat 测试和类型检查。
