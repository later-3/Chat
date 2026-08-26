# Chat项目管理模块

> 文档类型：已确认产品方向与后续规划边界
>
> 决策日期：2026-08-24
>
> 当前状态：产品方向已确认；Mini-Claw、Content Lab与Pipecat构成首轮真实来源验证

## 1. 结论

Chat需要拥有一套长期维护的**项目管理模块**。它服务的核心不是某一种方法论，也不是某一个
项目管理前端，而是用户在不同类型项目中持续管理和推进真实事情的需要。

当前确认：

1. 先从开源项目和真实产品中研究已经被验证的概念、工作方式与交互，不闭门发明一套万能方法论。
2. 研究结果要沉淀为Chat自己的产品语义、规则与可演进的Project Profile，而不是照搬某个产品的字段。
3. Codex、Pi Agent、Chat内Agent及以后接入的Agent，都通过Chat Application使用同一份项目上下文、命令语义、权限和事实。
4. Content Lab是第一个事项协调案例；首轮实现用Mini-Claw、Content Lab和Pipecat验证真实软件/内容场景，学习和个人日报仍作为待真实样本验证的扩展边界。
5. 核心定义用户需要的Work、Document、Code、Media、Timeline、Report、Relation和Review能力，不固定由哪个前端呈现；DSH可以直接实现Document等能力，也可以跳转到外部表面。
6. Git是包含代码或受管版本化文件时确定采用的版本控制基础设施；其他Viewer、编辑器、知识或报表工具按能力和项目Configuration选择。

这不是为了把Chat做成“可随意更换任意项目管理工具”的抽象平台。可替换性是正确划分事实所有权和
Provider边界后的结果，不是第一目标。第一目标始终是满足用户在不同项目中的真实管理与协作需要。

## 2. 用户说的“项目”是什么

这里的项目不是代码仓库、外部事项容器、文档目录或一个Agent Session的同义词，而是：

> 用户想长期推进的一件内聚的事情；它有目标、参与者、资源、工作、决定、证据、历史和下一步。

因此，下列事情都可以是Chat Project，但不应使用完全相同的管理方式：

- 软件开发：例如Chat，重点是需求、场景、方案、实现、测试、发布和维护。
- 内容生产：例如Content Lab，重点是内容流水线、发布记录、案例、经验和工作流优化。
- 个人学习：例如四个月完成AI转职，重点是目标拆解、能力差距、练习、笔记、反馈和阶段验证。
- Idea与复盘：重点是捕获、整理、关联、选择、行动和周期回顾。

项目类型不同，管理对象、时间政策、完成证据和用户视图可以不同；但身份、权限、决定、Event/Revision、来源、恢复和Agent协作等底层不变量应由Chat统一守护。

完整对象、时间、维护、呈现、Context和存储边界以
[Chat 全项目生命周期管理蓝图](./project-management-system-blueprint.md)为准；具体行为以
[Chat 项目管理三真实项目验证](./project-management-three-real-project-validation.md)记录首轮已执行验收；
[四场景纵向推演](./project-management-four-scenario-walkthroughs.md)仅保留为类别设计压力测试，不代表四类都已真实验证。

## 3. 三个参与方的责任

### 3.1 用户

用户需要：

- 看清为什么做、现在在哪里、发生了什么、有什么风险、下一步是什么。
- 在适合自己的项目视图中查看工作、历史、决定、证据和结果。
- 修订Agent提出的计划、分类、状态和总结，而不是被自动化替代判断。
- 在更换前端或Agent后仍能恢复项目，不依赖某次会话记忆。

### 3.2 协作Agent

协作Agent包括Codex、Pi Agent、Chat内Agent和以后授权接入的Agent。它们需要：

- 开工前恢复同一份项目身份、目标、Profile、当前承诺、相关资源、决定、证据和约束。
- 只认领授权范围内的工作，执行中报告进展、阻塞、观察和候选结果。
- 把模型判断先提交为Candidate；只有通过相应Decision/Gate后才成为长期产品事实。
- 结束时留下可被其他Agent继续使用的结构化交接，不把上下文锁在Session中。
- 通过同一套Application命令工作，不因使用不同Skill、CLI或Provider而改变业务语义。

### 3.3 Resource与Presentation Provider

Resource Provider负责发现、读取、写入、版本、Diff、搜索、观察或导出真实资源；Presentation Provider负责Work、Document、Code、Media、Timeline、Report、Relation或Review等用户表面。同一个系统可以同时承担两种能力，但必须分别声明。

Provider不拥有Chat的项目身份、产品终态、Agent授权或跨Provider协调事实。文档、代码、事项和媒体可以由DSH或合适的外部表面呈现；这些选择不改变Project对象和Revision。

Provider能力必须以真实源码、固定工件和文档为证据。Chat不能要求Provider完成它不具备的行为，也
不能把当前Provider的字段集合当作Chat项目领域的上限。

## 4. 项目管理规则的分层

Chat不应只有一张“所有项目通用表”，也不应为每个项目写一套互不相干的脚本。规则分为五层：

| 层 | 责任 | 示例 |
|---|---|---|
| 通用不变量 | 所有项目必须守住的产品语义 | 身份、权限、决定、证据、Event/Revision、来源、恢复 |
| Project Profile | 某一类项目的默认对象、时间、视图、Context和完成门 | 软件开发、内容生产、学习、日报/复盘 |
| Project Configuration | 某个真实项目采用的目标、术语、角色、资源和Capability Binding | Content Lab的渠道、栏目、发布、媒体和复盘规则 |
| Provider Mapping | 把Chat语义投影到具体Provider | Work Tracker、文档、代码或媒体表面的映射 |
| Agent Runtime Contract | Agent怎样读取、认领、推进、交接和对账 | Context、Command、Candidate、Evidence |

Profile是可版本化、可组合、可由真实使用结果修订的产品配置。它属于Chat，不属于某个Provider、
某个Skill或某个Agent。

## 5. Chat应拥有的模块责任

后续设计至少要区分以下责任，具体包名和接口尚未决定：

1. **Project Domain**：项目、目标、阶段、工作、资源、参与者、决定、证据、更新等产品语义与不变量。
2. **Profile Registry**：不同项目类型的Object Catalog、生命周期、时间政策、Context、View Requirement和完成门。
3. **Project Understanding**：从用户目标和真实资源形成可审核的Profile/Configuration候选。
4. **Context Compiler**：按当前任务编译最小而充分的协作上下文，而不是把全部历史塞给模型。
5. **Coordination Runtime**：Agent认领、进展、阻塞、审核、交接和结果提交的统一Application用例。
6. **History与Query**：保存稳定Event、Object Revision、Provenance和时间语义，编译当前、Timeline、Report和关系读模型。
7. **Resource Observer**：观察仓库、文件、发布物、笔记等外部资源，生成Observation或Candidate，不越权改写项目事实。
8. **View Model Compiler**：按Profile和用户Authority编译Project Home、Work、Document、Code、Media、Timeline、Report、Relation、Review和Attention。
9. **Maintenance Runtime**：由Agent生命周期、资源变化、期限和周期触发观察、同步、Attention、报告和复盘候选。
10. **Provider Ports**：按能力把同一产品语义投影到DSH或其他表面，并处理身份、版本、失败和对账。
11. **Method Evolution**：用实际项目结果、用户反馈和失败案例更新Profile及方法规则，保留变更理由和版本。

这些责任应沉淀在Chat项目管理模块中。文档、Skill、Agent Prompt、CLI和前端只是入口或客户端，不能
成为唯一事实源或第二套控制面。

## 6. Agent的统一项目上下文

后续方案应定义一个由Chat Application生成的`ProjectCoordinationContext`。名称和Schema尚未冻结，
但至少需要回答：

- 我在推进哪个Chat Project，当前采用哪个Profile及版本？
- 用户要达成什么结果，当前阶段或周期的承诺是什么？
- 我被授权做什么、明确不能做什么，哪些动作需要用户决定？
- 哪些资源和历史决定与当前工作有关，证据在哪里？
- 当前有哪些活动工作、参与者、依赖、风险、阻塞和待审核候选？
- 应向哪个Provider投影什么信息，失败后怎样查证和对账？
- 完成后必须提交什么结果、证据、更新和交接？

不同Agent可以有不同执行能力，但不能各自解释一套项目状态。Agent本地Session、`PROJECT_STATE.md`、
外部事项、外部页面或Agent Session都只能是运行责任、导航或外部投影，不能单独取代Chat产品事实。

## 7. Provider策略

### 7.1 View Capability优先于Viewer名称

Profile先声明用户需要的View，Configuration再选择当前实现。例如：

- Document View可以由DSH、Markdown查看器、代码编辑器或知识工具提供；
- Code View可以由code-server、VS Code或未来代码表面提供；
- Work View可以由DSH或其他事项表面提供；
- Media、Timeline、Report和Relation View可以分别采用最适合的表面。

核心只保存View Requirement、View Intent、Resource/Artifact稳定引用和用户动作合同。缺失能力时明确显示`unsupported`和替代入口，不为了适配某个Viewer丢弃对象，也不预先安装没有当前纵向需求的工具。

### 7.2 Provider接入边界

Provider不被压成最低公分母DSL。每个Binding按真实能力声明`discover/read/write/version/diff/search/watch/render/export`或Work Tracking能力，并分别审核：

- 正文或二进制由谁拥有；
- 用户和Agent可以读写什么；
- 单主写、并发冲突和人工修改怎样对账；
- 写入幂等、`outcome_unknown`、审计和恢复怎样表达；
- 移除Provider后Project、Artifact入口和历史能否恢复。

首版只实现三个真实样本实际使用的Capability与Provider，不提前构建任意编排平台。

## 8. Content Lab首个典型案例

Content Lab不是“另一套软件开发Backlog”。它的初步用户结果是：

- 持续把感兴趣的YouTube内容转译、加工为中文内容并发布到小红书等渠道。
- 让用户看见昨天、前天和更早处理或发布了什么，以及每条内容当前在哪里。
- 积累来源、成品、案例、反馈、经验和可复用规则。
- 让一套或多套内容工作流通过真实结果持续优化，而不是只增加待办数量。

它适合验证以下对象是否足够：

- Content Intake / Source：待处理来源和采用决定。
- Content Production：转录、翻译、改写、配图、审核、发布等一次生产流。
- Publication / Outcome：渠道、时间、成品、反馈和效果证据。
- Case / Learning：成功案例、失败案例、经验和适用条件。
- Workflow / Experiment：当前采用的流程版本、假设、实验和调整决定。
- Cadence / Review：日常进度、周期回顾和下一轮改进。

这些概念由Content Lab Profile表达，不要求某个外部表面承载全部正文、媒体、知识和方法。首个案例的价值是用真实使用检验哪些对象必要、哪些重复，以及Work、Document、Media、Timeline和Report怎样共同呈现完整项目。

## 9. 演进方式

用户无法在看到真实效果前一次性决定全部规则，因此采用可逆的试用—观察—修订方式：

```text
明确用户结果与当前假设
-> 选择最小Profile和Provider映射
-> 由用户与Agent真实使用
-> 收集结果、摩擦、遗漏和失败证据
-> 修订Project Configuration或Profile
-> 再决定是否上升为通用规则
```

项目中的一次偏好不自动成为所有项目的规范；同一摩擦在多个案例中出现并有证据时，才考虑固化为
通用能力。所有结构变化都应保留版本和迁移路径。

## 10. 当前决定与待规划事项

### 已确认

1. Chat拥有项目管理模块和跨Agent协作语义。
2. 用户需求先于方法论与Provider。
3. 以开源项目和真实产品事实作为重要研究输入。
4. Mini-Claw、Content Lab和Pipecat作为首轮真实边界验证；Content Lab保留第一个真实事项协调案例地位，学习和个人日报等待真实样本。
5. 用户View以Capability定义，不固定某个Viewer；DSH可以直接承担合适的View。
6. Git是软件代码和声明为版本化文件的固定版本历史基础设施。
7. Project状态、时间线、Revision和用户报表从同一事件/对象历史派生，不能依赖手工多处同步。
8. Maintenance Runtime需要在Agent生命周期、资源变化和时间触发下持续维护，不等用户逐条提醒。

### 当前实施重点

1. 冻结通用对象、时间、历史、View、Context、Profile/Configuration和Provider Capability合同。
2. 解决正式`main`与P8历史分支的Product Store双谱系和非fast-forward集成。
3. 收敛Project Query、Context Compiler、Coordination和Maintenance Runtime。
4. 以Content Lab与Chat先做真实纵向，再做AI学习和连续7日个人日报。
5. 用真实摩擦修订Profile与Configuration；不把单项目偏好静默升级为内核。

当前三套Project能力怎样收敛以及每阶段的目标和完成门，见
[Chat项目管理内核收敛实施计划](./project-management-kernel-convergence-plan.md)。用户已批准目标驱动的本地设计、代码实施和验证；正式Store迁移、外部Provider写入、部署、push和PR仍按具体影响范围授权。
