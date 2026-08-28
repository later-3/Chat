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

## 当前开发 Worktree

当前 Workflow 对接尚未合入正式目录，使用 Git worktree 隔离开发：

| 仓库 | 临时开发目录 | 本地开发分支 |
|---|---|---|
| Chat | `/Users/xulater/Code/Chat-pi-web-workflow-adapter` | `codex/pi-web-workflow-adapter` |
| Pi Web | `/Users/xulater/Code/pi-web-chat-frontend-adapter` | `codex/chat-frontend-adapter` |

这些 worktree 只是同一 Git 仓库的额外检出目录，不是新项目、运行时服务或长期架构模块。分支合入后应使用正式目录，并删除不再需要的 worktree。

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

当前开发阶段打开：

```text
/Users/xulater/Code/pi-web-chat-frontend-adapter
```

在 VS Code 中按 `F5`，选择：

```text
Debug Pi Web + Chat Workflow
```

该配置启动 Chat Workflow（`127.0.0.1:43112`）、Pi Web（`127.0.0.1:30145`）和 Chrome 调试器。分支合入正式目录时，必须把调试配置中的临时 worktree 路径同步改为 `../Chat` 和 `../pi-web`。
