# LA5 独立复核：群任务执行边界

日期：2026-09-21。结论：暂不验收；独立复现 3 项 P1。不是剩余问题总数承诺。

本轮按现有架构 Skill、LA5 任务书 S8/V5 和 Session 隔离合同复核，不修改业务实现、不提交、不推送、不部署。

## 已确认问题

### P1-1：群后台任务复用参与 Session

位置：`src/long-agents/conversations/work.ts:155–178`。

启动一个用户后台任务并执行完毕，记录的 `sourceSessionId` 与成员的 `sessionId` 完全相同。实现直接使用 `member.sessionId` 打开 Pi Session，并持有与群发言相同的整轮锁。因此任务过程进入群参与历史，该 Friend 后续群发言必须等待任务完成。独立 work 记录不等于独立执行 Session。

这违反任务书 S8“群内安排研究任务，用户继续群聊”，以及“后台 Task Session 继续独立”的合同。

修复：给每个 work 建立耐久、独立且受同一授权约束的 Task Session 绑定；明确群来源、参与期、根预算和返回目标；公共群只接受经过授权的结果引用。不能仅删除锁让两个执行者并发修改同一个 Pi Session。验证任务运行中同一 Friend 可以继续群发言，任务过程不成为后续群发言的隐式历史，同时恢复/撤权/结果发布仍成立。

### P1-2：运行中取消仍发布，且取消终态被覆盖

位置：`src/long-agents/conversations/work.ts:196–221`、`:254–266`。

在真实 Pi 工厂所调用的本地可控模型返回前，调用取消服务；随后模型返回 `CANCELLED_RESULT`。实际结果：`status=completed` 且公共投影包含该正文；预期为 `status=cancelled` 且不发布。

取消仅写状态，执行完成后只复核成员授权，没有复核 work 的取消状态；完成/异常写回也无预期状态保护。用户 HTTP 取消入口调用的正是该服务，属于实际可达行为。

修复：取消、发布及终态提交须有明确顺序和同一执行身份/版本约束；取消先成立则后到结果不得发布或覆盖终态。传播运行中 abort，并保护排队等待期间取消、失败迟到、进程恢复等路径。仅在模型返回后增加一次锁外检查不足以关闭竞态。

### P1-3：根预算检查与计量分离，讨论与子工作可共同超限

位置：`src/long-agents/conversations/work.ts:134–186`、`src/long-agents/conversations/dispatch.ts:66–108`。

配置 `maxModelCalls=1`，先派发讨论发言，在模型请求内暂停；再启动同根讨论派生 work，等待其领取为 running，再释放第一个模型请求。两个服务调用均成功，模型服务实际收到 **2 次**请求。不是多次请求计数推测，也不是依赖固定延迟的竞态。

讨论与 work 分别在调用前读取尚未计量的根预算，随后即使同一 Session 串行化，第二个执行者也沿用过时检查；计量发生在 prompt 返回后。两个 worker 分开运行，Session 锁不能承担根预算仲裁。

修复：以根 discussion 为单位建立原子预算占用/调用登记与恢复合同，在真正模型调用边界执行；所有发言、选择器、工具后续模型轮次与子工作共享，不能只按 prompt 结束计一次。后一项是修复时应一并核对的计量范围，本轮已独立复现的是并发超限。加入多 Friend 并行、同 Friend 等锁、取消、失败与崩溃后的计量门禁。

## 独立证据

- 现有 `scope`、`conversation-work`、`conversation-dispatch`、`conversation-orchestrator` 测试：**27/27 通过**。
- 独立探针：**3/3 触发预期不变式失败**，分别确认上述三个缺陷。
- 使用隔离 fixture、真实 Pi 装配与本地可控 HTTP 模型；没有使用正式模型或业务数据。
- 探针及日志在 `.data/verification/la5-independent-review/`：`probe.test.mjs`、`probe.log`、`regression.log`。探针保留原测试目录相对导入，复跑时复制到 `test/long-agents/la5-independent-probe.test.mjs`，执行后移除临时副本。

复跑命令：

```bash
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types --test --test-timeout=20000 test/long-agents/la5-independent-probe.test.mjs
```

本轮没有独立重跑全量 verify、真实浏览器、付费模型和 kill/restart；实施者报告的那些结果不能替代上述场景验证。已阅读相应验收脚本，浏览器中央入口/发消息和真实模型单轮非空回复属于有价值的冒烟证据，但不能据此认定任务书完整场景均验收。

## 下一步

先修复这三项协议问题并把不变式纳入永久门禁，再重跑受影响的真实 HTTP/浏览器场景及全量门禁。A 的权限边界和其他 B/C/D/E 能力未因这次 27 项通过而获得全面独立验收；LA5 仍待复核。LA6 的每 Friend 项目上下文记忆、外部渠道与自然运行验收不计入本轮缺陷。

## 第二轮：独立复核修复（2026-09-21）

结论：独立 Task Session 与首轮原子预算占用已有实际改善；取消和预算的两个既有合同仍不闭合，保留 **2 项 P1**，LA5 不验收。本轮不是所有 A–E 功能的全面验收。

### R2-P1-1：取消状态保住了，但取消后仍可公开发布

位置：`src/long-agents/conversations/work.ts:234–265`；`src/long-agents/conversations/publication.ts:148–176`。

确定性探针先持有公共根 Session 操作锁，让任务正常执行到 `assertSourceSessionAuthorized`（用 Pi SessionManager.getEntries 的观察点确认已进入发布流程，不改变条目或服务返回值）；在公开追加尚不可能发生时调用取消服务并等待返回，然后释放公共根锁。

实际：`{status: "cancelled", published: true}`；预期：`{status: "cancelled", published: false}`。公开投影中包含 `LATE_CANCEL_PUBLIC_RESULT`。

根因：work 的状态检查在发布之前且在锁外；发布锁内只检查群成员授权和 Task Session 标记，不检查/协调任务取消。末尾 finishWork CAS 只能保护终态，不能撤销已经追加的公共消息。该交错对应公共根正在处理其他追加操作时用户取消，不是构造不存在的运行入口。

修复要求：取消与公开提交需共享明确的仲裁顺序（且记录锁/Session 锁顺序一致），取消先成功则发布必须拒绝；发布先成功的语义也须明确并可恢复。补发/恢复应遵循同一合同。不要再仅增加一次锁外状态重读；对“检查之后、追加之前”的暂停点增加门禁。

### R2-P1-2：工具后续模型轮次仍可突破根预算

位置：`src/long-agents/conversations/dispatch.ts:125–149`；`src/long-agents/conversations/work.ts:197–228` 有同型逻辑。

独立探针配置 `maxModelCalls=1`，为成员显式授权原生 read，实际模型第一次返回 read 工具调用；工具执行后 Pi 请求第二轮模型，返回正文。HTTP 模型服务实际收到 **2 次**请求（探针仅检查真实请求数，不用元数据代替）。工具路径被权限拒绝也仍会产生工具结果并触发下一轮，属正常 Pi 执行链。

根因：claimDiscussionModelCall 只在 prompt 前执行一次；后续在 assistant `message_end` 中无等待地补计数，事件发生时该次请求已完成，无法阻止超限调用。原“两个执行者共享首轮预算”已修，但同一 prompt 内的调用并未受相同约束。

修复要求：每次实际 provider 请求前使用同一可等待、可拒绝的根预算准入；适配公共 Pi 装配/既有请求扩展机制，不另写 Agent Loop。讨论和派生 work 共同接入；额外计量不能 fire-and-forget 后吞错。至少覆盖首轮工具→第二轮被拒、多轮工具、多个成员竞争最后额度，并核对自动重试/其他内部请求采用的预算语义。

### 本轮证据与范围

- 实施者永久执行协议测试 8 项 + 原 conversation-work 测试 5 项：**13/13 通过**。独立 Session、基础取消和首轮并发预算回归成立。
- 新独立探针 **2/2 复现上述失败**，无超时；使用隔离 fixture、真实 Pi 与本地可控 HTTP 模型。
- `.data/verification/la5-review-round2/` 保存 `probe.test.mjs`、`probe.log`、`regression.log`；探针相对导入以临时放入 `test/long-agents/la5-round2-probe.test.mjs` 执行为准，执行命令同上（替换文件名）。失败探针未留在常规测试目录。
- 本轮未修改业务实现，未独立重跑全量 verify/真实浏览器/付费模型/进程重启；未提交、未推送、未部署。
- 下一步先修上述两个尚存的旧问题，补齐确定性交错与 provider 请求边界门禁后再复核。

## 第三轮：请求门复验通过，取消仲裁仍未闭合（2026-09-21）

结论：执行协议永久门禁 **10/10 独立通过**，已覆盖的独立 Session、首轮并发及工具续轮预算修复成立。仍确认 **1 项 P1（原取消问题未关闭）**。不表示整个 LA5 只剩这一项，也不构成 A–E 全面验收。

### R3-P1：锁内读取不等于取消与发布原子仲裁

位置：`src/long-agents/conversations/work.ts:258–262`、`:342–358`；`src/long-agents/conversations/publication.ts:168–185`。

本轮把 work 状态重读移到公共根 Session 操作锁内，但 cancelConversationWork 仅取得 works 文件锁，未与公共根发布使用同一仲裁。两条路径仍可交错。

独立探针：拦截 `assertStillAuthorized` 内部对 works.json 的真实异步读取；读取已取得 running 内容后暂停其返回（不修改内容），调用并等待 cancelConversationWork 完成，再恢复读取。最终真实公共投影仍含 `STALE_CHECK_RESULT`，任务状态为 cancelled。结果为 `{status:"cancelled",published:true}`，预期 published=false。探针没有使用固定延迟，不改变授权/状态的返回值；模拟异步读取旧快照后，另一请求完成取消的正常交错。

这与上一轮是同一取消合同：用户取消已成功且公共 append 尚未发生，后到结果不得公开。新增锁内检查只缩小窗口；“发布先成功保留历史”的语义不能解释这个反例，因为暂停时尚未 append。

修复要求：

- 取消状态转换和发布提交必须参与同一个仲裁协议。例如两者按一致顺序获取公共根/任务状态锁，或建立明确、耐久的发布领取状态与恢复合同；不能再次只加一处重读。
- 明确提交胜出的线性化点，保证取消先成功时迟到发布不可能继续；发布先成功时记录/回执/恢复保持一致。
- 不持有提交锁等待模型或 abort 完成；锁只覆盖必要的状态检查与持久提交，避免引入死锁。
- 将“最终状态读取已取得旧内容→取消成功→恢复发布”纳入确定性门禁；若修复后取消按新仲裁合法等待，探针应验证排队并正确释放暂停点，不要求取消越过正确持有的锁。

### 证据与限制

- `conversation-execution-protocol.test.mjs`：10/10 通过。
- 新独立探针：1/1 复现上述 P1，无超时。
- 证据在 `.data/verification/la5-review-round3/`：`regression.log`、`probe.log`、`probe.test.mjs`；探针运行时临时放回 `test/long-agents/la5-round3-probe.test.mjs`，使用前述 TypeScript loader 命令。
- 已核对 providerRequestGate 由公共装配透传到 Pi 请求回调，工具续轮拒绝门禁独立通过；未据此宣称所有 provider 内部网络重试策略均已验收。
- 未改业务代码，未独立重跑全量 verify、真实浏览器、付费模型或进程重启。未提交、未推送、未部署。

## 第四轮：仲裁交错通过，新增锁异常释放缺口（2026-09-21）

原取消竞态通过现有排队与先取消门禁，相关执行协议/发布/任务测试共 **20/20 独立通过**。新增仲裁锁存在 **1 项 P1**，本轮仍不验收 LA5。

### R4-P1：状态读取异常泄漏 work commit 锁，阻塞同群后续操作

位置：`src/long-agents/conversations/work.ts` 的 `assertStillAuthorized` 回调（取得 acquireWorkCommitLock 后、return release 前）。

取得锁后，readConversationWorkState 的 I/O 或解析若抛错，代码既不会进入“状态不是 running”的显式 release，也不会把 release 交给 publication 的 finally。publication 在 await guard 成功之后才进入 try/finally，因此无法释放尚未交接的锁。workCommitKey 按 Project+Conversation，而不是 workId，所以影响整个群的后续任务取消/发布，持续到进程重启。

独立故障注入：只在 assertStillAuthorized 内对 works.json 的读取注入一次 EIO，其余调用恢复正常。第一个任务按预期抛出该错误；随后取消同群第二个 queued 任务，在 500ms 探针界限内一直未完成。代码中丢失的 release 没有其他持有者能调用，故这是锁泄漏而非模型缓慢。

修复要求：从成功 acquire 到把 release 返回交接之间，以 try/catch 兜住全部失败，失败时释放并重抛；成功交接后由 publication finally 释放。不要在成功返回 release 的同时提前释放，否则原取消竞态会回来。复核读取异常、非法状态拒绝、append/flush 抛错三个位置，确认后续同群操作可以继续。

证据：`.data/verification/la5-review-round4/{probe.test.mjs,probe.log,regression.log}`。探针临时放在 `test/long-agents/la5-round4-probe.test.mjs`，运行方法同前。独立故障探针 1/1 暴露问题；未改业务实现，未重跑全量 verify/浏览器/付费模型，未提交/推送/部署。


## 第四轮缺陷收尾：复核者直接修复

用户要求停止往返返工后，本轮直接修复 R4 锁泄漏，并验证读取/append/flush 失败的锁释放。原四轮已确认缺陷关闭；另在实际场景中修正圆桌同轮上下文与停止后的迟到发布。最终全量验证、真实浏览器与额外真实模型策略结果，以及完整任务书剩余边界，统一见[第一轮整体实测](./2026-09-21-long-agent-la5-acceptance.md)。不以本历史记录早先“待返工”状态覆盖最新结果。


## 最终状态

前述缺陷与后续预算/引用/迁移/渠道/浏览器边界完成收口，独立全量验证和真实模型策略复跑通过。LA5 本地群聊已验收，范围与证据以[最终验收记录](./2026-09-21-long-agent-la5-acceptance.md)为准；历史“未验收”描述不代表当前状态。
