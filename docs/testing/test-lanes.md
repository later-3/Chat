# Chat 测试 lane

`config/test-lanes.json`是正式测试文件与根级测试命令的机器可检查索引；它不改变测试的事实
Owner。测试继续靠近对应Workspace，lane runner只负责分类、批次隔离、去凭据环境和度量。

## Lane 与运行政策

| lane | 责任 | 自动运行 |
| --- | --- | --- |
| `core` | 纯规则、Domain与核心单元测试 | 每个PR、main的统一`ci` Job |
| `contract` | Schema、API、架构、Store迁移与CI配置合同 | 每个PR、main的统一`ci` Job |
| `integration` | Local World、跨包、进程与恢复纵向 | 每个PR、main的统一`ci` Job |
| `compat` | 历史Workflow、Store和暂停Memory兼容 | 每个PR、main的统一`ci` Job |
| `beta` | Workbench等Beta纵向 | 仅显式手工 |
| `browser` | 无付费Provider的确定性Chromium | PR/main跑一条系统接缝；完整套件定时或手工 |
| `paid` | 真实模型与Provider | 仅显式手工，永不进入普通CI |
| `external` | 真实Memory及其他外部写 | 仅显式手工，永不进入普通CI |

常用入口：

```bash
pnpm test:core
pnpm test:contract
pnpm test:integration
pnpm test:compat
pnpm test:beta
pnpm test:browser
pnpm test:all:deterministic
pnpm verify:core
```

`pnpm test`等于`test:all:deterministic`。runner会删除`NODE_OPTIONS`，按最多6个Vitest文件或
12个Node测试文件分批，以最多2个Worker且关闭文件并行的独立进程执行。结果写入被Git忽略的
`test-results/test-lanes/`，包含文件数、测试数、墙钟、进程树最大RSS和最慢10项。

新增、删除或改名正式测试时必须同步Manifest。合同门拒绝未分类、重复分类、不存在文件、根
测试脚本漏分配、lane命令漂移和task引用缺失。不要用全局8 GiB `NODE_OPTIONS`掩盖聚合OOM。

## 付费与外部写门

付费命令必须同时满足以下3项，安全门才会加载凭据并启动子进程：

1. 命令名包含`:paid`；
2. `CHAT_ALLOW_PAID_TESTS=1`；
3. 该Provider声明的精确凭据存在。

例如百炼门使用`test:paid:provider:bailian*`和`DASHSCOPE_API_KEY`。真实外部写命令使用
`:external:`命名、`CHAT_ALLOW_EXTERNAL_WRITES=1`以及服务专用开关。普通CI统一清空Provider、GitHub、SSH和动态模型Key，关闭
Memory、Workbench、paid与external开关。仅本机存在Key不会触发凭据加载或外部子进程。

父级launcher读取`.env`后会重新清空全部Provider/base URL、Memory、GitHub/npm/SSH及动态模型Key，
只恢复本命令声明的精确Credential、全局mode、服务开关和命令名。真实Memory与Bailian入口还在任何Key
读取、文件删除/写入、子进程或网络之前执行child-side精确命令门；绕过launcher直接运行会非零退出且无副作用。

Browser场景、唯一Harness与子进程环境边界见[确定性Browser lane](./browser-lane.md)。实际
case数由Browser合同测试直接解析当前spec，不在文档重复维护。

## 基线度量

测试文件与项数会随合同测试同步变化，因此文档不维护易漂移的手抄总数。每次运行lane都会生成
`test-results/test-lanes/<lane>.json`，其中的`fileCount`、`testCount`、`wallMs`、`peakRssBytes`和
`slowest10`是该commit、该机器、默认Node Heap下的唯一度量证据；最终报告从本轮4个JSON汇总，
不得沿用历史快照。RSS是受监督子进程树采样总和，不是单个Node Heap上限。

GitHub普通流水线只有一个稳定命名的`ci` Job：`pnpm bootstrap`只准备一次固定Pi/DSH与Chat，
随后运行根build/lint/format/typecheck/test、一条Capability Governance浏览器接缝以及安装后
启动/健康/停止。完整Browser与标准`pnpm audit --prod`属于`maintenance`定时/手工流水线。
Pi、DSH各自在自己的Fork运行全量CI，Chat不重复执行其整仓测试。

## 测试瘦身证据

删除的`prompt-review-continuation.poc.test.ts`是任务前PoC，不再作为第二套执行语义。它的4项
风险分别由生产路径测试承接：

| PoC风险 | 生产测试证据 |
| --- | --- |
| 审核通过只发送一次 | `prompt-review-gate.test.ts`的“批准一次只发送一次”及Direct Executor Service消费测试 |
| 拒绝时Provider调用为0 | `prompt-review-gate.test.ts`的拒绝零调用场景 |
| Tool Result后进入下一轮审核 | `prompt-review-gate.test.ts`的Tool Result后二次审核场景 |
| 重启后同一Payload Hash恢复 | Checkpoint重建与Later Pi AgentSession恢复场景 |

正式套件还覆盖响应丢失、permit unknown、Payload漂移、dispatching重启、Provider完成后崩溃、
Assistant tail拒绝及Service/Client/Workflow/API/Store链，因此删除PoC不损失恢复或幂等不变量。

重复alias `test:memory:memmy-real-import`与`test:e2e:planning-execution:real`已删除；真实实现分别
由明确的`:external:`与`:paid`入口保留。`B2`、`M1`、`S7`仍标识冻结历史代际和Fixture含义，
机械改名会丢失兼容语境，因此保留并归入`compat`或相应事实Owner lane。
