---
status: candidate
version: 0.1
date: 2026-08-11
scope: Basecamp + Things + Linear + HEY Calendar + Microsoft Agent Feed + Heptabase
---

# 参考原型场景矩阵与组合策略 v0.1

## 1. 结论先行

六个参考原型既是边界不同的交互证据，也是本轮组合实现必须直接复用的 UI / 交互来源：

1. **Basecamp** 最完整地证明多 Project、Project room 与对象返回连续性。
2. **Things** 最完整地证明长期 Project 与个人 Today 是两条正交轴，也覆盖个人生活、娱乐与爱好。
3. **Linear** 证明列表、Peek、详情与负责人 Update 的多档阅读速度，但不拥有完整 Project 方法对象。
4. **HEY Calendar** 证明 Day / Week / Year 的连续时间尺度，以及来源进入日历前的候选与冲突处理。
5. **Microsoft Agent Feed** 证明多 Agent 的类型化监督队列，但 Feed 不能成为决定、运行或 Evidence 的事实源。
6. **Heptabase** 最完整地证明资料对象身份、空间 placement、显式 AI 上下文和知识编排复用。

七条场景轴中，只有“多 Project”“Today / 个人节奏”“多 Agent 看护”“知识资料编排”分别出现明确主参考；**没有任何一个参考完整覆盖 Chat 的 Stage / Milestone / Iteration / Work / Scope / Action / Update 对象链，也没有任何一个参考完整覆盖未来用户—用户、用户—他人 Agent、Agent—Agent 的 visibility / consent / participant 合同。** 这两处必须由 Chat 的产品事实与权限合同补足，不能借参考产品的外观假装已经成立。

本轮不再把上述场景重新画成 3 个抽象模式。每套都是包含 `Projects / Room / Work / Updates / Today / Calendar / Agents / Knowledge` 的完整 App；差异只来自 Basecamp 与 Linear 的真实重叠主责。最小且有区分度的组合数量仍是 **3 套**：

- **Room × Linear Work（房间优先）**：Basecamp 拥有 Project 入口 / Room，Linear 独占 Work / Update。
- **Basecamp Native × Linear Update（原生房间）**：Basecamp 独占 Project / Room / Work，Linear 只补 Update。
- **Linear Console × Basecamp Room（工作优先）**：Linear 拥有 Project / Work / Update，Basecamp 只补协作 Room。

Things、HEY、Agent Feed、Heptabase 在 3 套中分别固定拥有 Today、Calendar、Agent supervision、Knowledge。第 4 个数学组合“Linear Project 首页 + Basecamp Work”只会增加反向跳转和第二套 Project 语法，没有新增用户能力，因此不成立。第 11 节给出当前完整推导。

## 2. 判定口径与证据范围

### 2.1 三档判定

- **覆盖**：冻结原型的核心可点击路径直接完成该场景的主要用户结果；不表示它等同于 Chat 的生产合同。
- **部分覆盖**：只完成子路径、只提供可复用语法，或缺少该场景的权威对象、生命周期、权限或恢复边界。
- **不负责**：冻结范围没有执行该场景；即使原产品理论上可以被配置成类似用途，也不据此扩张结论。

### 2.2 审计边界

1. 事实来自冻结 worktree / commit 中的实际实现、自动化测试和浏览器路径；不是只读审计总结。
2. QA 数字表示本轮实际运行的合同 / Sites 测试；浏览器结论包含桌面与移动主路径及控制台检查，但不宣称完整无障碍合规。
3. Heptabase 已完成独立复核后的最终 QA；其独立 freeze 是 `3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb`，不能用工作树基点冒充 freeze。literal combination 另以第 14 节登记的 commit 冻结。
4. 本文只决定组合原型的事实输入，不改变生产 UI，也不把任何参考产品提升为 Chat 的产品事实源。

## 3. 精确证据账本

| 原型 | 冻结 branch / commit | worktree | 实现路径 | 本轮实际 QA |
|---|---|---|---|---|
| Basecamp | `codex/basecamp-full-interaction-v0.2` / `13656c41f0407e24d94a2f174a71525f21c2fc9c` | `/Users/xulater/Code/Chat-basecamp-reference-v02` | `docs/design/reference-implementations/basecamp` | 合同与浏览器路径 `21/21`；console `0` |
| Things | `codex/things-today-reference-qa` / `2b431c0942b7747e4c56210ada148e37684f109d` | `/Users/xulater/Code/Chat-things-today-reference-qa` | `docs/design/reference-implementations/things-today` | 合同与浏览器路径 `21/21`；console `0` |
| Linear | `codex/linear-reference-v0.1` / `a74e088c0f7f1d04c653ae0a18c2487e0dff3879` | `/Users/xulater/Code/Chat-linear-reference-v01` | `docs/design/reference-implementations/linear` | 交互 `10/10` + Sites `4/4` = `14/14`；桌面 / 移动 console `0` |
| HEY Calendar | `codex/hey-calendar-reference-v0.1` / `87596d433e120fa09c85484bd8591c1c6a4fdd30` | `/Users/xulater/Code/Chat-hey-calendar-reference-v01` | `docs/design/reference-implementations/hey-calendar` | 交互 `11/11` + Sites `4/4` = `15/15`；桌面 / 移动 console `0` |
| Microsoft Agent Feed v0.1 | `codex/microsoft-agent-feed-reference-v0.1` / `eed0aa0e4b9fec38fcf7e4eb6684a23e9897e8aa` | `/Users/xulater/Code/Chat-agent-feed-reference-v01` | `docs/design/reference-implementations/microsoft-agent-feed` | 原始视觉 freeze preserved；交互 `15/15` + Sites `4/4` = `19/19`，console `0`；复核缺口仍为 `2 P1 + 4 P2` |
| Microsoft Agent Feed Human Loop v0.2 | `codex/microsoft-agent-feed-human-loop-v0.2` / `8d30cfe5651665407bf6e6dddc0339c075453704` | `/Users/xulater/Code/Chat-agent-feed-human-loop-v02` | `docs/design/reference-implementations/microsoft-agent-feed-human-loop-v0.2` | model/interaction `31/31` + Sites `4/4` = `35/35`；build、1440×900、391×844、console `0`、同屏视觉通过；`P0/P1/P2 = 0` |
| Heptabase | `codex/reference-prototype-combinations` / `3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb` | `/Users/xulater/.codex/worktrees/b469/Chat` | `docs/design/reference-implementations/heptabase` | 模型 / UI `15/15` + Sites `4/4` + IAB browser gates `9/9` = `28/28`；CSS `391×844` 无横溢、启用控件 `<44px = 0`、console `0`；frozen |

对应审计入口：[`Basecamp`](./basecamp-interaction-audit-v0.1.md)、[`Things`](./things-today-interaction-audit-v0.1.md)、[`Linear`](./linear-interaction-audit-v0.1.md)、[`HEY Calendar`](./hey-calendar-interaction-audit-v0.1.md)、[`Microsoft Agent Feed`](./microsoft-agent-feed-interaction-audit-v0.1.md)、[`Heptabase`](./heptabase-interaction-audit-v0.1.md)。

## 4. 6 × 7 事实场景矩阵

| 参考原型 | ① 多 Project 事务与持续推进 | ② Project room / Stage / Milestone / Iteration / Work / Scope / Action / Update | ③ Today / 个人节奏与长期 Project 正交 | ④ 多 Agent / HITL / Decision / Candidate / 运行异常 | ⑤ Resource / Evidence / 知识资料收集、关联、编排与复用 | ⑥ 生活、娱乐、爱好等个人 Project | ⑦ visibility / consent / participant 边界 |
|---|---|---|---|---|---|---|---|
| **Basecamp** | **覆盖**：8 个不同 Project 可从 Home、Folder、Search、Star 与跨项目聚合入口进入；创建 Project、切换 Room、进入 Tool / Item 并返回都保持对象身份。 | **部分覆盖**：有 Project Room、6 个工具、4 列 Workflow、Schedule milestone、Todo、Message / Hill Update；没有一等 `Iteration`、`Scope`，Workflow 列也不能冒充 Chat 的 Stage。 | **部分覆盖**：`My Tasks`、`Do Today` 等个人投影复用原 Project Todo，并能返回来源；没有 Things 式 When / This Evening 节奏，也没有独立的日历承诺语义。 | **不负责**：没有 Agent 身份、模型候选、版本绑定 Decision、Run Attempt 或 `outcome_unknown`。 | **部分覆盖**：Docs & Files、Message、附件、搜索和 preview 可收集与打开资料；没有 provenance、版本、Evidence 验证或关系图。 | **不负责**：冻结 fixture 是团队 / 客户 Project；不能因 Project 容器通用就声称覆盖家庭、娱乐或爱好。 | **部分覆盖**：有人员、presence、`All-access` 和可见人数；客户 / item 级权限、明确 consent 和 Agent Participant 未实现。 |
| **Things** | **部分覆盖**：Area / Project / Today 管理多个个人 Project，状态跨列表与详情一致；没有团队 room、负责人 Update 或多人持续推进。 | **部分覆盖**：有 Area → Project → Heading → To-do、Checklist，以及 When / Move / Deadline / Complete 分责；没有 Stage、Milestone、Iteration、Scope、Evidence 或负责人 Update。 | **覆盖**：Today 是跨 Project 的独立注意力投影；This Evening、来源副标题、原位详情、完成 / 撤销与 Quick Find 都保持长期 Project 身份。 | **不负责**：没有 Agent、HITL、Decision、运行或异常处置。 | **不负责**：Notes / Checklist 不等于可收集、关联、验证和复用的 Resource / Evidence 系统。 | **覆盖**：冻结 fixture 直接包含工作、生活、娱乐与爱好；个人 Project、Anytime / Someday 和 Today 节奏可实际操作。 | **不负责**：是个人任务语法；没有共享参与者、权限或同意合同。 |
| **Linear** | **部分覆盖**：3 个 Project 可切换并进入 Pulse / Updates；只有 Atlas 有完整 Issue 集，状态保存在前端内存，未证明完整 Portfolio 生命周期。 | **部分覆盖**：有 Overview、Issues、Updates、Milestones、Issue List / Peek / Detail 与负责人 Update；没有独立 Stage、Iteration、Scope、Action，Issue 不能代替所有工作层级。 | **不负责**：没有跨长期 Project 的个人 Today / 日程节奏。 | **部分覆盖**：单一 Agent 可起草 Project Update，人工编辑后 Publish；只有发布后才进入 Overview / History / Pulse。没有多 Agent、正式 Decision、Run 或异常监督。 | **部分覆盖**：有 Resources、来源、Observed changes 与 History；没有真实关联、空间编排、版本验证或复用闭环。 | **不负责**：冻结 fixture 是软件工程 Project，没有生活 / 爱好场景。 | **部分覆盖**：有 lead、assignee、author、commenter 身份；没有 permission、consent 或跨组织 participant 模型。 |
| **HEY Calendar** | **不负责**：Calendar 与 calendar group 不是 Project 组合或推进生命周期。 | **不负责**：Event、Habit、Journal、Sometime 不等于 Project room、Stage / Work / Update。 | **部分覆盖**：Day / Week / Year 可连续切换，Event / Sometime / Habit / Journal 保持类型；但没有把 Today 项明确连回长期 Project，也不负责 Project 下一行动。 | **部分覆盖**：Email 来源先形成日历候选，冲突可见，用户可改时间、保存或取消；没有 Agent 身份、Decision 版本、Run 或异常恢复。 | **部分覆盖**：保留 Email / calendar source、搜索与 Journal；没有知识关系、版本、Evidence 验证或跨 Project 复用。 | **部分覆盖**：Personal / Family / Maybe、运动、旅行、Habit 与 Journal fixture 可体验；没有个人 Project 的阶段与持续推进。 | **部分覆盖**：有 calendar visibility、invitee 和来源；隐藏日历只是视图过滤，不是授权、consent 或 participant 合同。 |
| **Microsoft Agent Feed** | **部分覆盖**：v0.2 以 4 个角色 Agent、4 个 Project 跨项目监督；没有 Project 目标、阶段或持续推进生命周期。 | **部分覆盖**：Update candidate、Decision / Run / Evidence、related record 与 fact-before-resume 完整演示单条纵向闭环；没有 Room 或 Stage → Iteration → Work 层级。 | **不负责**：风险队列不是个人 Today，不能占用日常节奏入口。 | **覆盖**：Decision 修订、Assistance、candidate、`outcome_unknown` 与 Agent—Agent delegation 均有 typed human/system action、owner、waiting 和独立终态；v0.1 缺口不再阻断复用 v0.2。 | **部分覆盖**：可选择 Evidence、展示新 Evidence、delegated Evidence 与 related record；没有知识资料的长期编排，Feed 仍不拥有 Evidence。 | **部分覆盖**：保留只读 dismissed Personal Studio fixture，只证明私人候选可降噪；没有个人 Project 的真实推进。 | **部分覆盖**：delegation 明示 participant visibility 与 coordination-only；不虚构跨账户社交或生产 Agent 私聊。 |
| **Heptabase** | **部分覆盖**：Work / Life tab group 与 3 个 Whiteboard 组织多个上下文；同一 Card 可跨 Board 复用，但没有 Project 生命周期、推进事务或负责人 Update。 | **部分覆盖**：Whiteboard、Section、Card placement、connection 与上下文侧栏可组成项目工作台；没有一等 Stage、Milestone、Iteration、Work、Scope、Action 或 Update。 | **部分覆盖**：官方 Daily Journal 与 Work / Life tab 分层提供日常记录语法，MCP 也可 append Journal；冻结核心路径没有执行 Today ↔ 长期 Project 的双向投影。 | **部分覆盖**：AI 上下文可显式选择，访问日志区分 `searched` / `viewed`，回答先是 candidate，保存后带 provenance；没有多 Agent、正式 Decision、Run Attempt 或异常监督。 | **覆盖**：Card / source card、PDF、highlight、双向链接、Search、Whiteboard placement / Section / connection 与同一 Card 多 Board 复用形成完整知识工作台；边界是这些仍不是 Chat 的正式 Evidence 验证与版本事实。 | **部分覆盖**：Life group 与“周末陶艺”Board 直接覆盖个人爱好资料编排；没有阶段、承诺、下一行动和健康 Update。 | **部分覆盖**：原型有 Board owner / edit / view / none，协作者只看显式共享 Board 上的 Card；AI 有 Space search 开关和访问日志，但官方目前不能在已开启的 Space search 内排除单张敏感 Card / Board，也没有 consent 历史或 Agent Participant。 |

## 5. Heptabase 当前官方补充及其影响

2026-08-10 复核的一手资料补充了旧审计没有完全覆盖的 AI 与复用边界：

1. [Heptabase 产品页](https://heptabase.com/) 仍把 Card、Whiteboard、PDF / YouTube / Note / Journal、双向链接与来源研究作为主结构。这支持矩阵第 ⑤ 轴的“覆盖”，但不证明 Project 生命周期。
2. [Space search 数据访问说明](https://support.heptabase.com/en/articles/13009956-what-data-can-ai-access-when-i-turn-on-the-space-search-option-in-an-ai-conversation) 明确：开启后可在一个 Space 的全部 Card / Whiteboard 中检索，实际送入模型的是检索到的小部分内容；界面会显示 `searched` / `viewed`，当前 tab 在工具读取前只暴露名称。它同时明确目前不能在开启 Space search 时排除某一张敏感 Card / Board，所以第 ⑦ 轴只能判为“部分覆盖”。
3. [Heptabase MCP 官方说明](https://support.heptabase.com/en/articles/12679581-how-to-use-heptabase-mcp) 提供 `save_to_note_card`、`append_to_journal`、语义搜索、Whiteboard 搜索 / 读取与单对象读取。它加强了“收集 → 找回 → 理解编排 → 保存复用”的证据，但 MCP 写入仍不能替 Chat 决定 Project、Decision、Evidence 或完成事实。
4. 旧审计的 [User Interface Logic](https://wiki.heptabase.com/user-interface-logic)、[Fundamental Elements](https://wiki.heptabase.com/fundamental-elements) 与 [Use Case and Workflow](https://wiki.heptabase.com/use-case-and-workflow) 继续支持 Card identity 与 Whiteboard placement 分离的判断。

对组合原型的直接约束是：显式 context、访问日志和 provenance 可以采用；默认搜索整个 Space、把位置 / 连线当领域关系、或让 AI 写入后自动成为正式事实必须拒绝。

## 6. 真实缺口、反万能边界与复用阻断

### 6.1 六个参考共同没有解决的缺口

1. **完整 Project 对象链缺口**：没有任何原型同时拥有 Stage Goal、Milestone、Iteration Commitment、Work、执行中发现的 Scope、具体 Action、负责人 Update、Gate 与 Decision。组合原型必须以 Chat 对象合同为骨架，不能用 Basecamp Workflow 列或 Linear Issue 状态补齐名词。
2. **事实提交缺口**：Microsoft Agent Feed v0.2 已用完整 fixture 状态机证明 `candidate → 人工修订 → revision / hash / scope / Evidence 绑定 Decision → Product Commit → Run resume → result` 的交互与非法转换；它仍不证明生产耐久执行，权威事实必须由 Chat Product Store / Application / Workflow 实现。
3. **结果未知缺口**：Agent Feed v0.2 已证明 `outcome_unknown → provider query → Evidence → Product Commit / manual disposition` 的监督语法并拒绝普通 Retry；真实 provider 对账、幂等与结果未知仍属于生产 Application / Workflow 合同。
4. **跨表面连续性缺口**：各原型分别证明 Project、Today、Agent Feed、Calendar、Workbench；没有一个证明同一 Work 在这四类投影间往返仍保持身份、revision、返回位置和未提交草稿。
5. **未来参与边界缺口**：没有参考完整覆盖用户—用户、用户—他人 Agent、Agent—Agent 的 visibility / consent / participant。当前组合只展示显式可见范围、权限警告和 Participant 身份，不虚构社交关系、跨账户授权或代他人 Agent 同意。
6. **正式 Evidence 缺口**：Heptabase 擅长知识资料，Basecamp / Linear 擅长附件与变化，Agent Feed 擅长 related record；但都不能直接背书 Chat 的 Evidence 验证、版本、贡献归属与完成门。

### 6.2 每个参考明确不能扩成什么

| 参考 | 可采用的核心语法 | 明确拒绝的万能化 |
|---|---|---|
| Basecamp | Account → Project → Tool → Item；稳定返回；跨项目个人聚合 | 不把六宫格 Tool 当 Chat 全局骨架；不让 Everything / Feed 拥有事实；不以头像或颜色代替状态 |
| Things | parent context × attention projection；When / Move / Deadline / Complete 分责 | 不把所有对象 checkbox 化；不把个人手排变成团队优先级；不把固定 macOS 窗 CSS 原样用于移动端 |
| Linear | List / Peek / Detail 三档阅读；负责人 Update 与 observed changes 分离 | 不把 Issue 当 Stage / Work / Scope / Action 的通用替身；不把进度条自动解释为健康 |
| HEY Calendar | Day / Week / Year 连续尺度；source → candidate → conflict → commit | 不让 Calendar 拥有 Project；不让颜色 / 装饰成为事实；不让 Habit 完成冒充 Project 进度 |
| Microsoft Agent Feed | 风险优先的类型化监督；Agent + Project 组合过滤；related record + back | 不让 Feed 成为事实源；不复制 Completed 大桶、Insights 排名、通用 Undo 或 `outcome_unknown` 的 Retry |
| Heptabase | canonical object × placement；主表面 + context sidebar；显式 AI context / provenance | 不把无限画布作为默认首页；不把位置、颜色、箭头直接当领域关系；不让无来源 AI Card 自动进入长期事实 |

### 6.3 当前发现的 P1 / P2 复用阻断

当前没有 P0。下表中的“阻断”指 **不能把相关 CSS、动作语义或组件直接复用进组合原型**，不等于每个问题都超出原参考原型自己的冻结范围。

| 来源 | 级别 | 已核对事实 | 对组合复用的处理 |
|---|---|---|---|
| Basecamp Todo detail | **P1** | v0.3 浅主题仍命中旧深色规则；Complete 对比 `1.24:1`，事实标签 `1.33:1` | 不复用该主题规则；组合原型重新映射语义 token，并以正文 `≥4.5:1`、交互 `≥3:1` 实测收口 |
| Basecamp mobile | **P2** | `375px` 下 Complete 高 `38px`、Post comment 高 `42px` | 复用对象与路径，不复用命中区；组合统一 `≥44×44px` |
| Things mobile | **P1（组合阻断）** | 冻结原型是固定 macOS 窗；`375px` 时 document width `760px`，内容缩为约 `303×262`。这不否定其桌面参考范围，但不能成为移动 UI | 只复用模型和交互语法；移动端重写为原生单列层级，不缩放桌面窗 |
| Things desktop controls | **P2** | 46 个 visible button 中 41 个至少一维 `<44px` | 视觉尺寸可保持克制，热区必须扩到 `44px`，并重测键盘焦点 |
| Linear Update composer | **P2** | Project Update composer 聚焦后按 `Escape` 不关闭；现有键盘处理只覆盖 Peek | 统一键盘合同：`Escape` 取消未提交 composer / 关闭临时层，并把焦点还给触发点 |
| Microsoft Agent Feed mobile | **P1** | CSS `389/391×844` 时 page width `451px`，横溢 `62/60px` | 不复用现有 grid / min-width；移动端改为单列，完成门要求 `scrollWidth = clientWidth` |
| Microsoft Agent Feed action semantics | **P1** | 所有动作共用 Undo，可把已确认 provider 对账、Decision approval、accepted Update 回退 | 删除通用 Undo；只有确定可逆的本地筛选 / 暂存动作可撤销，正式 Decision / 对账使用新 revision 或补偿流程 |
| Microsoft Agent Feed Insights | **P2** | Reconcile 后 Feed `needs = 3`，Insights 仍硬编码 `4` | 所有计数从同一投影模型计算，不保留独立展示常量 |
| Microsoft Agent Feed dismissed state | **P2** | dismissed 的 `Personal Studio` 仍显示可编辑空 Candidate 表单 | dismissed / rejected 使用明确只读终态；重新发起必须是新 candidate |
| Microsoft Agent Feed mobile controls | **P2** | 6 个核心移动控件只有 `30/32px` | 统一 `44px` 热区与可见焦点 |
| Microsoft Agent Feed motion | **P2** | 无限旋转没有 `prefers-reduced-motion` 降级 | 去掉持续循环；reduced motion 下使用静态状态图标 |

因此 Microsoft Agent Feed v0.1 的 `frozen / QA passed` 仍只表示原始视觉 freeze，`19/19` 与 console `0` 不能抵消上述响应式和动作语义缺陷。Human Loop v0.2 已逐项收口这些阻断：`35/35`、1440×900 与 391×844 浏览器路径、console `0`、同屏视觉 QA，最终 `P0/P1/P2 = 0`。后续复用必须指向 v0.2 freeze；现有 literal combination 副本不会因登记更新而自动升级。

已关闭、因此不再阻断当前复用的 Heptabase 问题：移动端曾丢失 Section / Card 关系、14 个触控目标 `<44px`；独立复核又发现 `6 P1 + 2 P2`（全状态 44px、键盘 Card 入口、移动 tab 名称、Share focus lifecycle、board-scoped permission、仓库 browser runner 和动态权限副标题）。最终已按 Section 顺序大纲、全端 44px、原生 Card 主按钮、具名 tabs、modal focus trap、`permissionsByBoardId` 和仓库内 IAB runner 收口；`391×844` 实测 `scrollWidth = clientWidth = 391`，Heptabase 最终 `P0/P1/P2 = 0`。HEY Calendar 当前也没有确认的 P0 / P1 / P2。

未分级但必须进入组合 E2E 的证据缺口：对所有 modal / drawer 验证焦点锁定、`Escape`、关闭后的焦点返回；自动化和截图不能单独证明完整屏幕阅读器顺序。

## 7. 已废弃的第一次抽象组合推导（历史记录）

> **Superseded 2026-08-10**：第 7～10 节描述的 `Project Room / Today Rhythm / Evidence Workbench` 是用户已退回的抽象重绘方向，不再是实现、体验 URL、冻结输入或任务 2 依赖。保留本段只用于解释为什么旧方案被废弃；当前事实从第 11 节开始。

### 7.1 先按工作模式与注意力合同分组

| 工作模式 | 用户此刻的主问题 | 注意力强度 | 主要对象 | 主要参考 |
|---|---|---|---|---|
| 持续推进 / 深度编排 | “这个 Project 现在在哪里，下一段投入、资料和决定怎样组织？” | 中到高；持续 | Project、Stage、Iteration、Work、Resource、Update、Evidence | Basecamp + Linear + Heptabase |
| 今日选择 / 时间安排 | “今天真正要做什么，何时做，怎样不丢长期来源？” | 低到中；频繁短访 | Today projection、Action、Event、Habit、Journal | Things + HEY Calendar |
| 异常监督 / 人工介入 | “哪些 Agent 现在需要我，风险与后果是什么？” | 高风险；中断驱动 | Candidate、Decision、Product Run / Attempt、Evidence、Exception | Microsoft Agent Feed + Linear Peek + Heptabase context |

Resource Workbench 与 Project Room 都是高上下文、持续工作的模式，而且共享 canonical Resource / Evidence / Work 身份；它应该是 Project 内的一个可切换工作表面，而不是第四个拥有独立对象与导航的产品。

### 7.2 数量比较

| 数量 | 最小分法 | 结果 | 判定 |
|---|---|---|---|
| **2 套** | 必须把“今日选择”与“Agent 异常”，或把“项目推进”与“Agent 异常”塞进同一默认入口 | 用户主动选择的 Today 与系统推来的风险通知争抢首屏；或 Feed 侵入 Project room，迫使列表、日程、运行异常共享同一优先级和完成语义 | **过少**：至少有两种互斥注意力合同被混合 |
| **3 套** | Project Room / Today Rhythm / Evidence Workbench | 每套只有一个默认问题、一种主要注意力节奏和一组主动作；通过 canonical object 与 return anchor 互相交接 | **刚好**：覆盖三种不可合并的工作模式，同时不重复事实所有权 |
| **4 套** | 再把 Resource Workbench 从 Project Room 独立出来 | Project、Resource、Evidence 会在两个高上下文空间重复导航、搜索和“当前位置”；用户需要先决定去 Project 还是 Knowledge 才能打开同一对象 | **当前过多**：除非未来真实研究证明存在脱离 Project 的独立知识产品主场景，否则不成立 |

因此冻结 **3 套**。这是最小数量，不是固定模板；未来只有在第四种独立注意力合同被真实场景和浏览器路径证明后才重新打开数量决定。

## 8. 已废弃的三套抽象模式合同

### 8.1 Project Room｜项目房间

**主场景**：团队或个人在多个长期 Project 间持续推进；进入一个 Project room，理解 Stage / Milestone / Iteration，打开 Work / Scope / Action，查看负责人 Update，并把真实 Resource / Evidence 放进可复用工作台。

**采用的交互语法**：

1. Basecamp 的 `Account → Project → Tool / surface → Item` 地点感、Folder / Search / Star 入口和稳定返回。
2. Linear 的 List / Peek / Detail 三档阅读、Project Update cadence、人工叙事与 observed changes 分离。
3. Heptabase 的 canonical object / placement 分离、同一对象跨 Board 复用、主表面 + context sidebar、显式 AI context 与 provenance。

**为什么组合成立**：三者都服务持续、高上下文工作；Basecamp 提供 Project 地点，Linear 提供工作密度与快速深入，Heptabase 提供资料编排。它们共享 Project / Work / Resource 的稳定身份，不需要叠加三套全局导航。

**明确拒绝**：

- 不以 Basecamp 六宫格作为全局骨架。
- 不把 Linear Issue 当全部 Work 层级，也不从完成比例自动计算 Project 健康。
- 不让 Heptabase Canvas 成为默认首页；placement / connection 不是 Dependency / Evidence link，除非形成显式 candidate 并被确认。
- 不在此套复制 Today 队列或 Agent Feed；只显示摘要和去对应套的稳定链接。

**与其他两套的区别**：它拥有长期 Project 的上下文和正式对象详情；Today Rhythm 只选择当日注意力，Evidence Workbench 只管理需要人工介入的异常。后两者都通过 related object 进入本套，并能返回原位置。

**核心可点击路径**：

```text
Portfolio / Search
→ Project Room
→ Stage / Milestone / Iteration
→ Work list
→ Peek
→ full detail / edit / decide / complete or reopen
→ Resource Workbench / Evidence
→ publish owner Update
→ back restores Project, filters, scroll and focused object
```

**真实 mock 覆盖**：

- 至少 4 个不同类型 Project：棕地软件 `Chat · Project Solution`、持续运维 `Home Lab · 存储迁移`、家庭项目 `秋季家庭旅行`、爱好项目 `周末陶艺 · 第一只可用茶杯`。
- 每个 Project 有不同 Stage；至少 2 个有 Milestone，2 个有显式 Iteration，1 个故意无 Iteration 以证明非软件小项目不被强制套方法。
- 至少 8 个 Work、6 个 Scope、12 个 Action；包含阻塞、未知、完成后 reopen 和下一步为空的状态。
- 3 名人类 Participant、3 个 Agent Participant；Contribution / Decision / Evidence 各至少 4 条，且 reported Contribution 与 verified Evidence 可辨。
- Resource 至少覆盖 Git / 文档 / PDF / 日历来源；同一 Resource 出现在 Project Room、Workbench 与 Decision context 时仍是同一 ID。

### 8.2 Today Rhythm｜今日节奏

**主场景**：用户从多个长期 Project 中挑出今天真正要关注的 Action，同时处理工作、家庭、娱乐、爱好、日历承诺、Habit 和 Journal；安排时间时不让 Calendar 接管 Project。

**采用的交互语法**：

1. Things 的 parent context × attention projection、Today / This Evening、When / Move / Deadline / Complete 分责、来源副标题、原位详情、Undo 与 Quick Find。
2. HEY Calendar 的 Day / Week / Year 连续尺度、Event / Sometime / Habit / Journal 类型区分，以及 `source → candidate → conflict → human adjust → save / cancel`。

**为什么组合成立**：Things 回答“今天选择什么”，HEY 回答“时间上放在哪里”；二者共享 Action / Event 的稳定引用，但完成、截止、安排时间和习惯打卡仍是不同事实。

**明确拒绝**：

- 不把所有 Project 对象 checkbox 化，不让人工排序变成团队优先级。
- 不让 Calendar event 或时间块拥有 Work；Habit 勾选不能推进 Stage。
- 不自动把昨天未完成事项无记录滚入今天；Move 必须保留来源和决定。
- 不复用 Things 固定桌面窗的移动 CSS，不只靠 Calendar 颜色表达状态。

**与其他两套的区别**：它是个人当日注意力投影，不拥有 Project 健康、团队 Update 或 Agent 监督优先级；打开来源时进入 Project Room，Agent 要求介入时进入 Evidence Workbench。

**核心可点击路径**：

```text
Today
→ filter Work / Life / Evening
→ open Action inline
→ When / Move / Deadline / Complete / Undo
→ open source Project and return
→ Day / Week / Year
→ open source candidate
→ inspect conflict
→ adjust / save or cancel
→ return to Today with the same Action identity
```

**真实 mock 覆盖**：

- 同时引用上述 4 个 Project，Today 至少 7 项：工作 3、家庭 1、娱乐 1、爱好 1、This Evening 1。
- 至少 2 个 Event、1 个冲突候选、1 个 Sometime、2 个 Habit、2 条 Journal；安排时间与 Action 完成分别可操作。
- 覆盖 overdue、移动到明天、移动到 Evening、完成 / 撤销、来源 Project 返回、隐藏 calendar 但不删除对象。
- 至少 1 个 Calendar Agent 起草候选；用户可改时间或取消，保存前不形成正式 Event。
- 个人 fixture 必须真实可读，不把生活项目降为“其他”或只做一个 dismissed 彩蛋。

### 8.3 Evidence Workbench｜证据工作台

**主场景**：多个 Agent 在多个 Project 上工作时，用户快速找到真正需要介入的候选、决定、review、权限问题、失败和 `outcome_unknown`，查看证据后接受、修订、拒绝、对账或转到权威对象。

**采用的交互语法**：

1. Microsoft Agent Feed 的风险优先 typed supervision、Agent + Project 组合过滤、side / full / mobile 注意力切换、candidate / accepted 分离、revision / hash / Evidence 和 related record + back。
2. Linear Peek 的列表 → Preview / Peek → full detail 三档阅读与焦点返回。
3. Heptabase 的显式 context chips、`searched` / `viewed` 访问日志和保存结果 provenance；只用于解释 Agent 读了什么，不拥有决定。

**为什么组合成立**：三者都服务“先快速判断是否需要介入，再深入一个稳定对象”。Feed 决定优先级，Peek 控制阅读成本，context / provenance 解释材料边界；权威事实仍在 Project / Decision / Run / Evidence 对象。

**明确拒绝**：

- Feed 不拥有 Project、Decision、Run 或 Evidence，也不以 Completed 大桶制造完成感。
- 正式 approval、accepted Update 与 provider reconciliation 没有通用 Undo；需要修订时创建新 revision / Decision。
- `outcome_unknown` 只提供 Query / Reconcile / Escalate，不提供普通 Retry。
- `review` 不显示假审批；没有权限时显示原因和 related record，不放一个会失败的主按钮。
- 不用 Agent 头像色代替类型、风险、权限或运行状态。

**与其他两套的区别**：它只处理例外和人工介入，不是个人 Today，也不是 Project 工作区。完成处理后回到原 Feed 过滤 / 焦点；深入正式对象时进入 Project Room。

**核心可点击路径**：

```text
Needs attention
→ filter Agent + Project + type
→ preview candidate / decision / run exception
→ inspect revision, consequence, permission and Evidence
→ edit / accept / reject / reconcile / escalate
→ open related authoritative record
→ back restores filter, list position and focused item
```

**真实 mock 覆盖**：

- 4 个 Project、至少 4 个 Agent、3 名人类 Participant；同一 Project 同时出现 candidate、accepted 与 exception，状态不互相覆盖。
- 至少 10 条监督项：2 个 Update candidate、2 个 version-bound Decision、1 个 data entry、1 个 review、1 个 permission blocked、1 个 fatal error、1 个 `outcome_unknown`、1 个 reconciliation result。
- 覆盖人工编辑、接受、拒绝、无权限、过期 revision、对账成功、对账仍未知和转 related record。
- `Personal Studio` 可被降噪，但必须保留私人 visibility 标签；其他参与者与 Agent 不因出现在 Feed 就自动获得访问权。
- 每个 item 显示 `visible to` / required permission / related object；这些只是当前 fixture 的明确边界，不声称已实现跨账户社交系统。

## 9. 已废弃方案当时的共享合同

1. **对象身份**：Project、Stage、Milestone、Iteration、Work、Scope、Action、Update、Resource、Evidence、Participant、Contribution、Decision、Product Run / Attempt 都有稳定 ID；三套只保存各自 projection / layout，不复制权威内容。
2. **任务连续性**：跨套跳转携带 `returnTo + focusedObjectId + filter / scroll anchor`；浏览器 Back、产品 Back 和关闭 Peek 都回到同一上下文。
3. **事实门**：模型输出先是 candidate；高影响决定显示 revision、hash、后果和 Evidence。完成、接受、发布、拒绝、撤销、对账分别使用自己的动作语义。
4. **单一导航语法**：每套只有一个主导航和一个上下文层；Project Room 的 Resource Workbench 是 Project 内 surface，Evidence Workbench 的 related record 不是第二套详情，Today 的 source subtitle 不是复制 Project sidebar。
5. **统一视觉系统**：沿用 Chat 字体栈、4px 间距梯度、统一宽度 / radius / hairline / icon library、黑白骨架与三通道状态；不复制 Basecamp / Linear / Power Apps / Heptabase 的品牌皮肤。
6. **统一响应式合同**：`375/391px` 无横向滚动；核心触控目标 `≥44×44px`；桌面 side panel 在移动端变为全屏层级，不缩放桌面 Canvas / Window。
7. **统一键盘语义**：`Escape` 关闭临时层或取消未提交编辑并恢复焦点；`Enter` 只提交当前明确表单；Quick Find 使用同一入口；任何高影响确认不与普通完成快捷键复用。
8. **统一动效**：只做 `150–250ms` 状态过渡；不持续旋转；`prefers-reduced-motion` 下取消非必要动效。
9. **visibility / consent 边界**：只呈现当前 fixture 已定义的 Project / Board / object 可见范围、Participant role 与权限警告；不虚构好友、关注、跨账户 Agent 授权、代表他人同意或 Agent—Agent 私聊。
10. **Feed / Today / Canvas 都不是事实源**：清缓存或离开 projection 后，正式状态必须能由 canonical mock model 重建；组合原型也要用这一结构预演未来 Product Store 所有权。

## 10. 已废弃方案的冻结记录

- 组合工作 branch：`codex/reference-prototype-combinations`
- Heptabase 实现：`docs/design/reference-implementations/heptabase`
- 组合原型实现：`docs/design/combination-prototypes`
- 本矩阵：`docs/design/references/reference-scenario-matrix-v0.1.md`
- 共同 freeze commit：`3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb`

第 8、9 节不再约束后续实现；当前约束以第 11～14 节为准。

## 11. 当前组合数量：从真实重叠主责推导 3 套

### 11.1 先定不重叠场景

以下 4 个场景在 6 个参考中各有明确且互补的主责，不需要做变体：

| 场景 | 唯一 UI / 交互来源 | 明确边界 |
|---|---|---|
| Today / Action | Things | When / Deadline / Complete 只改变 Action，不创建 Event |
| Calendar / Event | HEY Calendar | Day / Week / Year、candidate / conflict / save；不拥有 Work |
| Agent supervision | Microsoft Agent Feed | typed task、人工介入、异常；正式事实回权威对象 |
| Knowledge / Evidence material | Heptabase | Card / placement / context / provenance；不自动成为正式 Evidence |

3 套都必须包含这 4 个场景，而且直接复用对应冻结原型；不存在“这一套没有日历”或“另一套没有 Agent”的残缺版。

### 11.2 再解 Basecamp × Linear 的重叠

| 能力 | Basecamp 可主责 | Linear 可主责 | 组合规则 |
|---|---|---|---|
| 多 Project 默认入口 | Home / Folder / Room 地点感 | Project overview / Favorites 工作台 | 每套只能选一个默认 Project index |
| Project room | Message / Docs / Chat / Schedule / Workflow | 不覆盖完整协作 Room | Basecamp 固定主责 |
| Work List / Detail | To-do List / Detail | List / Peek / full Detail | 每套只能有一条 Work 对象链 |
| Project Update | Message Board / Activity 的部分语法 | Overview / Update composer / History / Pulse | Linear 固定主责；Basecamp Message Board 不再展示重复 Update |

数学上有 4 个 Project owner × Work owner 组合；其中 `Linear Project + Basecamp Work` 要从 Linear 默认工作台反向跳到另一套任务系统，同时丢掉 Linear Peek，没有新增能力也没有降低适配量，所以拒绝。剩下 3 套都是完整且有区分度的有效解。

### 11.3 三套 owner 矩阵

| 组合 | Projects | Room | Work | Updates | Today | Calendar | Agents | Knowledge |
|---|---|---|---|---|---|---|---|---|
| `room-linear` 房间优先 | Basecamp | Basecamp | Linear | Linear | Things | HEY | Agent Feed | Heptabase |
| `room-basecamp` 原生房间 | Basecamp | Basecamp | Basecamp | Linear | Things | HEY | Agent Feed | Heptabase |
| `work-linear` 工作优先 | Linear | Basecamp | Linear | Linear | Things | HEY | Agent Feed | Heptabase |

## 12. 当前三套 literal-reference 组合合同

### 12.1 Room × Linear Work｜房间优先

**主场景**：用户先把 Project 视为一个持续协作地点，再用 Linear 的高密度 Work 链推进。

**直接采用**：Basecamp Home / Folder / Project Room / Message / Docs / Chat / Schedule / Workflow；Linear Issue List / Peek / Detail、Project Overview / Updates / Pulse；其余 4 个固定场景。

**去重**：Basecamp Project Tasks、My Tasks、Everything todos 都跳同一个 Linear Work route；Basecamp Todo List / Detail 不可达。Linear Project 的 Issues tab 也回 canonical Work，不出现第二个列表。

**核心路径**：

```text
Basecamp Home → Project Room → Project Tasks
→ Linear List + Peek → full detail → Back
→ Linear Updates → compose / publish → Pulse
→ Today / Calendar / Agents / Knowledge → authoritative record → return
```

**为什么成立**：Basecamp 负责“在哪里协作”，Linear 负责“工作对象如何快速读写”；地点感与执行密度互补，没有重叠导航。

### 12.2 Basecamp Native × Linear Update｜原生房间

**主场景**：优先保留 Basecamp 从 Home → Room → To-do 的完整原生连续性，只借 Linear 补负责人 Update。

**直接采用**：Basecamp Home / Room / Tools / Todo List / Todo Detail；Linear Project Overview / Updates / Pulse；其余 4 个固定场景。

**去重**：Linear Issues / Peek / Detail 不可达；Basecamp Message Board 不再拥有 `Updates` 类别或 weekly client update。

**核心路径**：

```text
Basecamp Home → Room → Project Tasks
→ Basecamp To-do List → Detail → Complete / Back
→ Linear Updates → compose / publish
→ Today / Calendar / Agents / Knowledge
```

**为什么成立**：它是适配最少的完整版本，牺牲 Linear Peek，换取 Basecamp 工作链原貌；仍然只有一个 Work owner。

### 12.3 Linear Console × Basecamp Room｜工作优先

**主场景**：用户默认从 Linear Work / Project status 开始，只在需要多人协作上下文时进入 Basecamp Room。

**直接采用**：Linear Project / List / Peek / Detail / Updates / Pulse；Basecamp Project Room 与 Message / Docs / Chat / Schedule / Workflow；其余 4 个固定场景。

**去重**：Basecamp Home / My Tasks / Todo 不可达；Linear Projects / Favorites 是唯一 Project index。Room 只补协作工具，不复制 Work list。

**核心路径**：

```text
Linear Work → Peek / Detail
→ Project Overview / Updates / Pulse
→ Basecamp Room → Message / Docs / Chat / Schedule / Workflow
→ Today / Calendar / Agents / Knowledge
```

**为什么成立**：它把高频执行入口前置，同时保留 Basecamp 真正独有的 Room；适合工作状态优先而不是地点优先的用户。

## 13. 三套当前共享合同

1. **直接复用**：6 个参考各自保留 App / model / markup / CSS / 真实资产；宿主只做路由、owner 和主题胶水，不重新画 Project、Task、Calendar、Feed 或 Whiteboard 页面。
2. **唯一主责**：同一组合中的 Project index、Work List / Detail、Update、Today、Calendar、Agent supervision、Knowledge 都只有 1 个 owner。
3. **稳定 iframe**：切场景不销毁 6 个来源实例；source 内编辑、选择、完成、候选与白板状态保存在原模型中。
4. **主题不碰状态**：`source` 保留冻结视觉；`warm-room / quiet-day / graphite-ops / common-thread` 只映射视觉 token，并通过 `chat:theme` 更新，不重放 canonical route。
5. **对象边界**：Action 与 Event 分离；Feed 只是权威 Project / Run / Decision / Evidence 的投影；Card material 与正式 Evidence fact 分离。
6. **返回连续性**：List / Peek / Detail、Room / Tool / Item 和 related record 走来源原生返回；跨场景由宿主 canonical route 交接。
7. **响应式**：`391×844` 宿主和 6 来源无横向溢出；核心启用控件 `≥44×44px`；移动端使用来源适配层，不缩放桌面窗或 Canvas。
8. **可见边界**：只呈现 fixture 中已有的 access / permission / visibility；不虚构用户—用户、用户—他人 Agent 或 Agent—Agent 社交系统。
9. **生产边界**：这是独立设计原型，不修改生产 UI；正式产品对象与事务所有权继续以架构合同为准。

## 14. 当前实现与冻结输入

- branch：`codex/literal-reference-compositions`
- worktree：`/Users/xulater/.codex/worktrees/b469/Chat`
- 实现：`docs/design/combination-prototypes`
- 6 来源副本：`docs/design/combination-prototypes/references/{basecamp,linear,things,hey,agent-feed,heptabase}`
- Heptabase 独立 freeze：`3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb`
- literal combination freeze：`58257710cd78285b7616067ba6685271e0c741ff`
- 体验根：`http://127.0.0.1:4177/`
- 自动化：宿主 / theme `15/15` + 六来源 `88/88` + Sites `4/4` = `107/107`
- 浏览器 / 视觉证据：`docs/design/combination-prototypes/evidence/stage1`、`docs/design/combination-prototypes/evidence/theme-qa`

任务 2 只能从第 11～14 节、统一登记入口和最终 freeze commit 读取组合事实；不得恢复第 7～10 节的抽象重绘方案。
