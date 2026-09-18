# Workflow TUI 调试

当前TUI只调用普通Workflow。UI来源、提示行、状态栏、Web/NanoClaw关系以[架构合同](../../architecture/chat-workflow-tui.md)为准，完整命令和独立安装见[CLI指南](../../cli.md)。本章验证终端入口到同一Backend的真实执行链。

## 选择启动方式

已有普通开发后端时，在另一交互终端运行：

```bash
pnpm dev:all                 # 终端一：Backend 43112 + Web 30145
pnpm dev:tui                 # 终端二：仅连接 Backend 43112
# 自定义后端端口时显式传递
pnpm dev:tui --url http://127.0.0.1:44112 --project my-project
```

开发TUI只启动客户端；首次按提示登录，先在Web打开业务Project，再通过 `/project` 选择。它使用 `.data/dev/client` 保存登录凭据，服务端数据仍由Backend的 `CHAT_HOME` 决定。`CHAT_SERVER_URL`、`CHAT_CLI_HOME` 可显式覆盖。VS Code任务 `Chat: open development TUI` 等价于 `dev:tui`。

需要不调用真实模型的隔离调试时：

```bash
pnpm debug:start --tui       # 一次启动假模型、Backend、Web，再打开TUI
# 或已有专用调试服务时，仅打开TUI
pnpm debug:tui
```

调试Backend为 `45112`、Web为 `35145`、假模型为 `45401`。TUI不占端口。启动器自动构建 `cli/dist` 和Source Map，最多等待Backend就绪60秒，使用 `.data/debug/backend.env` 的账号登录、通过API登记 `Debug Lab`，最后以 `--project debug-lab` 进入。首次无需先从Web登记项目。Cookie放在 `.data/debug/client`，不读取普通客户端的凭据；运行不依赖NanoClaw。

F5有3种选择：`Debug TUI` 只启动客户端；`Debug Chat TUI` 启动假模型 + Backend + TUI；`Debug Chat Web + TUI` 额外启动Vite与独立Chrome，适合双端同步断点。单独TUI配置需要Backend/模型已运行；启动器不会暗中拉起它们。所有TUI配置使用 `integratedTerminal`，不能放在Debug Console或把stdout接到pipe/tee。

## TUI-01：提交真实Workflow

用 `Debug Chat Web + TUI` 或 `pnpm debug:start --tui` 启动后，确认状态栏为 `debug-lab · minimal-pi-coding-agent · idle · 新会话`。输入 `DEBUG_HELLO`，观察Run进入终态并回复 `DEBUG_OK`；输入 `DEBUG_READ_SKILL`，观察服务端 `read` 调用后返回 `DEBUG_SKILL_LOADED`。确定性假模型只验证文本和Tool工程路径，不代表它能完成规划Workflow。

| 层次 | 断点 | 关键观察值 |
|---|---|---|
| 终端启动/登录 | `cli/src/main.ts`：`main`、`login` | 目标URL、Project参数；不要记录密码/Cookie |
| 命令/提交 | `cli/src/controller.ts`：`submit` | Prompt、projectId、workflow、sessionId |
| HTTP | `cli/src/api.ts`：`json`、`events` | `/runs`响应、runId、NDJSON恢复游标 |
| 输入与显示 | `cli/src/tui.ts`：`ChatTerminalView` | Pi组件与Chat提示/状态适配 |
| Backend入口 | `src/routes/runs.post.ts` | 同一Project、Session、Run关联 |
| Workflow/Pi | [Backend章节](./backend-workflow.md)、[Pi章节](./pi.md) | 实际Step、公共装配、AgentSession和模型请求 |

修改CLI后重启 `Debug TUI` 会重新编译；当前无TUI热更新。Source Map对应 `cli/dist/**/*.js` → `cli/src/*.ts`，VS Code自动附着启动器的Node子进程。运行模型的Pi断点应选Backend/Step调用栈；Pi显示组件断点应选TUI进程。

## TUI-02：Web共享历史与恢复

在调试Web的同一 `debug-lab` Project中选中相同Session ID。`/web`生成的是Backend地址，生产时可直接打开；开发时若要调试Vite前端，将其端口换成 `35145`（普通开发为 `30145`），保留查询参数。确认用户输入、回复和Tool结果一致；Web再发一轮，TUI看到持久历史更新。运行中关闭独立TUI，再用 `/resume` 选择原Session，确认附着原Run而非重复提交。`/history` 显示完整持久消息，`/tree` 只读查看分支。

Web通常在空闲可见页面3秒轮询后更新，TUI每2秒重读；长历史分页和流恢复详见CLI指南。浏览器必须使用调试profile登录，不能靠普通浏览器端口隔离Cookie。`Debug Chat TUI` 本身没有启动Web，验证双端请用包含Web的组合。

## TUI-03：切换与Fork

完成一轮后执行 `/workflow`，选择器内容来自后端；切换只影响下一轮。用 `/fork` 选择User Entry，在该输入前建立新Session，并恢复文字为草稿。检查新旧Session ID不同、Project相同，Web列表能读到两者。原Session正在运行或等待审核时Fork应明确拒绝。规划审核的自动化覆盖使用专门Runtime fixture，不用 `debug-model` 的固定回复代替真实审核成功证据。

## 退出和故障

独立 `dev:tui` / `debug:tui` 的 `/quit` 只断开客户端，显式 `/cancel` 才取消Run。`debug:start --tui` 的 `/quit` 会结束本次整套调试栈；F5 compound的Stop也会收回关联服务，可能中断任务。`pnpm debug:stop -- tui` 只停止有归属记录的TUI；若它属于CLI整套栈，父启动器也会随之收尾。详情见[停止说明](./stopping.md)。

`/help 查看命令` 留在提示行是当前界面行为。连接失败先核对后端端口；401核对调试Backend与 `backend.env` 的账号是否一致并重启；没有TTY时改用交互终端；断点灰色时检查当前子进程和新生成的CLI Source Map。服务输出保留在 `.data/debug/logs`，全屏TUI运行期间不会混入服务日志；TUI日志仅记录进程生命周期，不录制ANSI画面或对话。HTTP、Session和Run问题继续按[故障定位](./troubleshooting.md)追踪。
