# Chat 90%交互设计跨Session续接入口

> 状态：**长期任务已归档；MD-01已获用户批准，1/28个模块完成，27个待完成；下一模块为MD-02，尚未启动**（2026-08-01）
> 用途：让新的AI开发协作Session或新的AI不依赖旧聊天即可继续“工作台参考界面 / 前端交互设计”任务。
> 边界：本文件负责续接路由与当前Checkpoint；28个模块定义由[模块总表](./chat-interaction-design-module-map.md)拥有，逐Interaction Unit批准状态由[覆盖台账](./chat-interaction-design-coverage-ledger.md)拥有。

本文件中的“Session”只指Codex/AI开发协作对话，不是Chat产品里的Product Session、MAF AgentSession、
AG-UI Thread或Workflow Checkpoint。

## 1. 长期目标

把Chat目标系统的用户交互逐模块设计并交给用户拍板，最终满足：

1. 当前Interaction Coverage冻结后，至少90%的Interaction Unit获用户批准。
2. 所有P0主旅程和高影响控制交互100%获批，不能用低风险页面凑比例。
3. Personal Home、Personal Workspace、Project Dossier、Workflow Run View、Artifact/Evidence、身份和Super Admin等关键呈现面都不缺席。
4. Web是当前交付载体；使用同一套响应式界面继续完善PWA，不建设独立桌面App。
5. 后端尚未实现的界面可以先批准“交互壳”，但必须显式标记`待实现`并写清所需合同；设计批准不等于代码完成。

当前候选分母为86个Interaction Unit，其中P0 42、P1 37、P2 7；分母尚未在自然校对点冻结，因此暂不报告正式百分比。

## 2. 当前Checkpoint

| 项目 | 当前事实 |
|---|---|
| 模块目录 | 28个，用户已批准这套工作目录 |
| 已完成 | `MD-01 快速捕获与Idea去向`，1个模块 |
| 已批准Interaction Unit | `IU-104`、`IU-105`，共2个设计批准记录 |
| 待完成 | `MD-02`—`MD-28`，共27个模块 |
| 下一模块 | `MD-02 Personal Home、注意力与继续工作` |
| 当前活动模块 | 无；本次归档不启动MD-02 |
| 实现边界 | MD-01只有独立Web原型和设计合同；未接Chat后端、Product DB、MAF或AG-UI |

### 2.1 MD-01已批准决定

用户在2026-08-01看过可操作原型及本地单文件效果后，认可当前模块整体交互与呈现，并批准当前revision的4项决定：

1. `D1`：快速捕获是全局动作；桌面提供快捷键，不新增一级页面。
2. `D2`：原话默认进入Garden“待整理”的类型未定候选，不直接成为正式Idea。
3. `D3`：先可靠保存，再保留、关联或升级；捕获时不强迫填写对象表单。
4. `D4`：成功反馈提供查看、撤销、关闭并自动消失；失败保留文字并给重试、复制；普通撤销不删除原始Message来源。

事实依据仍保持原证据上限：Routine `A-RT-01`为0条O、9组D、3组S；Super Productivity `A-SP-01`只提供已取得的O局部辅助事实。用户批准的是Chat设计，不是把参考证据升级为实机完整走查。

## 3. 28个模块状态快照

本表只帮助新Session快速定位；名称、边界、主参考、展示物和IU映射以[模块总表](./chat-interaction-design-module-map.md)为准。

| 模块 | 名称 | 状态 |
|---|---|---|
| MD-01 | 快速捕获与Idea去向 | **已批准**；原型已完成，业务未接线 |
| MD-02 | Personal Home、注意力与继续工作 | **下一个；未启动** |
| MD-03 | Activity Calendar、Conversation Day与日/周复盘 | 待完成 |
| MD-04 | Personal Workspace／我的工作台 | 待完成 |
| MD-05 | Today计划、时间容量与专注 | 待完成 |
| MD-06 | 单个Project档案、生命周期与资源 | 待完成 |
| MD-07 | Work Detail、Plan/Action与责任推进 | 待完成 |
| MD-08 | 学习队列、练习与复习 | 待完成 |
| MD-09 | 研究、Knowledge与Memory治理 | 待完成 |
| MD-10 | Schedule、Occurrence与Delivery | 待完成 |
| MD-11 | 权威查询与轻问答 | 待完成 |
| MD-12 | 澄清、目标关联与对象候选 | 待完成 |
| MD-13 | 多Intent分流 | 待完成 |
| MD-14 | Context、Protocol、Workflow选择与Plan | 待完成 |
| MD-15 | ExecutionDraft与逐次Model Call审批 | 待完成 |
| MD-16 | 跨Session冲突、Diff与重基 | 待完成 |
| MD-17 | Workflow Run View、Human Decision与报告 | 待完成；禁用GitHub Actions式视觉 |
| MD-18 | Pause、Steer、Cancel、Reconnect与Checkpoint Resume | 待完成 |
| MD-19 | Retry、Restart与Attempt历史 | 待完成 |
| MD-20 | Tool授权、Operation Ledger与结果未知 | 待完成 |
| MD-21 | Artifact版本、评审与Canvas | 待完成 |
| MD-22 | Evidence、Validation与Result Commit | 待完成 |
| MD-23 | Agent、Workflow与HITL配置 | 待完成 |
| MD-24 | Provider、模型与Tool配置 | 待完成 |
| MD-25 | 身份、Scope、设备与PWA连续性 | 待完成 |
| MD-26 | Obsidian／第三方投影与受治理写回 | 待完成 |
| MD-27 | Super Admin运营总览与使用下钻 | 待完成 |
| MD-28 | 敏感访问、管理员审计与Runtime Diagnostics | 待完成 |

## 4. 新AI开发协作Session怎样恢复

新AI收到“继续工作台参考界面”“继续前端交互设计”或“继续90%交互设计”后，按以下顺序工作：

1. 按`AGENTS.md`完成项目强制治理读取；不要用旧聊天替代仓库事实。
2. 读取本文件，确认完成数、下一个模块和本轮停止边界。
3. 读取[模块总表](./chat-interaction-design-module-map.md)中当前模块行及已批准合批规则。
4. 读取[覆盖台账](./chat-interaction-design-coverage-ledger.md)中当前模块映射的IU合同。
5. 只读取当前模块直接相关的参考事实卡、概念簇、现有页面和原型；不通读24个候选、28条流程、27个旧模块材料或旧聊天。
6. 先向用户声明“本次只做哪个模块、解决什么、不做什么、为什么单做或合批”，再进入事实提取和效果制作。
7. 不重做MD-01；只有用户明确要求复审，或跨模块一致性走查发现真实冲突时才重新打开。

## 5. 每个模块的固定小循环

```text
用户场景与目标
→ 1个主参考（关键事实缺失时最多1个辅助参考）
→ 入口/动作/反馈/状态/保存或恢复/下一步的事实提取
→ Chat采用、改造、拒绝和未验证
→ 1个轻量HTML或1—3个关键画面
→ 1个最高风险态与必要的桌面/390px手机重排
→ 2—4个会影响后续组合的决定
→ 用户拍板
→ 落盘Checkpoint并结束当前Session
```

### 5.1 事实提取标准

1. `O`实机观察、`D`官方说明、`S`截图可见事实、`U`用户报告和Chat项目推断必须分开。
2. 静态截图只证明可见布局；不能据此推断保存、撤销、失败恢复、响应式或长期状态。
3. 每条交互事实至少尽量覆盖：前置状态、入口、用户动作、即时反馈、状态变化、持久结果、返回/恢复和下一步。
4. 视觉提取至少写清布局层级、注意力、密度、字号、色彩角色、间距、边界、响应式和反馈节奏，不能只写“简洁、现代”。
5. 参考未涉及Chat独有的版本、Hash、CAS、`outcome_unknown`、Evidence、Memory或管理员审计时，明确写“未涉及”，转入自主设计。

### 5.2 吸收标准

每个模块分别记录：

- 采用：事实与Chat用户目标、对象和风险相容，可直接借用的模式。
- 改造：参考模式有价值，但对象、权限、状态或恢复语义必须改变。
- 拒绝：会制造错误心智、假成功、技术后台感或第二事实源的做法。
- 未验证：当前证据无法支持的行为，不用相似截图补齐。

## 6. 单次AI开发协作Session与Token控制

1. 默认一个新模块使用一个新Session；当前模块获批并落盘后结束，不自动开始下一个模块。
2. 两个新模块只有同时满足模块总表第5节的全部合批条件才可同Session；三个模块只用于已经分别获批后的组合一致性走查。
3. 不做泛调研。现有候选广度已经足够，只补当前模块决定设计所必需的事实缺口。
4. 不重新讲解已批准模块，不反复生成总计划，不加载全部参考截图；直接引用权威文档和原型路径。
5. 原型范围固定为1条主路径、1个风险态、1—3个画面或1个轻量HTML；超出时先拆模块，不靠延长Session完成。
6. 用户拍板后立即更新第8节列出的状态文件；批准没有落盘，视为该Session尚未收口。

## 7. 原型交付门

1. 交付Web响应式效果，不建设桌面App；PWA只在对应模块补安装、更新、认证和离线连续性。
2. 用户收到具体`.html`路径时，该文件必须自包含并按`file://`方式可见、可操作；Vite源码入口不能冒充可双击产物。
3. HTTP、Sites和直接文件入口应来自同一源码/构建版本；至少验证首屏、主路径、风险态和控制台。
4. 后端未实现的控件必须禁用、标`待实现`或明确只演示反馈；不能用可点击假按钮冒充真实保存、执行或交付。
5. 适用时同时检查桌面、390px手机、短视口/软键盘、焦点、Escape、Tab、横向溢出和不只靠颜色表达状态。
6. 视觉继续使用已批准基线；不用GitHub Actions式开发者流水线，不引入紫色AI渐变。Super Productivity保留在已经批准的局部参考范围。

## 8. 每个模块批准后的落盘清单

| 事实 | 唯一或主要维护位置 |
|---|---|
| 28个模块名称、边界、顺序、主参考与IU映射 | [模块总表](./chat-interaction-design-module-map.md) |
| 逐IU设计/预览/批准/实现状态与覆盖率 | [覆盖台账](./chat-interaction-design-coverage-ledger.md) |
| 外部产品事实、证据等级和模式决定 | [事实走查计划](./ui-ux-reference-fact-walkthrough-plan.md) |
| 单模块事实、方案、决定、原型和验证 | `docs/ui-ux-modules/md-xx-*.md` |
| 可操作原型 | `prototypes/chat-interaction-modules/md-xx-*/` |
| 当前项目事实 | [PROJECT_STATE](../PROJECT_STATE.md) |
| 路线与下一个审核门 | [PROJECT_PLAN](../PROJECT_PLAN.md) |
| 当前完成数、下一模块和续接方法 | 本文件 |

落盘时必须同时写明：用户批准日期与revision、批准的2—4项决定、对应IU、后端/实现边界、验证证据、剩余问题和下一个模块。不能只在最终回复里宣布“完成”。

## 9. 整项任务的完成门

1. 28个模块都经过事实提取、效果呈现和用户拍板，或被用户明确合并/取消并同步IU映射。
2. 冻结覆盖版本后至少78/86个单元获批；若分母修订，按新revision重新计算。
3. 42个P0及9条P0主旅程全部获批并完成端到端串联检查。
4. 约30%、60%、90%三个自然节点完成跨模块导航、视觉、对象、状态、返回和跨端一致性走查。
5. 所有未实现能力有诚实壳与待实现合同；设计进度与代码进度继续分开。

## 10. 可直接复制的续接指令

推荐在新的Session发送：

> 继续Chat的90%前端交互设计。请按`docs/chat-interaction-design-handoff.md`从第一个未完成模块继续；本次默认只做一个模块，不重做已批准模块。完成参考事实提取、Chat采用/改造/拒绝、1个轻量HTML或1—3张草图、1个最高风险态和2—4个拍板点后停下来给我审核。

以下短句也必须路由到本文件：

- “继续我们的工作台参考界面。”
- “继续前端交互设计。”
- “继续90%的Chat系统交互设计。”

当前下一次执行应选择`MD-02 Personal Home、注意力与继续工作`，但先按该模块边界恢复事实，不在本次归档Session启动设计。
