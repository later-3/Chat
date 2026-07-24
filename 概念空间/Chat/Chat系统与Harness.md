# Chat系统与Chat Harness

## 文档治理信息

| 项目 | 内容 |
|---|---|
| 目的 | 固定完整Chat系统、Chat Harness、MAF AI Runtime、执行层和前端之间的责任边界。 |
| 概念状态 | 有效；2026-07-24用户确认Chat系统由Chat Harness与基于MAF的AI运行能力共同构成。 |
| 实现状态 | 局部实现并持续建设：Product Harness、持续协作Workflow、模型调用治理、运行恢复和渐进式Workbench已有纵向切片；多Product Session共享Harness目标已批准，但活动感知与冲突交互尚未实现；完整Tool/Evidence、周期工作、身份/多入口和生产运营能力仍未完成。 |
| 产品责任 | [PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md) |
| 实现事实 | [PROJECT_STATE.md](../../PROJECT_STATE.md) |
| 维护责任 | 产品概念、总体架构、Harness应用层、MAF运行层、执行层与前端各自维护对应事实。 |

## 一句话理解

**Chat系统是完整协作产品；Chat Harness保存并约束“用户在做什么、采用什么信息与规则、什么可以执行和回写”，MAF AI Runtime负责受控智能运行，执行层负责有权限边界的真实动作。**

## 为什么需要

直接把用户一句话和不断增长的聊天历史交给模型，会同时产生4类问题：

1. 用户没有重复项目、学习或任务背景时，模型缺少真正需要的上下文。
2. 全量历史不断累积，噪声、过期信息和Token成本一起增加。
3. 模型候选容易被误当成正式Project、Work、Memory或“已经完成”的事实。
4. 用户看不见系统采用了什么、为什么这样运行，也无法在执行前修正。

Chat Harness把成熟的项目、任务、学习、研究和周期工作方法变成版本化协作协议，把长期事实和
每轮Context分开管理，并给用户提供可读、可选、可修改和可追溯的交互面。

## 定义

| 概念 | 定义 |
|---|---|
| Chat系统 | 完整产品边界，包括用户交互、产品事实、协作方法、Agent与Workflow运行、执行、证据、交付、恢复和可观察性。 |
| Chat Harness | 产品语义与协作控制系统，把自然语言落到可维护、可审核、可执行和可恢复的产品对象与规则。 |
| Chat AI Runtime | 基于MAF组织Agent、Workflow、Executor、Checkpoint、模型与Tool调用的智能运行能力。 |
| 执行层 | 具有独立权限、副作用、恢复和证据边界的Worker、Tool Gateway、pi等外部Runtime、Validator与Reconciler。 |
| 前端交互面 | Harness与Runtime的可读投影及命令入口，不是新的事实源。 |

Chat Harness拥有或协调：

1. Product Session、Interaction和Message等对话事实。
2. Project、Work、Plan和Action等工作事实。
3. Note、Memory、规则、来源和Context等知识事实。
4. 版本化协作协议及其作用域Binding。
5. ExecutionDraft、RunSpec、HITL、Approval和产品提交门。
6. Evidence、Artifact、Trace、Delivery及失效传播。
7. 用户、Workflow Agent和执行层所需的不同公开投影。

## 边界与不是什么

1. Chat系统不是聊天页面、单个MAF Agent、一次Prompt调用，也不是外部系统的附属通道。
2. Chat Harness不是大Prompt、System Instructions、MAF AgentSession、万能Service或数据库大表。
3. Project、Context或Memory面板只是Harness权威事实的可读投影和命令入口。
4. Chat AI Runtime不拥有Product Session、Project、Work、Accepted Memory、Approval或Product Run最终成功事实。
5. 执行层只能接收当前步骤的受控输入与能力Allowlist；不能扩大RunSpec，也不能直接提交长期产品事实。
6. 前端不拥有权威业务状态，刷新后必须能从Product Store、Trace、Checkpoint和运行事件恢复投影。
7. 一个Project的代码仓库或物理目录不是新的Chat部署边界；同一用户的多个Product Session共享
   Harness，并以revision、CAS和来源Trace治理并发修改。

## 关系

```text
用户
  ↕ 前端交互面
Chat Harness
  ├─ 权威事实、协议、Context、治理、结果和提交门
  └─ 为每一步编译最小充分输入
       ↕ revision与hash绑定
Chat AI Runtime（MAF）
  ├─ Agent / Workflow / Executor / Model / Tool
  └─ 公开结果、候选Product Patch和Evidence
       ↕ 受控执行合同
执行层
  └─ Worker / Tool Gateway / pi / Validator / Reconciler
```

一次协作回合的核心对象链是：

```text
用户输入
-> Intent候选与Project/Work绑定
-> Collaboration Protocol选择
-> ContextPackage revision
-> ExecutionDraft revision
-> 用户或策略决定
-> 不可变RunSpec
-> MAF Workflow步骤与StepInputProjection
-> 模型/Tool/执行层Attempt
-> 候选结果、Evidence与验证
-> Product提交
-> TurnDigest和后续Context索引
```

## 人和系统怎样使用

用户通过渐进式界面完成4件事：

1. 先看本轮目标、关联Project/Work、采用的协作方法、关键规则、Context预算和当前步骤。
2. 按需展开来源内容，采用、排除、锁定或直接修正要进入本轮的Context。
3. 在有影响的节点回答澄清、修改ExecutionDraft、确认或停止；可按作用域配置哪些HITL允许跳过。
4. 运行后查看节点真实输入、公开输出、Evidence、状态回写和下一步，不需要到多个页面拼事实。
5. 在多个Product Session同时推进事项时，看见相关资源的其他活动Run、来源变更和冲突Diff；关闭
   一个Session不取消其他Run，无冲突更新也不应频繁打断用户。

Chat Workflow每轮必须按确定性边界先读权威目录和用户已接受事实，再让模型处理语义候选；模型、
Agent和执行Runtime都不能绕过Harness直接提交Product事实。执行层只收到当前步骤的最小工作包、
允许能力、预算、输出合同和停止条件。

## 正例与反例

正例：用户说“继续昨天的FastAPI学习”，系统先用轻量目录命中学习Project，再只装配该Project
的开放学习单元、相关Note和Accepted Memory；用户可以排除一条不相关Note后再执行。

正例：软件交付步骤只给pi当前目标、必要代码/规则索引、允许Tool、验证标准和停止条件；完成后
还要经过测试Evidence与产品提交门。

反例：把全部项目规则写进System Prompt，或把一个Session的所有消息无边界加入每轮上下文。

反例：MAF Workflow跑完就把Project标记为完成；Workflow输出只是候选，完成还需要Evidence与
产品状态转换。

反例：前端勾选Context后直接修改旧记录；正确做法是提交不可变Context revision并使旧授权失效。

反例：用户、Chat和pi共享同一份巨大Markdown；三方应引用同一协议revision的不同最小投影。

反例：因为Harness负责总体控制，就把所有规则、查询和事务塞进一个HarnessService。

## 当前状态与未知

已实现并验证的关键纵向能力包括：

1. Product Session、Message、Run/Attempt、Harness Project/Work/Plan/Action/Note/Memory与两阶段Context。
2. 持续协作MAF Workflow、逐次模型调用审批、ExecutionDraft/RunSpec和Checkpoint/Outbox恢复切片。
3. 7类内置协作协议、4级Binding解析、TurnDigest v1、不可变Context修订与步骤输入投影。
4. 渐进式Harness Workbench、Workflow思维导图、节点公开内容、HITL矩阵和配置中心入口。

仍未完成的目标能力以[项目状态](../../PROJECT_STATE.md#5-尚未实现的能力)为准，重点包括通用Tool
副作用对账、独立Evidence/Artifact/Delivery生命周期、周期Schedule、完整多Intent、身份/多入口、
完整Session恢复矩阵以及生产SLO/备份/容量与告警。

尚需通过真实用户体验继续验证：信息层级是否足够清楚、默认展开量是否合适、普通用户与设计者视图
是否应进一步分离，以及不同作用域的协议和HITL配置是否容易理解。

## 来源与依据

1. 稳定产品目标与对象边界：[PROJECT_CONTEXT.md](../../PROJECT_CONTEXT.md)。
2. 当前实现事实和未完成能力：[PROJECT_STATE.md](../../PROJECT_STATE.md)。
3. 分阶段交付与质量门：[PROJECT_PLAN.md](../../PROJECT_PLAN.md)。
4. 协议、Context与步骤输入Schema：[Chat Harness协议、Context与步骤输入详细设计](../../docs/chat-harness-protocol-context-detailed-design.md)。
5. MAF事实与参考项目规则遵循仓库根[AGENTS.md](../../AGENTS.md)中的固定源码与版本证据顺序。

## 维护与重入

1. 新的长期用户场景先判断能否复用现有Project、Work、Note、Memory、Schedule、Evidence和协议对象，不能先造一个新“管理器”。
2. 修改产品身份、状态所有权或Harness/Runtime/执行层边界时，先更新稳定产品文档并获得审核。
3. 新协作方法发布新Definition revision，不能原地修改已被Run引用的协议。
4. Context、ExecutionDraft和RunSpec使用revision/hash保持可重入；重放不能产生不同权威事实。
5. 新Session或进程恢复必须从仓库治理文档、Product Store和可恢复运行事实继续，不能依赖当前对话记忆。

## 验证

1. 概念验证必须通过`概念空间/验证概念空间.py`，并区分概念有效与功能已实现。
2. 领域验证覆盖状态机、CAS、幂等、事务回滚、来源失效、权限边界和候选不得冒充事实。
3. 长场景覆盖软件项目、学习、研究、周期工作、无关问答、多项目切换、跨天和进程重建。
4. 运行验证覆盖Worker退出、Checkpoint、Outbox、重复、超时、结果未知、拒绝、修改与恢复。
5. 前端验证覆盖键盘、窄屏、渐进披露、加载失败、刷新恢复和真实浏览器交互。
6. 真实模型验证逐次审批每个Provider调用，断言协议、Context来源、结构合同、Attempt和产品提交，不按回答措辞逐字断言。
