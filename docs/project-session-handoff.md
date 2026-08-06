# Chat 项目跨 Session 续接入口

> 更新时间：2026-08-06
> 适用范围：Chat 项目的一般续接。仅当任务是“继续90%交互设计”时，改用
> [交互设计专项续接入口](./chat-interaction-design-handoff.md)。

## 1. 这个文件负责什么

本文件只负责让新的 Session 或新的 AI 快速找到当前审核门、下一步和权威资料，不复制完整项目事实。

- 当前事实以 [PROJECT_STATE.md](../PROJECT_STATE.md) 为准。
- 工作顺序以 [PROJECT_PLAN.md](../PROJECT_PLAN.md) 为准。
- 稳定产品边界以 [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) 为准。
- 协作约束以 [AGENTS.md](../AGENTS.md) 和 [PROJECT_LESSONS.md](../PROJECT_LESSONS.md) 为准。

## 2. 新 Session 必须先恢复什么

按以下顺序完整读取，再回答或行动：

1. [AGENTS.md](../AGENTS.md)
2. [PROJECT_LESSONS.md](../PROJECT_LESSONS.md)
3. [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
4. [PROJECT_STATE.md](../PROJECT_STATE.md)
5. [PROJECT_PLAN.md](../PROJECT_PLAN.md)
6. [概念空间索引](../概念空间/00-索引.md)中与本次任务直接相关的概念簇
7. 本文件指向的当前审核材料

不得依赖旧聊天摘要替代这些权威文件。

## 3. 当前准确停点

截至2026-08-06，项目停在以下审核门：

1. 目标方向已冻结为TypeScript全栈，`pi-agent-core`作为Agent核心基座。
2. `pi + pi-web`双轨完整掌握材料已经完成并于2026-08-05获Later审核通过；Later个人掌握仍不由AI代签。
3. 现有Python/FastAPI/MAF/AG-UI/React/Vite实现仍是迁移行为预言机，替代链验证前不删除。
4. 上一轮错误地把“研究pi支持”跳成D1—D8 Chat架构审核，该审核请求已撤回；随后已完成`native/partial/design-only/missing`源码事实矩阵。2026-08-06用户明确要求基于源码事实和pi设计哲学进入Chat方案审核，重新形成的4种总体路线与新D1—D8是当前唯一审核门。
5. 当前仍没有授权创建目标生产目录、引入目标依赖、设计正式Schema/迁移或开始产品重建。

“材料完成”只表示研究和课程已经落盘，不表示Later个人已经完成学习验证。

## 4. 当前审核材料

当前首要任务材料：

- [Workflow/HITL/Checkpoint架构候选](./pi-workflow-hitl-checkpoint-architecture.md)（基于源码事实重建；D1—D8待用户审核）
- [Workflow/HITL/Checkpoint pi原生支持研究](./research/pi-workflow-hitl-checkpoint-research.md)（已完成；作为事实基线）

其上pi技术基座证据入口位于Chat仓库之外的共享Agent知识库：

- [pi与pi-web知识入口](/Users/xulater/Code/opc-os/agent_knowledge/project-studies/pi-agent/README.md)
- [Later学习起点](/Users/xulater/Code/opc-os/agent_knowledge/project-studies/pi-agent/用户学习/项目掌握实践/01-从这里开始.md)
- [AI当前版本事实手册](/Users/xulater/Code/opc-os/agent_knowledge/project-studies/pi-agent/AI工作区/当前版本-pi与pi-web架构事实手册.md)
- [运行证据入口](/Users/xulater/Code/opc-os/agent_knowledge/project-studies/pi-agent/AI工作区/运行证据/current/README.md)
- [主AI质量复核](/Users/xulater/Code/opc-os/agent_knowledge/project-studies/pi-agent/质量复核/当前版本完整掌握/01-主AI自检与收口.md)
- [Chat侧技术基线与迁移预言机](./research/pi-native-technical-baseline.md)

固定研究版本：

| 源码 | 固定提交与版本 | 验证状态 |
|---|---|---|
| pi | `10e99ae9914cd34f622633fac42f9a90714e9cf4`，Packages `0.82.1` | 源码树验证后clean；Agent Core 240通过/1跳过，Coding Agent定向244通过/18跳过，TUI定向测试与类型检查通过 |
| pi-web | `82cb76a36b379a050e93ee7d726f2cf591e5f942`，App `0.8.6`、Pi SDK `0.83.0` | 源码树验证后clean；TypeScript、ESLint及343/343项Node测试通过 |

## 5. 用户话语如何改变停点

| 用户指令 | 新 Session 应做什么 | 是否改变项目阶段 |
|---|---|---|
| “继续Chat项目”“现在到哪了” | 先汇报本文件第3节停点，继续新D1—D8架构审核 | 否 |
| “继续学习pi/pi-web” | 从Later学习起点继续，记录学习反馈，不冒充已经掌握 | 否 |
| “材料通过”“开始下一步” | 已于2026-08-05执行；不得重复打开已通过的技术基座材料审核门 | 已改变 |
| “研究已经完成”“给我Chat方案” | 已于2026-08-06执行；进入新D1—D8架构审核，不恢复撤回版 | 已改变 |
| “继续90%交互设计” | 转入交互设计专项续接入口，从其首个未完成模块继续 | 否，除非用户另行批准架构阶段变化 |

## 6. 已冻结的唯一后续顺序

```text
pi对Workflow/HITL/Checkpoint的原生支持研究（已完成）
-> Chat如何利用/补足这些能力的架构取舍（新D1—D8已形成，当前待审核）
-> Memory在TypeScript/pi与Workflow边界下重新选型与接入设计
-> BMAD项目管理方法研究与取舍
-> 总体架构修订与审核
-> 重建/迁移详细计划
-> 纵向实现
```

后续阶段不能因为“技术上可以开始”而越过前一审核门。

## 7. 当前禁止误做

1. 不恢复原RP-01.2—RP-01.6逐卡停顿顺序；它们只保留为研究历史。
2. 不在Workflow架构前先做Memory接入；旧的`memmy-agent` 82分结论基于Python/MAF权重，只是历史证据。
3. 不把pi Runtime Session、Product Session、前端实时Thread/Connection、Workflow Checkpoint、Product Run或Run Attempt合并成同一对象。
4. 不按pi仓库目录反推Chat产品架构；Intent、Work、Approval、Accepted Memory和Evidence仍是Chat产品责任。
5. 不删除或继续扩张现有MAF目标能力；只把现有系统作为迁移预言机维护。
6. 不读取、输出或迁移`backend/config.json`中的私有配置。
7. 不覆盖工作区中与本次任务无关的现有改动，不擅自提交或推送。

## 8. 可直接复制到新 Session 的指令

```text
继续Chat项目。请先按AGENTS.md规定的顺序完整读取PROJECT_LESSONS.md、
PROJECT_CONTEXT.md、PROJECT_STATE.md、PROJECT_PLAN.md和相关概念，再读取
docs/project-session-handoff.md。不要依赖旧聊天恢复状态。当前默认停在
基于pi源码事实重新形成的Workflow/HITL/Checkpoint架构候选D1—D8审核门。先读取
docs/research/pi-workflow-hitl-checkpoint-research.md作为事实基线，再读取
docs/pi-workflow-hitl-checkpoint-architecture.md；继续比较4种总体路线并逐项审核新D1—D8。
不要恢复已撤回的旧草稿，不要启动Memory或实现工作。
```

## 9. 阶段切换时的维护规则

每次用户批准一个审核门，必须在同一批文档变更中完成：

1. 在`PROJECT_STATE.md`记录批准事实、完成证据和新待审核项。
2. 在`PROJECT_PLAN.md`把唯一下一步前移，但不删除完整后续路线。
3. 在`AGENTS.md`更新“当前阶段”和禁止提前进入的边界。
4. 更新本文件第3、5、6节，使新 Session 只看到一个准确停点。
5. 若产品稳定边界确有变化，才更新`PROJECT_CONTEXT.md`；不要把临时进度写入其中。
