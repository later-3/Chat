# Workflow

## 文档治理信息

| 项目 | 内容 |
|---|---|
| 目的 | 统一项目Workstream、可执行Workflow定义、用户选择、实际运行、节点和运行视图。 |
| 概念状态 | 有效；用户已批准“发送前选择Workflow，发送后展示实际Run”。 |
| 实现状态 | 局部实现并验证：持续协作主Workflow当前为v1.8.0，含39个MAF节点和43条静态边；Intent Set/复合Plan、两级Context、3路执行、pi只读/隔离编辑、Result Claim、AG-UI投影、Product Harness接合和主Workflow安全点Checkpoint/跨进程恢复纵向链已存在。其他Definition、全部子级HITL和完整故障矩阵尚未获得同等保证。 |
| 事实所有者 | 产品选择规则见[项目经验反例013](../../PROJECT_LESSONS.md#16-反例-013把workflow选择prompt发送和运行展示混成一个动作)，实现见[项目状态](../../PROJECT_STATE.md)。 |
| 维护责任 | Workflow目录、Run管理、MAF Runtime和前端Workflow Run View共同维护。 |

## 一句话理解

**可执行Workflow是版本化执行图；用户在发送前选择Definition，发送后Product Run按该版本推进，Workflow Run View只投影这次真实运行。**

## 为什么需要

“工作流”既被用来描述项目交付工作包，也被用来描述MAF执行图；同时又容易把Workflow选择器、Run和右侧可视化页面混成一个对象。这样会造成系统静默换流程、节点状态无法追溯，或把项目计划节点误当运行节点。

## 定义与边界

| 概念 | 定义 | 不是什么 |
|---|---|---|
| Project Workstream / 项目工作流 | `PROJECT_PLAN`中的W0-W9交付工作包 | 不是可以被MAF执行的图；文档中优先称“交付Workstream” |
| Workflow Definition / 工作流定义 | 具有稳定ID、版本、节点、边和输入输出合同的可执行图 | 不是当前Run状态或UI页面 |
| Workflow Selection / 工作流选择 | 用户在发送Prompt前为本次请求明确选定的Definition ID和版本 | 不是Agent建议或页面默认值 |
| Workflow Recommendation / 工作流推荐 | Agent未来根据意图提出的候选及原因 | 不是选择，更不是执行授权 |
| Workflow Run / 工作流运行 | Product Run按已绑定Definition版本产生的运行语义 | 当前不另建与Product Run竞争的产品聚合 |
| Workflow Node Definition / 节点定义 | Definition中的稳定图位置，声明要调用的Executor和边关系 | 不是Agent本身，也不是一次执行状态 |
| Node Activity / 节点活动 | 某次Workflow Run中该节点的开始、完成、失败或等待投影 | 不是新的长期Product Run，除非详细设计明确需要子Run |
| Code Execution Stage / 代码执行阶段 | 设计者视图中与真实函数、协议边界或持久化门对应的可观察阶段；可以位于MAF节点内部，也可以位于MAF之外 | 不是额外的Workflow Node，不能改变Definition拓扑 |
| Subworkflow / 子工作流 | 由一个父节点调用的另一个版本化Workflow Definition | 不是把UI卡片缩进一层的装饰关系 |
| Workflow Checkpoint / 检查点 | 图版本、控制流位置和可恢复状态 | 不是Trace，也不能证明外部Tool结果 |
| Workflow Run View / 运行视图 | 在Workbench中展示真实节点状态、审批和公开输入输出的前端投影 | 不是Workflow选择入口、运行器或Canvas |

## 概念关系

```text
用户发送前
  Workflow Selection -> Workflow Definition(id, version)

点击发送
  prompt + context + workflow id/version -> Product Run

运行中
  Product Run -> Workflow Run -> Node Activity
                         ├── Deterministic Executor
                         ├── Governed Agent Executor
                         └── Subworkflow

前端
  Node Activity / Approval / Trace -> Workflow Run View
                                    ├── 逻辑节点视图（面向普通用户）
                                    └── 代码执行链（面向设计者）
```

## 人和系统怎样使用

1. Prompt发送区必须显示当前选择的Workflow名称和版本；唯一选项也不能隐藏选择事实。
2. Run创建后不能静默切换Definition版本；改变选择必须创建新的运行输入。
3. Agent未来只能推荐Workflow，用户接受后才更新Selection。
4. 节点内容只展示可公开输入输出、状态、时间和错误；不展示隐藏推理。
5. 嵌套Workflow使用稳定路径或父子节点关系投影，刷新后从产品Trace恢复终态，但Trace不能冒充Checkpoint恢复。
6. 设计者视图可以把一次真实节点执行展开为多个代码阶段，但必须同时显示每个阶段的运行层、Runtime类型和源码入口，并明确标出哪些才是MAF图节点。
7. 点击节点查看的内容由同一Product Trace按稳定`executor_id`关联；必须分开显示公开输入、公开输出、运行事实和源码入口，不能把完整Provider JSON或隐藏推理冒充节点内容。
8. 选择节点必须同时投影候选边、声明顺序、公开条件、实际值、选中目标和未走原因；运行视图读取Workflow Definition与本轮Trace的同一事实，不能只把全部节点平铺后让用户猜路径。
9. 设计者运行视图以思维导图式拓扑作为第一信息层：真实节点、边、分叉、选中路径和汇合关系共同表达；为压缩线性阶段增加的容器必须标明“布局分组，不是额外MAF节点”，完整节点台账只作为第二层审计入口。

## 正例与反例

正例：发送区显示“发送前可编辑Prompt v3”；点击发送后右侧运行视图展示本次Run绑定的v3节点状态。

反例：Agent判断另一个Workflow更合适，未让用户接受就替换本次选择并运行。

反例：把Project Plan中的“W6 MAF/Workflow执行”当成一个可点击的MAF Workflow。

反例：把每个Workflow Node都称为Agent，导致确定性校验、审批节点和子Workflow无法表达。

反例：为了让流程图看起来完整，把“接收AG-UI请求”“Provider传输”“Product提交”等代码阶段伪装成MAF节点，导致展示拓扑与实际代码不一致。

## 当前状态与未知

当前发送区只选择“持续协作主 Workflow v1.8.0”；它以39个真实MAF节点、43条静态边覆盖选择性摘要、
directory/detail两步Context、Intent Set、Project/Work绑定、协作协议、4路场景选择、可选Plan、
ExecutionDraft授权、不可变RunSpec、answer/pi只读/pi隔离编辑、Result Claim、Result/Work/Memory分别决定、
回合沉淀和产品终态。真正的澄清问题会先作为Assistant Message提交，下一条User Message通过未解决问题
摘要重新进入Intent判断。其余5个Definition是配置中心/测试/演示用的独立辅助Workflow，不会与主图隐式
叠加，也不是当前普通发送区的可选根流程。

多目标不会修改基础协作协议Definition。Workflow保留原协议revision/Hash，再以带Hash的
`composition_overlay`形成本轮有效执行策略，例如把`planner=disabled`覆盖为
`planner=required_for_intent_set`；“本轮”工作台必须同时展示基础方法和本轮有效策略，不能只显示
其一。多Intent中的权威Product查询先由确定性Executor完成，再把结果作为事实交给Planner和Response，
避免模型规划系统没有提供的Tool。

设计者运行视图现在先展示完整系统执行链，再把真实MAF Definition与本轮Trace组合成可缩放拓扑：
`scenario_router`的4条候选边、`execution_route`的3条候选边、选中路径和未走原因来自同一Definition/Trace
事实。点击图上节点按需展开步骤输入、公开输入、运行事实与治理事实；39节点完整台账是审计层。
S1–S7只是代码拥有的学习分组，不是额外MAF节点。旧Run若只保存较少分支事实，视图必须标为兼容投影，
不能用当前代码反推并冒充历史Trace。

主Workflow现在把MAF Checkpoint绑定到Product Run/Attempt、Definition/version、图签名和Pending Request；决定可以经Lease Outbox由新的OS进程恢复到下一审批安全点，前置节点不重跑。活动Run已经具有持久Runtime Job、公开事件Journal、签名Cursor回放和Execution Worker纵向切片，但完整多设备、事件保留、背压和容量矩阵仍未验收。Checkpoint保证只覆盖已接合的主Workflow和无外部Tool副作用阶段；持久Definition版本仓库、其他Definition、嵌套子级HITL和Tool副作用恢复仍需后续交付。

## 来源、维护与验证

来源：[项目经验反例013](../../PROJECT_LESSONS.md#16-反例-013把workflow选择prompt发送和运行展示混成一个动作)、[架构新手导读7.3](../../docs/architecture-beginner-guide.md#73-workflow不等于agent)和[项目状态](../../PROJECT_STATE.md)。

验证至少覆盖发送前选择、版本绑定、Agent建议不自动选择、异构节点、嵌套成功/失败、刷新投影、拒绝后重新发送和Definition升级不污染旧Run。
