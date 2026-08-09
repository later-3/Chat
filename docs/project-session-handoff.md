# Chat 项目跨 Session 续接入口

> 更新日期：2026-08-09

## 1. 当前停点

1. `main`已经包含PR #12与PR #13；精确提交以`origin/main`为准。统一应用启动与调试已在`codex/app-dev-runtime`完成本地实现和真实验收，待独立PR。
2. P0、P1.1、P1.2、B1、B2和M1～M3已完成。浏览器可以真实完成“发送消息 → 选择memmy或Tencent MemoryCore → pi规划 → 用户修订/批准 → 同一Vercel Workflow恢复 → pi执行 → Product Commit → 正式回复”。
3. 本地百炼私有配置已可用于真实`qwen3.7-plus`测试；`.env`被Git忽略且权限为`0600`，任何续接过程不得输出或提交Key。
4. M2已增加正式消息整条/UTF-16选区导入、`MemoryImportWorkflow`、memmy真实add/对账、Store v3、严格Trace/Replay、最小统一UI与重启恢复；M3又增加Tencent L0接收、L0/L1只读对账与L1查询。
5. M2固定memmy真实导入与原生幂等、完整Chat响应丢失对账且SQLite唯一已经通过；最终clean代码提交`3bcb7b7`的真实浏览器1/1通过（浏览器2.8分钟、命令3.1分钟），Import Replay 6事件、Run Replay 103事件、真实`qwen3.7-plus`规划与执行均成功。
6. 当前标准入口是仓库拥有的`pnpm dev/dev:debug`；VS Code只有`Chat：调试应用`一个薄入口。真实F5已验证5个服务Ready、Chrome调试和TypeScript附加，停止后7个固定端口释放。
7. Tencent真实Adapter已经合入；当前仍没有BMAD项目上下文和用户规则集。所有后续设计必须有参考项目依据、代码有中文注释、纵向里程碑使用真实模型和严格E2E。
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

Trace + Product Store + Version Evidence -> Replay
```

固定本地端口为Web `43110`、API `43111`、Workflow `43112`、memmy `18960`、MemoryCore `18970`、API Inspector `43120`和Workflow Inspector `43121`。启动前只清理身份确认属于本项目的旧进程；未知占用只报告、不杀进程。

## 4. 下一阶段目标与依赖

当前是一个阶段目标，不是一个大PR。先复核真实参考项目与既有分析，再冻结小任务书；建议依赖顺序如下，最终编号以任务书为准：

1. **参考证据与共享边界**：定位腾讯Memory、memory-agent及其他已调研项目，定位BMAD源码/文档和既有分析，明确采用、调整、拒绝；只定义三个能力真正共享的身份、来源、版本和选择证据，不做万能Context Service。
2. **Memory单后端查询纵向链**：M1已由PR #10合入，真实memmy查询、Application Port、Workflow节点、Trace、最小UI和真实E2E均完成。
3. **Memory显式导入纵向链**：M2已由PR #11合入，完成有来源、目标、幂等、结果未知对账和重启恢复的真实memmy导入。
4. **第二真实Memory后端**：M3已由PR #12合入，固定Tencent MemoryCore真实服务验证了L0接收、L1查询、强隔离与异步物化语义。
5. **项目上下文纵向链（下一任务）**：基于BMAD的阶段、状态、产物和推进门设计Chat自己的Project/Work/Document Manifest/Context Package，并让Workflow可读取、维护候选和提交用户确认后的变化。
6. **用户规则纵向链**：实现Rule/RuleRevision/Tag/Scope，统一管理界面、对话主动勾选/标签筛选、合理自动召回和规划节点注入；记录采用了哪些规则及版本。
7. **组合验收**：真实用户场景同时使用项目上下文、选择规则和Memory查询完成规划—确认—执行，页面刷新后能从权威事实恢复，公开面不泄漏外部服务或Runtime私有身份。

每个实现任务使用独立worktree、`codex/`分支和PR，控制在约0.5～2个单人开发日。小任务在最接近代码边界的位置运行合同/状态机测试；真实服务、真实模型和浏览器E2E在形成可用纵向结果时运行，不在每次机械改动后重复付费。

## 5. 三类能力的硬边界

1. 外部Memory服务拥有其内部记录和检索索引；Chat拥有本次查询条件、返回来源、用户选择、采用证据和导入意图。召回内容不能未经筛选直接变成长期产品事实。
2. BMAD是项目推进方法和参考实现，不是Chat的事实源。Chat必须拥有Project阶段、状态、文档清单、版本、决定和Context Package，且允许不同项目裁剪结构。
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
main已完成真实规划—确认—执行、memmy查询/导入和Tencent MemoryCore第二后端闭环。
仓库统一`pnpm dev/dev:debug`已经过终端与真实VS Code F5验证；VS Code不再拥有或复制服务生命周期，不能用静态配置测试替代真实F5验收。
下一阶段接着建设：BMAD启发的项目上下文、
带标签且可主动选择的用户规则集。先读取本地参考项目与既有分析，给每个设计写出采用/调整/拒绝依据，
再按依赖拆成可独立合并的小任务；实现使用worktree+PR，纵向完成门必须包含真实服务、真实模型和浏览器E2E。
不要建立万能Context Service，不要把外部Memory、BMAD或Prompt当成Chat产品事实源。
```
