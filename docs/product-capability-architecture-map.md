# Chat目标能力、架构责任与开发地图

> 状态：**已批准并进入详细设计/实施追踪**。2026-07-30用户批准D1-D4；同日进一步授权连续完成
> W1-01、W2-01、W4-01、W4-03详细设计；W1-01基础实现已完成，并实现不依赖新Schema的W4-03固定Scope只读切片。
> 其余Schema、迁移、目录重构和完整能力仍按各工作包完成门实施。
>
> 机器关系：[product-capability-manifest.json](./product-capability-manifest.json)
>
> 稳定产品范围：[PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
>
> 当前实现事实：[PROJECT_STATE.md](../PROJECT_STATE.md)
>
> 唯一交付顺序：[PROJECT_PLAN.md](../PROJECT_PLAN.md)

## 1. 结论

Chat已有完整产品愿景和纵向实现；2026-07-30进一步正式批准14个逻辑状态所有者、3个应用组件、
3类运行责任及唯一交付坐标，使系统可以持续回答“缺什么、由谁负责、下一步开发什么”。

本基线把问题改为一条可双向检查的链：

```text
用户场景与产品保证
-> 目标能力CAP
-> 唯一责任模块/应用组件MOD/APP/RT
-> 对象、合同、投影和失败恢复
-> 当前实现证据与差距类型
-> PROJECT_PLAN主工作流下的开发工作包
-> 设计门、自动测试、真实运行和用户验收证据
```

场景总账只负责发现和证伪；看板、进度条和审计板只负责展示上述关系。任何一种展示都不能拥有
Project、Work、Memory、Approval、Evidence或完成状态。

## 2. 文档与机器清单怎样分工

| 事实 | 唯一所有者 | 本文/清单只保存什么 |
|---|---|---|
| 稳定产品问题、能力和体验 | `PROJECT_CONTEXT.md` | `CAP-*`与`SCN-*`的关系和链接 |
| 模块、对象、状态所有权和合同 | `overall-architecture-proposal.md`及获批详细设计 | `MOD-*`、`APP-*`、`RT-*`关系和决策状态 |
| 当前已经完成、缺失和风险 | `PROJECT_STATE.md` | `implemented/partial/missing/design_gap`快照和证据链接 |
| 唯一依赖顺序和完成门 | `PROJECT_PLAN.md` | `Wn-xx`工作包及依赖关系 |
| 具体行为 | 源码、Schema、协议和测试 | 实现/验收证据路径 |
| 课程覆盖 | `项目掌握/coverage-manifest.json` | 不复制；两套检查解决不同问题 |

`product-capability-manifest.json`不是新的产品事实源。它不保存完整需求正文、Schema字段或运行状态，
只保存稳定ID、关系、短状态和权威链接。

## 3. 场景族：用异质场景检查共性底座

| ID | 场景族 | 必须覆盖的代表问题 |
|---|---|---|
| SCN-01 | 权威查询 | “我有哪些项目/开放Work/学习进度”不调用模型猜、不误建资源 |
| SCN-02 | 新建并推进Project | 目标、阶段、Work、下一行动、阻塞、证据和复盘可持续管理 |
| SCN-03 | 跨天学习 | 诊断、练习、评估、复习、到期行动和掌握证据 |
| SCN-04 | 研究与知识沉淀 | 多来源、冲突、Note revision、Provenance和来源失效 |
| SCN-05 | 内容与Artifact交付 | 报告、图片、课程、文档等非代码产物的版本、验证和交付 |
| SCN-06 | 周期工作与提醒 | 时区、触发、漏跑、暂停、补跑、去重和Delivery失败 |
| SCN-07 | Idea捕获与升级 | 低摩擦保存，明确接受、关联、升级、合并和归档 |
| SCN-08 | 多Intent | 独立Context/Run、依赖、部分成功、聚合结果和取消 |
| SCN-09 | 受治理软件开发 | Repository基线、隔离Workspace、Tool副作用、验证、合入和部署授权 |
| SCN-10 | 外部副作用 | 扣费、发消息、写外部系统后的幂等、结果未知、查询与补偿 |
| SCN-11 | 跨Session并发 | 无冲突并行、同资源CAS、Diff/rebase和来源可见性 |
| SCN-12 | 失败与恢复 | 断线、进程退出、Worker接管、Checkpoint、Cursor和人工处置 |
| SCN-13 | 跨入口连续 | Web、Telegram、OPC-OS Bridge共享事实但不共享平台私有状态 |
| SCN-14 | 多呈现方式 | Web看板、Obsidian目录/Markdown和第三方前端读取同一事实 |
| SCN-15 | 超级管理员运营 | 身份、使用口径、工作/作品进度、异常和敏感访问审计 |
| SCN-16 | Chat开发Chat | 使用普通Project、受治理pi、Evidence和提交门完成真实Dogfood |

这些场景不各自创建一套数据库。场景间重复出现且拥有独立状态、事务、权限、恢复或变化节奏的责任
才进入公共模块；只改变方法的进入Protocol；只改变阅读/操作方式的进入Projection；确有领域独特
对象时再单独审核。

## 4. 第一版目标能力目录

下表只给出架构导航。完整用户保证仍由`PROJECT_CONTEXT.md`拥有，当前状态由`PROJECT_STATE.md`
拥有，机器关系由Manifest维护。

| ID | 目标能力 | 唯一责任 | 当前结论 | 主要工作包 |
|---|---|---|---|---|
| CAP-01 | Web工作区、响应式与无障碍 | APP-PROJECTION | 局部实现 | W4-03、W3-02 |
| CAP-02 | Principal、认证、Role/Grant、Scope与Channel信任 | MOD-IDENTITY | 详细设计已批准，未实现 | W2-01 |
| CAP-03 | Product Session、Interaction、Message树与生命周期 | MOD-CONVERSATION | 局部实现 | W2-02 |
| CAP-04 | 连续对话流、Conversation Day、Home与Idea | MOD-CONVERSATION | 局部实现 | W3-02 |
| CAP-05 | Project、Work、Plan、Action与责任闭环 | MOD-WORK | 局部实现，详细边界已批准 | W4-01 |
| CAP-06 | Note、规则与来源化知识 | MOD-KNOWLEDGE | 局部实现，目标边界已批准 | W4-01 |
| CAP-07 | Collaboration Protocol与Binding生命周期 | MOD-PROTOCOL | 局部实现，目标边界已批准 | W4-01 |
| CAP-08 | Context选择、版本、预算和失效 | MOD-CONTEXT | 局部实现 | W3-01 |
| CAP-09 | Memory候选、接受、纠正与失效 | MOD-MEMORY | 局部实现 | W3-01 |
| CAP-10 | Intent、澄清、多Intent和用户修正 | MOD-GOVERNANCE | 局部实现 | W4-02 |
| CAP-11 | ExecutionDraft、RunSpec、HITL、Decision与Approval | MOD-GOVERNANCE | 局部实现 | W4-01、W6-01 |
| CAP-12 | Agent、Workflow、ModelCall与运行时适配 | RT-MAF | 局部实现 | W1-01、W6-01 |
| CAP-13 | Product Run、Attempt、Job、Journal、控制与恢复 | MOD-RUN | 局部实现 | W5-01 |
| CAP-14 | Tool能力、副作用Ledger、对账与补偿 | MOD-TOOL | 局部实现 | W7-01 |
| CAP-15 | Evidence、Artifact、Provenance、Validation与Result Commit | MOD-EVIDENCE | 局部实现 | W8-01 |
| CAP-16 | Schedule、Recurrence、Trigger与漏跑策略 | MOD-SCHEDULE | 未实现，架构位置已批准 | W4-04 |
| CAP-17 | Delivery、Attempt、Receipt、重试与死信 | MOD-DELIVERY | 未实现 | W9-01 |
| CAP-18 | 稳定Read Model、多前端投影、导出与受治理写回 | APP-PROJECTION | 固定Scope只读Web/Obsidian切片已实现；Identity、写回与同步仍缺 | W4-03 |
| CAP-19 | 多Product Session活动感知、冲突与合并 | APP-INTERACTION | 局部实现 | W2-02 |
| CAP-20 | Web/Channel统一Ingress与跨入口连续性 | APP-INGRESS | 未实现 | W9-01 |
| CAP-21 | Super Admin Operations与审计 | MOD-ADMIN | 未实现 | W10-01 |
| CAP-22 | Trace、Observability、故障定位和公开解释 | RT-PLATFORM | 局部实现 | W1-01、W1-02 |
| CAP-23 | 配置、正式安全、容量、SLO、备份、保留与灾难恢复 | RT-PLATFORM | 局部实现 | W1-02 |

Chat开发Chat是SCN-16纵向验收线，不新建特殊产品模块；它必须同时穿透CAP-05、CAP-08、CAP-11至
CAP-15、CAP-19和CAP-23。

## 5. 已批准目标架构：状态所有者与协调组件分开

### 5.1 14个逻辑状态所有者

| ID | 模块 | 拥有的主要事实 | 公开合同状态 | 从历史11模块怎样演进 |
|---|---|---|---|---|
| MOD-IDENTITY | Identity与Channel Binding | Principal、Auth Session、Role/Grant、Scope、Binding | 已设计，未实现 | 保持现有责任 |
| MOD-CONVERSATION | Conversation | Product Session、Interaction、Message及生命周期 | 局部实现 | 保持现有责任 |
| MOD-WORK | Work | Project、WorkItem、TaskPlan、PlanNode、ActionItem | 局部实现 | 从Collaboration显式拆出逻辑所有权 |
| MOD-KNOWLEDGE | Knowledge | Note/Revision、可执行规则引用、知识来源关系 | 局部实现 | 补齐历史11模块未明确的Note所有者 |
| MOD-PROTOCOL | Protocol | Protocol Definition/Revision、Binding、覆盖和升级 | 局部实现 | 从Collaboration显式拆出逻辑所有权 |
| MOD-CONTEXT | Context | ContextPackage、Item、Adoption、预算和来源快照 | 局部实现 | 保持现有责任 |
| MOD-MEMORY | Memory | Candidate、Accepted Memory、Revision和有效性 | 局部实现 | 保持现有责任 |
| MOD-GOVERNANCE | Collaboration Governance | Intent/Set、ExecutionDraft、RunSpec、HITL Policy、Decision、Approval、ModelCallDraft | 局部实现 | 收窄现有Collaboration |
| MOD-RUN | Run Management | Product Run/Attempt、Job/Lease映射、Event Journal、Trace | 局部实现 | 保持现有责任 |
| MOD-TOOL | Tool Execution | Definition/Policy、Execution/Operation、Attempt、对账和补偿 | 局部实现 | 保持现有责任 |
| MOD-EVIDENCE | Evidence | Evidence、Artifact、Claim、Provenance、Validation、Validity | 局部实现 | 保持现有责任 |
| MOD-SCHEDULE | Schedule | Schedule/Revision、Recurrence、Trigger Occurrence、Misfire、暂停/恢复 | 已定位，待详细设计/实现 | 新增已批准状态所有者 |
| MOD-DELIVERY | Delivery | Delivery、Outbox、Attempt、Receipt、重试和死信 | 已设计，未实现 | 保持现有责任 |
| MOD-ADMIN | Super Admin Operations | Activity、Usage、Operations Projection、Admin Audit | 已设计，未实现 | 保持现有责任 |

这14项是逻辑模块，不要求立刻创建14个目录、服务或数据库。当前`backend/app/harness`可以在无行为
重构前继续物理共置；新增能力必须先按上述状态所有权确定事务和合同，不能继续以“Harness都能管”
为由把边界写回一个万能Service。

### 5.2 3个应用协调与投影组件

| ID | 组件 | 责任 | 公开合同状态 | 不拥有 |
|---|---|---|---|---|
| APP-INGRESS | Interaction Ingress | Web/Channel Envelope验证、身份/Binding解析、幂等接纳、顺序与分派 | 已设计，未实现 | 平台SDK、Conversation/Run事实 |
| APP-INTERACTION | Interaction Coordinator | 串联Context、Intent、Work、Governance和0..n Product Run；幂等恢复用例 | 局部实现 | 其他模块的领域状态 |
| APP-PROJECTION | Projection Query & Command Gateway | 组合稳定Read Model、版本/新鲜度/权限Envelope，并把外部编辑转换成候选命令 | 只读合同已实现；候选写回未实现 | Project/Work/Memory等权威事实 |

### 5.3 3类运行与基础设施责任

| ID | 责任 | 内容 | 公开合同状态 |
|---|---|---|---|
| RT-MAF | MAF Runtime Adapter | Agent、AgentSession、Workflow、Checkpoint、Model Gateway和MAF事件转换 | 局部实现；W1-01兼容门已建立 |
| RT-EXECUTION | Execution Runtime | Execution Worker、Schedule Trigger Worker、Reconciler、Delivery Worker、pi、Validator | 局部实现 |
| RT-PLATFORM | Platform Operations | 配置、日志、Trace、Metrics、诊断、SLO、备份与灾备 | 局部实现 |
| RT-PLATFORM | Platform Operations | Product/Runtime/Artifact Store实现、配置、Observability、安全、备份、容量和SLO |

## 6. D1：Schedule归属

### 决策原因

周期学习、提醒和周期简报已是批准场景，但历史11模块无人拥有业务时间定义、时区、下一触发、例外、
暂停、漏跑与补跑。现有`Scheduler/Reconciler`只负责运行恢复，不拥有业务调度语义。

### 参考覆盖

- MAF：未涉及业务Schedule。
- pi、LibreChat、QwenPaw：现有正式研究未提供可直接采用的完整业务Schedule模块。
- nanobot：有相邻cron/reminder形态，只能校准简单触发，不为Chat状态机背书。
- 本项目：`PROJECT_CONTEXT.md`场景7和愿景决定6明确要求`Work + Schedule + Run + Delivery`。

### 选择

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 放入MOD-WORK | 与Work/Action关系直接，模块少 | 时区、Trigger、Misfire和运行恢复使Work职责膨胀 |
| B. 独立MOD-SCHEDULE | 生命周期、查询、暂停/恢复和Worker合同清楚；可服务学习、简报和提醒 | 增加模块合同与详细设计成本 |
| C. 放入MOD-DELIVERY | 周期通知链短 | 混淆“何时产生工作”和“结果怎样送达” |

### 批准结果（2026-07-30）

选择B：独立`MOD-SCHEDULE`。Work/Protocol只绑定Schedule引用；Schedule到期产生Trigger Occurrence，
由应用协调器创建新的Interaction/Product Run；Delivery只处理结果送达。信心：中高。未验证：跨时区
旅行、DST、系统休眠后的Misfire策略和高频触发容量。

## 7. D2：多前端投影与Obsidian合同

### 决策原因

用户要求Product Store中的同一项目、学习、研究和产物事实可被Web、Obsidian或第三方前端分别
呈现。现有REST可以读取部分资源，但没有稳定Read Model版本、来源revision、新鲜度、外部编辑候选、
冲突和同步Attempt合同。

### 参考覆盖

- 当前Chat：REST资源、Home投影、Project Explorer和运营投影原则提供基础。
- LibreChat：为Web产品资源API和查询边界提供相邻证据，不涉及Obsidian双向同步。
- QwenPaw：为Adapter先终止外部协议提供相邻证据，不涉及通用文件投影。
- LifeOS研究：明确支持多投影、人类可读文件及“编辑→候选差异→CAS/HITL→产品提交”的拓扑；
  该部分是本项目方法候选，不是外部产品保证。

### 选择

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 每个前端直接调用各模块REST | 简单，短期开发快 | View自己拼口径，版本/权限/冲突漂移，第三方接入成本高 |
| B. APP-PROJECTION稳定组合Read Model，Web/Obsidian各自Adapter | 同一事实多呈现；View不拥有状态；可统一版本、新鲜度和候选写回 | 需要定义投影Schema、查询组合和同步故障语义 |
| C. 建独立Projection领域数据库 | 查询快、可离线 | 容易成为第二事实源，回写和一致性成本最高 |

### 批准结果（2026-07-30）

选择B。`APP-PROJECTION`不是第15个产品事实模块；它通过公开查询/事件组合Read Model。Web Adapter、
Obsidian File Adapter和未来第三方Adapter只负责呈现与协议。文件编辑先形成候选ChangeSet和Diff，
经当前对象revision、CAS、HITL、Validation和Evidence后调用真正所有者命令。Projection Contract与
Presentation Adapter边界已批准；[W4-03详细设计](./projection-contract-dossier-queue-obsidian-readonly-detailed-design.md)
已经冻结Envelope、Project Dossier、Personal Workspace和只读Obsidian Manifest/ZIP v1。`ChangeSet`、
`Sync Attempt`和双向同步仍未实现。信心：高。未验证：离线双向同步粒度、批量文件重命名和大规模Vault性能。

## 8. D3：Product Harness、Work、Knowledge、Protocol与Governance边界

### 决策原因

稳定产品上下文要求Harness内部区分Conversation、Work、Knowledge、Protocol、Context、Governance、
Evidence和Delivery；现有总体架构却用一个Collaboration顶层模块同时容纳Intent、Work/Plan和执行治理，
当前代码又把Project、Work、Note、Memory放入`harness`物理包。后续无法判断Note、Protocol或自然语言
写回缺失应由谁开发。

### 参考覆盖

MAF和4个固定参考项目没有提供Chat的Work/Protocol/Governance完整状态机；该决定主要来自本项目
已经实现的独立revision、事务、权限和变化原因。参考项目只支持“产品事实不能塞入Runner/Prompt”。

### 选择

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 保持11个顶层模块，内部边界只写在代码里 | 文档改动小 | 仍无法从目标能力稳定定位所有者，继续依赖大Service |
| B. 明确14个逻辑状态所有者，物理目录按风险渐进演进 | 责任、合同、工作包和测试可独立映射；不要求立即重构 | 顶层架构材料需要一次映射更新 |
| C. 按当前`harness`包作为一个模块 | 与代码现状最一致 | 把物理共置误当状态所有权，形成万能Harness |

### 批准结果（2026-07-30）

选择B。把原Collaboration逻辑拆为`MOD-WORK`、`MOD-PROTOCOL`和`MOD-GOVERNANCE`；补出
`MOD-KNOWLEDGE`作为Note/规则所有者；Memory继续独立；Schedule另按D1决定。14是当前可重算结果，
不是永久数量目标。[W4-01详细设计](./work-knowledge-protocol-governance-boundary-detailed-design.md)
已固定公开Port、单所有者事务、跨所有者Outbox/Saga和自然语言ChangeProposal方向。信心：高。
未实现：通用ChangeSet与4个Owner的完整物理包演进。

## 9. D4：唯一主开发依赖序

### 决策原因

当前并存项目阶段、W0-W10、A-F、Session Phase、Q、F和SD编号。专项完成门有价值，但它们各自排序
使“当前下一件事”无法机器判断。

### 选择

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 保持各专项独立排序 | 无迁移成本 | 继续需要人工裁决，无法自动发现遗漏 |
| B. W0-W10是唯一顶层工作流，工作包使用`Wn-xx`并维护一条主顺序；Q/F/SD只做映射 | 保留专项粒度且只有一个排序事实 | 需要一次性建立映射并维护Manifest |
| C. 删除所有旧编号并重编号 | 表面最整齐 | 破坏历史文档、提交和证据引用 |

### 批准结果（2026-07-30）

选择B。`PROJECT_PLAN.md`继续拥有W0-W10及唯一主顺序；Manifest只保存依赖和顺序。Q01-Q07、F01-F10、
Session Phase和SD编号保留为专项/历史引用，不再自行决定全局优先级。信心：高。

## 10. 当前差距分类

| 类型 | 定义 | 当前代表项 |
|---|---|---|
| architecture_gap | 目标能力没有明确所有者或正式架构位置 | D1-D3批准后当前无已知未归属能力；新增能力继续按此失败关闭 |
| boundary_conflict | 多份权威/设计材料给出不同状态所有权 | 目标边界已统一；现有物理代码共置仍待W4-01演进 |
| lifecycle_gap | 对象存在但创建、修订、暂停、完成、归档或删除不完整 | Session、Idea、Schedule |
| contract_gap | 模块间命令、查询、事件、幂等或失效合同缺失 | Projection写回、Delivery、来源失效 |
| projection_gap | 权威事实存在但用户/管理员/外部前端无法完整查看和操作 | Project Dossier、Evidence UI、Learning Queue |
| runtime_recovery_gap | 连接、Worker、Tool、Workflow或外部状态无法安全接续 | F03、F05、Tool outcome_unknown |
| evidence_gap | 不能用适量证据证明能力或完成 | 非代码Work完成、SD4-E、真实多设备 |
| quality_gap | 安全、容量、SLO、备份、保留或可访问性保证不完整 | F08、正式Identity/TLS |
| planning_drift | 能力、模块、Todo、代码和测试关系漂移 | 多套编号、学习总账不能替代开发地图 |

## 11. 第一版开发工作包

工作包属于`PROJECT_PLAN.md`的W0-W10，不建立新的顶层路线。`legacy`列只用于查找现有F/Q/SD材料，
不能决定全局顺序。

`W0-01`机器基线、`W0-02`架构审核/同步和`W1-01`合同基础均已完成。W2-01、W4-01、W4-03的
详细设计已获连续授权并保持`in_progress`；W4-03已先交付不新建Schema、不写回的安全只读切片，
不表示其Identity、双向同步、Schedule或完整Evidence依赖已经完成。

| ID | 工作包 | 主要能力 | 关键依赖 | legacy映射 |
|---|---|---|---|---|
| W0-01 | 能力—架构—差距—交付机器基线 | 全部 | 无 | AD4、Q07 |
| W0-02 | 审核D1-D4并同步正式总体架构 | CAP-05/06/07/16/18 | W0-01 | AD2、AD4 |
| W1-01 | 模块公开合同、错误/ID/升级门（已完成） | CAP-11/12/22 | W0-02 | Q01、Q03、AD6 |
| W2-01 | Identity、HTTPS、Auth Session和现有Scope迁移设计 | CAP-02 | W0-02 | F07、AD3 |
| W2-02 | Session完整生命周期与跨Session冲突 | CAP-03/19 | W2-01、W4-01 | F04 |
| W3-01 | Context/Knowledge/Memory来源权限与失效传播 | CAP-06/08/09 | W0-02、W2-01、W4-01 | F02、F06 |
| W3-02 | 连续对话、Conversation Day、Daily Journal和Idea治理 | CAP-01/04 | W2-02、W4-03 | M25 |
| W4-01 | Work/Knowledge/Protocol/Governance详细边界与自然语言写回 | CAP-05/06/07/11 | W0-02 | F06、Q02 |
| W4-02 | 多Intent独立Context/Run、部分成功与聚合 | CAP-10/19 | W4-01、W5-01、W8-01 | 阶段B、F06 |
| W4-03 | Projection合同、Project Dossier、Learning Queue与Obsidian只读切片设计 | CAP-01/05/18 | W0-02、W2-01、W4-01 | Q06、新增 |
| W4-04 | Schedule详细设计、Trigger Worker和学习/简报场景 | CAP-16 | W0-02、W4-01、W5-01、W8-01 | 阶段D、新增 |
| W5-01 | Runtime强退、多端、Cursor、容量和Lease矩阵 | CAP-13/22 | W1-01 | F03 |
| W6-01 | 任意Workflow、嵌套Workflow和pi持久恢复 | CAP-11/12/13 | W1-01、W5-01 | F05 |
| W7-01 | 通用Tool副作用对账、补偿和人工处置 | CAP-14 | W1-01、W5-01、W6-01 | F01 |
| W8-01 | Evidence失效传播、非代码完成模板、完整UI和场景验收 | CAP-15 | W3-01、W5-01、W7-01 | F02/SD4-D/E |
| W9-01 | Delivery、Channel Adapter与跨入口连续性 | CAP-17/20 | W2-01、W4-04、W5-01、W8-01 | F07 |
| W10-01 | Super Admin Operations详细设计与实现 | CAP-21 | W2-01、W8-01、W9-01 | F09 |
| W1-02 | 正式安全、配置、SLO、备份、保留、容量与灾备 | CAP-22/23 | W1-01、W2-01、W5-01 | F08、Q04/Q05 |
| W8-02 | Chat开发Chat完整Dogfood验收 | SCN-16横向线 | W2-02、W4-03、W6-01、W7-01、W8-01、W1-02 | F10/SD5/SD6 |

## 12. 唯一主顺序

这是“优先进入详细设计/交付”的正式主顺序，不要求所有实施物理串行；依赖满足且不会争夺同一状态
边界时可以并行。任何专项文档不得建立另一条全局优先级。`W0-01/W0-02/W1-01`已完成；当前活动设计/实现
工作包为`W2-01、W4-01、W4-03`，完成顺序仍受下列依赖控制。W4-03提前落地的只读切片
不接收Principal/Scope输入、不新建领域事实、不支持写回，完整W4-03仍等待W2-01与W4-01。

```text
W2-01
-> W4-01
-> W4-03
-> W3-01
-> W5-01
-> W1-02
-> W6-01
-> W7-01
-> W8-01
-> W4-04
-> W4-02
-> W2-02
-> W9-01
-> W3-02
-> W10-01
-> W8-02
```

这样排序的原因：先固定目标和合同；尽早补真实Identity；再固定Work/Protocol/Projection，使用户先能
看懂和管理项目；随后补Runtime和正式运营底座，再按既有W6→W7→W8语义完成Workflow恢复、Tool副作用
与Evidence闭环；Schedule建立在可恢复运行和完成证据上，多Intent与Session并发再复用这些保证；Delivery、
连续时间导航和管理员建立在已有权威事实上；最后用Chat开发Chat做全链验收。

## 13. 多呈现方式的目标拓扑

```text
MOD-*权威模块
  -> 公开Query / Domain Event
  -> APP-PROJECTION组合稳定Read Model Envelope
      ├-> Chat Web Adapter -> Dossier / Board / Calendar / Queue / Gallery
      ├-> Obsidian File Adapter -> Project README / Daily Note / Review / Protocol文档
      └-> Third-party Adapter -> 自定义前端

外部编辑
  -> Adapter解析候选差异
  -> APP-PROJECTION生成候选命令
  -> 权威模块重验Principal/Scope/revision
  -> CAS / HITL / Validation / Evidence
  -> Product事务提交
  -> 新Projection revision
```

第一条安全切片已实现为固定Scope只读Personal Workspace、Project Dossier、Obsidian Tree/ZIP；双向
编辑必须等Identity、稳定对象revision、冲突合同和Evidence门实现通过，不能因为Markdown可编辑就
直接把文件变成权威状态。详细字段、目录和诚实缺口见
[Projection详细设计](./projection-contract-dossier-queue-obsidian-readonly-detailed-design.md)。

## 14. 三个代表场景怎样落到开发工作包

### 14.1 新建“儿童AI课程”项目

1. MOD-WORK建立Project目标、Work、Plan和Action。
2. MOD-PROTOCOL绑定项目/学习/内容交付方法，不创建`ChildAIProject`专用数据库。
3. APP-PROJECTION生成Project Dossier，Web和Obsidian显示同一目标、阶段、下一行动和Evidence。
4. 非代码课程内容进入MOD-EVIDENCE的Artifact/Validation/用户接受路径。
5. 如果是儿童直接登录使用，才另行触发未成年人身份、监护和内容安全专项审核；“为儿童制作课程”本身
   不自动扩张身份模型。

暴露工作包：W4-01、W4-03、W8-01。

### 14.2 每天学习英语

1. MOD-WORK保存学习Project、单元、练习Action和薄弱点关联。
2. MOD-PROTOCOL说明诊断、学习、主动回忆、反馈和复习方法。
3. MOD-SCHEDULE拥有复习时间、时区、暂停和漏跑；每次触发建立独立运行血缘。
4. MOD-EVIDENCE保存作答、测验、作品和用户确认；模型自述不能直接形成“已掌握”。
5. APP-PROJECTION在Web显示Learning Queue，在Obsidian显示主题Note和Review。

暴露工作包：W4-04、W8-01、W4-03。

### 14.3 每周AI资讯简报

1. MOD-SCHEDULE触发本周Occurrence，不复用上周Run。
2. APP-INTERACTION创建研究Interaction/Product Run；MOD-CONTEXT提供来源规则和去重状态。
3. MOD-EVIDENCE保存来源、报告Artifact和有效性。
4. MOD-DELIVERY发送并记录Receipt；失败只重试Delivery，不重新研究。
5. Web、Obsidian和外部Channel显示同一Artifact及不同送达投影。

暴露工作包：W4-04、W8-01、W9-01、W4-03。

## 15. 机器检查规则

`scripts/check-product-capability-map.py`必须失败关闭以下漂移：

1. `SCN-*`、`CAP-*`、模块或工作包ID重复/悬空。
2. 目标能力没有唯一责任所有者或代表场景。
3. `partial/missing/design_gap`能力没有差距类型或开发工作包。
4. 工作包没有能力、依赖、详细设计门或验收依据。
5. 依赖存在环，或唯一主顺序漏掉/重复未完成工作包。
6. Manifest引用不存在的本地权威文档、源码或测试。
7. D1-D4决策卡或README/PROJECT_PLAN入口消失。

机器检查不能判断模块拆分是否合理、用户是否理解产品或真实场景是否好用；这些继续由架构审核、真实
浏览器/模型/故障验证和用户体验审核承担。

## 16. 已批准的4项决定

1. **D1**：Schedule成为独立`MOD-SCHEDULE`，不放入Work或Delivery。
2. **D2**：增加`APP-PROJECTION`应用边界；Web、Obsidian和第三方Adapter共享Read Model/候选写回
   合同，但Projection不成为产品事实模块。
3. **D3**：目标架构从“11个大责任模块”演进为“14个逻辑状态所有者 + 3个应用组件 + 3类运行责任”；
   物理目录和Schema仍逐模块详细审核，不立即重构。
4. **D4**：W0-W10是唯一顶层工作流，工作包统一使用`Wn-xx`；Q/F/SD/Session编号只做历史和专项映射。

D1-D4已同步到正式总体架构、Manifest、状态所有权和主序；W0-02与W1-01完成。W2-01、W4-01、W4-03
详细设计已批准，W4-03只读纵向切片已落地；Manifest继续用`partial/design_only/in_progress`保留尚未实现的
Owner合同、Identity、边界演进、双向同步和完整质量门，不能把基础门或局部代码外推为领域能力完成。
