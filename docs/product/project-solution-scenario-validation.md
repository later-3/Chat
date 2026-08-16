# Project Solution 场景验证

> 状态：待用户审核
>
> 目的：用真实用户场景反推方法、对象、工作流和分阶段交付，删除只有理论价值而没有独立产品责任的概念。

## 1. 验证规则

每个场景必须回答：

1. 用户只靠自然语言能否启动和推进？
2. 哪些事实来自用户，哪些来自真实Resource，哪些只是模型Interpretation，哪些已由Application编译成Chat Candidate？
3. Stage、Iteration、Work、Scope和Action是否各自承担不同责任？
4. 谁在做、改了什么、为什么决定、还有什么待办能否被证据化回答？
5. 页面刷新、API/Workflow重启和外部资源变化后能否恢复？
6. 方法是否帮助用户，而不是要求用户先学习方法论？
7. 失败时是否保留真实历史，避免假成功和无限延期？

## 2. 场景一：一个人管理多个软件项目

### 输入

用户同时维护Chat、pi-web和Memory服务，询问：

> 我现在有哪些项目？谁在做什么？今天应该先管哪件事？

### 必需事实

- 3个Project及各自目标、生命周期和Resource。
- 每个Project当前Stage、Iteration、Work/Action。
- 用户、Codex、Kimi和CI Participant。
- 最近Contribution、Decision、Project Update和Blocker。
- 等待用户确认的Candidate。

### 系统行为

1. Portfolio Query按Principal读取全部Project。
2. 聚合当前Iteration、等待Decision、blocked Action、陈旧Project Update和运行中Product Run。
3. Today按“需要用户介入→已承诺到期→正在运行→普通待办”排序。
4. 模型可以生成阅读摘要，但排序依据和对象引用必须由Application确定性提供。

### 结论

- Portfolio第一版应是投影，不需要新的空壳实体。
- Today是个人注意力投影，不拥有Work状态。
- Project Update与自动Activity必须分离，否则无法判断谁对健康结论负责。

## 3. 场景二：两周的小型产品改进

### 输入

> 两周内解决Chat手机端VS Code调试不通的问题，不重做UI。Kimi开发，Codex评审。

### 方法映射

- `small-project.v1`。
- Problem：手机端无法从前端进入完整调试链。
- Appetite：14天。
- Payout：从真实前端发送消息并可在固定断点调试。
- No-Gos：不重做UI、不换框架、不在服务器编译。
- Rabbit Holes：端口清理、DSH Host代理、插件升级、弱服务器。

### 对象

```text
Project
└─ current Stage: usable-debugging
   └─ Iteration: mobile-debug-closure
      ├─ Commitment
      ├─ Work: runtime chain / VS Code / mobile verification
      ├─ discovered Scopes
      └─ Actions assigned to Kimi/Codex
```

### 压力测试

1. 用户没有说“Shape Up”，Chat仍能生成Appetite/Payout/No-Gos候选。
2. 开始前的Tasks只是imagined；真实调试发现DSH插件或代理问题时新增discovered Action。
3. 10个Task完成8个不能表示80%；关键端口未知仍未解决时Scope保持`solving`。
4. 到期仍存在未知代理问题，系统提出reshape/stop而不是自动延期。

### 结论

- Proposal与Iteration必须分离：前者表达成形方案，后者表达已承诺投入。
- Scope必须允许执行中创建。
- Iteration Commitment需要显式确认，但可以和计划批准在同一界面完成。

## 4. 场景三：棕地软件功能

### 输入

> 在现有Chat里加入用户规则集，需要兼容Memory和Project上下文，UI后做。

### 方法映射

- `software-delivery.v1 / brownfield_focused`。
- Shape Up负责Problem、Appetite、No-Gos、Rabbit Holes和Iteration边界。
- BMAD负责相关PRD/Architecture、Story/Work Ready Gate、测试与QA。

### Resource事实

- Git仓库HEAD、branch、dirty status。
- Project架构、技术合同、现有Memory接口和测试脚本。
- 当前Product Store schema、Migration链和真实Provider配置状态。

### 工作流

```text
Observe existing Project
→ Shape candidate
→ select relevant BMAD Artifacts
→ Work Ready Gate
→ Iteration Commitment
→ PlanningExecutionWorkflow
→ code/document Resource Actions
→ tests/real model/browser Evidence
→ Contribution and Project Update
```

### 压力测试

1. 不允许全量加载所有项目文档；Context Builder按Work角色和预算选择。
2. UI后做必须成为No-Go/Decision，不能只留在聊天正文。
3. Store迁移、Memory Context和规则选择之间存在架构影响，不能使用brownfield_quick。
4. Agent说“测试通过”不够，必须有Verify Evidence。

### 结论

- Shape Up和BMAD不是替代关系：前者限定投入和风险，后者约束软件Artifact与质量。
- Method Snapshot必须组合Policy，而不是单一阶段枚举。

## 5. 场景四：非软件轻量项目

### 输入

> 下个月完成搬家，先把合同、搬家公司和必须处理的事情理清。

### 方法映射

- `lightweight.v1`。
- Stage：planning→preparation→moving→settled。
- Milestone：签约、打包完成、交接、入住。
- Work/Action：比较报价、签合同、预约、打包、地址变更。
- Resource：合同、报价单、日历事项。

### 压力测试

1. 不出现PRD、Architecture、Story、QA或Git字段。
2. Iteration可关闭；使用Milestone和Next Action推进。
3. Evidence可以是Document、Calendar或用户确认，不要求Commit/PR。
4. Stage和Milestone仍有独立价值：Stage表示长期位置，Milestone表示关键结果。

### 结论

- 核心Domain不能以软件对象命名。
- Method Profile必须允许关闭Proposal/Iteration/Scope，但Participant、Decision、Evidence和Action仍保留。

## 6. 场景五：持续运维项目

### 输入

> 持续维护pi-web服务器，处理故障、更新证书和发布版本。

### 问题

运维没有自然终点，如果强迫每个Project进入固定Cycle，会产生永不完成的Iteration。

### 设计

- Project kind为operations。
- 使用持续Work/Action流和周期Project Update。
- Incident、证书更新、版本发布可以形成独立Work。
- 较大改进使用Proposal/Iteration。
- Service/Deployment Observation提供健康、版本和漂移证据。

### 结论

- Iteration是可选推进工具，不是所有Project的生命周期骨架。
- Method需要`reviewTrigger`，持续流也必须定期回顾健康和下一步。

## 7. 场景六：真实资源变化与贡献身份

### 输入

用户离线期间，GitHub PR已合并，CI已通过。用户回来询问：

> 昨天谁改了什么？项目状态要不要更新？

### 系统行为

1. Git Adapter Observe得到新HEAD、Commit、PR和CI Evidence。
2. 与上次Observation比较，生成Resource Drift和Contribution Candidate。
3. Git author与Chat Participant存在可信映射时可标为observed；没有映射时必须请求用户确认。
4. PR合并不能直接把Work变done；系统检查AC、测试和Review Gate后提出Work Acceptance Candidate。
5. 用户确认后提交Contribution、Decision和Work状态。

### 结论

- Observation与Contribution是不同对象：前者说明资源变了，后者说明谁为哪个Work做出了什么贡献。
- Evidence与Decision也是不同对象：证据证明发生了什么，决定表达项目如何解释和接纳它。

## 8. 场景七：Iteration失败与Circuit Breaker

### 输入

一个14天Iteration到期，核心功能完成，但数据迁移仍有未知问题。

### Review输入

- 原Commitment与Payout。
- Must-have/Nice-to-have。
- Scope uncertainty。
- verified Contributions和Test Evidence。
- 新发现Rabbit Hole。
- 剩余Appetite。

### 候选路径

1. `complete`：只有Payout和Gate满足。
2. `extend`：仅剩downhill must-have，短扩展有明确上限。
3. `reshape`：仍有uphill未知，需要新Proposal。
4. `stop`：收益不值得继续投入。

### 结论

- Iteration到期必须产生Review，不自动carry-over。
- `partial`是结果描述，不是假完成状态。
- 新Proposal/Iteration不能覆盖旧失败历史。

## 9. 场景八：方向变化与Correct Course

### 输入

用户在开发中要求从本地Memory切换到新的外部Provider。

### 工作流

1. 识别触发原因和Evidence。
2. 分析Stage Goal、Iteration Commitment、Work、Resource、Artifact和后续Milestone影响。
3. 提供继续、回滚、缩减、重塑等选项。
4. 形成具体ProjectChangeProposal。
5. 用户拒绝：Project不变，Candidate保留历史。
6. 用户批准：原子提交Decision和Project事实；真实资源修改进入独立Action Workflow。

### 结论

- Correct Course不能只是改Stage或文档状态。
- ProjectChangeProposal必须覆盖方法、范围、资源和迭代影响。

## 10. 对象覆盖矩阵

| 对象 | 1多项目 | 2小项目 | 3软件 | 4非软件 | 5运维 | 6外部变化 | 7失败 | 8改道 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Project | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Stage/Goal | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| Milestone | ✓ |  | ✓ | ✓ |  |  |  | ✓ |
| Proposal |  | ✓ | ✓ |  | 可选 |  | ✓ | ✓ |
| Iteration | ✓ | ✓ | ✓ | 可选 | 可选 |  | ✓ | ✓ |
| Work/Scope/Action | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Resource/Observation | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Participant/Contribution | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Evidence | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Decision | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Project Update | ✓ |  | ✓ | 可选 | ✓ | ✓ | ✓ | ✓ |
| Change Proposal |  |  | 可选 |  | 可选 |  | ✓ | ✓ |

所有保留对象至少在一个场景中承担无法被其他对象替代的责任。Portfolio与Activity保持读模型，不新增重复事实实体。

## 11. 场景验证后冻结的决定

1. Stage和Iteration必须分离。
2. Stage Goal内嵌Stage；Milestone可选。
3. Proposal和Commitment必须分离。
4. Scope允许执行中发现；Action记录imagined/discovered来源。
5. Iteration第一版只属于一个Project。
6. Lightweight/Operations允许不使用Iteration。
7. Project Update是负责人叙事；Agent只能起草。
8. Git/外部作者映射必须可信或用户确认。
9. Observation不能直接完成Work。
10. Iteration到期必须Review，默认不延期。
11. Project完成必须显式Decision，不能由子对象计数推导。
12. 多项目优先级与Today先做投影，暂不新增Portfolio事实对象。

## 12. 分阶段可验证结果

### PS1

用户通过对话建立真实Project，观察真实资源，确认方法建议和初始账本；页面能回答Project、资源、参与者、初始Stage、Work/Action、决定和最近观察。

### PS2

用户通过对话管理Stage Goal、Milestone、Proposal、Iteration Commitment、Work/Scope/Action和Project Update；完成一次small-project与一次software-delivery迭代Review。

### PS3

用户批准计划后，Workflow真实修改代码/文档或运行脚本，验证并形成Contribution/Evidence，项目事实可正确回写和对账。

### PS4

用户可以发现外部漂移、处理Correct Course、查看多项目风险/Today/Pulse并配置合理维护节奏。

每个阶段都有真实用户闭环；不能把某个内部M或单层Schema称为阶段完成。
