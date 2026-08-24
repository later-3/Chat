# Chat 测试 lane

`config/test-lanes.json`是正式测试文件与根级测试命令的机器可检查索引；它不改变测试的事实
Owner。测试继续靠近对应Workspace，lane runner只负责分类、批次隔离、去凭据环境和度量。

## Lane 与运行政策

| lane | 责任 | 自动运行 |
| --- | --- | --- |
| `core` | 纯规则、Domain与核心单元测试 | 每个PR、main |
| `contract` | Schema、API、架构、Store迁移与CI配置合同 | 每个PR、main |
| `integration` | Local World、跨包、进程与恢复纵向 | 每个PR、main |
| `compat` | 历史Workflow、Store和暂停Memory兼容 | 相关PR、main、夜间 |
| `beta` | Workbench等Beta纵向 | 仅显式手工 |
| `browser` | 无付费Provider的确定性Chromium | 产品变更门 |
| `paid` | 真实模型与Provider | 仅显式手工，永不进入普通CI |
| `external` | 真实Plane、Memory及其他外部写 | 仅显式手工，永不进入普通CI |

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
`:external:`命名、`CHAT_ALLOW_EXTERNAL_WRITES=1`以及服务专用开关；Plane还要求
`CHAT_PLANE_CE_API_TOKEN`。普通CI统一清空Provider、GitHub、Plane、SSH和动态模型Key，关闭
Memory、Workbench、paid与external开关。仅本机存在Key不会触发凭据加载或外部子进程。

## Phase 2 基线度量

2026-08-24在默认Node Heap、同一开发机上重新盘点：原根门为196个正式测试文件、1,532项
测试、337.81秒、进程树最大RSS 4,305,469,440字节；其中`packages/testing`单次聚合曾接近
默认Heap边界。分lane后的确定性测试为183个文件、1,533项，单lane结果如下：

| lane | 文件 | 测试 | 墙钟 | 最大RSS |
| --- | ---: | ---: | ---: | ---: |
| core | 35 | 235 | 36.34秒 | 954,269,696字节 |
| contract | 56 | 534 | 75.65秒 | 917,569,536字节 |
| integration | 64 | 530 | 183.54秒 | 4,200,054,784字节 |
| compat | 28 | 234 | 62.77秒 | 2,365,997,056字节 |

每次正式交付以新运行生成的JSON为准，不沿用此快照冒充当前结果。

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
