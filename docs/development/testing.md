# Chat 测试说明

本文说明 Chat 父仓库的测试层级、常用命令和新增回归测试的原则。Frontend、Pi与NanoClaw是独立Submodule；修改它们时还要遵守各自仓库的测试要求。

## 测试层级

Chat 的测试从快到慢分为四层：

1. **针对性测试**：验证一个模块或一次修复，适合开发中的快速反馈。
2. **父仓库测试与类型检查**：验证 Backend、Frontend 合同和 TypeScript 类型。
3. **生产构建与构建产物测试**：验证 Frontend 与 Nitro 能构建，并检查生产服务的 HTTP、资源、Session、Workflow 和 Pi 装配链。
4. **Nitro 开发链测试**：启动真实开发服务，验证开发环境生成的 Step bundle、Workflow Runtime、Frontend Run 合同和本地假模型能够走到完成状态。

相邻层级通过不能代替用户实际经过的链路。尤其是 Workflow 在普通 Node 测试中通过，不代表 Nitro 开发 Step bundle 或生产构建一定可用。

## 常用命令

在父仓库根目录运行：

```bash
# 单个 Backend node:test 文件
node --import ./scripts/typescript-test-loader.mjs \
  --experimental-strip-types --test test/example.test.mjs

# 架构导航、Skill单一来源与开发启动/关闭脚本
pnpm check:architecture
pnpm test:tooling

# 全部 Backend 测试
pnpm test:backend

# 全部 Frontend 测试
pnpm test:frontend

# 父仓库与 Frontend 类型检查
pnpm typecheck

# Frontend、Nitro 与独立 CLI 生产构建
pnpm build

# 测试已经生成的 .output 生产服务
pnpm test:built

# 测试 Nitro 开发服务和真实 Workflow 开发链
pnpm test:dev

# 完整验证链
pnpm verify
```

`pnpm test:built` 依赖 `pnpm build` 生成的 `.output`，不要把旧构建产物的通过结果当成当前源码的验证结果。

Workflow TUI 的认证、NDJSON、原生终端输入/显示、缩放与响应校验位于 `test/workflow-tui.test.mjs`，Fork 与压缩前历史边界位于 `test/session-fork.test.mjs`。`scripts/workflow-tui-runtime-fixture.mjs` 使用编译后的客户端，在 built/dev 两种真实服务上验证 Web/TUI 双向历史、审核恢复、Fork 隔离与取消；仅使用隔离 CHAT_HOME 和本地假模型。`pnpm test:dev` 会先构建 CLI。发布前还需 `pnpm pack:cli` 并在仓库外临时目录安装 tarball，确认 bin 和 Pi Registry 依赖可用。

TUI启动/调试变更还须运行 `pnpm test:tooling`：覆盖开发入口参数转发、客户端环境隔离、F5任务/组合引用、Source Map选项、Backend就绪/Project登记、非TTY拒绝和既有进程停止边界。实际PTY启动、输入到Run完成及退出清理应使用临时checkout/隔离数据与本地假模型；CLI Source Map通过不等于VS Code GUI断点已命中，二者分别记录证据。

Frontend 单个测试可在需要时直接运行：

```bash
node --experimental-strip-types --test frontend/lib/example.test.mjs
```

## 什么改动跑什么

| 改动 | 开发中至少运行 | 完成前运行 |
|---|---|---|
| 纯文档/架构Skill | 链接与示例检查；Skill变更做有界只读场景问答 | `pnpm check:architecture`、`git diff --check` |
| 开发启动、正常/调试关闭与VSCode配置 | `pnpm test:tooling`；核对VSCode配置 | 隔离Chat Home的真实启动/停止冒烟；关闭测试只用临时服务，不试停生产；源码映射与断点需单独验证 |
| 单个 Backend 模块 | 对应的单文件测试 | `pnpm test:backend`、`pnpm typecheck` |
| Backend API 或持久化合同 | 相关模块与 API 测试 | `pnpm verify` |
| Frontend 逻辑或 Backend/Frontend 合同 | 对应 Frontend 测试 | `pnpm test:frontend`、`pnpm typecheck`；完成前通常运行 `pnpm verify` |
| 构建、路由、静态资源或生产启动 | 相关测试 | `pnpm build`、`pnpm test:built` |
| `src/workflows/**`、Workflow SDK、Builder Patch、Agent 装配或 Workflow 可达资源 | 对应单元/合同测试 | `pnpm verify`，并确认 `pnpm test:dev` 实际覆盖目标启动链 |
| `frontend/` 或 `pi/` 的 gitlink | 子仓库自身验证 | 父仓库 `pnpm verify` |
| `nanoclaw/` 源码或 gitlink | 源码改动运行NanoClaw自身测试/构建及受影响桥接合同；更新gitlink时确认Commit已存在于公开Fork的`chat`分支 | 父仓库Submodule与差异检查；涉及Chat桥接运行的改动运行父仓库`pnpm verify`并验证两侧合同 |

完成代码修改后还应运行：

```bash
git diff --check
git -C frontend diff --check
```

测试通过只说明已覆盖的行为通过。提交前仍要检查架构、配置、Frontend 合同和生产装配路径是否与改动一致。

## 测试隔离

测试不得读写用户真实的 `~/.chat` 或正式 Project 数据。

- 为每次测试创建临时根目录，并通过绝对路径 `CHAT_HOME` 指向其中的 Chat Home。
- Project 应在临时目录中创建自己的 `.chat/project.json` 和所需 Fixture。
- Session、Memory、Prompt 资源、模型配置和 Workflow 数据都应留在该临时目录。
- 测试结束后关闭 Server、文件句柄和监听端口，并清理测试创建的数据。
- 不依赖开发者当前工作目录中碰巧存在的配置、模型或凭据。

涉及文件访问时，应同时测试允许路径、越界路径、符号链接或规范化后的真实路径；不能只验证正常输入。

## 模型与外部服务

自动化测试必须可重复、可离线控制，并且不能产生真实费用或外部副作用。

- 不读取或写入正式 Provider 密钥、Credential、Cookie 或 Token。
- 不调用付费模型，也不把真实模型可用性作为测试前提。
- 需要验证 Agent 或 Workflow 时，在测试进程内启动本地假模型服务，返回确定性的流式响应和固定 Token 用量。
- 需要 Embedding 或其他外部协议时，使用本地受控服务模拟实际 HTTP 合同。
- 假模型应只模拟测试需要的协议和分支；不要在测试中复制完整 Provider 实现。
- CI 不执行外部写操作，也不依赖实时模型目录刷新。

### 多阶段假模型的分流与收尾

一个 Workflow 的最后一个节点可能是**会话记忆写入**（`remember`），它的请求带着**和上一阶段相同的对话历史**。假模型如果按“历史里出现过某个标记”分流，就会把 writer 当成工作请求，让它在只为工作 Agent 准备的一次性闸门上永久等待——HTTP 悬空、Run 不结算，而失败点离真正原因很远。

- 按**当前 Workflow / Stage / Agent**分流（例如 system prompt 属于哪个 Agent），不要按历史消息、工具结果或任意位置的标记分流。
- 每个阶段都要有**有限且正确**的响应：该阶段需要的工具调用先给一次，收到工具结果后必须收尾；不能靠“跳过该阶段”取得绿色。
- 一次性闸门（取消、放行）只作用于**目标工作请求**，并按测试预期只触发一次；跨阶段的请求不得共享同一个闸门。
- 处理函数抛出异常时必须**结束请求**（如返回 500 与错误说明），不能留下悬空响应；否则测试会在超时处失败并掩盖真实原因。
- 共享的分流与写响应助手放在 `scripts/fake-model-stages.mjs`，避免每个夹具各写一份。
- 回归：`test/workflows/session-memory-tail.test.mjs` 覆盖阶段归属、失败记录与开关；`scripts/dev-server.test.mjs` 与 `scripts/built-server.test.mjs` 覆盖审核多轮、格式修正与取消后 writer 仍能运行。
- 用户开关必须有**真实浏览器**验收：关闭后发送、重新开启后发送、关闭并刷新后首次发送，逐一核对实际请求参数、HTTP 接受成功、本轮耐久终态与 writer 是否执行；关闭时应正常完成工作，不能把 HTTP 400 后 writer 未运行当作通过。连续发送必须在同一页面、同一会话执行，仅刷新场景主动 reload；记忆失败通知必须通过公共会话读取返回**并在刷新后可见**（`scripts/session-memory-switch-browser.test.mjs`）。

### 独立真实模型验收

上述限制针对默认自动化门禁；真实模型验收是用户授权后单独运行的补充，不能用假模型通过声称真实模型已经可用。Agent 装配、工具调用、压缩及每日总结变更应明确记录真实模型是否验收；有条件且已授权时完成验收，再报告范围。真实渠道发送需要另外的明确授权。

Friend 生命周期可使用 `scripts/long-agent-live-smoke.mjs`：

```bash
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types \
  scripts/long-agent-live-smoke.mjs --allow-paid-model \
  --source-home /absolute/path/to/authorized-chat-home \
  --provider your-provider --model your-model
```

该脚本不会被 `pnpm verify` 或 CI 自动执行。它只读取指定 Provider 的模型配置与认证，在临时 Chat Home 中调用真实模型；使用生产消息/日历路由处理器、公共 Pi 装配、真实文件工具和原生压缩。Nano 身份是测试数据，只有日期使用可控时钟，不发送外部渠道消息。检查 A/B 项目规则和写入隔离、请求重放、压缩后继续、跨日总结与新日交接。临时会话、项目和认证运行后删除，仅保留合成场景的 `report.json`；报告明确列出模型、范围、检查结果、耗时和可取得的用量。此验收不替代真实浏览器或 Telegram 全链路测试。

## 新增回归测试

优先测试用户可观察的场景和模块合同，而不是私有函数的实现细节。一个有效的回归测试通常包含：

1. 构造最小但真实的输入、Project 和 Chat Home。
2. 经过生产代码使用的公开入口或同一装配路径。
3. 断言结果、持久化状态和必要的错误边界。
4. 覆盖导致事故的条件，并证明旧问题不会静默复发。
5. 保持输出确定，不依赖时间竞态、网络状态或正式数据。

新增 API 时，应覆盖有效请求、无效结构、Project 边界、失败状态和不会泄露敏感字段的响应。新增持久化行为时，应覆盖中断、重复执行、冲突或恢复语义中与该功能有关的部分。

开发故障如果形成可复用结论，还应在 `docs/development/experiences/` 记录事故背景、原因和门禁；对应自动化测试是结论的一部分，不能只补文档。

## 调试专用入口

`pnpm test:debug`检查VS Code引用、专用端口/缓存、环境过滤、符号链接拒绝、私有配置保留和本地假模型；已并入`pnpm test:tooling`。启动`Debug Chat`后，`pnpm debug:smoke`通过Vite代理验证真实文本/Tool Run与Session重读。该冒烟会写调试Home，不会访问正式模型/渠道。Source Map实际断点与真实Telegram/微信收发需单独验收，见[调试说明书](./debugging/README.md)。

`pnpm verify`会重写`.output`和`frontend/dist`；正常实例使用这些产物时，先在独立checkout应用本次改动并安装依赖，再运行验证。

## 完整验证

`pnpm verify` 是父仓库完成代码改动后的统一验证入口，当前顺序为：

```text
架构入口与开发启动工具检查
→ Backend 与 Frontend 测试
→ TypeScript 类型检查
→ Frontend 与 Nitro 生产构建
→ 构建产物服务测试
→ Nitro 开发链测试
```

CI 的职责、环境版本和 Submodule 边界见 [Chat CI](./ci.md)。

`pnpm verify`不包含NanoClaw自身测试或所有真实Docker/浏览器路径。Long Agent后续设计必须按[实施前约束与验证](../modules/long-agents/chat-long-agent-engineering-baseline.md)明确各入口的门禁，不能用父仓库通过代替子仓库与桥接验证。新增目标场景的测试计划不等于现有命令已覆盖。

## Agent入口的低成本验证

修改架构导航时，用没有前文的Agent读取入口和最多3–4份相关文档，只回答方案，不实施需求。题目至少覆盖新资源如何生效、跨模块合同变化、并发/失败恢复之一。核对它能否区分当前与目标、指出拥有者和实际入口、选择正确门禁、记录未验证项。错误回答先修概念或导航，再复测；不靠增加泛化禁令弥补。结构检查和问答不能证明生产Agent已装配Skill，也不能代替实现验收。审核证据放入`docs/history/reviews/`。

## 安装与服务控制回归

`pnpm test:tooling` 同时运行 `scripts/chat-start.test.mjs`：服务归属/端口/产物/配置预检、Backend→Nano 顺序、重复启动不换 PID、只回收新启动服务、控制锁和 Linux chatctl 参数转发。在 macOS 创建临时双 LaunchAgent，真实启动/健康及网页资源检查/再次启动/停止，另验证“健康 200、首页 500/重定向/资源缺失/资源返回 HTML”必须失败；Linux 同样验证调用公共 Web 检查。Nano HTTP 为带认证的隔离替身；不启动用户正式服务，也不把它视为真实渠道验收。

`pnpm test:tooling` 包含 `scripts/chatctl.test.mjs`：在临时目录替换系统服务适配边界，执行实际 shell 安装/启停控制逻辑，检查安装不启动、重复 start、逆序停止、模块选择和失败回收；Node 测试通过本地 HTTP 验证 Nano 认证和实例 ID，环境准备验证已有私有值保留与冲突拒绝。不会对宿主执行 sudo、systemctl 或包管理安装。

这些测试不替代空白 Linux/WSL 的包下载、systemd 真机验收。装机验收需另记录平台版本、四个仓库 Commit、安装/两次启停、认证健康、数据保留与模型/渠道的真实使用范围。

## 公共装配 P1 原生接缝门禁

`test/agents/pi-assembly-seams.test.mjs` 已纳入 Backend 测试自动发现，使用隔离目录、本地 HTTP 假模型、真实 Pi 和文件工具，覆盖同 Session 跨目录重装配、元数据/上下文投影、原生压缩恢复、规则快照更新及无伪用户消息的内部维护轮次。它证明底层可行性，不代表 Chat 公共工厂、路由或渠道已经实现 P2–P5。

```bash
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types --test test/agents/pi-assembly-seams.test.mjs test/workflows/agent-context-files.test.mjs
```

P1 只修改合同与实验测试，无产品执行代码变更；运行上述门禁、Backend 回归和架构导航检查。产品装配从 P2 改动起仍须完整 verify 与开发 Step/生产链证据。

## 公共 Agent 装配回归

`test/agents/public-assembly.test.mjs` 通过生产公共工厂和本地 HTTP 假模型覆盖同 Session 的 A/B/null、实际原生工具写入、规则/Skill 冻结与恢复、路径边界、模型预算失败、Memory 目标和跨项目父子 Session。`test/long-agents/long-agents.test.mjs` 另以真实检查/消息 HTTP 路由比较最终 System Prompt，防止预览另用一套 Resolver。

这些是 Chat 实现门禁；`pi-assembly-seams.test.mjs` 只证明原生接缝。公共装配变更还必须通过 verify 中的 Builder、开发 Step bundle、生产 Runtime 和 test:dev，不用公共工厂单测替代。已运行服务使用 `.output` 时，应在隔离源码副本完成 build/verify，避免改写运行中的产物。P2 完整证据见 [阶段记录](../history/reviews/2026-09-19-agent-unification-p2.md)。

普通 Workflow 还必须覆盖“用户项目嵌套在另一个仓库下、没有 AGENTS/README”的场景：模型请求父级 README 时得到明确越界错误，使用当前项目名称与用途，不把父级仓库当作当前项目。`public-assembly.test.mjs` 覆盖父级/相邻项目/符号链接、六种原生文件工具、检查入口与重试身份冻结；Friend A/B 通过不能代替这条普通 Workflow 回归。事故机制见[嵌套项目身份与文件边界](./experiences/nested-project-identity.md)。

## Friend P3 生命周期门禁

`test/long-agents/daily-lifecycle.test.mjs` 使用真实 Pi、本地流式假模型与只替换 Date 的可控时钟，覆盖接受冻结、唯一日期、旧链接、重启队列/未知副作用、跨日总结、原子写入故障和原生压缩后工具操作。其中独立 Node 进程恢复验证无内存 Loader 的持久请求。`long-agents.test.mjs` 覆盖实际 Web/Nano 并发、原生 HTTP 入口、渠道投递失败次日只重投、可信私聊边界及已支持调度。Frontend 的 `friend-daily-browser.test.mjs` 验证状态/操作响应；浏览器矩阵与完整门禁结果记录于 [P3 自检](../history/reviews/2026-09-19-agent-unification-p3.md)。模拟 Nano 不等于真实 Telegram 验收。


### P4 公共实时聊天回归

`test/long-agents/turn-feedback.test.mjs` 通过 HTTP 接受、原生 Pi 和可控模型验证 202 与执行解耦、真实增量、256 事件窗口 reset、去重/冲突/归属、取消后后续消息、同项目原生引导、跨项目拒绝、模型错误与图片能力。`frontend/lib/friend-execution.test.mjs` 验证相同消费器的断序补读、重复忽略、未知版本/错误身份拒绝、无响应超时、观察终止和终态。P3 生命周期用例继续覆盖重启、跨日和原生压缩恢复。

真实浏览器必须对照普通 Session 与 Friend：首 Token/工具/完成、刷新与断网不重发、取消、引导、切项目后的后续消息、明暗主题与长内容滚动。假模型边界测试和真实供应商测试分别记录，不能互相冒充。用户现有服务运行时，在隔离源码副本执行 `pnpm verify`，禁止覆盖其正在使用的 `.output`。本次证据见[P4 审计](../history/reviews/2026-09-19-agent-unification-p4.md)。


## LA0 原生独立会话接缝

`test/long-agents/la0-session-seams.test.mjs` 使用公共工厂、本地 HTTP 假模型与真实 Pi 持久化，验证同身份独立 Session 并发、原生工具/压缩后的公开 Entry 引用、旧写入器风险、同锁重开及丢回执去重。已知风险用例是可行性基线，不是生产修复验收；LA1 必须增加真实入口回归并替换对应风险断言。LA0 没有新增群/任务 UI，不能报告真实浏览器群聊通过。阶段边界与证据见[LA0 审计](../history/reviews/2026-09-20-long-agent-la0.md)。
