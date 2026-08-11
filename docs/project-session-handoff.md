# Chat 项目跨 Session 续接入口

> 更新日期：2026-08-11

## 1. 当前停点

1. `origin/main`已经包含PR #22与PS2.1，当前merge commit为`71ac8282318230a033a8826832d312352b5fdf72`；下一实现任务从该基线开始。
2. P0、P1.1、P1.2、B1、B2和M1～M3已完成。浏览器可以真实完成“发送消息 → 选择memmy或Tencent MemoryCore → pi规划 → 用户修订/批准 → 同一Vercel Workflow恢复 → pi执行 → Product Commit → 正式回复”。
3. 本地百炼私有配置已可用于真实`qwen3.7-plus`测试；`.env`被Git忽略且权限为`0600`，任何续接过程不得输出或提交Key。
4. M2已增加正式消息整条/UTF-16选区导入、`MemoryImportWorkflow`、memmy真实add/对账、Store v3、严格Trace/Replay、最小统一UI与重启恢复；M3又增加Tencent L0接收、L0/L1只读对账与L1查询。
5. M2固定memmy真实导入与原生幂等、完整Chat响应丢失对账且SQLite唯一已经通过；最终clean代码提交`3bcb7b7`的真实浏览器1/1通过（浏览器2.8分钟、命令3.1分钟），Import Replay 6事件、Run Replay 103事件、真实`qwen3.7-plus`规划与执行均成功。
6. 当前标准入口是仓库拥有的`pnpm dev/dev:debug`；VS Code只有`Chat：调试应用`一个薄入口。真实F5已验证5个服务Ready、专属Profile Chrome、TypeScript附加、遗留浏览器自动收敛，停止后浏览器和7个固定端口释放。
7. Tencent真实Adapter已经合入；PS1完成对话建项、真实Git/文档/脚本观察、Project账本、管理候选与响应式UI；PS2.1又完成Stage Goal / Milestone、负责人Project Update与严格状态转换。当前仍没有Shaping Proposal、Iteration Commitment、Scope / Gate / Review、Planning Project Context和用户规则集。
8. 旧会话遗留的治理文档和设计截图已经恢复；不能再使用“M1待审核”“B2待真实Key验收”或“P1.2待实现”等旧状态。

## 2. 新 Session 读取顺序

1. [AGENTS.md](../AGENTS.md)
2. [PROJECT_LESSONS.md](../PROJECT_LESSONS.md)
3. [Chat概念空间](./product/concept-space.md)
4. [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
5. [PROJECT_STATE.md](../PROJECT_STATE.md)
6. [PROJECT_PLAN.md](../PROJECT_PLAN.md)
7. [Chat项目飞轮](./product/flywheel.md)
8. [设计规范](./product/design-guidelines.md)
9. [仓库目录与关键文件地图](./architecture/repository-map.md)
10. [前后端交互现状](./architecture/frontend-backend-interaction.md)
11. [Workflow运行设计现状](./architecture/runtime-workflows.md)
12. [技术合同](./architecture/technology-contract.md)
13. [系统边界](./architecture/system-boundaries.md)
14. 本文件与当前任务书

## 3. 已证明的技术基线

```text
React / PWA / TanStack Query
        |
REST Query / Command
        v
Hono -> Application -> JSON Product Store
                    -> Outbox / Runtime Binding
        |
PlanningExecutionWorkflow
        |
Memory Query -> ContextPackage -> pi Planner -> HITL Hook -> pi Executor -> Validation -> Product Commit
        |
Bailian qwen3.7-plus

Message Selection -> MemoryImportIntent/Outbox -> MemoryImportWorkflow
                  -> memmy L2 materialized
                  -> Tencent L0 accepted -> L0/L1只读reconcile

Project Intake Message -> ProjectIntakeWorkflow -> pi Project Understanding + Resource Observe
                       -> Candidate HITL -> Project/Stage/Work/Action/Decision/Observation账本
Project Advancement Message -> revision/Hash Candidate -> 用户确认 -> Stage/Milestone/Update/Decision

Trace + Product Store + Version Evidence -> Replay
```

固定本地端口为Web `43110`、API `43111`、Workflow `43112`、memmy `18960`、MemoryCore `18970`、API Inspector `43120`和Workflow Inspector `43121`。启动前只清理身份确认属于本项目的旧进程；未知占用只报告、不杀进程。

## 4. 下一阶段目标与依赖

当前是一个阶段目标，不是一个大PR。先复核真实参考项目与既有分析，再冻结小任务书；建议依赖顺序如下，最终编号以任务书为准：

1. **参考证据与共享边界**：定位腾讯Memory、memory-agent及其他已调研项目，定位BMAD源码/文档和既有分析，明确采用、调整、拒绝；只定义三个能力真正共享的身份、来源、版本和选择证据，不做万能Context Service。
2. **Memory单后端查询纵向链**：M1已由PR #10合入，真实memmy查询、Application Port、Workflow节点、Trace、最小UI和真实E2E均完成。
3. **Memory显式导入纵向链**：M2已由PR #11合入，完成有来源、目标、幂等、结果未知对账和重启恢复的真实memmy导入。
4. **第二真实Memory后端**：M3已由PR #12合入，固定Tencent MemoryCore真实服务验证了L0接收、L1查询、强隔离与异步物化语义。
5. **Project Solution纵向链**：PS1与PS2.1已经完成对话建项、真实Resource、项目账本、Stage Goal / Milestone和负责人Project Update；当前下一任务是PS2.2 Shaping Proposal / Iteration Commitment，随后由PS2.3推进Scope / Gate / Review，再进入PS3真实资源执行和PS4维护 / Correct Course。
6. **用户规则纵向链**：实现Rule/RuleRevision/Tag/Scope，统一管理界面、对话主动勾选/标签筛选、合理自动召回和规划节点注入；记录采用了哪些规则及版本。
7. **组合验收**：真实用户场景同时使用项目上下文、选择规则和Memory查询完成规划—确认—执行，页面刷新后能从权威事实恢复，公开面不泄漏外部服务或Runtime私有身份。

每个实现任务使用独立worktree、`codex/`分支和PR，控制在约0.5～2个单人开发日。小任务在最接近代码边界的位置运行合同/状态机测试；真实服务、真实模型和浏览器E2E在形成可用纵向结果时运行，不在每次机械改动后重复付费。

## 5. 三类能力的硬边界

1. 外部Memory服务拥有其内部记录和检索索引；Chat拥有本次查询条件、返回来源、用户选择、采用证据和导入意图。召回内容不能未经筛选直接变成长期产品事实。
2. Shape Up与BMAD都是方法输入，不是Chat事实源。Chat拥有Project、Stage Goal/Milestone、Iteration、Work/Scope/Action、Resource、Participant、Contribution、Decision、Evidence、Update和Context Package；小团队不强制六周，非软件/运维项目不强制BMAD Artifact或Iteration。
3. 用户规则是可修订、可删除、带标签与场景范围的产品对象，不是藏在Prompt里的不可见文本。自动维护只能提出候选，正式规则变化必须经过确定性校验和必要的用户确认。
4. 规划节点只接收本轮明确选中的版本化Context Package；完整会话、全部Memory、全部项目文档和全部规则不能默认塞进模型上下文。
5. Trace继续只记录系统路径、选择结果、版本、Hash、耗时、错误与对象引用，不复制会话、Memory正文、项目文档正文、规则正文或Provider Payload。

## 6. 当前已知风险

1. 必须先确认本机真实参考项目的位置、版本和可运行接口，不能凭项目名称猜Schema或API。
2. 多个Memory项目可能对“记忆”的粒度、身份、写入和检索语义不同；只有第二个真实Adapter跑通后才能证明公共接口稳定。
3. BMAD文档结构可能偏软件开发项目，Chat需要保留阶段与推进门的价值，同时避免把所有项目强制成同一模板。
4. 规则自动选择与Memory召回都可能污染规划上下文，必须有来源、版本、预算、排序和用户覆盖机制。
5. `@workflow/core@4.8.1`把Hook赢得`Promise.race`后已产生`wait_created`的败选sleep误报为uncommitted；local world在Run完成后已删除wait，无功能/耐久缺口。后续升级SDK时应以官方race场景回归，不为消警告删除审批过期语义。
6. 固定memmy提交的供应链审计仍有8项已知漏洞；它只用于loopback、物理隔离SQLite的本地合同/E2E，不是生产依赖或服务器部署产物。

## 7. 可复制续接指令

```text
继续Chat项目。按AGENTS.md规定顺序读取治理文件和docs/project-session-handoff.md。
main已完成真实规划—确认—执行、memmy查询/导入、Tencent MemoryCore第二后端、PS1对话建项/真实Resource/Project账本，以及PS2.1 Stage Goal/Milestone/负责人Project Update闭环。
仓库统一`pnpm dev/dev:debug`已经过终端与真实VS Code F5验证；VS Code不再拥有或复制服务生命周期，不能用静态配置测试替代真实F5验收。
下一阶段接着建设：PS2.2 Shaping Proposal/Iteration Commitment，随后PS2.3 Scope/Gate/Review，
带标签且可主动选择的用户规则集。先读取本地参考项目与既有分析，给每个设计写出采用/调整/拒绝依据，
再按依赖拆成可独立合并的小任务；实现使用worktree+PR，纵向完成门必须包含真实服务、真实模型和浏览器E2E。
不要建立万能Context Service，不要把外部Memory、BMAD或Prompt当成Chat产品事实源。
```

## 8. 参考原型与组合策略冻结输入

本节只冻结独立设计原型和下一任务输入，**没有修改生产 UI**。

1. 唯一登记入口：[`docs/design/references/README.md`](./design/references/README.md)。6 × 7 事实场景矩阵：[`reference-scenario-matrix-v0.1.md`](./design/references/reference-scenario-matrix-v0.1.md)。
2. Heptabase 独立 freeze：branch `codex/reference-prototype-combinations`，commit `3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb`，实现 `docs/design/reference-implementations/heptabase`；合同 / Sites / browser gates `28/28`，`P0/P1/P2 = 0`。
3. 当前组合 branch：`codex/literal-reference-compositions`；worktree：`/Users/xulater/.codex/worktrees/b469/Chat`；literal combination freeze：`58257710cd78285b7616067ba6685271e0c741ff`。
4. 当前组合不是抽象重绘。实现 `docs/design/combination-prototypes` 直接包含 `references/{basecamp,linear,things,hey,agent-feed,heptabase}`；宿主只做 canonical scene、唯一 owner 与主题切换。此前 `Project Room / Today Rhythm / Evidence Workbench` 方向已废弃，不再是任务输入。
5. 数量决定：冻结 3 套 ownership 变体——`room-linear`（Basecamp Project / Room + Linear Work / Update）、`room-basecamp`（Basecamp Project / Room / Work + Linear Update）、`work-linear`（Linear Project / Work / Update + Basecamp Room）。Things / HEY / Agent Feed / Heptabase 在三套中固定主责 Today / Calendar / Agents / Knowledge。
6. 本地体验根：`http://127.0.0.1:4177/`。8 个 scene：`projects / room / work / updates / today / calendar / agents / knowledge`。主题：`source / warm-room / quiet-day / graphite-ops / common-thread`。
7. 验证：宿主 / theme `15/15` + 六来源 `88/88` + Sites `4/4` = `107/107`；production build `4805 modules`；desktop theme `30/30`、mobile theme `40/40`、state continuity `6/6`，console `0`，残余 `P0/P1/P2 = 0`。
8. 对象合同：每套只有一个 Project index、Work、Update、Today、Calendar、Agent supervision、Knowledge owner；Action / Event、Feed / authoritative record、Card material / Evidence fact 不合并。`chat:theme` 只换视觉 token，不重放 route 或丢本地状态。
9. 参考缺口：冻结 Agent Feed、Basecamp、Things、Linear 的原始 P1/P2 仍记录在矩阵第 6.3 节；组合副本已经用 canonical route、移动适配、动作裁剪和 44px 合同收口，下一任务只能复用当前组合路径，不能倒退复制冻结缺陷。
10. 依赖任务 2：thread `019fe738-1b0d-70e3-932c-cdad3b702124`，worktree `/Users/xulater/.codex/worktrees/35f2/Chat`。稳定输入是本节、统一登记入口、矩阵第 11～14 节、组合 `README.md` / `design-qa.md` 与 literal freeze commit；冻结后由本任务直接发消息交接，不需要用户手工搬运。

## 9. Microsoft Agent Feed Human Loop v0.2 冻结输入

本节只登记独立参考原型，**没有修改生产 UI，也没有 push、deploy 或创建 PR**。

1. branch：`codex/microsoft-agent-feed-human-loop-v0.2`；worktree：`/Users/xulater/Code/Chat-agent-feed-human-loop-v02`。
2. implementation freeze：`8d30cfe5651665407bf6e6dddc0339c075453704`；实现：`docs/design/reference-implementations/microsoft-agent-feed-human-loop-v0.2`。
3. 本地体验：`http://127.0.0.1:4184/`；核心 task ID 是 `task-decision-retry`、`task-assistance-source`、`task-data-project-update`、`task-outcome-unknown`、`task-delegation-evidence`。
4. 完成门：model/interaction `31/31` + Sites `4/4` = `35/35`；Vite build `223 modules`；1440×900 / 391×844 `scrollWidth = clientWidth`；启用控件 `<44px = 0`；干净浏览器 console warn/error `0`；`P0/P1/P2 = 0`。
5. Decision 路径固定为 `revision 7 → structured feedback → revision 8 + diff/new hash/new Evidence/response → Decision fact → Run resume → authoritative record`；stale revision 被拒绝。
6. Assistance、candidate、outcome_unknown、delegation 分别拥有独立命令、waiting owner 与终态；没有万能 Approve / Complete / Undo，unknown side effect 没有普通 Retry。
7. Agent—Agent handoff 展示 parent/delegated task、dependency、participants、visibility、current owner、returned Evidence；coordination 明确不是 Product fact，人可加方向、改派或停止。
8. Microsoft Take：Fluent / Power Apps 三栏、typed feed、side/full/mobile hierarchy、Agent + Project 过滤、related record + Back。Chat Adapt：fact-before-resume、structured composer、typed reconciliation/delegation、权威 record。Refuse：Feed 事实源、通用聊天、coordination 冒充事实、硬编码 Insights、dismissed 可编辑、无限动效。
9. 组合原型后续稳定输入：v0.2 `README.md`、`current-audit.md`、`design-qa.md`、`src/agentFeedModel.js`、核心 fixture ID 与上述 freeze。当前 `docs/design/combination-prototypes/references/agent-feed` 仍是此前收口副本；后续接入必须独立任务验证 canonical route、theme bridge 和组合状态连续性，不能直接复制内存 fixture 到生产。
