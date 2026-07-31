# 项目掌握 — 唯一学习入口与61课完整路线

这里是Later掌握Chat源码的**唯一课程入口**。项目根目录先从`README.md`来到本页；进入本页后，
从第01课顺序读到第61课，不需要再按文件夹猜下一篇，也不需要搜索场景文件名。

这61课恰好覆盖`项目掌握/`下全部面向学习者的Markdown文档。没有进入课程的只有2个特殊文件：
本页`INDEX.md`本身，以及约束AI怎样维护教材的`AGENTS.md`。`docs/`、概念空间和项目治理文档是
课程会引用的权威证据，不强行混入线性课程；稳定产品定义看`PROJECT_CONTEXT.md`，当前实现看
`PROJECT_STATE.md`，交付路线看`PROJECT_PLAN.md`，具体行为最终以源码和测试为准。

```mermaid
flowchart LR
    R["根README"] --> I["本页：唯一课程入口"]
    I --> P0["01–02 定路线与覆盖"]
    P0 --> P1["03–10 Web运行和框架基础"]
    P1 --> P2["11–21 架构、对象和治理"]
    P2 --> P3["22–30 MAF主Workflow"]
    P3 --> P4["31–38 执行、证据和工程"]
    P4 --> P5["39–46 调试工具和公共主干"]
    P5 --> P6["47–61 场景逐项验证"]
```

> 课程编号只表示**学习前置关系**，不是项目交付阶段，也不是主Workflow的S1–S7。读一课时，按
> “先预测 → 再看文档 → 点击源码 → 动手观察 → 回答验收题”完成；没有亲手验证，不把个人状态记成L2。

## 61课完整路线

<!-- project-mastery-route:start -->

### 第一段：先知道要学什么（01–02）

| 课 | 文档 | 本课完成标准 |
|---:|---|---|
| 01 | [从Web小白到能设计开发Chat的学习路线](./00-从这里开始/从Web小白到能设计开发Chat的学习路线.md) | 明白B0–B5不是阅读量，而是复述、定位、观察和安全修改能力 |
| 02 | [全盘掌握范围与覆盖审计](./00-从这里开始/全盘掌握范围与覆盖审计.md) | 知道14个状态所有者、3个应用组件、3类运行时职责、28个学习单元和实现缺口怎样互相校验 |

### 第二段：Web运行和前后端框架基础（03–10）

| 课 | 文档 | 本课完成标准 |
|---:|---|---|
| 03 | [从C++到Chat：前后端怎样跑起来](./00-从这里开始/从C++到Chat前后端怎样跑起来.md) | 能从源码说到进程、端口、HTTP、JSON和SSE |
| 04 | [TypeScript、React与Chat前端基础](./00-从这里开始/TypeScript-React与Chat前端基础.md) | 能追一次事件、Hook、State和React重绘 |
| 05 | [Vite、浏览器API与Chat网络调试基础](./00-从这里开始/Vite-浏览器API与Chat网络调试基础.md) | 能在DevTools区分资源、REST、AG-UI POST和SSE |
| 06 | [Uvicorn、FastAPI与Chat后端基础](./00-从这里开始/Uvicorn-FastAPI与Chat后端基础.md) | 能把请求追到ASGI App、Router、DTO和Lifespan |
| 07 | [配置怎样变成整个后端对象图](./00-从这里开始/配置怎样变成整个后端对象图.md) | 能解释Settings、组合根、应用组件和生命周期；不读取私有值 |
| 08 | [Home、App Shell与Workbench怎样协作](./前端交互/Home-AppShell与Workbench怎样协作.md) | 能区分页面状态、后端投影和权威产品事实 |
| 09 | [Chat源码目录、文件职责与模块流程地图](./00-从这里开始/Chat源码目录文件职责与模块流程地图.md) | 能从目录进入进程、架构层、产品模块和主要符号 |
| 10 | [Chat系统总地图与学习方法](./00-从这里开始/Chat系统总地图与学习方法.md) | 能画出一次点击的整机链路并说明各类事实源 |

### 第三段：架构、产品对象和治理边界（11–21）

| 课 | 文档 | 本课完成标准 |
|---:|---|---|
| 11 | [Chat总体架构与一次点击的七层链路](./架构与模块/Chat总体架构与一次点击的七层链路.md) | 能从用户问题推导七层责任、信任和失败边界 |
| 12 | [14个状态所有者与3个应用组件的职责与代码落点](./架构与模块/14个状态所有者与3个应用组件的职责与代码落点.md) | 能解释历史11模块为何演进成14+3+3，并区分架构、设计、实现和验证缺口 |
| 13 | [核心对象词典：谁创建、谁保存、谁消费](./架构与模块/核心对象词典-谁创建谁保存谁消费.md) | 能区分View、DTO、Envelope、产品对象和运行对象 |
| 14 | [进程、协议与Store为什么必须分开](./架构与模块/进程协议与Store为什么必须分开.md) | 能判断一个状态该在进程、协议投影还是哪类Store |
| 15 | [前端会话面板的数据来源与保存形式](./Session与状态持久化/前端会话面板的数据来源与保存形式.md) | 能区分Product Session、AG-UI Thread、MAF Session和Checkpoint |
| 16 | [Project、Work、Plan、Action、Note与Memory为什么分开](./Product%20Harness与协作对象/Project-Work-Plan-Action-Note与Memory为什么分开.md) | 能解释6类协作对象的生命周期与提交边界 |
| 17 | [APP-PROJECTION怎样把同一Project呈现到Web与Obsidian](./架构与模块/APP-PROJECTION怎样把同一Project呈现到Web与Obsidian.md) | 能从Product Store追到角色视图、Dossier、稳定文件树和只读ZIP，并说清已实现与缺口 |
| 18 | [recent_turn_summaries与ContextPackage为什么存在](./Context与回合沉淀/recent_turn_summaries与ContextPackage为什么存在.md) | 能解释上下文来源、revision、Hash和历史边界 |
| 19 | [Intent、澄清、协议、StepInput与Plan怎样连接](./协作理解与执行治理/Intent-澄清-协议-StepInput与Plan怎样连接.md) | 能把原话追到多Intent、澄清、协作规则和Plan |
| 20 | [ExecutionDraft、RunSpec、HITL、Decision与Grant怎样连接](./协作理解与执行治理/ExecutionDraft-RunSpec-HITL-Decision与Grant怎样连接.md) | 能解释为什么修改内容会使旧批准失效 |
| 21 | [Agent、ModelCall、Workflow与Checkpoint怎样分工](./Agent与MAF运行时/Agent-ModelCall-Workflow与Checkpoint怎样分工.md) | 能区分产品Agent角色、模型调用和MAF运行对象 |

### 第四段：MAF持续协作主Workflow（22–30）

| 课 | 文档 | 本课完成标准 |
|---:|---|---|
| 22 | [ProductAwareWorkflow与全部Workflow的关系](./Workflow架构与ProductAwareWorkflow/ProductAwareWorkflow设计与全部Workflow的关系.md) | 先知道主Workflow、5个辅助Workflow和图外产品生命周期 |
| 23 | [持续协作主Workflow的39节点设计](./Workflow架构与ProductAwareWorkflow/持续协作主Workflow的39节点设计.md) | 能解释39节点、43边、8条典型路径和S1–S7学习分组 |
| 24 | [S1：输入接纳与目录级上下文](./Workflow架构与ProductAwareWorkflow/学习阶段S1-输入接纳与目录级上下文.md) | 掌握节点1–5的输入、对象、Store和失败门 |
| 25 | [S2：意图、Project绑定与详情上下文](./Workflow架构与ProductAwareWorkflow/学习阶段S2-意图Project绑定与详情上下文.md) | 掌握节点6–15的Intent、绑定、Context和协议 |
| 26 | [S3：场景路由与可选规划](./Workflow架构与ProductAwareWorkflow/学习阶段S3-场景路由与可选规划.md) | 掌握节点16–20的路由、澄清和Plan分叉 |
| 27 | [S4：执行草稿、授权与运行路由](./Workflow架构与ProductAwareWorkflow/学习阶段S4-执行草稿授权与运行路由.md) | 掌握节点21–24的Draft、授权、RunSpec和执行路由 |
| 28 | [S5：pi执行、Workspace与Evidence](./Workflow架构与ProductAwareWorkflow/学习阶段S5-pi执行Workspace与Evidence.md) | 掌握节点25–31的两条pi路径与Evidence准备 |
| 29 | [S6：响应、摘要与提交决定](./Workflow架构与ProductAwareWorkflow/学习阶段S6-响应摘要与提交决定.md) | 掌握节点32–36的候选输出和3类提交决定 |
| 30 | [S7：产品事实写入与本轮终态](./Workflow架构与ProductAwareWorkflow/学习阶段S7-产品事实写入与本轮终态.md) | 掌握节点37–39和图外Product Finalization |

### 第五段：执行层、证据、存储与安全修改（31–38）

| 课 | 文档 | 本课完成标准 |
|---:|---|---|
| 31 | [从用户点击发送到pi执行的完整链路](./执行层与pi运行时/从用户点击发送到pi执行的完整链路.md) | 能从前端一路追到S4/S5执行分叉 |
| 32 | [pi子进程在哪里启动](./执行层与pi运行时/pi子进程在哪里启动.md) | 能追到Runtime Manager、JSONL RPC和Node子进程 |
| 33 | [Run、Worker、Cursor、Tool与Workspace怎样恢复](./运行执行与证据/Run-Worker-Cursor-Tool与Workspace怎样恢复.md) | 能区分Run、Attempt、Job、Lease、Cursor和Tool账本 |
| 34 | [Artifact、Evidence、Validation、Claim与Result Commit怎样证明完成](./运行执行与证据/Artifact-Evidence-Validation-Claim与ResultCommit怎样证明完成.md) | 能解释为什么进程成功不等于产品完成 |
| 35 | [每轮双Trace如何保存、分析与可视化](./Trace与可观测性/每轮双Trace如何保存、分析与可视化.md) | 能区分事实事件、machine报告、human报告与日志 |
| 36 | [SQLite、Alembic、事务、CAS、幂等与Outbox怎样配合](./工程基础/SQLite-Alembic-事务-CAS幂等与Outbox怎样配合.md) | 能解释并发、重复命令和跨进程恢复的物理底座 |
| 37 | [测试金字塔、质量门与安全修改怎样配合](./工程基础/测试金字塔-质量门与安全修改怎样配合.md) | 能为一次改动选择合同、故障、浏览器和真实运行证据 |
| 38 | [Chat与pi的两种调试模式](./调试实战/Chat与pi的两种调试模式.md) | 能选择只调Chat或跨仓双窗口调pi源码 |

### 第六段：调试工具、公共调用栈和实验方法（39–46）

| 课 | 文档 | 本课完成标准 |
|---:|---|---|
| 39 | [从断点停住到知道来路和下一跳](./调试实战/从断点停住到知道来路和下一跳.md) | 能在任一断点回答调用者、当前数据和下一跳 |
| 40 | [一句Prompt如何逐层变成Chat对象](./调试实战/一句Prompt如何逐层变成Chat对象.md) | 能沿同一Run解释字段在哪一层被增加或转换 |
| 41 | [断点清单与调试配置](./调试实战/断点清单与调试配置.md) | 能按场景选择小断点组合，不在默认运行中卡住 |
| 42 | [场景实验室使用方法](./调试实战/00-场景实验室使用方法.md) | 能先写预言机，再用断点、Store和Trace验收 |
| 43 | [第1课：从点击发送到ContextPackage](./调试实战/第1课-从点击发送到ContextPackage.md) | 完成第一条可重复的S1数据实验 |
| 44 | [第2课：端到端全链调试与Trace使用](./调试实战/第2课-端到端全链调试与Trace使用.md) | 能复用公共断点和Trace工具定位分叉 |
| 45 | [第3课：真实运行全链透视](./调试实战/第3课-真实运行全链透视.md) | 会区分历史实测样本和当前可重复合同 |
| 46 | [15个场景教材深度审计与升级顺序](./调试实战/15个场景教材深度审计与升级顺序.md) | 先看清每个场景是L2实值、L1+受控证据还是缺口 |

### 第七段：用自己的输入逐场景验证（47–61）

| 课 | 场景 | 当前教材证据 |
|---:|---|---|
| 47 | [SC01：确定性查询正式Project目录](./调试实战/场景/SC01-确定性查询正式Project目录.md) | L2+：当前真实确定性Run与精确合同 |
| 48 | [SC02：普通问答与三次模型调用治理](./调试实战/场景/SC02-普通问答与三次模型调用治理.md) | L2：当前真实3次ModelCall Run |
| 49 | [SC03：歧义请求与跨回合澄清](./调试实战/场景/SC03-歧义请求与跨回合澄清.md) | 第一轮L2；跨回合部分L1+ |
| 50 | [SC04：多Intent与组合Plan](./调试实战/场景/SC04-多Intent与组合Plan.md) | L1+：受控集成Fixture |
| 51 | [SC05：修改Context与revision失效](./调试实战/场景/SC05-修改Context与revision失效.md) | L1+：受控集成Fixture |
| 52 | [SC06：Repository来源失效零发送](./调试实战/场景/SC06-Repository来源失效零发送.md) | 失败路径L2：当前真实失败Run与零新发送合同 |
| 53 | [SC07：编辑模型请求与重新审批](./调试实战/场景/SC07-编辑模型请求与重新审批.md) | L1+：字节精确受控Fixture |
| 54 | [SC08：放弃模型调用零发送](./调试实战/场景/SC08-放弃模型调用零发送.md) | L2：当前真实放弃Run与零发送合同 |
| 55 | [SC09：受治理pi只读检查](./调试实战/场景/SC09-受治理pi只读检查.md) | L2：当前真实pi进程与Tool Run |
| 56 | [SC10：隔离精确编辑与Evidence提交](./调试实战/场景/SC10-隔离精确编辑与Evidence提交.md) | L1+并保留真实缺口样本；不要误判成完整成功 |
| 57 | [SC11：Validation失败与结果未知](./调试实战/场景/SC11-Validation失败与结果未知.md) | L1+：受控故障注入 |
| 58 | [SC12：断线后Worker继续与Cursor接回](./调试实战/场景/SC12-断线后Worker继续与Cursor接回.md) | L1+：真实Runtime组件与受控断线 |
| 59 | [SC13：取消与结果未知](./调试实战/场景/SC13-取消与结果未知.md) | L1+：受控产品状态机 |
| 60 | [SC14：Retry与Restart血缘](./调试实战/场景/SC14-Retry与Restart血缘.md) | L1+：受控Product Run血缘 |
| 61 | [SC15：跨进程HITL恢复](./调试实战/场景/SC15-跨进程HITL恢复.md) | L1+：受控多进程SQLite与Worker |

<!-- project-mastery-route:end -->

如果某一课卡住，不要跳到后面背名词：回到本页看它的上一课。课程到第61课结束后，再按下方分类索引
把文档当作日常查询手册；分类是“查资料的地图”，上面的61课才是“第一次学习的顺序”。

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
| 逻辑状态所有者 | 14个 | 已批准总体架构 |
| 应用协调与投影组件 | 3个 | 已批准总体架构 |
| 运行与基础设施职责 | 3类 | 已批准总体架构 |
| 学习单元 | 28个（M00–M27） | `coverage-manifest.json` |
| 连续课程文档 | 61篇（01–61） | 本页`project-mastery-route`区块 |
| 可执行调试场景 | 15个（SC01–SC15） | `调试实战/scenario-manifest.json` |

运行`.venv/bin/python scripts/check-project-mastery.py`会用代码反向核对这些事实。

## 00—从这里开始

| 文档 | 解决的问题 |
|---|---|
| [从Web小白到能设计开发Chat的学习路线](./00-从这里开始/从Web小白到能设计开发Chat的学习路线.md) | B0基础到B5安全改功能应按什么顺序学、每一级怎样才算过关 |
| [全盘掌握范围与覆盖审计](./00-从这里开始/全盘掌握范围与覆盖审计.md) | 14+3+3架构责任、28个学习单元、源码面和未实现能力有没有漏 |
| [从C++到Chat：前后端怎样跑起来](./00-从这里开始/从C++到Chat前后端怎样跑起来.md) | TypeScript/Python源码由谁执行，Vite/Uvicorn怎样启动，浏览器和后端怎样通过HTTP/JSON/SSE交互 |
| [TypeScript、React与Chat前端基础](./00-从这里开始/TypeScript-React与Chat前端基础.md) | JavaScript/TypeScript/TSX、组件、Props、State、Hook和当前Chat组件树怎样工作 |
| [Vite、浏览器API与Chat网络调试基础](./00-从这里开始/Vite-浏览器API与Chat网络调试基础.md) | Vite、DOM、事件、Fetch、Storage、Abort、AG-UI流和DevTools怎样落到当前代码 |
| [Uvicorn、FastAPI与Chat后端基础](./00-从这里开始/Uvicorn-FastAPI与Chat后端基础.md) | Python模块、Uvicorn、ASGI、FastAPI、Starlette、Pydantic、Router、Middleware与Lifespan怎样落到当前代码 |
| [配置怎样变成整个后端对象图](./00-从这里开始/配置怎样变成整个后端对象图.md) | config字段形状怎样变成Settings、组合根、应用组件与启动/关闭生命周期，同时不泄露私有值 |
| [Chat源码目录、文件职责与模块流程地图](./00-从这里开始/Chat源码目录文件职责与模块流程地图.md) | 每个关键文件由谁加载、属于哪层/模块、上下游与状态所有权是什么，以及大文件怎样审查 |
| [Chat系统总地图与学习方法](./00-从这里开始/Chat系统总地图与学习方法.md) | 产品架构、Workflow、代码地图、项目计划怎样区分 |

## 前端交互

| 文档 | 解决的问题 |
|---|---|
| [Home、App Shell与Workbench怎样协作](./前端交互/Home-AppShell与Workbench怎样协作.md) | React入口、Feature懒加载、Home/Chat/Workbench、页面State和后端权威事实怎样协作 |

## 架构与模块

| 文档 | 解决的问题 |
|---|---|
| [Chat总体架构与一次点击的七层链路](./架构与模块/Chat总体架构与一次点击的七层链路.md) | 从场景和失败保证推导七层、历史11模块与正式14+3+3责任，并将理论落到当前技术、源码、对象和Store |
| [14个状态所有者与3个应用组件的职责与代码落点](./架构与模块/14个状态所有者与3个应用组件的职责与代码落点.md) | 历史演进、状态所有者、应用协调、运行时职责、当前实现边界与缺口分类 |
| [核心对象词典](./架构与模块/核心对象词典-谁创建谁保存谁消费.md) | View、DTO、Envelope、领域对象、Runtime对象的生命周期 |
| [进程、协议与Store为什么必须分开](./架构与模块/进程协议与Store为什么必须分开.md) | FastAPI/Worker/pi/浏览器怎样通信，各类状态存在哪里 |
| [APP-PROJECTION怎样把同一Project呈现到Web与Obsidian](./架构与模块/APP-PROJECTION怎样把同一Project呈现到Web与Obsidian.md) | 同一权威Project怎样变成工作台、Dossier、角色责任和可重建Obsidian文件 |

## Product Harness与协作对象

| 文档 | 解决的问题 |
|---|---|
| [Project、Work、Plan、Action、Note与Memory为什么分开](./Product%20Harness与协作对象/Project-Work-Plan-Action-Note与Memory为什么分开.md) | 从用户目标推导6类协作对象、各自生命周期、Store和完成/接受边界 |

## 协作理解与执行治理

| 文档 | 解决的问题 |
|---|---|
| [Intent、澄清、协议、StepInput与Plan怎样连接](./协作理解与执行治理/Intent-澄清-协议-StepInput与Plan怎样连接.md) | 原话怎样形成多Intent、跨回合澄清、有效协作规则、节点输入和Plan |
| [ExecutionDraft、RunSpec、HITL、Decision与Grant怎样连接](./协作理解与执行治理/ExecutionDraft-RunSpec-HITL-Decision与Grant怎样连接.md) | 人工看见的执行候选怎样通过版本、Hash、决定和一次性授权变成运行合同 |

## Agent与MAF运行时

| 文档 | 解决的问题 |
|---|---|
| [Agent、ModelCall、Workflow与Checkpoint怎样分工](./Agent与MAF运行时/Agent-ModelCall-Workflow与Checkpoint怎样分工.md) | Chat Agent角色、Provider调用、MAF图/Session/Checkpoint和Product Run为何不能混用 |

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

## 运行执行与证据

| 文档 | 解决的问题 |
|---|---|
| [Run、Worker、Cursor、Tool与Workspace怎样恢复](./运行执行与证据/Run-Worker-Cursor-Tool与Workspace怎样恢复.md) | Product Run、Attempt、Job、Lease、Cursor、ToolExecution/Operation和隔离Workspace如何串联 |
| [Artifact、Evidence、Validation、Claim与Result Commit怎样证明完成](./运行执行与证据/Artifact-Evidence-Validation-Claim与ResultCommit怎样证明完成.md) | 为什么进程成功不是产品完成，以及证据/来源/提交门如何阻止假成功 |

## 工程基础

| 文档 | 解决的问题 |
|---|---|
| [SQLite、Alembic、事务、CAS、幂等与Outbox怎样配合](./工程基础/SQLite-Alembic-事务-CAS幂等与Outbox怎样配合.md) | 物理Store、Schema演进、并发、重复命令和跨进程可靠恢复怎样配合 |
| [测试金字塔、质量门与安全修改怎样配合](./工程基础/测试金字塔-质量门与安全修改怎样配合.md) | 不同测试证明什么、预言机怎样分级、如何从红测试到真实Run安全修改 |

## 调试实战

| 文档 | 实验目标 |
|---|---|
| [场景实验室使用方法](./调试实战/00-场景实验室使用方法.md) | 用自己的Prompt，先写分级预言机，再按断点/Store/Trace判定15个场景 |
| [从断点停住到知道来路和下一跳](./调试实战/从断点停住到知道来路和下一跳.md) | 从目录、文件和函数建立4段调用栈，知道每个公共断点的调用者、当前数据、下一跳和调试按键 |
| [一句Prompt如何逐层变成Chat对象](./调试实战/一句Prompt如何逐层变成Chat对象.md) | 用SC01同一真实Run展示原话怎样叠加协议身份、Product对象、Runtime Job、MAF状态和回程事件 |
| [断点清单与调试配置](./调试实战/断点清单与调试配置.md) | VS Code配置、代码级断点开关、场景Profile和每个断点的触发边界 |
| [15个场景教材深度审计](./调试实战/15个场景教材深度审计与升级顺序.md) | 逐场景记录L1+/L2、真实/受控/缺口证据；SC10真实缺口不被测试替身掩盖 |
| [第1课：从点击发送到ContextPackage](./调试实战/第1课-从点击发送到ContextPackage.md) | 用断点、只读SQL和Trace亲眼验证S1节点1–5 |
| [第2课：公共断点与Trace工具](./调试实战/第2课-端到端全链调试与Trace使用.md) | 复用前端/接纳/Worker/Workflow/提交边界断点；具体预期由场景卡拥有 |
| [第3课：真实运行证据样本](./调试实战/第3课-真实运行全链透视.md) | 7次历史真实运行的实测值与问题发现；不是可重复场景合同 |
| [Chat与pi的两种调试模式](./调试实战/Chat与pi的两种调试模式.md) | 只调Chat仍使用pi，以及双窗口联合调试pi源码 |

### 15张场景卡直接入口

| 场景 | 文档 | 当前教材证据 |
|---|---|---|
| SC01 | [确定性查询正式Project目录](./调试实战/场景/SC01-确定性查询正式Project目录.md) | L2+，当前真实确定性Run |
| SC02 | [普通问答与三次模型调用治理](./调试实战/场景/SC02-普通问答与三次模型调用治理.md) | L2，当前真实3次ModelCall Run |
| SC03 | [歧义请求与跨回合澄清](./调试实战/场景/SC03-歧义请求与跨回合澄清.md) | 第一轮L2、跨回合L1+ |
| SC04 | [多Intent与组合Plan](./调试实战/场景/SC04-多Intent与组合Plan.md) | L1+受控集成Fixture |
| SC05 | [修改Context与revision失效](./调试实战/场景/SC05-修改Context与revision失效.md) | L1+受控集成Fixture |
| SC06 | [Repository来源失效零发送](./调试实战/场景/SC06-Repository来源失效零发送.md) | 失败链L2，当前真实失败Run |
| SC07 | [编辑模型请求与重新审批](./调试实战/场景/SC07-编辑模型请求与重新审批.md) | L1+字节精确Fixture |
| SC08 | [放弃模型调用零发送](./调试实战/场景/SC08-放弃模型调用零发送.md) | L2，当前真实放弃Run |
| SC09 | [受治理pi只读检查](./调试实战/场景/SC09-受治理pi只读检查.md) | L2，当前真实pi与Tool Run |
| SC10 | [隔离精确编辑与Evidence提交](./调试实战/场景/SC10-隔离精确编辑与Evidence提交.md) | L1+且保留真实0 Artifact/Claim/Commit缺口 |
| SC11 | [Validation失败与结果未知](./调试实战/场景/SC11-Validation失败与结果未知.md) | L1+受控故障注入 |
| SC12 | [断线后Worker继续与Cursor接回](./调试实战/场景/SC12-断线后Worker继续与Cursor接回.md) | L1+真实Runtime组件与受控断线 |
| SC13 | [取消与结果未知](./调试实战/场景/SC13-取消与结果未知.md) | L1+受控产品状态机 |
| SC14 | [Retry与Restart血缘](./调试实战/场景/SC14-Retry与Restart血缘.md) | L1+受控Run血缘 |
| SC15 | [跨进程HITL恢复](./调试实战/场景/SC15-跨进程HITL恢复.md) | L1+受控多进程SQLite与Worker |

场景卡覆盖确定性查询、普通问答、澄清、多Intent、Context revision/失效、模型请求修改/放弃、pi只读、
隔离编辑与Evidence、Validation失败、断线、取消、Retry/Restart和跨进程HITL恢复。每张卡都绑定当前测试函数、
输入族、关键节点/边界和通过/失败预言机；受控证据不能冒充当前真实Run，SC10也不会把
“Run succeeded但0 Artifact/Claim/Commit”解释成完整成功。

## 机器覆盖与补文档顺序

本页`project-mastery-route`区块维护01–61的第一次学习顺序，反向覆盖全部学习者Markdown；
`coverage-manifest.json`维护M00–M27、14个状态所有者、3个应用组件、3类运行时职责、后端/前端源码面、6个Workflow、39节点、S1–S7、
进程角色、协议边界、状态位置和质量/部署面。M01、M02、M06、M08–M10、M12–M20和M27现在已有面向小白的专题入口；
目标尚未实现、辅助Workflow未逐个L2和需要用户亲手完成的L3验收仍保留为显式缺口。

`调试实战/scenario-manifest.json`另外维护SC01–SC15的文档、pytest证据、必经/禁止节点和断言等级；
`scripts/check-project-mastery.py`会同时检查连续课程路线与两本机器账。
