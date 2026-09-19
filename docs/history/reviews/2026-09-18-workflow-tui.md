# Workflow TUI 接入审核

## 场景与决定

用户需要一个可安装命令直接使用 Pi 终端交互组件，选择 Chat Workflow、恢复和 Fork Session、查看完整历史，并与 Web 接续。范围为普通 Workflow；NanoClaw / Long Agent 不进入本轮。

按[贡献流程](../../development/agent-contribution.md)、[模块合同](../../architecture/chat-module-contracts.md)、[Session 架构](../../modules/sessions/chat-session-architecture.md)和[Workflow 框架](../../modules/workflows/chat-workflow-framework.md)，终端定义为 Backend 的 HTTP 消费者。运行事实仍由 Workflow Runtime 与 Pi SessionManager 拥有，模型、配置、资源和装配继续复用服务端入口。实现不修改 Pi 或 NanoClaw，不复制 Agent Loop。

Pi `InteractiveMode` 绑定本地 AgentSession；直接实例化会引入第二条本地执行链。采用公开 Editor、消息、工具、选择器和布局组件，通过窄控制器消费已有 Run API。native edit 预览具有本地文件读取副作用，因此远程模式不触发该预览，保留服务端结果渲染。独立包固定 Pi 0.85.1，需额外验证 Registry 包与仓库源码一致的公共能力。

## 合同与失效边界

- 新增 v1 transcript 只读投影与 fork 写入合同，客户端运行时校验；Project、Session 与父会话身份必须一致。完整历史分页独立于模型压缩上下文。
- Fork 在请求锁与源 Session 操作锁内创建，临时文件 flush 后保存最小身份回执并排他发布；已准备的失败保留文件供恢复，发布后清理准备目录，源 JSONL 不修改。同一 requestId 可重试，参数冲突拒绝；父 Session 仍须可读。子会话已移除或永久删除时旧请求拒绝，不能复活历史。
- 后端通用活跃 Run 投影支持 Web/TUI 恢复；轮询只是失效恢复机制，状态仍查询 Runtime。提交断线不自动重发 Prompt。客户端退出不取消 Run。
- Web 的 Fork 与新恢复字段使用结构解析；空闲页面同步保留草稿，浏览历史暂停替换。新 Run 与 Fork 共用已有操作锁，补齐接受到 Step 启动之间的重叠请求防护，保留旧审核错误合同。
- 首版只提交文字；历史图片按终端能力显示，Fork 只恢复文字草稿。不宣称 Pi 的本地模型/扩展命令已接入。
- Project 选择核对 `src/projects/request.ts` 与 Registry 的当前实现：未指定时使用最近打开的可用普通用户 Project，显式绑定不可用时失败。未沿用部分旧文档中共享 `daily` 的默认描述，也不修改 Long Agent 的项目迁移机制。

## 验证

2026-09-18 验证结果：

| 门禁 | 结果 |
|---|---|
| `pnpm verify` | 退出 0；工具 23、Backend 295、Frontend 130、built 29、dev 1，共 478 项通过；类型检查、Frontend/Nitro/CLI 构建通过 |
| Workflow 装载链 | Builder 单层转换、开发 Step 产物装载、生产真实 Run、Nitro dev 的 Frontend Run 合同均通过 |
| CLI 与 Fork 专项 | 中文终端、选择器、缩放、只读渲染、认证、丢失接受响应、完整历史、Fork 中断恢复/删除后重试均通过；登录记录损坏后的 logout 另补 5 项 CLI 回归通过 |
| 独立安装 | tarball 在仓库外临时目录从 npm Registry 安装 Pi 0.85.1；bin、原生 UI 和真实 PTY 的启动/Workflow 选择/帮助/退出通过 |
| 安装包 Runtime | 通过 `CHAT_TEST_CLI_PACKAGE` 使用安装后的控制器，再跑 built 服务的 Web/TUI 接续、审核、Fork 和取消，1 项通过 |
| 文档与差异 | 架构导航 22 入口/332 本地链接通过；父仓库与 Frontend `git diff --check` 通过 |

所有 Runtime 测试使用临时 CHAT_HOME、Project 和本地假模型，未访问真实模型账号。代码与分发包已备妥，未在真实 Linux 部署验收；本轮不提交、不推送、不发布 npm，也不部署未指定的生产实例。Frontend 子模块与父仓库代码必须一起发布，安装 CLI 不能替代后端升级。经验归档见[远程渲染边界](../../development/experiences/remote-tui-renderer-boundary.md)。

## 启动脚本与调试配置补充验收

场景：开发者从脚本或F5进入TUI，在同一Debug Lab中验证Workflow与Web共享历史，并能独立关闭客户端或结束整套调试栈。沿用原有 `debug-launch` 角色归属、环境白名单、端口保护和 `debug-stop`，增加无监听端口的TUI角色，不新增常驻运行时。普通 `dev:tui` 仅连接已有开发Backend；专用调试自动编译CLI、登录和通过Project API登记练习项目。配置和操作见[TUI调试](../../development/debugging/workflow-tui.md)。

2026-09-18补充验证：

| 门禁 | 结果 |
|---|---|
| 完整 `pnpm verify` | 退出0；工具27、Backend 295、Frontend 130、built 29、dev 1，共482项通过；类型检查与三项构建通过 |
| 脚本/配置 | 开发参数与cwd、客户端凭据隔离、F5任务与组合引用、非TTY拒绝、后台stdin隔离及进程回收通过 |
| 真实PTY与真实服务 | 临时checkout内运行 `debug:start --tui`，自动登录/登记项目；输入 `DEBUG_HELLO` 与 `DEBUG_READ_SKILL`，分别完成并得到 `DEBUG_OK` / `DEBUG_SKILL_LOADED` |
| Web互通 | 经Vite `35145` 的Session API读到TUI创建的同一Project/Session与 `DEBUG_OK` 历史 |
| 停止边界 | 整套TUI `/quit` 后服务端口空闲；另起独立TUI，`debug-stop tui` 后Backend与Vite仍健康，最后回收全部测试进程 |
| 源码断点 | Node Inspector命中实际TUI `WorkflowTerminal.submit`，CLI Source Map正确映射 `cli/src/controller.ts`；未进行VS Code GUI点击验收 |

真实终端发现并修复了后台Vite与TUI竞争stdin的问题，加入真实子进程回归并归档为[终端输入归属经验](../../development/experiences/terminal-stdin-ownership.md)。假模型仅验证工程链路，没有接入真实渠道或改变NanoClaw模式；测试目录、Cookie和运行数据全部隔离。
