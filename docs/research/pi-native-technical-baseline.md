# Chat pi原生技术基线研究

> 日期：2026-08-05
> 研究计划：RP-01
> 当前批次：`pi + pi-web`完整掌握收口
> 状态：RP-01.0/1.1已纳入完整掌握成果；AI工作区、Later课程、运行证据和双链抽查已完成，待用户审核
> 边界：本文记录Chat侧源码证据、实验、迁移预言机和差距，不批准目标依赖、目录、Schema、迁移或产品代码重建。

## 0. 当前完整掌握入口

2026-08-05用户要求不再以RP-01.2—1.6逐卡停顿，而是先将`pi + pi-web`一次性吃透。因此本文继续拥有Chat侧迁移预言机和架构缺口；可跨项目复用的当前完整源码知识、课程和运行证据统一维护在：

`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/pi-agent/README.md`

其中已分开锁定pi `10e99ae`/0.82.1与pi-web `82cb76a`/0.8.6/Pi SDK 0.83.0，不用一条版本线静默为另一条背书。

## 1. RP-01.0已批准结论

RP-01.0已经形成可供后续研究引用的基线，但发现1项必须显式处理的版本漂移：

1. 全局`pi`仍直接指向本地pi仓库`10e99ae`的0.82.1构建；Later对pi的唯一增量只是VS Code构建/Attach配置，没有修改`packages/**`运行时代码。
2. 当前Chat源码通过Python启动`pi-coding-agent --mode rpc`，并在外部保留Provider、Tool、Product Run和Evidence治理；它不是直接嵌入`pi-agent-core`的目标形态。
3. `pi-web`是独立的Next.js/React全栈应用，在Next.js服务进程内直接创建`AgentSession`，不是浏览器直接运行pi。
4. `pi-web`当前实际加载npm安装的Pi SDK 0.83.0，没有链接本地0.82.1源码。`scripts/configure-local-pi-stack.sh`描述的“三端单一分发”已经漂移，且其版本相等前置条件当前不成立。
5. `pi-web`的Later分支相对上游不是小补丁：当前有36个Later提交、177个文件差异和约19,887行新增。它可以提供Web/移动交互和Agent连接证据，但不能被当成未经改造的上游前端底座。
6. 6条迁移行为预言机的代表测试已在当前Chat工作树重新运行并全部通过。

因此，本批可以冻结“研究对象和迁移验收标准”，但不能在这里提前冻结Next.js/Vite、HTTP框架或Workflow实现。

## 2. 证据规则

本文把证据分成4层：

| 标签 | 含义 |
|---|---|
| `PI-SOURCE` | 固定pi提交的源码、Package manifest与构建产物 |
| `PI-WEB-SOURCE` | 固定pi-web提交的源码、Package manifest与本地服务实况 |
| `CHAT-SOURCE` | 当前Chat源码、测试和现有产品状态 |
| `INFERENCE` | 从前3类证据推导出的Chat研究结论；不是框架保证 |

README、Stars和包描述只能帮助定位，不能独立证明恢复、权限、审批或产品完成语义。

## 3. 固定版本与运行入口

### 3.1 版本表

| 对象 | 固定事实 | 工作树/运行事实 | 本批用途 |
|---|---|---|---|
| Chat | `main@3f49c0a0835a6d7f59f373a0ef392fdc2c37368c` | 工作树非clean，包含用户既有代码/文档改动和当前RP-01文档；`18030`与`15073`本批未运行 | 现有产品语义与迁移预言机 |
| pi源码 | `codex/later-custom@10e99ae9914cd34f622633fac42f9a90714e9cf4` | clean；相对`upstream/main@fdbedcad`仅领先1个提交 | 目标Agent Runtime源码基线 |
| pi Packages | 0.82.1 | `pi-ai`、`pi-agent-core`、`pi-storage-sqlite-node`、`pi-coding-agent`、`pi-server`、`pi-tui`均为0.82.1 | RP-01.1—1.3的同版本源码链 |
| 全局pi | `/Users/xulater/.local/bin/pi` | 符号链接到本地`packages/coding-agent/dist/cli.js`；`pi --version`为0.82.1 | 证明终端入口与本地源码构建同源 |
| pi-web | `codex/later-custom@82cb76a36b379a050e93ee7d726f2cf591e5f942` | clean；相对`upstream/main@dfab585`领先36个提交；本地分支比`origin/codex/later-custom`领先1个未推送提交 | Web连接与交互参考 |
| pi-web应用 | `@agegr/pi-web@0.8.6` | Next.js 16.2.12、React 19.2.4；`30141/api/health`返回200 | 当前可运行Web参考 |
| pi-web中的Pi SDK | 0.83.0 | 4个`@earendil-works/pi-*`均为普通`node_modules`目录，不是指向本地pi的符号链接；导入烟测通过 | 只能证明0.83.0 SDK与当前pi-web行为 |
| pi知识库旧基线 | `2b00dade7cec918aefb025c8b7a4fa304a30acdd` | 是当前pi提交祖先，相差293个提交 | 旧笔记可作定位输入，RP-01.1必须重新核对后才能引用为当前事实 |

### 3.2 Later分支究竟改了什么

`PI-SOURCE`：pi的Later提交`10e99ae`只修改3个工程文件：`.gitignore`、`.vscode/launch.json`、`.vscode/tasks.json`，共49行新增。`packages/**`没有Later运行时代码差异。因此：

1. 当前0.82.1 Runtime语义应归因于`upstream/main@fdbedcad`，不能声称是Later定制内核。
2. 后续若Chat需要Provider审批、Workflow或恢复补丁，应优先做Chat Adapter或向上游贡献；不能先假定必须长期Fork核心。

`PI-WEB-SOURCE`：pi-web Later分支主要新增或强化PWA、应用内认证、移动工作区、Provider Request查看、运行状态对账、多设备切换、云中继和运维。它已经是Later维护的真实产品分支，而不是可以无成本替换Chat前端的薄Demo。

### 3.3 当前3条pi使用路径

```text
终端用户
-> ~/.local/bin/pi
-> 本地pi 0.82.1 coding-agent构建

当前Chat
-> Python PiRuntimeManager / PiExecution
-> Node + pi-coding-agent 0.82.1 --mode rpc
-> 本地Chat Provider/Tool Gateway
-> Chat Product Store、Approval、Tool Ledger、Evidence提交门

当前pi-web
-> Browser HTTP/SSE
-> Next.js Route Handler
-> 同进程createAgentSessionServices/createAgentSessionFromServices
-> npm Pi SDK 0.83.0 AgentSession
-> pi JSONL Session
```

这3条路径只共享pi的能力体系，不共享进程、配置、Session、权限或产品事实。目前连代码版本也没有完全共享。

## 4. Package与入口地图

| 层次 | Package/应用 | 源码入口 | 直接责任 | 不为Chat证明 |
|---|---|---|---|---|
| Provider | `@earendil-works/pi-ai` | `packages/ai/src/index.ts`、`api/*`、`providers/*` | 模型目录、Provider协议、请求与流式响应类型/实现 | ModelCallDraft审批、产品权限、最终产品提交 |
| 通用Agent | `@earendil-works/pi-agent-core` | `packages/agent/src/agent.ts`、`agent-loop.ts`、`harness/agent-harness.ts` | Agent loop、消息/事件、Tool调用、Harness Session/Compaction能力 | Product Session、Product Run、Workflow/HITL产品状态机 |
| Agent Session存储 | `@earendil-works/pi-agent-core`内存/JSONL + `@earendil-works/pi-storage-sqlite-node` | `packages/agent/src/harness/session/*`、`packages/storage/sqlite-node/src/*` | pi Session持久化实现 | Chat Product Store或Runtime Event Store |
| Coding Agent | `@earendil-works/pi-coding-agent` | `packages/coding-agent/src/core/sdk.ts`、`agent-session*.ts`、`rpc-entry.ts` | Coding Agent组合、资源/扩展、Session、内置工具、CLI/RPC | Tool执行授权、外部副作用Exactly-once、Evidence完成门 |
| 实验Server | `@earendil-works/pi-server` | `packages/server/src/supervisor.ts`、`storage.ts`、`serve.ts` | Coding Agent进程/实例服务化实验 | 生产多租户、持久Workflow或Worker接管 |
| 终端UI | `@earendil-works/pi-tui` | `packages/tui/src/*` | 终端渲染与输入 | Web产品状态或网络协议 |
| Web参考 | `@agegr/pi-web` | `app/api/agent/*`、`lib/rpc-manager.ts`、`hooks/useAgentSession.ts` | Next.js HTTP/SSE、同进程AgentSession、Session浏览和Web交互 | Chat Project/Work/Approval/Evidence事实源 |
| 当前Chat Adapter | Python模块 | `backend/app/pi_gateway.py`、`pi_runtime.py`、`execution_dispatch/*` | 把pi RPC包入现有产品治理闭环 | 目标TypeScript架构已经完成 |

### 4.1 pi-web当前连接链的源码事实

`PI-WEB-SOURCE`：

1. `POST /api/agent/new`调用`startRpcSession()`创建新Session，可立即下发首条命令。
2. `startRpcSession()`在Next.js服务进程内调用`createAgentSessionServices()`和`createAgentSessionFromServices()`；运行对象保存在`globalThis.__piSessions`，并用进程内Promise Map合并并发启动。
3. `POST /api/agent/[id]`向活动Wrapper发命令；若只有Session文件，则重新创建`AgentSession`。
4. `GET /api/agent/[id]/events`订阅Wrapper事件并转为SSE；浏览器断开只取消本次订阅。
5. Session列表/历史从JSONL文件读取，不需要创建AgentSession。
6. 这些机制能证明“Web怎样接pi”，不能证明进程退出后活动Run、Tool副作用或产品审批可以安全恢复。

### 4.2 当前Chat连接链的源码事实

`CHAT-SOURCE`：

1. `PiRuntimeManager.start()`为一次ToolExecution创建并登记一个`PiExecution`。
2. `PiExecution.start()`创建一次性`PI_CODING_AGENT_DIR`、明确的新pi Session和Chat治理扩展，再以`node .../dist/cli.js --mode rpc`启动子进程。
3. 启动参数关闭隐式Extensions、Skills、Prompt Templates、Themes和Context Files；只读/编辑模式还关闭内置Tool。
4. pi模型请求先打到Chat本机Provider Gateway，Chat收到精确Body后创建可治理边界；Tool提议经扩展返回Chat审批和Gateway。
5. pi终态只是候选结果；`execution_dispatch`、Tool Operation和Result Commit Gate再决定Product Run、Action和Evidence状态。
6. 当前跨MAF Checkpoint的活动pi只支持同一后端进程内按稳定ID重挂接；进程退出不能冒充pi活动恢复。

## 5. 6条迁移行为预言机

这6条描述目标TypeScript/pi系统必须继续满足的可观察保证，不要求复制当前Python/MAF实现方式。

### O1 普通回答与权威历史

| 项目 | 预言机 |
|---|---|
| 输入 | Product Session中的一条新User Message；第二轮携带服务端已恢复的公开历史 |
| 权威状态 | User Message先进入Product Store；每轮建立独立Product Run/Attempt；Assistant Message只在成功提交后出现 |
| 用户可见结果 | 两轮后稳定看到`user/assistant/user/assistant`，ordinal连续，无客户端历史重复 |
| 失败分支 | 归档Session拒绝运行；失败/中断Run保留User事实但不产生伪Assistant成功 |
| 当前证据 | `backend/tests/test_product_sessions.py::test_two_turns_restore_only_product_messages_without_duplicate_history`及同文件归档/重启测试 |
| 本批复验 | 通过 |

### O2 Provider请求审批与精确发送

| 项目 | 预言机 |
|---|---|
| 输入 | 完整ModelCallDraft：Provider、协议、Messages/Instructions、Tools、参数、Canonical bytes与Hash |
| 权威状态 | Approval绑定当前Draft revision和Hash；一次性消费后才创建ModelCallAttempt |
| 用户可见结果 | 可读视图与Provider JSON来自同一Draft；修改后出现新revision/Hash并再次审批 |
| 失败分支 | 拒绝为0 Attempt；旧审批不得发送新版本；并发领取只有1个赢家；Transport不得在批准后改写Body |
| 当前证据 | `backend/tests/spikes/test_model_call_approval_spike.py`中的exact bytes、8 Worker领取、跨进程Checkpoint、revision与reject测试 |
| 本批复验 | exact approved bytes代表测试通过 |

### O3 Tool提议、审批、执行与回注

| 项目 | 预言机 |
|---|---|
| 输入 | 第1次模型调用提出已注册Tool及参数；用户可修改参数 |
| 权威状态 | Tool Call只是提议；具体参数审批后才执行；ToolExecution/Operation与Provider Attempt分别记账 |
| 用户可见结果 | 能看到第1次模型审批、Tool参数审批、执行结果和包含Tool Result的第2次模型审批 |
| 失败分支 | 放弃Tool后不再发起后续模型调用且无假成功；结果未知不得盲目重做副作用 |
| 当前证据 | `backend/tests/test_pi_agent.py::test_pi_workflow_reapproves_two_model_calls_edits_tool_args_and_persists_metrics`、`test_tool_operation_workspaces.py`故障矩阵 |
| 本批复验 | 通过 |

### O4 HITL暂停与安全点继续

| 项目 | 预言机 |
|---|---|
| 输入 | Workflow在ModelCall/HITL边界暂停；决定可由新的API/Worker进程提交 |
| 权威状态 | Product Run、Checkpoint、Pending Request、Decision和Interrupt Link持久关联 |
| 用户可见结果 | 刷新/换进程后仍看到同一待处理卡；批准后从对应安全点继续，前置节点不重跑 |
| 失败分支 | Definition/图签名不兼容时失败关闭；无Checkpoint或外部副作用不明确时不得伪Resume |
| 当前证据 | `backend/tests/test_continuous_chat.py::test_continuous_workflow_restores_each_hitl_checkpoint_in_a_new_process`及Outbox Worker重启测试 |
| 本批复验 | 通过 |

### O5 进程重启的诚实恢复语义

| 项目 | 预言机 |
|---|---|
| 输入 | User Message与Run已持久化，但进程在没有验证过的可恢复安全点时退出 |
| 权威状态 | User Message保留；Run/Attempt收敛为`interrupted/process_restarted`；Session不再指向假活动Run |
| 用户可见结果 | 用户能重新打开历史并看见中断，不会看到伪成功或无依据自动续跑 |
| 失败分支 | 活动pi进程丢失不能仅凭JSONL Session自动重放Provider或Tool；另行Retry/Restart需建立新血缘 |
| 当前证据 | `backend/tests/test_product_sessions.py::test_file_store_survives_restart_and_reconciles_unfinished_run`、`test_continuous_pi_readonly.py`丢失live pi测试 |
| 本批复验 | 通过 |

### O6 Evidence与结果提交门

| 项目 | 预言机 |
|---|---|
| 输入 | pi执行候选结果、Artifact、Validation Contract/Run、Completion Claim和用户决定 |
| 权威状态 | Result Commit在提交时重验Claim revision/hash、mandatory Evidence、Artifact和主体版本；Product事实由Chat事务提交 |
| 用户可见结果 | 验证通过并接受后，目标Action才变为completed；父Work可继续in_progress；来源与证据可追踪 |
| 失败分支 | Validation失败只允许拒绝；unknown不产生supports或完成；并发/过期/篡改零部分提交 |
| 当前证据 | `backend/tests/test_result_pipeline.py::test_result_commit_gate_completes_action_after_accepted_validation`及失败/unknown/陈旧矩阵 |
| 本批复验 | 通过 |

本批复验命令只使用测试Provider、临时SQLite/目录和本地进程，没有真实付费模型调用：

```bash
PYTHONBREAKPOINT=0 .venv/bin/pytest -q \
  backend/tests/test_product_sessions.py::test_two_turns_restore_only_product_messages_without_duplicate_history \
  backend/tests/spikes/test_model_call_approval_spike.py::test_streaming_provider_dispatches_the_exact_approved_body_bytes \
  backend/tests/test_pi_agent.py::test_pi_workflow_reapproves_two_model_calls_edits_tool_args_and_persists_metrics \
  backend/tests/test_continuous_chat.py::test_continuous_workflow_restores_each_hitl_checkpoint_in_a_new_process \
  backend/tests/test_product_sessions.py::test_file_store_survives_restart_and_reconciles_unfinished_run \
  backend/tests/test_result_pipeline.py::test_result_commit_gate_completes_action_after_accepted_validation
```

结果：`6 passed`。

## 6. 已确认缺口与风险

| ID | 缺口/风险 | 对后续批次的约束 |
|---|---|---|
| G01 | pi源码/全局入口为0.82.1，pi-web实际SDK为0.83.0 | pi-web行为不能直接为0.82.1源码结论背书；RP-01.4必须单列两条版本线 |
| G02 | `configure-local-pi-stack.sh`要求版本完全相等，当前前置条件不成立 | 不运行链接脚本，不通过覆盖`node_modules`强行制造“同源” |
| G03 | pi Later分支没有Runtime改动 | 现有Chat治理全部是Chat能力，不得误归因于pi Fork |
| G04 | pi-web活动Agent registry、启动锁和SSE订阅属于Next.js进程内状态 | 不能冒充多实例Worker、持久Event Journal或跨进程活动Run恢复 |
| G05 | 当前Chat通过Python/MAF/子进程RPC接pi；目标计划是TypeScript直接使用pi体系 | RP-01.1—1.5必须证明目标Adapter仍保留6条预言机，不能只证明“能聊天” |
| G06 | pi知识库固定提交比当前基线早293个提交 | RP-01.1完成当前源码核对后再更新可复用知识，不能直接复制旧结论 |
| G07 | Chat基线工作树非clean，且当前前后端服务未运行 | 本批只冻结源码/测试快照；重建切换前还需固定可复现实验提交或Artifact |
| G08 | pi Package地图中没有Chat所需的完整Product Workflow/HITL/Checkpoint对象 | 先在RP-01.1—1.3核实缺口，再决定自建边界或申请外部组件研究 |

## 7. 对前端选型的当前约束

本批不直接选择前端框架，但已经把选型问题收窄为2种可验证候选，而不是重新泛选整个TypeScript生态：

1. **React + Next.js一体化应用**：重点验证能否复用pi-web的同进程SDK连接、Session交互和移动/PWA工程，同时把Chat Product API、Runtime Worker和权威Store从Next.js页面进程中分离。
2. **React + Vite独立前端 + TypeScript产品后端**：重点验证能否保留现有Chat交互资产和明确的前后端进程边界，同时建立一套不与pi事件竞争的实时协议。

当前不能选择“直接把pi-web改名为Chat”，原因有3个：

1. pi-web的核心状态是pi Session和进程内AgentSession，不是Chat Product Session/Run/Work/Evidence。
2. Later pi-web已经包含大量独立移动、认证、多设备和运维改造，迁入Chat会同时引入不必要的产品与部署耦合。
3. 0.83.0 pi-web行为尚未与RP-01固定的0.82.1源码链统一。

前端框架最终决定仍应等RP-01.4完成Web/Server拓扑研究、RP-01.5完成E1流式纵向实验后，在RP-01.6决策卡中审核。

## 8. RP-01.1入口（已执行）

本入口在RP-01.0获批后定义了RP-01.1的限定范围：

1. 固定0.82.1源码的对象词典和Package依赖关系。
2. 追踪1条无Tool回合和1条有Tool回合的真实函数/事件顺序。
3. 分开Agent Message、LLM Message、pi Session记录、UI事件和Chat产品对象。
4. 明确`Agent`、`AgentHarness`、Session Backend、Coding Agent和Server各自拥有与不拥有的状态。
5. 将经过当前提交重新核对的可复用pi知识同步到`agent_knowledge/project-studies/pi/`，旧固定提交结论保留历史边界。

2026-08-05用户批准本批固定版本、Package地图、6条迁移行为预言机和8项缺口。该批准只解除RP-01.1
研究门，不授权修改pi、pi-web或Chat产品代码，也不授权依赖、Schema、迁移、部署或付费模型调用。

## 9. RP-01.1结论摘要（待用户审核）

`PI-SOURCE`与定向测试共同证明：pi 0.82.1不是一条统一的
`Agent -> AgentHarness -> Session -> Coding Agent`继承链，而是3种不同职责的组合：

1. `Agent`是围绕`runAgentLoop`的进程内状态包装器，不拥有持久Session。
2. `AgentHarness`直接调用`runAgentLoop`，并额外组合通用Session树、资源、Hook、Compaction和持久写入；它不包装`Agent`。
3. 当前`pi-coding-agent`实际主链使用`Agent + AgentSession + Coding SessionManager`，没有使用通用`AgentHarness`或通用Session Backend。
4. `pi-server`在此之上启动独立Coding Agent RPC子进程并转发事件；它是实验性进程监督器，不是可恢复Product Run或Workflow引擎。

`INFERENCE`：目标Chat可以选择直接组合`Agent`，也可以评估通用`AgentHarness`，但不能因为
Coding Agent和Harness都使用“Session”这个词，就把两套对象或持久化格式视为同一个稳定合同。最终选择留给
RP-01.6决策卡，本批只冻结源码事实和架构约束。

## 10. Package关系图

```text
@earendil-works/pi-ai
    ^
    |
@earendil-works/pi-agent-core ----------------> @earendil-works/pi-storage-sqlite-node
    ^                                                        |
    |                                                        `-> 通用Session Backend
@earendil-works/pi-coding-agent
    ^
    |
@earendil-works/pi-server -> 每实例一个Coding Agent RPC子进程
```

| Package | 直接依赖 | 本批确认的边界 |
|---|---|---|
| `pi-ai` | 不依赖Agent包 | Model、Provider、LLM Message、Context与Stream合同 |
| `pi-agent-core` | `pi-ai` | 低层Loop、`Agent`、`AgentHarness`、Agent Message/Event与通用Session抽象 |
| `pi-storage-sqlite-node` | `pi-agent-core`、`pi-ai` | 通用Session的SQLite Repo/Storage；不接入Coding SessionManager |
| `pi-coding-agent` | `pi-agent-core`、`pi-ai`、`pi-tui` | Coding Agent产品协调、独立JSONL SessionManager、CLI/Print/RPC |
| `pi-server` | `pi-coding-agent` | Coding Agent子进程、IPC/RPC桥和实例元数据 |

关键负证据：在`packages/coding-agent/src`和`packages/server/src`检索不到`AgentHarness`引用；
`sdk.ts`实际分别构造`new Agent(...)`和`new AgentSession(...)`，而`AgentHarness`自身在
`agent-harness.ts`直接调用`runAgentLoop(...)`。

## 11. 对象级导读

| 对象 | 创建者/所有者 | 生命周期与Store | 用户可见性 | 与Chat的关系 |
|---|---|---|---|---|
| `pi-ai Message` | `convertToLlm`与Provider适配层 | 单次模型Context；pi-ai本身不持久化 | 通常不直接显示 | 只是Provider输入对象，不是Product Message或ModelCallDraft |
| `AgentMessage` | Agent宿主 | 标准LLM Message加应用自定义Message；进入Provider前转换 | 上层可投影 | 可作为Runtime消息载体，不能直接成为Chat权威Message |
| `AgentState` | `Agent` | 进程内可变：模型、Thinking、工具、消息、流状态、待执行Tool、错误 | 通过上层投影 | 不是Product Session、Product Run或Checkpoint |
| `AgentEvent` | `runAgentLoop` | 进程内事件流；是否保存由订阅者决定 | RPC/TUI可继续投影 | 不是持久Trace或浏览器重连协议 |
| `AgentHarnessTurnState` | `AgentHarness` | 每轮冻结模型、资源、工具、Stream选项、Session ID等快照 | 默认不直接显示 | 类似Runtime输入快照，但不是Chat不可变RunSpec |
| 通用`Session` | Harness/调用方 | 委托`SessionStorage`保存append-only树 | 由宿主展示 | 只保存pi转录/分支/配置，不是Product Store |
| `SessionStorage/Repo` | Agent Core/Storage包 | 内存、JSONL或SQLite；Repo负责create/open/list/delete/fork | 不直接显示 | 是可替换Runtime Session Backend候选 |
| Coding `SessionManager` | `createAgentSession` | 独立JSONL v3树；新Session在首个Assistant消息前可能只在内存 | CLI/RPC可查历史 | 与通用Session不是同一接口；不能恢复活动Tool/Provider |
| `AgentSession` | Coding Agent组合根 | 进程内协调Agent、SessionManager、资源、Extension、Tool、压缩、重试、Bash | TUI/Print/RPC围绕它工作 | 是Coding Agent应用协调器，不是Chat应用层 |
| `AgentSessionRuntime` | CLI主入口 | 持有当前Session及cwd绑定服务；切换时销毁/替换 | 间接可见 | 不是跨进程Worker Lease或Run所有者 |
| RPC Command/Response/Event | RPC模式 | stdin/stdout逐行JSON；无持久重放保证 | RPC客户端可见 | 可作Runtime Adapter输入，不应直接定为Chat实时协议 |
| Server `InstanceRecord` | `pi-server` | `instances.json`记录ID、状态、cwd、Session ID/File等；子进程仍在内存 | Server API可见 | 是进程目录，不是Product Run、Work或用户Session |
| Product Session/Run/Approval/Evidence | Chat产品层 | Product Store及相应状态所有者 | 必须可审核、恢复 | pi没有原生拥有，目标系统仍需Chat定义 |

### 11.1 5种“消息”必须分开

1. **Provider流事件**：`start/text_delta/toolcall_delta/done/error`，来自`pi-ai`的Assistant流。
2. **LLM Message**：`UserMessage | AssistantMessage | ToolResultMessage`，能进入Provider Context。
3. **Agent Message**：在LLM Message外允许宿主扩展自定义角色；通过`transformContext`和`convertToLlm`后才成为LLM输入。
4. **pi Session Entry**：通用Session或Coding SessionManager保存的消息、模型、Thinking、Compaction、Branch等树条目。
5. **Chat Product Message/Trace Event**：具有产品身份、序号、权限、提交与恢复语义；不能由上述任一对象自动替代。

## 12. 无Tool回合源码调用链

### 12.1 输入、处理、输出

| 阶段 | 输入 | 关键函数 | 输出/状态变化 |
|---|---|---|---|
| Coding预处理 | 用户文本、图片、RPC行为 | `AgentSession.prompt()` | Extension命令判断、模板/Skill展开、模型鉴权、必要的预压缩和UserMessage |
| Agent入口 | 一个或多个`AgentMessage` | `Agent.prompt()` | 建立本次AbortController并调用`runAgentLoop` |
| Loop启动 | Agent Context与配置 | `runAgentLoop()` | `agent_start`、`turn_start`，随后输入消息`message_start/end` |
| Context投影 | `AgentMessage[]` | `transformContext()`后`convertToLlm()` | Provider可接受的`pi-ai Message[]` |
| 模型调用 | Model、Context、StreamOptions | `streamFunction(model, context, options)` | `pi-ai` Assistant流 |
| 流事件映射 | Provider `start/delta/done` | `streamAssistantResponse()` | Agent `message_start/update/end`并更新当前Assistant消息 |
| Loop收尾 | 最终Assistant Message | `runLoop()` | `turn_end`、`agent_end` |
| Coding收尾 | Agent事件 | `AgentSession._handleAgentEvent()`、`_handlePostAgentRun()` | Extension/监听器通知、SessionManager追加、重试/压缩/队列处理、`agent_settled` |

### 12.2 Agent Core事件顺序

```text
agent_start
turn_start
message_start(user)
message_end(user)
message_start(assistant)
message_update(assistant) * N
message_end(assistant)
turn_end
agent_end
```

`Agent.processEvents()`先更新自身内存状态，再等待Agent订阅者。Coding `AgentSession`收到同一事件后，顺序是：

1. Extension事件处理。
2. 通知`AgentSession`监听器/RPC订阅者。
3. 对`message_end`追加Coding SessionManager。

因此RPC客户端看见`message_end`与消息已经成功物理落盘不是同一个合同；Chat若要求“先提交、后发布”，必须在自己的应用层与Store中重新定义。

## 13. 有Tool回合源码调用链

### 13.1 主链

```text
第1次Provider调用
-> AssistantMessage包含toolCall
-> tool_execution_start
-> 查找Tool
-> prepareArguments（可选）
-> TypeBox参数校验
-> beforeToolCall（可阻止或修改参数）
-> Tool.execute(partial update callback)
-> tool_execution_update * N
-> afterToolCall（可替换content/details/isError/usage/terminate）
-> tool_execution_end
-> 合成ToolResultMessage
-> message_start(toolResult)
-> message_end(toolResult)
-> turn_end
-> 若没有terminate：turn_start
-> 第2次Provider调用，Context包含Tool Result
-> Assistant message_start/update/end
-> turn_end
-> agent_end
```

### 13.2 失败与并发语义

1. `tool_execution_start`在Tool存在性和参数校验之前发出；它只表示开始处理调用，不表示授权通过或Tool已真正执行。
2. Tool不存在、参数无效、被Hook阻止或`execute()`抛错，会转为`isError=true`的Tool Result供后续模型使用。
3. 默认允许并行时，`tool_execution_end`按真实完成顺序发出；写入Context的Tool Result仍按Assistant原始Tool Call顺序排列。
4. 所有Tool Result的`terminate=true`或`shouldStopAfterTurn()`可阻止下一次Provider调用。
5. pi的Tool Result不声明外部副作用是否已提交、是否可重试、是否需要对账；这些仍属于Chat Tool Operation与Evidence边界。

定向无网络验证运行了3条测试：无Tool事件类型、有Tool执行/结果、精确停止事件序列。结果为
`1 test file passed; 3 passed | 18 skipped`。

## 14. `Agent`与`AgentHarness`边界

| 维度 | `Agent` | `AgentHarness` |
|---|---|---|
| 调用Loop | 调用`runAgentLoop` | 也直接调用`runAgentLoop`，不经`Agent` |
| 消息状态 | `AgentState.messages`进程内数组 | 从通用Session构建Context并把事件写回Session |
| 运行配置 | 当前Model、Thinking、Tool、Stream/Hooks | 每轮创建`TurnState`快照，并允许下一轮更新 |
| Queue | steering/follow-up进程内队列 | next-turn队列与Harness phase |
| 持久化 | 无 | 通过通用Session/Storage保存消息、快照相关条目、分支、压缩等 |
| 资源 | 调用方传System Prompt/Tool | 组合Resources、Skill、Prompt Template、Context File、Tool与Hook |
| 适合回答的问题 | 如何嵌入最小Agent loop | 如何获得更完整但仍是pi范围的Runtime Harness |
| 不提供 | Product Store、Workflow、Approval、Evidence | 同样不提供Product Store、Workflow、Approval、Evidence |

`INFERENCE`：若目标Chat希望最大限度掌握运行内核、让产品应用层拥有Session/Run/Workflow，则直接组合
`Agent`更小；若希望复用通用Context/Session/Compaction/Hook能力，则评估`AgentHarness`更省工作。
两种方案的真正选择必须在RP-01.6结合Session、Provider治理和Workflow实验统一决定，本批不提前批准。

## 15. 两套pi Session与状态寿命

### 15.1 通用Harness Session

`PI-SOURCE`：通用`Session`是`SessionStorage`之上的append-only树，支持Message、Model、Thinking、Active Tools、Custom、Compaction、Branch和Leaf等条目。已有3种Backend形态：

1. `InMemorySessionStorage`：随进程消失。
2. `JsonlSessionStorage/Repo`：每次append先写文件，再更新内存索引。
3. `SqliteSessionRepo/Storage`：WAL、`synchronous=FULL`、事务与迁移支持。

### 15.2 Coding SessionManager

`PI-SOURCE`：Coding Agent的`SessionManager`也是append-only JSONL v3树，但属于另一套实现。它在
`AgentSession`的`message_end`后追加消息；对于新Session，Header、User Message等可先只存在内存，直到首个
Assistant Message到达才完整创建JSONL文件。

### 15.3 能恢复与不能恢复

| 状态 | 通用Session/Coding Session能否保存 | 不能据此保证 |
|---|---|---|
| 历史消息与当前Branch | 能 | Product Message已提交、租户权限正确 |
| 模型/Thinking/Active Tools变化 | 能或部分能 | Provider审批和Tool Revision已批准 |
| Compaction/Branch摘要 | 能 | 完整产品历史已被安全裁剪 |
| 已完成Tool Result | 能保存转录 | 外部副作用Exactly-once、Evidence有效 |
| 正在进行的Provider流 | 不能恢复活动流 | 断点续传 |
| 正在运行的Tool | 不能恢复调用栈 | 副作用状态已知或可安全重试 |
| Product Run/Attempt/Checkpoint | 未涉及 | Workflow安全点恢复 |

## 16. Coding Agent、RPC与Server边界

1. `createAgentSession()`恢复Coding Session里的模型、Thinking和消息，构造`Agent`，再构造`AgentSession`。
2. `AgentSessionRuntime`负责当前AgentSession及cwd绑定服务；`new/switch/fork`会先中止并清理旧Runtime，再创建新Runtime。
3. RPC模式从stdin读取Command，从stdout写Response、AgentSession Event和Extension UI Request。
4. `prompt`命令在预检成功后输出成功Response，但模型/Tool事件异步继续；命令被接受不等于回合已结算。
5. RPC显式处理stdout背压，但协议本身没有提供持久Event ID、重放游标或跨实例订阅恢复。
6. `pi-server`每个实例启动一个Coding Agent RPC子进程，维护进程内订阅者，并把少量实例元数据写入`instances.json`。
7. Server重启时，旧`online/starting`实例被改为`stopped`并断开外部Presence；没有重新接管旧进程或继续Provider/Tool执行。

`INFERENCE`：RPC可以继续作为迁移过渡期的Runtime Adapter行为参照；目标TypeScript系统若直接嵌入pi，仍需把
Agent Runtime进程/Worker、Chat实时协议和Product Run Store分开设计。`pi-server`只作为RP-01.4的实验Server参考，
不能在本批直接选为生产Host。

## 17. pi明确不拥有清单

固定0.82.1源码没有为以下Chat产品状态提供权威所有者：

1. Identity、Tenant、User、Role与超级管理员授权。
2. Product Session、公开Message、Ordinal、标题、归档和跨通道绑定。
3. Project、Work、Task、Plan、Intent与完成条件。
4. Product Run、Run Attempt、Worker Lease、Workflow Definition和Checkpoint。
5. ModelCallDraft Revision、Canonical Body/Hash、Approval及一次性消费。
6. Tool Catalog Revision、Tool提议、Approval、ToolExecution Ledger、外部副作用幂等与未知结果对账。
7. Artifact、Evidence、Validation Contract/Run、Completion Claim和Result Commit Gate。
8. Accepted Memory、Memory来源/冲突/撤回和Project Context版本。
9. 可供浏览器断线重放的持久Runtime Event Journal与Product Trace。
10. 多租户数据隔离、运营看护、审计访问和部署级可靠性。

这些不是对pi质量的否定，而是状态所有权边界：pi专注Model/Agent/Tool/Session Runtime，Chat仍需拥有完整产品闭环。

## 18. RP-01.1采用判断与未验证项（待用户审核）

| 分类 | 本批建议 | 原因 | 信心/未验证项 |
|---|---|---|---|
| 采用 | 把`pi-ai + runAgentLoop/Agent`作为目标Runtime核心候选 | 边界小、事件清楚、与Product Store可分离 | 高；Provider精确Payload/Hooks待RP-01.2 |
| 继续评估 | `AgentHarness`的通用Session、Context、Hook、Compaction能力 | 能减少重复Runtime基础设施，但与Coding Agent主链不同 | 中；需结合目标Session与Workflow责任决定是否整体采用 |
| 作为参考 | Coding `AgentSession/SessionManager` | 提供成熟Coding资源、Tool、分支、压缩、重试和RPC行为 | 高；不把其JSONL当产品事实源 |
| 作为参考 | `pi-server` | 提供子进程监督与RPC桥的真实入口 | 中；生产多实例、恢复、租户和安全未验证 |
| 拒绝 | 把任一pi Session等同Product Session/Run/Checkpoint | 源码没有产品状态与恢复保证 | 高 |
| 拒绝 | 把Agent Event/RPC Event直接定为Chat实时协议或持久Trace | 缺少持久Event ID、提交门和重放合同 | 高 |

本表现作为`pi + pi-web`完整掌握的Chat侧取舍输入，不再单独触发RP-01.2逐卡停顿。用户审核当前材料后，Provider审批、Tool治理、Session恢复、Server/Web拓扑和持久HITL将在下一份Chat Workflow架构计划中绕产品闭环重组。

## 19. RP-01.1证据与验证

### 19.1 固定事实

1. pi：`codex/later-custom@10e99ae9914cd34f622633fac42f9a90714e9cf4`，工作树clean。
2. 相关5个Package均为0.82.1。
3. `pi-coding-agent`与`pi-server`源码中`AgentHarness`引用数为0。
4. 本批未修改pi源码、未新增依赖、未调用真实付费Provider。

### 19.2 源码证据

1. Agent与Loop：`packages/agent/src/agent.ts`、`agent-loop.ts`、`types.ts`。
2. Harness：`packages/agent/src/harness/agent-harness.ts`、`harness/types.ts`、`harness/session/*`。
3. SQLite Session：`packages/storage/sqlite-node/src/sqlite/repo.ts`及Storage实现。
4. Coding组合：`packages/coding-agent/src/core/sdk.ts`、`agent-session.ts`、`agent-session-runtime.ts`、`session-manager.ts`。
5. RPC：`packages/coding-agent/src/modes/rpc/rpc-mode.ts`、`rpc-types.ts`、`rpc-entry.ts`。
6. Server：`packages/server/src/serve.ts`、`handler.ts`、`supervisor.ts`、`rpc-process.ts`、`storage.ts`。

### 19.3 定向测试

```bash
cd /Users/xulater/Code/opc-os/pi/packages/agent
../../node_modules/.bin/vitest run test/agent-loop.test.ts \
  -t 'should emit events with AgentMessage types|should handle tool calls and results|should stop after the current turn when shouldStopAfterTurn returns true'
```

结果：`1`个测试文件通过，`3 passed | 18 skipped`，耗时约`0.6s`。

### 19.4 完整掌握收口证据

1. pi Agent Core：18个测试文件通过，240项通过，1项跳过。
2. Coding Agent关键合同：9个测试文件通过，1个文件跳过；244项通过，18项跳过。
3. pi TUI：3个定向Node测试文件通过，`tsgo --noEmit`通过。
4. pi-web：TypeScript和ESLint通过，76个`*.test.mjs`文件中343/343项测试通过。
5. 两个源码仓验证后仍是clean工作树；开源研究结构校验为0 errors/0 warnings。
6. 不调用真实Provider，因而不将网络、账号、费用、上游限流或0.83.0完整源码行为标记为已验证。

### 19.4 知识同步

已将当前0.82.1对象边界、两条调用链、Session双实现和Server边界同步到：

`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/pi/0.82.1-Agent-Harness-Coding-Session对象与调用链.md`

旧`2b00dade`研究文档保留为历史快照，没有用当前提交静默覆盖旧证据。
