# pi 对 Workflow、HITL 与 Checkpoint 的原生支持研究

> 日期：2026-08-05；阶段状态更新于2026-08-06
> 状态：**源码研究已完成；用户已明确进入Chat架构方案审核，本文作为事实基线保留**
> 纠正：上一版把“研究pi支持什么”偷换成Chat架构D1—D8。D1—D8已撤回，不属于本文审核内容。
> 授权边界：本文不批准目标依赖、生产目录、Schema、迁移、Worker、部署或产品代码修改。

## 1. 本文只回答什么

本文只回答固定版本的5个对象对Workflow、HITL和Checkpoint究竟提供了什么：

1. `pi-ai`；
2. `pi-agent-core`；
3. `pi-coding-agent`；
4. `pi-server`；
5. `pi-web`。

每项结论只使用以下4种状态：

| 状态 | 判定标准 |
|---|---|
| `native` | 当前源码存在公开类型或运行路径，并有测试、示例或可定位调用链支持 |
| `partial` | 当前有可用原语或扩展点，但没有形成所问能力的完整合同 |
| `design-only` | pi文档已经设计，但当前源码、存储或公开API尚未实现 |
| `missing` | 当前源码、测试和设计材料都没有提供该能力，或明确不保证 |

本文不提出Chat应采用的Workflow对象、审批Schema、Checkpoint结构或Worker拓扑；这些属于下一工作包。

## 2. 固定版本与验证范围

| 对象 | 固定版本 | 工作树 | 本文使用范围 |
|---|---|---|---|
| pi源码 | `10e99ae9914cd34f622633fac42f9a90714e9cf4` | clean | `pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-server` |
| pi Packages | `0.82.1` | 与上述源码同一提交 | 当前公开类型、实现、测试和设计文档 |
| pi-web源码 | `82cb76a36b379a050e93ee7d726f2cf591e5f942` | clean | Next.js进程内Wrapper、Extension UI、SSE和重连 |
| pi-web App / Pi SDK | App `0.8.6` / SDK `0.83.0` | 普通`node_modules`安装 | 只能为pi-web当前行为背书，不能反向证明pi 0.82.1 |

本轮无真实模型、无API Key、无外部副作用，只运行定向离线测试：

| 验证 | 结果 |
|---|---|
| `pi-agent-core`: `agent-loop.test.ts` + `harness/agent-harness.test.ts` | `44/44`通过 |
| `pi-coding-agent`: `agent-session-model-extension.test.ts` + `agent-session-runtime.test.ts` | `23/23`通过 |
| `pi-ai`: `deferred-tools.test.ts` | `22/22`通过 |
| pi-web: `rpc-manager.test.mjs` + `useAgentSession.test.mjs` | `13/13`通过 |

## 3. 一页结论

| 主题 | 当前结论 | 直接含义 |
|---|---|---|
| Workflow | pi有Agent loop、Tool batch、队列、事件和宿主Hook；**没有可执行Workflow定义/图/节点状态机** | pi能执行一个Agent循环，不能直接充当Chat Workflow引擎 |
| HITL | pi能在Tool执行前await、询问用户、修改或阻断调用；Coding Agent RPC和pi-web能展示交互请求；**这些等待主要是进程内Promise** | 可做在线人工确认，但不是可审计、可跨进程恢复的持久HITL |
| Checkpoint | pi能保存消息树、配置变化、Compaction和叶子位置，能重开已完成Session；**当前不能恢复活动Provider/Tool/人工等待** | Session恢复不等于Run恢复，更不等于Workflow Checkpoint恢复 |
| durable harness | pi已有完整设计稿，定义Run、Step、Checkpoint、Suspended、`resume()`和`harness_entries`；**当前实现仍标记Planned/Designed** | 可作为未来方向和概念证据，不能作为当前可调用能力 |
| pi-server | 保存实例与Session元数据；重启后把原`online/starting`改成`stopped` | 不接管或重放崩溃前的活动执行 |
| pi-web | 同一Next.js进程内能保持Wrapper、重放未回答UI卡片并重连SSE | 进程退出后Wrapper、待回答Promise和未持久事件都消失 |

最容易误判的3个同名词：

1. `save_point`是一次`turn_end`后刷新内存写队列的事件，不是持久控制流Checkpoint。
2. Compaction文档中的“self-contained checkpoint”是模型上下文重建锚点，不是活动Run恢复点。
3. `pi-ai`的deferred tools是“延迟把Tool Schema加载给模型”，不是延迟执行、人工审批或持久HITL。

## 4. Workflow支持矩阵

这里的Workflow限定为：有显式定义、节点/边、控制状态、分支/汇合、失败语义，并能记录和恢复进度的可执行流程；自然语言中的“工作流”不计入。

| 能力 | 状态 | pi当前事实 | 边界 |
|---|---|---|---|
| 模型—Tool循环 | `native` | `agent-loop.ts`驱动Provider、Assistant Tool Call、Tool Result和下一轮Provider | 是Agent loop，不是任意Workflow图 |
| Tool批次顺序/并行执行 | `native` | `toolExecution`支持`sequential`/`parallel`，并固定预检与结果事件顺序 | 只覆盖单次Agent回合中的Tool batch |
| Steer / Follow-up / Next-turn队列 | `native` | AgentHarness维护3类队列并发出`queue_update` | 队列是内存状态，进程退出不恢复 |
| Agent/Provider/Tool生命周期事件 | `native` | Agent loop与Harness提供消息、Tool、Provider和settled相关事件/Hook | 没有Workflow节点事件或Definition版本 |
| Compaction与Session树导航 | `native` | Harness可压缩上下文、切换叶子并生成Branch Summary | 操作的是消息树，不是流程图 |
| 宿主自定义编排 | `partial` | 应用可以组合`prompt()`、Tool、Hook、Extension和外部代码 | 可靠性、状态机和持久化全部由宿主承担 |
| 显式Workflow Definition | `missing` | 生产源码无Workflow类、图定义、节点/边模型或Runner | Prompt、Skill、Extension不能冒充定义 |
| 条件分支、并行分支、Join | `missing` | 无对应控制流对象和运行状态 | Tool并行不等于Workflow并行 |
| Timer、Signal、等待节点 | `missing` | 无持久Timer或外部Signal合同 | 当前await只活在进程内 |
| 子流程与流程版本 | `missing` | 无Subworkflow、Definition ID/version/hash | 无法检查旧进度与新定义兼容性 |
| 节点级重试/补偿 | `missing` | Provider retry和Tool error是局部运行语义 | 无Workflow节点补偿/回滚模型 |
| 持久Workflow进度与恢复 | `missing` | 当前Session entry不记录Workflow节点状态 | durable harness设计也不是任意Workflow图引擎 |

源码检索还发现，生产目录中的`workflow`主要出现在自然语言、测试fixture和`.github/workflows`路径中，没有实现级Workflow对象。

### 4.1 pi真正能承担的执行原语

当前公开运行链是：

```text
Agent.prompt / AgentHarness.prompt
-> 构建Context与Provider请求
-> streamFn
-> AssistantMessage
-> 0..n Tool Call
-> Schema校验
-> beforeToolCall
-> Tool.execute
-> afterToolCall
-> ToolResult
-> 下一轮Provider或结束
```

因此，pi原生支持的是“一个可扩展Agent循环”；如果宿主把多个循环串成业务流程，那是宿主编排，不是pi已提供Workflow引擎。

## 5. HITL支持矩阵

这里的HITL限定为：系统在副作用前产生可识别的Decision Point，向人发出请求，保存决定与授权范围，并允许等待、超时、拒绝和恢复。

| 能力 | 状态 | pi当前事实 | 边界 |
|---|---|---|---|
| Tool执行前拦截 | `native` | `beforeToolCall`在参数Schema校验后、`Tool.execute`前运行 | Hook本身没有持久化 |
| 阻断Tool | `native` | 返回`{block:true, reason}`可阻止执行 | pi生成`isError=true` Tool Result，Agent loop可继续，不是Suspended |
| Tool参数修改 | `native` | Extension可原地修改已校验参数 | 修改后**不会再次Schema校验**；不是审批后的不可变请求 |
| TUI人工选择/确认/输入 | `native` | Extension UI提供`select`、`confirm`、`input`、`editor` | 当前进程内Promise等待 |
| Coding Agent RPC交互请求/响应 | `native` | stdout发`extension_ui_request`，stdin收同ID的`extension_ui_response` | ID到resolver只存在内存Map |
| pi-web人工对话框 | `native` | Wrapper将Extension UI请求投影到浏览器并接收响应 | 只在同一Wrapper存活期间有效 |
| 浏览器断线后重显待答请求 | `partial` | 新SSE listener会遍历`pendingUiRequests`重新发送 | 只抵抗浏览器断线，不抵抗Next.js进程退出 |
| 超时与Abort默认值 | `native` | RPC/pi-web UI等待支持timeout与AbortSignal | 超时结果没有内建Decision Record或审计链 |
| 无UI时Fail Closed | `partial` | `permission-gate.ts`示例可在无UI时返回block | 是扩展模式，不是统一政策引擎 |
| Project Trust | `native` | 专用信任提示支持session-only或写入`trust.json` | 只负责项目目录信任，不是通用审批系统 |
| Provider请求/Headers拦截 | `partial` | AgentHarness/Coding Extension有Provider前置Hook | 可改请求，但没有审批请求、Hash绑定或持久等待 |
| 通用Decision Point/Policy | `missing` | 无统一策略评估、风险级别或决策主体模型 | 需由宿主定义 |
| 持久Human Decision Request/Record | `missing` | Session entry union无Approval/Decision条目 | UI卡片和Tool Result都不能替代 |
| 决定绑定Run/Revision/Request Hash | `missing` | 无Grant、Consumption或不可变请求绑定 | 旧批准无法自动防止复用到新请求 |
| 跨进程恢复待审核请求 | `missing` | RPC/pi-web resolver、request Map和JS调用栈均不持久 | 新进程不能继续原Promise |
| 多端领取、权限、审计 | `missing` | pi没有审批Principal、claim、ACL或审计合同 | pi-web登录也不等于审批授权 |

### 5.1 `beforeToolCall`的精确语义

源码顺序是：

```text
prepareArguments
-> Schema validation
-> beforeToolCall(args)
-> block ? synthetic error ToolResult : Tool.execute(args)
```

两点不能忽略：

1. `block`是“拒绝这次Tool并把错误结果喂回模型”，不是“暂停当前Run，等待将来resume”。
2. Hook收到的`args`可变，测试明确证明修改后不会再次校验；所以它不能天然提供“审批内容与实际执行内容相同”的不可变性保证。

### 5.2 在线HITL为何不等于持久HITL

Coding Agent RPC和pi-web都形成了可用的在线链：

```text
tool_call Extension
-> await ctx.ui.select/confirm
-> extension_ui_request(id)
-> 浏览器或RPC客户端回答
-> 内存Map按id resolve
-> Tool继续或block
```

浏览器短暂断开时，pi-web会在新listener订阅后重发`pendingUiRequests`，这是有价值的断线恢复；但Next.js进程退出时，Wrapper、Map、Promise和活动Agent loop一并消失。它没有跨进程HITL恢复语义。

## 6. Checkpoint与恢复支持矩阵

这里的Checkpoint限定为：足以判断活动执行进度和外部副作用状态、能由新进程安全接管的持久恢复点。

| 能力 | 状态 | pi当前事实 | 边界 |
|---|---|---|---|
| JSONL消息树持久化 | `native` | Coding SessionManager保存消息、分支、模型、thinking、compaction等 | 是Transcript/Context持久化 |
| 通用Harness Session Store | `native` | Memory、JSONL、SQLite Session存储消息树和leaf | 不保存活动operation |
| SQLite事务与WAL | `native` | `sessions`、`session_entries`、sequence、branch、materialized表 | 没有`harness_entries`表 |
| Compaction上下文锚点 | `native` | `retainedTail`可作为自包含Context重建点 | 不是Workflow控制点 |
| Harness `save_point`事件 | `native` | `turn_end`后刷新`pendingSessionWrites`并发事件 | 事件本身不写Session，不带Run/Step/Checkpoint ID |
| 重开已完成Session | `native` | `SessionManager.open()`重建消息、模型和thinking；`switchSession`创建新Runtime | 恢复历史，不恢复旧调用栈 |
| 浏览器接回同进程活动流 | `partial` | pi-web查询进程内Wrapper状态并重连SSE | 无持久Event Cursor；断线期间普通事件不重放 |
| Provider调用start/finish journal | `missing` | 当前Session entry无generation/provider operation条目 | 崩溃后无法仅靠pi判断是否已外发 |
| Tool调用start/finish journal | `missing` | 当前Session只在事件结束时追加消息结果 | 崩溃在Tool中途时无法判断副作用 |
| Durable queue / pending writes | `missing` | Harness的3类队列和`pendingSessionWrites`都是内存Array | 进程退出即丢失 |
| Run/Step/Attempt/Checkpoint ID | `missing` | 当前Harness phase只有`idle/turn/compaction/branch_summary/retry` | phase不是耐久身份 |
| `Suspended`与`resume()` | `missing` | 当前AgentHarness constructor/API无此状态和方法 | Coding `/resume`是Session重开，名称相同但语义不同 |
| 单写者Lease/Claim | `missing` | 当前Session存储无跨进程运行所有权 | SQLite写安全不等于唯一执行者 |
| pi-server进程接管 | `missing` | 重启时把旧`online/starting`改成`stopped`并断开presence | 不自动respawn或恢复活动Provider/Tool/UI等待 |
| pi-web进程接管 | `missing` | Registry位于`globalThis.__piSessions` | 只跨热重载，不跨进程退出 |
| Durable AgentHarness完整方案 | `design-only` | `harness.md`定义Run、Step、Checkpoint、Suspended、`resume()`、refs和writer claim | 当前源码未实现 |
| `harness_entries`运行日志 | `design-only` | 设计稿定义operation/provider/tool/queue/deferred-write条目及SQLite表 | 当前migration无该表，entry union无这些类型 |
| Tool崩溃恢复策略 | `design-only` | 设计要求默认不重试非幂等Tool，仅retry-safe/idempotent工具可重试 | 当前没有实现与Tool metadata合同 |
| Provider流中点续传 | `missing` | durable-harness明确Provider stream不可续传 | 未来设计也是重新从安全边界处理，不恢复字节流 |
| Workflow图Checkpoint | `missing` | 当前和future harness都未提供任意Workflow节点/图进度 | future Harness Checkpoint是Agent step之间的安全点 |

### 6.1 当前`save_point`为什么不是Checkpoint

当前AgentHarness在`turn_end`时：

```text
发送turn_end事件
-> flushPendingSessionWrites()
-> 发送save_point({hadPendingMutations})
```

它有助于宿主知道“一轮消息相关的延迟写已经刷新”，但缺少4类Checkpoint最小信息：

1. 没有稳定Checkpoint ID或Run/Step ID；
2. 没有Provider/Tool在途状态；
3. 没有持久队列、Decision Request或外部副作用引用；
4. 没有新进程`restore -> Suspended -> resume/abort`入口。

所以只能称为事件级安全提示，不能称为durable Checkpoint。

### 6.2 当前Session `/resume`究竟恢复什么

`createAgentSession()`调用`buildSessionContext()`，恢复：

1. 已写入的消息；
2. 已记录的模型；
3. thinking level；
4. Compaction/Branch Summary形成的上下文。

它不恢复：

1. 已经发出但尚未提交结果的Provider请求；
2. 正在执行或结果未知的Tool；
3. 内存队列与pending writes；
4. Extension UI待答Promise；
5. Workflow节点与HITL Decision Point。

因此应准确称为“重开持久Session历史/上下文”，不能写成“恢复活动Run”。

## 7. durable harness：设计得很完整，但当前不可调用

pi仓库有3份容易混淆的材料：

| 文档 | 当前定位 | 能否作为已实现能力 |
|---|---|---|
| `packages/agent/docs/agent-harness.md` | 当前实现说明与路线；明确把通用Hook和semi-durable recovery标为Designed/Planned | 当前部分可用，Planned段不可用 |
| `packages/agent/docs/durable-harness.md` | future semi-durable harness方案和最小Spike | 不可 |
| `packages/agent/docs/harness.md` | 很完整的未来权威设计：Run、Step、Checkpoint、Suspended、resume、refs、日志与SQLite表 | 不可；文末测试与实现顺序仍是TODO |

未来设计值得保留的事实包括：

1. 接受的Prompt会成为durable operation；
2. 崩溃恢复后先进入`Suspended`，不会自动执行；
3. `resume()`从最后安全边界继续；
4. 用私有`harness_entries`记录operation、generation、tool、queue和deferred write；
5. 未完成的非幂等Tool默认不能自动重试；
6. Provider stream本身不可续传；
7. Hooks自己的HTTP/文件副作用仍需自行幂等。

但是当前源码检查结果是：

- 无`AgentHarness.create()/restore()`；
- 无`resume()`；
- 无`SuspendedOperation`运行实现；
- 无`operation_started/generation_started/tool_started/operation_finished`生产类型；
- SQLite migration无`harness_entries`；
- 当前3类消息队列和pending writes仍是内存结构。

结论：durable harness是强相关设计输入，不是pi 0.82.1的运行时能力。

## 8. 进程退出语义总表

| 退出时刻 | 当前pi能留下什么 | 新进程能做什么 | 当前不能保证什么 |
|---|---|---|---|
| Provider请求前 | 可能已有用户消息 | 重开Session重新发起新回合 | 不知道旧进程是否已经完成dispatch边界 |
| Provider流中 | 只留下此前已append条目 | 重开最后已提交上下文 | 续传原stream或证明没有重复收费/执行 |
| Assistant消息已提交后 | Assistant Message/Tool Calls可在Session中 | 重建历史并开始新回合 | 恢复旧Agent调用栈 |
| Tool执行中 | 通常只有Tool Call所在Assistant消息 | 看到曾提议Tool | 判断Tool副作用未发生、已发生或结果未知 |
| Tool Result已提交后 | Tool Result Message | 重建上下文继续新回合 | 把它关联成产品级Execution/证据账本 |
| Extension UI等待中 | 同进程Wrapper可重显请求 | 浏览器重连同一进程可回答 | 进程重启后继续等待和接受原决定 |
| pi-server退出 | `instances.json`有实例/Session元数据 | 重启后看到实例为`stopped` | 自动接管活动Run |
| pi-web退出 | JSONL历史仍在 | 新建Wrapper重开Session | 恢复旧Wrapper、SSE事件或待答Promise |

## 9. 对Chat的事实缺口，不是架构决定

与Chat已经确认的产品保证相比，当前pi还缺以下事实能力；这里仅列缺口，不决定由哪个模块补建：

| 缺口 | pi现状 | Chat为什么不能直接省略 |
|---|---|---|
| 可执行Workflow定义与版本 | `missing` | 需要知道当前节点、允许转换和恢复兼容性 |
| Product Run / Attempt身份 | `missing` | pi Session ID不能表达产品Run和重试尝试 |
| 持久Decision Request/Record | `missing` | 模型提议不能自动成为用户批准 |
| 请求内容与批准绑定 | `missing` | 必须防止旧批准被复用到已变化请求 |
| Provider/Tool在途账本 | `missing` | 崩溃后必须诚实区分未派发、已派发和结果未知 |
| Durable Checkpoint与接管 | `design-only/missing` | 新Worker不能依赖旧进程Promise和调用栈 |
| Event Journal/Cursor | `missing` | SSE重连不能只接未来事件而漏掉状态转换 |
| Tool幂等、对账、补偿 | `design-only/missing` | 外部副作用不能盲重试 |
| Evidence与产品完成门 | `missing` | `agent_end`不等于产品已完成且证据已提交 |

这些缺口说明下一步需要做Chat架构取舍，但不能反向把本轮研究写成已经选择了某套对象或Schema。

## 10. 证据索引

### 10.1 pi当前实现

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/types.ts`
- `packages/agent/src/harness/agent-harness.ts`
- `packages/agent/src/harness/types.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/storage/sqlite-node/src/sqlite/migrations/001_initial.sql`
- `packages/coding-agent/src/core/sdk.ts`
- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/core/session-manager.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/core/project-trust.ts`
- `packages/coding-agent/examples/extensions/permission-gate.ts`
- `packages/server/src/supervisor.ts`
- `packages/server/src/rpc-process.ts`

### 10.2 pi设计材料

- `packages/agent/docs/agent-harness.md`
- `packages/agent/docs/durable-harness.md`
- `packages/agent/docs/harness.md`
- `packages/coding-agent/docs/session-format.md`
- `packages/coding-agent/docs/sessions.md`

### 10.3 pi-web当前实现

- `lib/rpc-manager.ts`
- `app/api/agent/[id]/route.ts`
- `app/api/agent/[id]/events/route.ts`
- `hooks/useAgentSession.ts`

## 11. 阶段结果与后续使用

2026-08-06，用户明确要求基于已完成的pi源码研究和设计哲学进入Chat方案审核，因此本文不再是当前审核门；当前材料为[pi承载Chat Workflow/HITL/Checkpoint架构候选](../pi-workflow-hitl-checkpoint-architecture.md)。

本文后续只负责约束架构推断：

1. 不得把future durable harness写成当前可用。
2. 不得把pi Session重开写成活动Run或Workflow恢复。
3. 不得把Extension UI Promise写成持久HITL。
4. 不得把Agent loop写成pi原生Workflow图引擎。
5. 新版本或新结论必须重新核对源码、测试和版本线。
