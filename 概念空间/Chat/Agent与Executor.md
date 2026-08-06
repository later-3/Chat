# Agent与Executor

## 文档治理信息

| 项目 | 内容 |
|---|---|
| 目的 | 区分可编辑Agent配置、pi/MAF Agent运行对象、Workflow Executor和多Agent交接。 |
| 概念状态 | 有效。 |
| 实现状态 | 局部实现并验证：4个可编辑Agent Profile、规划/审校交接和三方成语接龙的受治理Agent Executor已存在；动态拓扑和持久多Agent恢复未完成。 |
| 事实所有者 | 目标pi边界以[RP-01](../../docs/pi-native-replatform-plan.md)后续研究为准，当前MAF实现见[项目状态](../../PROJECT_STATE.md)。 |
| 维护责任 | Agent目录、Workflow Runtime、模型调用审批和Tool治理共同维护。 |

## 一句话理解

**Agent Profile描述“这个Agent被配置成什么”；目标pi Agent执行智能步骤；Executor是Workflow节点实际调用的运行单元，既可以是Agent，也可以是确定性代码或子Workflow。**

## 为什么需要

如果把Agent当成整个Chat产品，它会被错误赋予Session、权限、审批、Evidence和产品终态；如果把每个Workflow节点都叫Agent，确定性转换、策略校验和子Workflow就失去准确表达。配置Agent也不应被误认为授权它立即执行。

## 定义与边界

| 概念 | 定义 | 不是什么 |
|---|---|---|
| Agent Profile / Agent档案 | 版本化的名称、职责、Instructions、Provider/模型偏好和允许能力配置 | 不是运行实例、用户身份或执行授权 |
| pi Agent / pi Agent对象 | 组合模型、System Prompt、Messages、Tools、Context转换、Hook和运行选项的目标智能运行对象 | 不是Chat产品、Product Session、Product Run或产品事实源 |
| MAF Agent / MAF Agent对象 | 当前Python实现中组合模型Client、Instructions、Context Provider、Tools、Middleware和运行选项的智能运行对象 | 是迁移预言机，不再是目标Runtime |
| Agent Configuration Snapshot | Product Run开始时取得的不可变Profile版本投影 | 不是可在运行中静默变化的在线配置 |
| Executor / 执行器 | Workflow节点收到输入后按合同产生输出、事件或中断的运行单元 | 不必调用模型，也不必是Agent |
| Deterministic Executor / 确定性执行器 | 用确定性代码完成编译、校验、路由、转换或审批控制的Executor | 不是“能力较弱的Agent”，也不产生隐藏推理 |
| Governed Agent Executor / 受治理Agent执行器 | 调用Agent智能能力，但把Provider请求、Tool和产品终态交给产品治理门的Executor | 不是pi Agent或MAF原生Agent-as-Executor就天然获得产品审批 |
| Agent Handoff / Agent交接 | 将明确的原始目标、中间结果、来源和交接要求传给下一个Agent步骤 | 不是让两个Agent共享一段不可解释的隐式内存 |
| Multi-Agent Workflow / 多Agent工作流 | 由Workflow明确组织多个Agent与确定性Executor的执行图 | 不是自由群聊，也不自动优于单Agent |

## 概念关系

```text
Agent Profile revision
-> Run开始时冻结 Agent Configuration Snapshot
-> Workflow Node Definition 选择 Executor
   ├── Deterministic Executor
   ├── Governed Agent Executor -> pi Agent（目标）/ MAF Agent（当前预言机）
   └── Subworkflow Executor

多个 Governed Agent Executor
-> 通过显式 Agent Handoff 组成 Multi-Agent Workflow
```

产品身份、权限、Approval、Run终态、Tool副作用、Evidence和Delivery始终在Agent外由Chat产品拥有。

## 人和系统怎样使用

1. UI的Agent设置页编辑Profile并产生Revision；保存配置不启动Run。
2. Product Run记录采用的Profile Revision和配置快照，后续配置修改不回写旧Run。
3. Workflow图展示节点类型；只有实际调用Agent的节点才标为Agent节点。
4. 每次Agent内部Provider调用仍生成独立ModelCallDraft并审批。
5. Agent交接必须可查看原始目标、上游输出、来源和明确要求；用户修改后形成新版本。
6. 多Agent游戏仍由确定性Workflow掌握轮次、校验和最终提交；Agent只负责各自需要智能生成的一棒，不能自行改变参与者顺序或跳过审批。

## 正例与反例

正例：planner Agent生成规划，确定性Executor把原始用户目标、规划结果和审校要求组装后交给reviewer Agent。

正例：用户给出“一心一意”，输入Executor校验后交给Agent甲；确定性交接再把“意气风发”和必须以“发”开头的规则传给Agent乙，两次Provider调用分别审批，结果Executor最后把下一棒交还用户。

反例：用户修改Agent名称后，系统把正在运行的旧Run也显示成使用新配置。

反例：把“保存Agent配置”当成允许Agent访问文件或发送外部请求的授权。

反例：在Workflow图里把审批等待、格式校验和路由节点都显示成多个Agent。

## 当前状态与未知

当前两个双Agent纵向切片已验证Profile CAS Revision、不可变快照、两次逐次审批、显式交接和确定性规则校验。其中成语接龙已经覆盖连续两轮、两位Agent分别放弃、错误接龙和无假成功。尚未完成动态Agent目录、并发多Agent拓扑、持久Checkpoint、多Agent活动Run恢复和细粒度Agent能力授权。

## 来源、维护与验证

来源：[架构新手导读Agent边界](../../docs/architecture-beginner-guide.md#75-agent明确不拥有的东西)、[项目状态多Agent事实](../../PROJECT_STATE.md)和[产品原则](../../PROJECT_CONTEXT.md#8-产品原则)。

验证覆盖Profile并发修改、Run快照不漂移、Agent节点逐次模型审批、完整交接、下游拒绝、无假成功和确定性节点不被误标为Agent。
