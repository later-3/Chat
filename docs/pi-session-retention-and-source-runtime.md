# Chat 托管 pi Session 与源码运行时设计

状态：**已实现并完成本地三方解析验证**  
批准日期：2026-07-28  
范围：持续协作 Workflow 调用 pi 的执行层留痕、pi-web 查看边界、本地源码构建与调试。

## 1. 要解决的问题

Chat 当前用一次性 pi RPC 子进程执行任务，但启动参数使用 `--no-session`。因此 Chat 能保存
Product Run、ToolExecution、审批和 Trace，却不能在 pi-web 中复核“pi 实际收到什么、产生了
哪些消息和 Tool 事件”。同时，Chat 默认调用全局安装包，不利于进入 pi 源码断点调试和后续维护
项目自己的 pi 分支。

本设计增加一份**执行层转录证据**，不改变权威状态和恢复边界。

## 2. 对象边界

| 对象 | 所有者 | 本次是否改变 | 作用 |
|---|---|---:|---|
| Product Session / Product Run | Chat Product Store | 否 | 对话、工作和结果的权威事实 |
| MAF AgentSession / Workflow Checkpoint | MAF | 否 | Agent 上下文与 Workflow interrupt/resume |
| ToolExecution | Chat Execution Dispatch | 增加映射 | 一次 pi 执行的权威账本 |
| pi Runtime Session | pi SessionManager | 新增持久化 | 保存本次 pi 子进程的原始 JSONL 转录，供复核 |

pi Runtime Session 不是 Product Session、不是 MAF Checkpoint，也不是下一轮 Chat 的默认上下文。
即使 ID 能互相映射，也不能合并职责。

## 3. 已批准合同

1. 每个 `ToolExecution` 启动一个全新的 pi Runtime Session，ID 为 `chat-<tool_execution_id>`。
2. 文件保存在专属目录 `~/.pi/agent/chat-sessions/`；目录与普通 pi Session 分开。
3. Chat 启动 pi 时显式传入新的 Session 文件，不加载历史 pi Session。
4. Session 名称包含“Chat 托管”、Product Session、Product Run 和 ToolExecution 的短标识。
5. pi 子进程结束后文件改为只读，并在 ToolExecution `metrics.pi_session` 中保存稳定映射、字节数和
   SHA-256；不把宿主机绝对路径暴露给浏览器。
6. pi-web 同时读取普通目录和 Chat 专属目录；Chat Session 显示来源与只读标识。
7. pi-web 允许查看上下文和导出，但服务端拒绝发送消息、重命名、删除和自动命名。
8. 本期不做 Fork，不从 pi-web 继续 Chat 托管 Session，也不把旧 pi Session 注入下一次 Chat 执行。
9. Chat 可固定到本地 pi 源码构建产物；Node 启用 source map，可选 `--inspect` / `--inspect-brk`。
10. 调试端口开启时只允许一个活动 pi 子进程，避免多个执行竞争同一端口。

### 3.1 本地单一分发与Fork拓扑

2026-07-28进一步完成“全局一份pi”的本地开发形态：唯一源码与编译真源是
`/Users/xulater/Code/opc-os/pi`，终端`pi`、Chat的`cli_path`和pi-web的4个pi SDK包都解析到
该源码树。这里只共享代码身份，不共享活动进程、配置、Session和权限。

| 消费者 | 共享方式 | 继续隔离的内容 |
|---|---|---|
| 终端pi | `~/.local/bin/pi`链接源码`dist/cli.js` | 个人配置、个人Session与交互权限 |
| Chat | 私有配置固定同一`dist/cli.js` | 临时Agent目录、Provider Gate、Tool Gate和Chat托管Session |
| pi-web | 4个`@earendil-works/pi-*`包链接同一源码工作区 | Next.js进程、个人AgentSession和Web状态 |

可重复配置入口是`scripts/configure-local-pi-stack.sh link`；`restore`会恢复原全局npm安装和
pi-web原npm包。脚本先构建、核对4个包版本与Chat私有路径，再切换链接；失败时恢复本次已切换项。
重新执行pi-web的`npm install`后需要再次运行`link`，但`package.json`和lockfile继续固定正式版本，
不写入本机绝对`file:`依赖。

两个源码仓库采用相同远端与分支角色：`origin`分别指向`later-3/pi`和`later-3/pi-web`，
`upstream`分别指向官方仓库；本地`main`跟踪Fork的`origin/main`，两者只做`upstream/main`的官方
主线镜像，避免普通`git push`误指向官方仓库。Later改动统一保存在`codex/later-custom`并跟踪
`origin/codex/later-custom`。2026-07-28已完成一次无
强推收敛：pi的`main`和Fork `main`位于`fdbedcad`，自定义分支头为`10e99ae`，当前Later提交只增加
双窗口VS Code调试配置而没有修改`packages/**`运行时代码；pi-web的`main`和Fork `main`位于
`894babf`，3个Later提交重放在该基线之上，自定义分支头为`a5c6d71`。
以后同步顺序固定为`fetch upstream -> 将本地main快进到upstream/main -> 快进origin/main -> rebase
codex/later-custom onto upstream/main -> 检查并推送自定义分支`；发生非快进时停止核对，不使用
force push覆盖Fork历史。两个仓库的`remote.pushDefault`也固定为`origin`。

## 4. 为什么这样选

- **保留原始执行证据**：Product Trace 解释 Chat 的路由和治理决策；pi JSONL 回答执行层到底收到、
  发送了什么。两者用途不同，互相不能替代。
- **不自动续聊**：事实已经回写 Chat；继续旧 pi Session 会绕过当前 RunSpec、Context Package、
  ModelCallDraft 和 Tool 审批版本，形成第二事实源。
- **终态只读**：Chat 托管 Session 是证据，不是 pi-web 的普通工作区。只隐藏输入框不够，必须在
  pi-web API 再做服务端拒绝。
- **专属目录**：无需改 pi 的 Session 文件格式，pi-web 又能明确分类，不把 Chat 执行混进个人 pi
  Session 列表。
- **源码构建而非复制 pi**：先由配置固定本地源码产物，Chat 不复制 pi 内部代码；后续修改 pi 时仍可
  单独构建、测试和回退。

## 5. 参考证据与取舍

### MAF 1.11.0 / AG-UI 1.0.0rc8

MAF AgentSession 和 Workflow Checkpoint 管理 MAF 运行语义，不负责外部 pi 子进程的 JSONL
Session。本项目只增加映射，不把 pi Session 冒充 MAF 恢复能力。

### pi 源码

本地源码的 `SessionManager` 使用版本 3 的 append-only JSONL 树；CLI 原生支持 `--session`、
`--session-dir` 和 `--name`。采用这些原生合同，不发明 Chat 私有 Session 格式。源码构建启用
source map，因此 Node 调试器可映射回 TypeScript。

### nanobot 与 QwenPaw

两者都体现了产品会话、运行实例和外部执行身份应分开管理；没有提供可直接替代 pi JSONL 的
合同。本设计只采用“独立身份与映射”原则，不复制它们的目录或恢复实现。

## 6. 失败与恢复语义

| 时点 | pi Session 结果 | Chat 结果 |
|---|---|---|
| 创建 Session 文件失败 | 不启动 pi | ToolExecution 失败并记录稳定错误码 |
| pi 启动失败 | 保留最小 Session 文件并冻结 | ToolExecution 失败 |
| Provider / Tool 审批拒绝 | 保留截至拒绝时的转录并冻结 | 按现有治理语义失败或放弃 |
| pi 成功 | 保存完整转录、哈希并冻结 | 结果照常进入 Evidence / Artifact / Trace |
| 进程或 Worker 崩溃 | 文件可能不是终态只读 | 只作为部分证据；不宣称可恢复活动执行 |

本期仍不保证跨进程恢复活动 pi、Tool 副作用恢复或从 pi Runtime Session 续跑。这些能力必须走
Session 总体规划和 Worker/Checkpoint 设计，不能由“文件存在”外推。

## 7. 验收条件

1. 两次 Chat 执行产生两个不同的 `chat-*` Session，第二次不含第一次上下文。
2. ToolExecution 可通过 `metrics.pi_session.id` 关联对应文件，终态包含哈希与只读状态。
3. pi-web 可查看和导出 Chat Session，但相关写 API 返回 `403`。
4. Chat 运行时健康投影能区分 `source_build` 与 `installed_package`，不泄露源码绝对路径。
5. 本地 pi 源码构建通过；pi仓库自己的VS Code窗口能附加到Chat派生子进程的Node调试端口，并命中
   本仓TypeScript Source Map断点，Chat窗口不跨仓接管pi源码调试。
