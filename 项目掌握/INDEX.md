# 项目掌握 — 全局索引

这里是Later掌握Chat源码的学习入口，不是新的事实源。稳定产品定义看`PROJECT_CONTEXT.md`，当前完成状态看
`PROJECT_STATE.md`，项目路线看`PROJECT_PLAN.md`，具体行为最终以源码和测试为准。

## 推荐学习顺序

1. [全盘掌握范围与覆盖审计](./00-从这里开始/全盘掌握范围与覆盖审计.md)：先知道“全盘”包含什么。
2. [Chat系统总地图与学习方法](./00-从这里开始/Chat系统总地图与学习方法.md)：建立一次点击的全链心智模型。
3. [Chat总体架构与一次点击的七层链路](./架构与模块/Chat总体架构与一次点击的七层链路.md)：先完成“产品问题→七层边界→11模块→技术选型→当前源码”的架构前置课。
4. [核心对象词典](./架构与模块/核心对象词典-谁创建谁保存谁消费.md)：先认清对象和所有者。
5. [11个产品模块](./架构与模块/11个产品模块的职责与代码落点.md)：理解完整目标架构与当前落点。
6. [持续协作主Workflow总览](./Workflow架构与ProductAwareWorkflow/持续协作主Workflow的39节点设计.md)：再读39节点和8条路径。
7. 按S1–S7逐阶段读代码，再进入[场景实验室](./调试实战/00-场景实验室使用方法.md)，用自己的Prompt逐场景验证。

不要从“阶段A”“节点3”开始背。先知道对象为什么存在，再看它在节点里怎样创建、保存和消费。

## 掌握标准

1. **L1能讲懂**：用自己的话解释对象、边界和设计原因。
2. **L2能定位**：给一个Product Run ID，能在UI、源码、Product Store、Checkpoint和Trace找到同一事实。
3. **L3能安全修改**：能预测Schema、版本/Hash、恢复、协议和测试影响，并用质量门验证。

“读过文档”“知道文件名”“背出节点顺序”都不算掌握。

## 口径总账

| 名称 | 当前数量 | 来源 |
|---|---:|---|
| 项目交付阶段 | 9个（0–8） | `PROJECT_PLAN.md` |
| 主Workflow学习阶段 | 7个（S1–S7） | `backend/app/continuous_workflow_learning.py` |
| 主Workflow节点/边 | 39/43 | `backend/app/workflows/catalog.py` |
| 典型主Workflow路径 | 8条 | `continuous_chat_factory.py`两个Switch |
| Context装配步骤 | 2个（directory/detail） | Context Executor |
| 单模型审批代码阶段 | 12个 | 仅`chat-model-call-approval` |
| 已注册Workflow | 6个 | `WORKFLOW_CATALOG` |
| 目标产品模块 | 11个 | 已批准总体架构 |
| 学习单元 | 27个（M00–M26） | `coverage-manifest.json` |
| 可执行调试场景 | 15个（SC01–SC15） | `调试实战/scenario-manifest.json` |

运行`.venv/bin/python scripts/check-project-mastery.py`会用代码反向核对这些事实。

## 00—从这里开始

| 文档 | 解决的问题 |
|---|---|
| [全盘掌握范围与覆盖审计](./00-从这里开始/全盘掌握范围与覆盖审计.md) | 11模块、27学习单元、源码面、未实现能力有没有漏 |
| [Chat系统总地图与学习方法](./00-从这里开始/Chat系统总地图与学习方法.md) | 产品架构、Workflow、代码地图、项目计划怎样区分 |

## 架构与模块

| 文档 | 解决的问题 |
|---|---|
| [Chat总体架构与一次点击的七层链路](./架构与模块/Chat总体架构与一次点击的七层链路.md) | 为什么这样分层，11模块怎样跨层，以及理论如何落实为当前技术、源码、对象和Store |
| [11个产品模块的职责与代码落点](./架构与模块/11个产品模块的职责与代码落点.md) | 完整产品模块、状态所有者、当前实现/未实现边界 |
| [核心对象词典](./架构与模块/核心对象词典-谁创建谁保存谁消费.md) | View、DTO、Envelope、领域对象、Runtime对象的生命周期 |
| [进程、协议与Store为什么必须分开](./架构与模块/进程协议与Store为什么必须分开.md) | FastAPI/Worker/pi/浏览器怎样通信，各类状态存在哪里 |

## Workflow架构与ProductAwareWorkflow

| 文档 | 解决的问题 |
|---|---|
| [持续协作主Workflow的39节点设计](./Workflow架构与ProductAwareWorkflow/持续协作主Workflow的39节点设计.md) | v1.8.0、39节点、43边、7学习阶段、8路径与HITL总账 |
| [S1：输入接纳与目录级上下文](./Workflow架构与ProductAwareWorkflow/学习阶段S1-输入接纳与目录级上下文.md) | Message、TurnSummary候选和directory Context怎样形成 |
| [S2：意图、Project绑定与详情上下文](./Workflow架构与ProductAwareWorkflow/学习阶段S2-意图Project绑定与详情上下文.md) | Intent Set、权威绑定、detail Context和协议怎样形成 |
| [S3：场景路由与可选规划](./Workflow架构与ProductAwareWorkflow/学习阶段S3-场景路由与可选规划.md) | 4路场景Switch、澄清和Plan治理 |
| [S4：执行草稿、授权与运行路由](./Workflow架构与ProductAwareWorkflow/学习阶段S4-执行草稿授权与运行路由.md) | ExecutionDraft、Hash、Grant、RunSpec和3路执行Switch |
| [S5：pi执行、Workspace与Evidence](./Workflow架构与ProductAwareWorkflow/学习阶段S5-pi执行Workspace与Evidence.md) | pi只读/隔离编辑、Tool账本、Artifact和Claim |
| [S6：响应、摘要与提交决定](./Workflow架构与ProductAwareWorkflow/学习阶段S6-响应摘要与提交决定.md) | Result、Work、Memory为何分别决定 |
| [S7：产品事实写入与本轮终态](./Workflow架构与ProductAwareWorkflow/学习阶段S7-产品事实写入与本轮终态.md) | 幂等提交、TurnSummary、Finalization与双Trace |
| [ProductAwareWorkflow与全部Workflow](./Workflow架构与ProductAwareWorkflow/ProductAwareWorkflow设计与全部Workflow的关系.md) | 图外Product Run生命周期、6个Workflow和辅助图边界 |

## Context与回合沉淀

| 文档 | 解决的问题 |
|---|---|
| [recent_turn_summaries与ContextPackage为什么存在](./Context与回合沉淀/recent_turn_summaries与ContextPackage为什么存在.md) | 从第一性原理理解摘要、Context Item、revision、Hash和持久化 |

## Session与状态持久化

| 文档 | 解决的问题 |
|---|---|
| [前端会话面板的数据来源与保存形式](./Session与状态持久化/前端会话面板的数据来源与保存形式.md) | Product Session/Message与MAF Session/Checkpoint为什么分开 |

## 执行层与pi运行时

| 文档 | 解决的问题 |
|---|---|
| [从用户点击发送到pi执行的完整链路](./执行层与pi运行时/从用户点击发送到pi执行的完整链路.md) | 主Workflow怎样从S4路由到S5并启动pi |
| [pi子进程在哪里启动](./执行层与pi运行时/pi子进程在哪里启动.md) | `PiRuntimeManager`、`PiExecution`和Node子进程入口 |

## Trace与可观测性

| 文档 | 解决的问题 |
|---|---|
| [每轮双Trace如何保存、分析与可视化](./Trace与可观测性/每轮双Trace如何保存、分析与可视化.md) | Product过程事实、machine/human报告、Runtime日志怎样区分 |

## 调试实战

| 文档 | 实验目标 |
|---|---|
| [场景实验室使用方法](./调试实战/00-场景实验室使用方法.md) | 用自己的Prompt，先写分级预言机，再按断点/Store/Trace判定15个场景 |
| [第1课：从点击发送到ContextPackage](./调试实战/第1课-从点击发送到ContextPackage.md) | 用断点、只读SQL和Trace亲眼验证S1节点1–5 |
| [第2课：公共断点与Trace工具](./调试实战/第2课-端到端全链调试与Trace使用.md) | 复用前端/接纳/Worker/Workflow/提交边界断点；具体预期由场景卡拥有 |
| [第3课：真实运行证据样本](./调试实战/第3课-真实运行全链透视.md) | 7次历史真实运行的实测值与问题发现；不是可重复场景合同 |
| [Chat与pi的两种调试模式](./调试实战/Chat与pi的两种调试模式.md) | 只调Chat仍使用pi，以及双窗口联合调试pi源码 |

15张独立场景卡位于[调试实战/场景](./调试实战/场景/)，覆盖确定性查询、普通问答、澄清、多Intent、
Context revision/失效、模型请求修改/放弃、pi只读、隔离编辑与Evidence、Validation失败、断线、取消、
Retry/Restart和跨进程HITL恢复。每张卡都绑定当前测试函数、输入族、逐节点/边界数据账和通过/失败预言机。

## 机器覆盖与补文档顺序

`coverage-manifest.json`维护M00–M26、11模块、后端/前端源码面、6个Workflow、39节点、S1–S7、
进程角色、协议边界、状态位置和质量/部署面。标记“待补L1/L2”的学习单元仍是后续教材缺口；本轮先把
全局架构、对象模型和主Workflow全阶段的骨架补齐，没有把“有映射”冒充“已经精通”。

`调试实战/scenario-manifest.json`另外维护SC01–SC15的文档、pytest证据、必经/禁止节点和断言等级；
`scripts/check-project-mastery.py`会同时检查两本机器账。
