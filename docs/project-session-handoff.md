# Chat 项目跨 Session 续接入口

> 更新日期：2026-08-10

## 1. 当前停点

1. `origin/main`已经包含PR #20与PS1；本地`main`同时保留统一应用启动与调试修复。
2. P0、P1.1、P1.2、B1、B2和M1～M3已完成。浏览器可以真实完成“发送消息 → 选择memmy或Tencent MemoryCore → pi规划 → 用户修订/批准 → 同一Vercel Workflow恢复 → pi执行 → Product Commit → 正式回复”。
3. 本地百炼私有配置已可用于真实`qwen3.7-plus`测试；`.env`被Git忽略且权限为`0600`，任何续接过程不得输出或提交Key。
4. M2已增加正式消息整条/UTF-16选区导入、`MemoryImportWorkflow`、memmy真实add/对账、Store v3、严格Trace/Replay、最小统一UI与重启恢复；M3又增加Tencent L0接收、L0/L1只读对账与L1查询。
5. M2固定memmy真实导入与原生幂等、完整Chat响应丢失对账且SQLite唯一已经通过；最终clean代码提交`3bcb7b7`的真实浏览器1/1通过（浏览器2.8分钟、命令3.1分钟），Import Replay 6事件、Run Replay 103事件、真实`qwen3.7-plus`规划与执行均成功。
6. 当前标准入口是仓库拥有的`pnpm dev/dev:debug`；VS Code只有`Chat：调试应用`一个薄入口。真实F5已验证5个服务Ready、专属Profile Chrome、TypeScript附加、遗留浏览器自动收敛，停止后浏览器和7个固定端口释放。
7. Tencent真实Adapter已经合入；PS1又完成了对话建项、真实Git/文档/脚本观察、Project账本、管理候选与响应式UI。当前仍没有完整Stage/Milestone/Iteration推进、Planning Project Context和用户规则集。
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
Project Management Message -> revision/Hash Candidate -> 用户确认 -> Action/Decision/Contribution

Trace + Product Store + Version Evidence -> Replay
```

固定本地端口为Web `43110`、API `43111`、Workflow `43112`、memmy `18960`、MemoryCore `18970`、API Inspector `43120`和Workflow Inspector `43121`。启动前只清理身份确认属于本项目的旧进程；未知占用只报告、不杀进程。

## 4. 下一阶段目标与依赖

当前是一个阶段目标，不是一个大PR。先复核真实参考项目与既有分析，再冻结小任务书；建议依赖顺序如下，最终编号以任务书为准：

1. **参考证据与共享边界**：定位腾讯Memory、memory-agent及其他已调研项目，定位BMAD源码/文档和既有分析，明确采用、调整、拒绝；只定义三个能力真正共享的身份、来源、版本和选择证据，不做万能Context Service。
2. **Memory单后端查询纵向链**：M1已由PR #10合入，真实memmy查询、Application Port、Workflow节点、Trace、最小UI和真实E2E均完成。
3. **Memory显式导入纵向链**：M2已由PR #11合入，完成有来源、目标、幂等、结果未知对账和重启恢复的真实memmy导入。
4. **第二真实Memory后端**：M3已由PR #12合入，固定Tencent MemoryCore真实服务验证了L0接收、L1查询、强隔离与异步物化语义。
5. **Project Solution纵向链**：PS1对话建项、真实Resource和项目账本已完成；当前下一任务是PS2 Stage/Milestone/Iteration与Project Update，随后推进PS3真实资源执行和PS4维护/Correct Course。
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
main已完成真实规划—确认—执行、memmy查询/导入、Tencent MemoryCore第二后端，以及PS1对话建项、真实Resource和Project账本闭环。
仓库统一`pnpm dev/dev:debug`已经过终端与真实VS Code F5验证；VS Code不再拥有或复制服务生命周期，不能用静态配置测试替代真实F5验收。
下一阶段接着建设：PS2 Stage/Milestone/Iteration与Project Update、
带标签且可主动选择的用户规则集。先读取本地参考项目与既有分析，给每个设计写出采用/调整/拒绝依据，
再按依赖拆成可独立合并的小任务；实现使用worktree+PR，纵向完成门必须包含真实服务、真实模型和浏览器E2E。
不要建立万能Context Service，不要把外部Memory、BMAD或Prompt当成Chat产品事实源。
```

## 8. 参考原型与组合策略冻结输入

本节只冻结独立设计原型和下一任务输入，**没有修改生产 UI**。

1. 唯一登记入口：[`docs/design/references/README.md`](./design/references/README.md)。6 × 7 事实场景矩阵：[`reference-scenario-matrix-v0.1.md`](./design/references/reference-scenario-matrix-v0.1.md)。
2. 工作 branch：`codex/reference-prototype-combinations`；worktree：`/Users/xulater/.codex/worktrees/b469/Chat`；共同 freeze commit：`3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb`。
3. Heptabase Workbench：`docs/design/reference-implementations/heptabase`；本轮 URL `http://127.0.0.1:4175/`；模型 / UI 合同 `15/15`、Sites `4/4`、仓库内 IAB browser E2E gates `9/9`，桌面 / 移动 console `0`、残余 `P0/P1/P2 = 0`。
4. 组合原型：`docs/design/combination-prototypes`；本轮 URL 根 `http://127.0.0.1:4176/`；Project / Today / Workbench 精确 query 见统一登记入口。合同 `17/17`、Sites `4/4`；真实浏览器 6 个桌面 / 移动表面、10 条核心路径，`391 × 844` 无横溢出、无未命名 / 小于 44px 的启用控件、console `0`，残余 `P0/P1/P2 = 0`。
5. 数量决定：冻结 3 套——Project Room（持续高上下文）、Today Rhythm（个人主动选择）、Evidence Workbench（中断式高风险监督）。2 套会混合互斥注意力合同；4 套会把 Resource / Evidence 从 Project 重复拆出。
6. 对象合同：三套共享 Project / Work / Action / Resource / Evidence / Decision / Run / Participant 的稳定 ID 和返回锚点；Today / Feed / Canvas 只保存投影，不拥有权威事实。正式 Decision、accepted Candidate 和 reconciliation 无通用 Undo；`outcome_unknown` 只有 Query / Reconcile / Escalate。
7. 视觉合同：Chat 黑白骨架、小面积暖色 Agent 标识、Phosphor 图标、统一 token / 字体 / 间距 / 层级 / 键盘语义；桌面与移动是真实响应式结构，不缩放 Things 窗口或 Heptabase Canvas。
8. 参考缺口：Microsoft Agent Feed freeze `eed0aa0e4b9fec38fcf7e4eb6684a23e9897e8aa` 的实现仍有 `2 P1 + 4 P2`；Basecamp / Things / Linear 也有矩阵列出的复用阻断。下一任务不得复制这些 CSS 或动作语义。
9. 依赖任务 2：thread `019fe738-1b0d-70e3-932c-cdad3b702124`，worktree `/Users/xulater/.codex/worktrees/35f2/Chat`。稳定输入是本节、统一登记入口、矩阵、组合 `README.md` / `design-qa.md` 与上述 freeze commit；冻结完成后已经由本任务直接发消息交接，不需要用户手工搬运。
