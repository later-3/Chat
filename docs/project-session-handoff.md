# Chat 项目跨 Session 续接入口

> 更新日期：2026-08-08

## 1. 当前停点

1. `main`已合入PR #7，当前提交`06d1177bdfd0f78bd84430d2eb57513b7638d08c`；本地与远端同步。
2. P0、P1.1、P1.2、B1、B2已完成。浏览器可以真实完成“发送消息 → pi规划 → 用户修订/批准 → 同一Vercel Workflow恢复 → pi执行 → Product Commit → 正式回复”。
3. 本地百炼私有配置已可用于真实`qwen3.7-plus`测试；`.env`被Git忽略且权限为`0600`，任何续接过程不得输出或提交Key。
4. B2真实Provider测试3/3、真实浏览器E2E 1/1、326项普通测试和全部CI已通过。真实运行Trace有124条事件，Replay完整性错误为0。
5. 当前没有Memory Adapter、BMAD项目上下文和用户规则集。用户已经要求逐步完成这三类真实能力，并要求所有设计有参考项目依据、代码有中文注释、纵向里程碑用真实模型和严格E2E验证。
6. 旧会话遗留的治理文档和设计截图已经恢复；不能再使用“B2待真实Key验收”或“P1.2待实现”等旧状态。

## 2. 新 Session 读取顺序

1. [AGENTS.md](../AGENTS.md)
2. [PROJECT_LESSONS.md](../PROJECT_LESSONS.md)
3. [Chat概念空间](./product/concept-space.md)
4. [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
5. [PROJECT_STATE.md](../PROJECT_STATE.md)
6. [PROJECT_PLAN.md](../PROJECT_PLAN.md)
7. [Chat项目飞轮](./product/flywheel.md)
8. [设计规范](./product/design-guidelines.md)
9. [技术合同](./architecture/technology-contract.md)
10. [系统边界](./architecture/system-boundaries.md)
11. 本文件与当前任务书

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
pi Planner -> HITL Hook -> pi Executor -> Validation -> Product Commit
        |
Bailian qwen3.7-plus

Trace + Product Store + Version Evidence -> Replay
```

固定本地调试端口为Web `43110`、API `43111`、Workflow `43112`、Inspector `43120/43121`。启动前只清理身份确认属于本项目的旧进程；未知占用只报告、不杀进程。

## 4. 下一阶段目标与依赖

当前是一个阶段目标，不是一个大PR。先复核真实参考项目与既有分析，再冻结小任务书；建议依赖顺序如下，最终编号以任务书为准：

1. **参考证据与共享边界**：定位腾讯Memory、memory-agent及其他已调研项目，定位BMAD源码/文档和既有分析，明确采用、调整、拒绝；只定义三个能力真正共享的身份、来源、版本和选择证据，不做万能Context Service。
2. **Memory单后端纵向链**：先接通一个真实服务的查询与导入，从Application Port到Workflow节点、Trace、最小UI和真实E2E完整证明。
3. **Memory多后端适配**：接入第二个真实项目，验证Adapter抽象确实覆盖差异；用户能选择后端，配置和密钥不进入浏览器或产品正文。
4. **项目上下文纵向链**：基于BMAD的阶段、状态、产物和推进门设计Chat自己的Project/Work/Document Manifest/Context Package，并让Workflow可读取、维护候选和提交用户确认后的变化。
5. **用户规则纵向链**：实现Rule/RuleRevision/Tag/Scope，统一管理界面、对话主动勾选/标签筛选、合理自动召回和规划节点注入；记录采用了哪些规则及版本。
6. **组合验收**：真实用户场景同时使用项目上下文、选择规则和Memory查询完成规划—确认—执行，页面刷新后能从权威事实恢复，公开面不泄漏外部服务或Runtime私有身份。

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
5. Workflow SDK 4.8的Hook超时`Promise.race`会留下未提交sleep operation警告；后续修改等待节点或升级SDK时应回归，但当前不阻塞下一阶段。

## 7. 可复制续接指令

```text
继续Chat项目。按AGENTS.md规定顺序读取治理文件和docs/project-session-handoff.md。
main已在06d1177完成真实规划—确认—执行闭环，百炼qwen3.7-plus与真实浏览器E2E已通过。
当前阶段依次建设：真实Memory查询/导入与多后端Adapter、BMAD启发的项目上下文、
带标签且可主动选择的用户规则集。先读取本地参考项目与既有分析，给每个设计写出采用/调整/拒绝依据，
再按依赖拆成可独立合并的小任务；实现使用worktree+PR，纵向完成门必须包含真实服务、真实模型和浏览器E2E。
不要建立万能Context Service，不要把外部Memory、BMAD或Prompt当成Chat产品事实源。
```
