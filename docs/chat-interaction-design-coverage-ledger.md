# Chat交互设计覆盖台账与阶段审核门

> 状态：**覆盖方法已获用户确认；Interaction Coverage v1候选已建账；MD-01对应2个单元已获设计批准，其余84个仍待逐模块审核**（2026-08-01）
> 产品载体：Chat Web，随后完善同一代码与合同下的PWA能力；不建设独立桌面App。
> 总目标：确认Chat目标系统至少90%的用户交互设计；允许后端尚未实现，但必须把待实现合同和诚实状态写清。
> 当前百分比：**暂不计算**。候选分母为86个交互单元（P0 42、P1 37、P2 7），其中2个已有批准记录；待若干模块完成并到达自然校对点后再冻结revision。批准记录有效，但冻结前不把`2/86`报告为正式覆盖率。

## 1. 本文件的唯一职责

本文件只拥有3类事实：

1. Chat交互单元的冻结分母与版本。
2. 每个交互单元的设计、呈现和用户批准状态。
3. 阶段性效果审核的触发点与完成门。

相邻文档继续各自拥有自己的事实：

| 文档 | 负责 | 不负责 |
|---|---|---|
| [Chat 90%交互设计模块总表](./chat-interaction-design-module-map.md) | 把86个原子交互映射为已获批准的28个设计工作包，并维护1—3个模块的有界批次规则 | 逐单元批准状态和覆盖率 |
| [UI/UX参考产品事实走查计划](./ui-ux-reference-fact-walkthrough-plan.md) | 外部产品事实、证据等级和采用/改造/拒绝决定 | Chat交互确认百分比 |
| [Chat UI/UX视觉基线v1](./ui-ux-visual-baseline.md) | 已批准的视觉、情绪和布局基线 | 全系统交互覆盖 |
| [Chat愿景方案与完整场景模拟验证](./chat-vision-scenario-validation.md) | 完整用户场景、异常和产品保证 | 页面完成或用户UI批准状态 |
| [PROJECT_STATE](../PROJECT_STATE.md) | 当前真实实现和验证事实 | 候选设计进度 |
| [PROJECT_PLAN](../PROJECT_PLAN.md) | 工作顺序和下一审核门 | 详细证据与逐单元决定 |

## 2. 90%的计算口径

### 2.1 分子和分母

```text
交互确认覆盖率
= 用户已批准的Interaction Unit数量
  / 当前冻结的Interaction Coverage版本中全部Interaction Unit数量
```

这里的Interaction Unit（交互单元）是：

> 一个明确角色在具体触发和前置状态下，为完成一个用户目标，从可见入口经过关键动作或决定，达到可见结果，
> 并拥有返回、撤销或恢复语义的一段可独立审核交互。

页面不是交互单元。一个Workflow Run View会承载观察、审批、暂停、取消、断线重连和结果未知等多个单元；
同一个Work也可能连续经过Home、Workspace、Project Dossier和Work Detail。已发现的呈现面清单只用于反向防漏，
不能直接作为分母。

### 2.2 90%之外的硬门

即使数量达到90%，同时满足以下条件才算达成目标：

1. 所有P0主旅程和高影响控制单元100%获批。
2. 6个UX场景组都有获批的端到端旅程，不能让某一组完全空白。
3. 每个已确认呈现面都映射到至少1个交互单元；每个交互单元也能回到用户场景和呈现面。
4. 适用的桌面与手机行为已经确认；手机不能只写“响应式”。
5. `empty / loading / waiting / blocked / partial / unknown / stale / forbidden / offline / failed / conflict / completed`
   中与该单元相关的状态已经确认。
6. 未实现能力明确标为`待实现`，并写明需要的后端对象、状态或合同；不能用假数据表现为已经可用。

### 2.3 分母维护与自然冻结

Interaction Coverage v1按以下顺序生成：

1. 从12条完整愿景场景、24条异常场景和15条Chat自主设计链提取用户目标与状态变化。
2. 与完整呈现面清单双向核对，补上Personal Home、Personal Workspace、Project Dossier、Workflow Run View、
   Artifact/Evidence、Schedule/Delivery、Identity和Super Admin等容易遗漏的面。
3. 去重为稳定`IU-xxx`，标记P0/P1/P2、主要与辅助呈现面、桌面/手机和权威对象。
4. 每完成一个小模块，只让用户审核与该模块直接相关的单元；遗漏、粒度和优先级修订同步回总账。
5. 在一个UX场景组基本成形或进入30%系统一致性走查等自然节点，再集中校对并冻结`Interaction Coverage v1`。
6. 新增稳定产品承诺时升为新revision并说明分母变化；不能静默增加或删除单元来改变百分比。

分母冻结前只报告“已建账/待建账”，不报告估算百分比。

当前已完成第1—3步，形成第5.3节86个候选。它们不要求用户现在逐项审核，也不阻塞模块研究和效果呈现；
若后续原样冻结，90%数量门为至少78个获批单元，同时42个P0必须全部获批，9条P0旅程也必须全部串联通过。

## 3. 5条进度轴必须分开

| 进度轴 | 含义 | 是否进入90%分子 |
|---|---|---|
| Reference | 已取得外部产品的O/D/S/U事实和证据上限 | 否 |
| Design | 已写清Chat入口、动作、状态、反馈、返回与跨端合同 | 否 |
| Preview | 已形成用户可以逐步检视或操作的真实效果 | 否 |
| Approval | 用户看过效果与原因并明确批准当前revision | **是** |
| Implementation | 代码与后端已经真实可用并经过验证 | 否，单独记录 |

页面壳可以在Design、Preview和Approval完整后进入设计确认，即使Implementation仍为`not_started`；但页面必须
诚实显示`待实现/unknown`，不能使用会让用户误以为已执行、已保存、已交付的假结果。

## 4. 每个交互单元的最小合同

每个`IU-xxx`必须包含：

| 字段 | 必填内容 |
|---|---|
| 用户与目标 | 角色、触发、前置状态、要完成的结果 |
| 起点与终点 | 从哪里进入，何时算完成、放弃或阻塞 |
| 动作与反馈 | 点击、输入、拖动、键盘/触摸及即时反馈 |
| 状态变化 | 哪个权威对象发生什么变化，页面状态不冒充产品状态 |
| 风险状态 | 适用的空、等待、失败、权限、冲突、陈旧、离线和恢复 |
| 可逆与恢复 | 取消、撤销、返回、重新进入、跨日、断线或重开 |
| 呈现面 | 主呈现面、辅助呈现面、进入与返回锚点 |
| 跨端 | 桌面、390px手机、键盘和必要的Channel差异 |
| 参考吸收 | 事实依据、采用/改造/拒绝及原因 |
| Chat边界 | 当前已实现、契约壳、待补状态合同和明确不保证 |
| 审核证据 | 原型revision、展示日期、用户决定和待修改项 |

单元只按`approved / not_approved`计数，不使用半分。局部事实、单张正常态截图或只有桌面首屏都不能补足
缺失的关键返回、恢复或手机合同。

## 5. v1候选覆盖宇宙

下表是生成分母的分组，不是最终Interaction Unit数量。

| 组 | 用户结果 | 必须覆盖的主要呈现面与交互 |
|---|---|---|
| UXG-01 进入、重新定位与低摩擦捕获 | 用户回来后知道从哪里继续，也能先保存尚未分类的输入 | App Shell、Personal Home、Activity Calendar、Continuous Chat、Conversation Day、Daily Journal、Idea/Capture、搜索与返回 |
| UXG-02 自我管理、Project、Work与学习 | 用户跨生活、工作、学习和研究掌握全局，再深入单个Project和行动 | Today/行动队列、Personal Workspace、Project Dossier、Work Detail、责任泳道、Learning Queue、Schedule/Timeblock、日终结转 |
| UXG-03 理解、Context与计划形成 | 用户看见系统理解、补充缺口、选择目标和流程，并修正准备执行的内容 | Chat、Intent、Clarification、Project Association、Context Inspector、Workflow Selection、Plan、ExecutionDraft、多Intent |
| UXG-04 审批、运行与失败恢复 | 用户知道真实运行到哪里，能安全批准、介入、停止和恢复 | ModelCall/Tool/Human Decision、Workflow Run View、Node Detail、Attempt/Job、Pause/Cancel/Steer、Retry/Restart/Resume、Reconnect、outcome_unknown、跨Session冲突 |
| UXG-05 结果、证据、复盘与交付 | 用户能判断结果是什么、为什么成立、是否被接受和是否真正送达 | Artifact Preview/Version、Evidence/Provenance、Validation、Result Commit、Review Thread、Memory治理、Schedule Occurrence、Delivery/Receipt、来源失效 |
| UXG-06 配置、身份、跨入口与运营 | 用户知道实际配置和权限；不同载体连续；运营者可信看护整体 | Configuration Center、Agent/Tool/Provider/HITL、Authentication/Scope、手机、Channel、Obsidian/第三方投影、Super Admin Console、Admin Audit、Diagnostics |

### 5.1 P0不得缺席的9条旅程

1. Personal Home恢复今日焦点并低摩擦捕获。
2. Personal Workspace → Project Dossier → Work/Action → 返回原筛选、滚动和选中位置。
3. Chat输入 → Intent/Clarification → Context → Plan/Workflow Selection → ExecutionDraft。
4. ExecutionDraft/ModelCall/Tool审批修改后revision与Hash失效并重新审核。
5. Workflow Run View观察 → Human Decision → Steer/Pause/Cancel → Reconnect/恢复。
6. Tool或Provider发送后结果未知 → 对账、补偿或人工处置，不盲目重试。
7. Artifact → Evidence/Validation → Result Commit → Work状态；允许部分接受和要求修复。
8. Schedule Occurrence → Run → Artifact → Delivery Attempt/Receipt；Delivery失败不重做原工作。
9. Identity/Role/Scope → 普通用户空间与Super Admin运营看护；敏感查看有理由、权限和审计。

### 5.2 双向防漏边界

冻结分母时必须单独核对：

- Personal Home ≠ Personal Workspace。
- Personal Workspace ≠ 当前Interaction的Workbench。
- Project Dossier ≠ Work Detail，也≠聊天摘要。
- Workflow Selection ≠ Workflow Run View，Workflow Run View ≠ Canvas。
- Activity Calendar ≠ 未来Schedule。
- 用户专注时间 ≠ Product Run / Provider / Tool / Worker / 登录活跃时长。
- Artifact存在 ≠ Evidence有效 ≠ Validation通过 ≠ Work完成 ≠ Delivery送达。
- Retry、Restart、Resume、Reconnect和Cancel不是同一个“重试”按钮。
- 普通用户个人主页、Workflow看护和技术Diagnostics都不能替代Super Admin Console。

### 5.3 Interaction Coverage v1候选总账（86个）

优先级只决定审核顺序，不决定是否进入分母：P0是完整产品与高影响控制不可缺失的交互；P1是日常完整性与
效率交互；P2是目标系统仍需要设计清楚、但允许较后审核的扩展交互。跨端、空态、失败和返回通常是每个单元的
验收维度，不为同一目标重复计数；只有设备接管、授权、Run血缘或副作用恢复本身就是用户目标时才独立成单元。

#### UXG-01 进入、重新定位与低摩擦捕获（11个）

| ID | P | 用户可审核结果 | 主要呈现面 | 必过边界 |
|---|---|---|---|---|
| IU-101 | P0 | 打开Chat后立刻知道今天、继续项和需要注意的异常 | Personal Home、Activity Rail | loading/empty/partial/stale/error；刷新不清空最后可信投影 |
| IU-102 | P0 | 从Home、Chat或外部入口继续同一Work/Project，并采用最小充分Context | Home、Continuous Chat、Context入口 | 唯一/多候选/无匹配/归档/forbidden；保留来源Session |
| IU-103 | P1 | 从Activity Calendar进入某日协作记录、打开来源并返回原日期与滚动位置 | Activity Calendar、Conversation Day | 空白日、跨时区、分页、partial/stale、返回锚点 |
| IU-104 | P0 | 从任意入口保存未分类原话，失败可重试或撤销且不误建Project | Chat Composer、Quick Capture、Idea Garden | 空输入、重复、离线、saving/failed、原文与来源 |
| IU-105 | P1 | 把Idea保持、重归类、关联或升级为Note/Work/Project并保留回链 | Idea Garden、候选卡、Dossier/Knowledge | 重复、属性不足、同名、冲突、取消；升级失败不丢Idea |
| IU-106 | P1 | 跨Project搜索正式对象，稳定ID打开并返回原筛选、焦点和工作位置 | Search/Command、Workspace、Dossier | 无结果、同名、权限、索引stale、危险动作确认 |
| IU-107 | P0 | 日终逐项决定完成、结转或放弃，次日Home从可信状态恢复 | Home、Daily Review、Today | 空日、部分完成、逾期、日界线、撤销、保存失败 |
| IU-108 | P1 | 在主页、工作台、对话、运行和配置之间切换且层级与焦点不丢 | App Shell、Activity Rail、移动导航 | 桌面/手机重排、深链、浏览器返回、键盘焦点 |
| IU-109 | P1 | 新建、命名、切换、归档、恢复或删除Product Session且不影响活动Run | Session Sidebar、Continuous Chat | 未保存草稿、活动Run、重复、归档/删除确认、恢复来源 |
| IU-110 | P1 | 查看并修订Daily Journal，区分原始事实、自动摘要和用户修正 | Conversation Day、Daily Journal | empty、draft、saving、revision冲突、来源Message链接 |
| IU-111 | P1 | 在一个注意力入口处理待决定、阻塞、失败、待评审和未送达事项 | Home Attention Inbox、Review/Decision入口 | stale/already_resolved、批量与逐项、返回来源、无假紧急 |

#### UXG-02 自我管理、Project、Work与学习（15个）

| ID | P | 用户可审核结果 | 主要呈现面 | 必过边界 |
|---|---|---|---|---|
| IU-201 | P1 | 扫描生活、工作、学习、研究和未分类事项，并选定下一对象 | Personal Workspace | empty/partial/100项截断/unknown/stale；筛选不改事实 |
| IU-202 | P0 | 从跨Project事项形成可开始Today序列，保留来源、责任和阻塞 | Home、Workspace、Today | blocked/overdue/容量不足、撤销、完成；计划日/截止/顺序/结转分开 |
| IU-203 | P1 | 把Today行动与日历容量协商成可行计划并处理冲突或超载 | Today、Schedule/Calendar | 无空档、拖动失败、删除、保存失败、恢复原排程 |
| IU-204 | P0 | 不看聊天也能从单个Project档案判断目标、阶段、责任、下一行动与真实缺口 | Project Dossier | 404/empty/partial/unknown/forbidden/error；可选区失败不毁核心档案 |
| IU-205 | P0 | 从Project进入Work Detail修改、保存并返回原筛选、滚动和选中位置 | Dossier、Work Board、Work Detail | unsaved/saving/validation/CAS/撤销；稳定对象ID |
| IU-206 | P0 | 管理Plan/Action及你、Chat与AI、外部协作责任，识别阻塞而不重复计数 | Dossier、Plan/Action、责任泳道 | 无下一行动、external waiting、Agent未授权、并发、完成证据 |
| IU-207 | P1 | 管理无Project Work，保持未分类或正式归入Project且投影一致 | Workspace、Work Detail、Project选择器 | 同名、权限、CAS、撤销；不能按标题猜分类 |
| IU-208 | P0 | 从到期/薄弱点进入学习、练习和验证，得到可信下一复习状态 | Learning Queue、Knowledge、Dossier | 空队列、答对/错、跳过、Evidence过期、Schedule unknown、跨天恢复 |
| IU-209 | P1 | 研究问题、来源和冲突后形成下一Work；来源失效时诚实降级 | Research Dossier、Knowledge、Source/Relation | 无来源、重复、冲突、partial/unavailable/permission |
| IU-210 | P1 | 创建、修改、暂停和恢复周期事项，理解时区、下一触发和misfire策略 | Dossier、Schedule Editor | 时区缺失、冲突、paused、漏跑、重复触发、revision/unknown |
| IU-211 | P2 | 给当前行动开始、暂停、恢复和结束专注计时，并核对真实累计历史 | Today、Work Detail、Focus、History | 重开、重复点击、崩溃未知；不混同Product Run或登录活跃 |
| IU-212 | P1 | 创建、改名、暂停、归档、恢复或删除Project并理解对Work/Run的影响 | Workspace、Project Settings、Dossier | 重复、活动Run、依赖、归档后继续、删除确认与恢复性 |
| IU-213 | P1 | 绑定、刷新、重绑或解绑Repository/资源，并理解新鲜度和失败后果 | Project Explorer、Dossier Resource | 路径/权限、stale snapshot、refresh失败、并发、脱敏 |
| IU-214 | P1 | 在List/Board/责任视图筛选、分组和移动同一Work，跨视图状态一致 | Work Board、Workspace | 空组、过滤无结果、拖动失败、撤销、跨视图稳定ID |
| IU-215 | P1 | 创建、查看和修订Note/Knowledge对象及关系，并返回原来源 | Knowledge Workbench、Object Detail、Dossier | 未分类、重复、关系失效、revision冲突、权限、双向回链 |

#### UXG-03 理解、Context与计划形成（12个）

| ID | P | 用户可审核结果 | 主要呈现面 | 必过边界 |
|---|---|---|---|---|
| IU-301 | P0 | 明确产品查询走权威Query、0模型、0误建Project/Work/Memory | Chat、结果卡、Workspace链接 | loading/empty/forbidden/error/stale；查询失败不让模型编造 |
| IU-302 | P1 | 普通知识问答显示是否采用当前学习/Project Context且不误报掌握 | Chat、Context提示、回答卡 | 无/唯一/多个/stale Context、排除、模型失败、Note候选 |
| IU-303 | P0 | 模糊想法可停在Idea或形成Project/Work候选；创建对象不等于授权执行 | Chat、Clarification、候选卡 | 信息足/不足、不回答、重复、取消、索引失败；原Message保留 |
| IU-304 | P0 | 查看并修正Intent/目标；同名Project明确选择或“都不是”且不泄漏不可见项 | Intent Review、目标选择器、Chat | 单一/多候选/跨Scope隐藏/归档/CAS；修改使下游失效 |
| IU-305 | P0 | 多Intent拥有独立Context/Plan/Run，允许排序、部分执行、取消和部分成功 | Multi-intent Review、Plan、Chat | 依赖、预算、一支失败/取消、跨Project权限；已交付分支不回滚 |
| IU-306 | P0 | 查看Context来源并纳入、排除、锁定或修订，生成新revision/hash | Context Inspector、来源预览 | empty/partial/stale/forbidden/revoked/token超限/CAS；重新装配 |
| IU-307 | P1 | 理解本轮有效Protocol、来源和规则，可切换或申请有界例外 | Protocol卡、Plan Review、配置入口 | 继承/覆盖/冲突/版本变化/例外；变更重编译Draft |
| IU-308 | P0 | 发送前选择并绑定Workflow Definition版本、审批模式和预计中断 | Chat Composer、Workflow Selector | 无合法Workflow、版本不可用、推荐未接受；不能静默切换 |
| IU-309 | P0 | 审核目标、步骤、依赖、三类责任和验收，可编辑、重排或Plan-only | Plan Review、Work/Action候选 | 空计划、依赖环、用户行动缺失、预算、CAS、放弃/重规划 |
| IU-310 | P0 | 编辑ExecutionDraft后旧授权失效；接受后生成不可变RunSpec | ExecutionDraft、Authorization | unsaved/saving/validation/superseded/CAS/cancel；Context/Plan变化重编译 |
| IU-311 | P0 | 逐次核对真正Provider请求，可修改后重审或放弃并保证零发送 | Model Call Review、Provider JSON | provider-model无效、hash变化、sending/outcome_unknown/abandoned；双视图同源 |
| IU-312 | P0 | Run前发现其他Session已改事实，比较后重基、合并、保留产物或停止 | Conflict Banner、Diff、Context/Plan/Draft | 无影响刷新、有冲突、stale Approval、目标已完成、forbidden |

#### UXG-04 审批、运行与失败恢复（16个）

| ID | P | 用户可审核结果 | 主要呈现面 | 必过边界 |
|---|---|---|---|---|
| IU-401 | P0 | 打开活动Run，知道真实进度、当前步骤、实际路径与阻塞原因并返回原锚点 | Workflow Run View、Timeline、Node Detail | queued/running/waiting/blocked/partial/failed/completed；关闭不取消 |
| IU-402 | P0 | 回答运行中的Human Decision Request，并从同一安全点继续或停止 | Decision Drawer/Sheet、Run View | waiting/stale/expired/forbidden/already_resolved；重复响应幂等 |
| IU-403 | P0 | 暂停调度并稍后继续同一Run，不把Pause冒充撤回外部调用 | Run控制栏、Timeline | pause_requested/paused/in_flight/outcome_unknown/resumed |
| IU-404 | P0 | 执行中Steer，在安全点形成Amendment并使受影响旧授权失效 | Chat、Run View、ExecutionDraft | waiting_safe_point、scope_changed、conflict、rejected/approved |
| IU-405 | P0 | 精确取消某Run并知道发送前、发送后与结果未知的不同后果 | Run控制栏、Timeline | cancel_pending/cancelled/outcome_unknown；迟到结果不自动提交 |
| IU-406 | P0 | 浏览器断线或重开后按Cursor接回同一Run，不新增Attempt或重放动作 | Chat、Run View、Reconnect Banner | offline/reconnecting/gap/cursor_expired；Snapshot+Journal |
| IU-407 | P0 | API/Worker/HITL中断后经兼容性、新鲜度和epoch核对从安全Checkpoint恢复 | Recovery、Run Timeline | missing/incompatible/stale/old epoch fenced；前置节点不重跑 |
| IU-408 | P1 | 已知可重试失败只重试失败步骤并创建新Attempt | Run View、Attempt List | eligible/ineligible/backoff/budget；未知副作用禁止进入Retry |
| IU-409 | P1 | 无法续跑或合同已变时，以旧结果为输入Restart成新Run | Run Summary、ExecutionDraft | stale source/new authorization/new Run ID；旧Trace/Artifact保留 |
| IU-410 | P0 | Provider/Tool已外发但结果不可信时，通过查询、Hash、补偿或人工判定收敛 | Recovery、Tool Ledger、Evidence | query/no support/hash match/mismatch/manual；绝不盲目重发 |
| IU-411 | P0 | 其他Session更新同一对象时比较Diff，并选择rebase、合并、保留产物或停止 | Conflict Diff、来源Session/Run | impact/conflict/stale/resolved；Artifact保留，旧Patch/Approval失效 |
| IU-412 | P0 | 扩大权限、范围、依赖或预算时先显示影响并重新授权或拒绝 | Run View、Amendment、Approval | denied/unsafe/budget exhausted/scope expansion；新Grant绑定revision |
| IU-413 | P0 | 审核Tool名称、参数、权限和副作用；修改生成新请求，拒绝不执行 | Tool Request Review、Diff预览 | invalid/stale/forbidden/high impact/duplicate/outcome_unknown；精确幂等键 |
| IU-414 | P1 | 从Run历史比较Attempt、错误、恢复动作和终态，而不把它们压成一次失败 | Run History、Attempt Compare | empty/partial/retention gap/superseded；稳定Run/Attempt ID |
| IU-415 | P1 | 检查Tool Operation请求、前后Diff、Ledger状态和对账结果 | Tool Operation Detail、Diff | proposed/sent/result_unknown/confirmed/compensated/failed；内容脱敏 |
| IU-416 | P2 | 设计者查看Product Run、Attempt、Job、Worker、Lease和事件序列以诊断运行 | Runtime Detail、Diagnostics | stale metrics/lost worker/lease epoch/redacted；不冒充用户工作状态 |

#### UXG-05 结果、证据、复盘与交付（12个）

| ID | P | 用户可审核结果 | 主要呈现面 | 必过边界 |
|---|---|---|---|---|
| IU-501 | P0 | 找到并查看明确版本Artifact，并返回来源Run/Project | Artifact Gallery/Preview、Dossier | processing/ready/partial/corrupt/missing/forbidden/superseded |
| IU-502 | P1 | 创建者与评审者围绕版本锚定反馈、解决/重开并比较下一版 | Artifact Preview、Review Thread、Version Compare | link invalid/permission/version drift/unread/resolved/reopened |
| IU-503 | P0 | 沿Claim/Requirement检查Evidence、来源和有效性，理解支持、反驳与未知 | Evidence View、Provenance | supports/refutes/unknown/stale/unavailable/forbidden/waived |
| IU-504 | P0 | 检查Validation合同、逐项要求、命令与结果并决定下一步 | Validation、Evidence View | pass/fail/timeout/error/outcome_unknown/not applicable；测试失败优先 |
| IU-505 | P0 | 接受、部分接受、要求修复或拒绝Result，只提交获准Work/Action状态 | Result Commit、Artifact/Evidence Summary | stale hash、mandatory fail、waiver、CAS、幂等；Memory独立 |
| IU-506 | P0 | 来源或证据失效后看到影响范围，选择重验、降级或移除采用 | Evidence、Artifact、Memory Review | unavailable/revoked/invalidated/unaffected/pending review；历史不删除 |
| IU-507 | P1 | 接受、纠正、拒绝或删除Memory Candidate且不连带改变Artifact/Work | Memory Review | conflict/wrong scope/source invalid/deleted；来源与Diff |
| IU-508 | P0 | 区分每次Schedule Occurrence、独立Run和Artifact，并处置漏跑或重复 | Schedule History、Run、Artifact | scheduled/due/missed/skipped/duplicate/succeeded/failed；最多补跑一次 |
| IU-509 | P0 | 独立观察Delivery Attempt/Receipt，失败只重投交付而不重做工作 | Delivery Center、Receipt | queued/sending/delivered/failed/dead letter/outcome_unknown/revoked |
| IU-510 | P1 | 按日/周复盘完成、未完成、证据不足和未送达项，决定结转或关闭 | Daily/Weekly Review、Home | empty/partial/overdue/unknown/delivery failed；显式结转 |
| IU-511 | P2 | 创建、打开和编辑空间型Canvas Artifact并保留版本，不与Run View/Workbench混用 | Canvas View、Artifact Gallery | empty/draft/saving/conflict/version/permission/offline；独立Artifact ID |
| IU-512 | P1 | 阅读或导出确定性Human Report/Trace，并从报告跳回对应节点、Tool和Evidence | Run Report、Trace、Node/Evidence | partial/redacted/retention gap/source missing；不展示隐藏推理 |

#### UXG-06 配置、身份、跨入口与运营（20个）

| ID | P | 用户可审核结果 | 主要呈现面 | 必过边界 |
|---|---|---|---|---|
| IU-601 | P1 | 看懂所有配置的实际有效值、来源和覆盖优先级，保存不等于执行 | Configuration Center | loading/invalid/unavailable/secret hidden/restart required/stale |
| IU-602 | P0 | 安全登录、管理自己的Authentication Session、撤销其他设备或退出并返回原目标 | Login、Identity & Sessions | invalid/expired/revoked/offline/rate limited；不重放副作用 |
| IU-603 | P0 | 遇到无Scope资源时不泄漏内容，可申请/切换合法身份后继续 | Forbidden、Identity/Scope | hidden/pending/limited/expired/denied；授权后恢复原目的地 |
| IU-604 | P1 | 从Web、手机或Channel继续同一Project/Run，不重复Interaction或动作 | Web、Mobile、Channel、Run View | offline/queued/binding revoked/cursor stale/duplicate ingress |
| IU-605 | P1 | 在Obsidian/第三方投影查看同一稳定ID、revision、新鲜度和partial状态 | Projection Export、Obsidian/Adapter | limit/stale/forbidden/adapter unavailable；刷新可重建 |
| IU-606 | P2 | 外部编辑先形成ChangeSet/Diff，经CAS/HITL/Validation提交或冲突，不双写事实 | Projection Sync、Conflict Diff | old revision/invalid/conflict/partial sync/permission/outcome_unknown |
| IU-607 | P0 | 超级管理员从可信总览发现用户、使用、Work、Artifact/Evidence和异常 | Super Admin Console | empty/loading/stale/partial/source unavailable/forbidden；freshness |
| IU-608 | P0 | 管理员区分登录、前台活跃、有效协作与Run/Provider/Tool/Worker耗时 | Usage Analytics | no data/partial/unknown/clock skew/stale；显示指标定义与来源 |
| IU-609 | P1 | 管理员从异常下钻到用户、Project、Work和Artifact元数据并返回原筛选 | Admin Detail、Work/Artifact Projection | redacted/partial/stale/unknown/no longer accessible；默认无正文 |
| IU-610 | P0 | 确需看敏感正文时说明理由、范围和期限，经额外授权限时查看并留审计 | Sensitive Access Gate、Admin Audit | denied/masked/expired/revoked/purpose missing；失败关闭 |
| IU-611 | P1 | 管理员创建、修改或撤销Role/Grant/Auth Session，并预览影响 | Identity Admin | self lockout/stale CAS/in use/propagation pending；管理动作留审计 |
| IU-612 | P1 | 审计者按操作者、理由、范围、对象和结果复核管理员访问及管理动作 | Admin Audit | retention gap/partial/forbidden/integrity unknown；追加不可改写 |
| IU-613 | P1 | 运营者从技术告警下钻到相关服务、队列、Provider、Tool和Runtime并取得脱敏动作 | Diagnostics、Runtime Detail | degraded/down/stale metrics/redacted/unreachable；不冒充用户活动 |
| IU-614 | P1 | 创建和修改Agent Profile的职责、Instructions与模型绑定，预览影响后保存revision | Agent Profile | invalid/missing provider/stale/in use/version conflict；不自动启动Run |
| IU-615 | P1 | 浏览Workflow目录、查看Definition/版本/审批模式并安全测试或停用 | Workflow Catalog/Definition | invalid graph/deprecated/in use/version mismatch/test failed；历史Run保留 |
| IU-616 | P1 | 配置Provider与模型目录、默认值和回退，密钥永不回显 | Provider/Model Settings | unavailable/invalid credential/model removed/rate limited/restart needed |
| IU-617 | P2 | 配置Tool Profile、限制和能力，并查看真实调用/成本/耗时/失败口径 | Tool Settings、Usage | forbidden/high impact/version mismatch/no data/stale metrics；不自动授权当前Run |
| IU-618 | P1 | 在多个作用域查看和修改HITL Policy，理解继承、最终动作与重新暂停原因 | HITL Policy Matrix | inherited/overridden/unsafe floor/conflict/stale；系统下限不可放宽 |
| IU-619 | P2 | 管理个人资料、时区、语言、通知与可见偏好，并看实际作用域 | Personal Settings/Profile | invalid timezone/unsaved/conflict/offline/permission；偏好不改产品事实 |
| IU-620 | P2 | 安装/更新PWA，在离线、版本更新和认证失效时安全恢复且不重放写请求 | PWA Install/Update/Auth Recovery | unsupported/offline/update waiting/auth expired/cache stale；回到原目标 |

候选总数为86：P0 42、P1 37、P2 7。当前`IU-104`、`IU-105`为`approved`，其余84个仍为
`inventory_candidate`。总账只在后台防漏；每个小模块获批时只更新相关单元，不会把相邻单元自动标记为
交互设计已批准，也不会改变实现状态。

### 5.4 增量批准记录

| 模块 | Interaction Unit | 批准日期 | Design / Preview / Approval | Implementation | 证据与边界 |
|---|---|---|---|---|---|
| MD-01 | IU-104 | 2026-08-01 | `approved / approved / approved` | `not_started` | 用户批准全局捕获、类型未定保存、反馈/失败和普通撤销合同；[设计档案与原型](./ui-ux-modules/md-01-quick-capture-and-idea-destination.md) |
| MD-01 | IU-105 | 2026-08-01 | `approved / approved / approved` | `not_started` | 用户批准先保存后保留/关联/升级，并保留原话与来源回链；关联与升级业务接线仍待实现 |

本记录不把Routine的D/S证据升级为O，也不表示Chat后端、Product DB、MAF或AG-UI已经支持这些动作。

## 6. 阶段审核节奏

| 审核门 | 何时停下来 | 给用户看什么 | 能决定什么 | 是否增加90%进度 |
|---|---|---|---|---|
| G0 总账校对（后台） | 一个UX场景组基本成形，或进入30%系统一致性走查时 | 与已完成模块对照后的遗漏、粒度、优先级和分母变化 | 冻结或修订分母与P0范围 | 否；也不阻塞当前模块 |
| G1 模块参考门 | 新设计默认1个模块；严格满足合批条件时最多2个 | 每个模块1个主参考，必要时最多1个辅助参考；真实界面/演示、交互与视觉事实、未知项、Chat采用/改造/拒绝 | 分别决定各模块设计输入 | 否 |
| G2 模块效果门 | 本批各模块事实足以形成方案时 | 每个模块各自的主路径、小效果、最重要风险态及设计原因 | 可分别批准或退回批内任一模块 | 是 |
| G3 系统一致性门 | 批准覆盖达到约30%、60%、90% | 从Home到工作、执行、结果和运营的串联走查；导航、视觉、对象、状态和跨端一致性 | 确认整体方向或要求重排 | 是 |
| P0专项门 | 高影响动作、结果未知、并发、Evidence、Delivery、Identity/Admin首次成形时 | 真实风险场景与失败/恢复效果 | 单独批准控制语义 | 是 |

G1不会要求用户为每张截图拍板，也不要求先完成某个参考产品的全部流程。同一产品的不同功能可以留到不同
模块再研究；本模块一旦有足够事实就立即形成小草图或HTML进入G2。

## 7. 每次效果审核包的固定内容

每次停下来默认只提交一个模块；新设计合批时最多提交2个满足第8节条件的小模块，并对每个模块分别固定展示。三个模块只用于已经分别获批后的组合一致性走查：

1. **目标**：一句话说清用户此刻要完成什么、起点与终点，以及明确不做哪些相邻功能。
2. **事实**：1个主参考真实做了什么、证据等级和没有验证什么；只有缺少关键状态时才补1个辅助参考。
3. **实际效果**：1条主路径、1—3个关键画面或1个轻量HTML；跨端只呈现本模块必要的关键重排。
4. **状态**：正常态以及本组最高风险的空、失败、冲突、恢复或权限态。
5. **理由**：为什么采用、为什么必须改造、为什么拒绝；至少说明主要备选与代价。
6. **Chat边界**：权威对象、保存/恢复语义、当前实现和待补合同。
7. **请用户拍板**：控制在2—4个会改变后续组合的明确决定。

用户批准后，同步本台账、参考走查决定、PROJECT_STATE摘要和PROJECT_PLAN下一门；用户要求修改时只让受影响
单元退回`not_approved`，不抹掉已经取得的参考事实或实现证据。

## 8. 从吸收到90%的固定小循环

1. 默认从用户场景只选1个模块，用一句话固定起点、终点和本轮非目标。
2. 两个新模块只有在前一终点就是后一入口、共享角色/对象链/主参考与视觉上下文、不涉及高影响审批、结果未知、并发、Evidence、Delivery、Identity/Admin或恢复语义，并且总计不超过1条主路径、4个关键画面、1个风险态和6个决定时才合批；否则回到单模块。三个模块只用于已批准模块的组合一致性走查。
3. 每个模块只选1个真正回答同一问题的主参考；只有关键状态缺失时增加最多1个辅助参考。没有直接参考时明确转入Chat自主设计，不为凑数扩表。
4. 逐项抽取真实入口、动作、反馈、状态、保存/恢复、布局与视觉事实，并把未知项留白。
5. 分别形成Chat的采用、改造、拒绝方案，映射权威对象、当前实现和待实现合同。
6. 每个模块提交1—3个关键画面或1个轻量HTML，并补1个最重要的空、失败、阻塞或恢复状态。
7. 用户分别拍板每个模块2—4个关键取舍；只更新已获批模块对应的Interaction Unit。
8. 到自然组合点才复查跨模块导航、视觉和对象一致性，并在约30%、60%、90%进行系统走查。

86项候选继续作为后台地图，保证Personal Home、Personal Workspace、Project Dossier、Workflow Run View、
Artifact/Evidence、Identity和Super Admin等不会在长期工作中漏掉；它不决定一次工作包必须做多大。

## 9. 当前审核门与其后第一个效果包

用户已批准[Chat 90%交互设计模块总表](./chat-interaction-design-module-map.md)中的28个设计确认模块。
MD-01随后于2026-08-01完成模块内审核，对应`IU-104`、`IU-105`进入批准记录；其余模块仍只锁定工作目录。

> 用户在任意当前入口想到一句尚未分类的内容时，能先保留原始表达，明确知道是否已保存、保存到哪里，
> 并能撤销或重新找到；本轮不要求立即判断它最终是Idea、Work还是Project。

本轮只使用2个直接参考：Routine的`A-RT-01`作为主研究对象，以及已经取得并获批模式取舍的
Super Productivity `A-SP-01`作为辅助事实。若二者没有覆盖Chat所需状态，明确标为自主设计，不自动追加第三个产品。

展示控制为：

1. 1个轻量HTML，或2—3张关键草图：捕获入口、类型未定/保存中、保存成功与撤销/找回。
2. 只补1个最高风险状态：保存失败或离线，不让用户误以为内容已保存。
3. 桌面Web为主；仅在入口与反馈会明显变化时补1个390px手机关键画面。
4. 只请用户拍板2—4项：默认落点、是否延后分类、成功反馈与重新找到的入口。

明确不在本包展开Today排序、日历Timeblock、日终结转、Personal Workspace、Project Dossier、专注计时或
Workflow Run View；它们各自在后续独立模块中研究和呈现。

2026-08-01进度：Routine `A-RT-01`已形成D/S事实卡，正常捕获、成功反馈、Garden待整理、正式Idea与
保存失败/离线状态已经做成[可操作Web原型](./ui-ux-modules/md-01-quick-capture-and-idea-destination.md)，用户已批准
入口形态、默认落点、分类时机、反馈与撤销4项决定。当前1/28个模块完成；下一模块为MD-02，但本次归档不启动。
