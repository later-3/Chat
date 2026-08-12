# Chat 设计参考区与原型总入口

这里是换 Session、换 Agent 后恢复参考研究、冻结原型与组合策略的**唯一登记入口**。它记录“为什么这样设计”、精确分支 / commit / worktree、可运行路径和 QA；任何参考结论都不自动改变生产 UI 或产品事实合同。

## 参考原型登记册

更新日期：2026-08-12。跨分支文件必须按表中 branch / commit 读取，或使用 `git show <commit>:<path>`；不能因为当前工作树没有某个目录就误判为未完成。

| 参考原型 | 事实场景主责 | 冻结状态与本轮 QA | 精确实现位置 | Take / Adapt / Refuse |
|---|---|---|---|---|
| Basecamp | 多 Project、Project room、事务 / 资料 / Update 的地点感与返回连续性 | frozen；`21/21`、console `0`；本轮复核发现复用阻断 `1 P1 + 1 P2` | branch `codex/basecamp-full-interaction-v0.2` · commit `13656c41f0407e24d94a2f174a71525f21c2fc9c` · worktree `/Users/xulater/Code/Chat-basecamp-reference-v02` · `docs/design/reference-implementations/basecamp` | Take 房间与返回；Adapt Project 对象层；Refuse 工具列表成为事实模型 |
| Things | 长期 Project 与个人 Today 的正交投影；工作、生活、爱好共存 | frozen desktop scope；`21/21`、console `0`；组合复用阻断 `1 P1 + 1 P2` | branch `codex/things-today-reference-qa` · commit `2b431c0942b7747e4c56210ada148e37684f109d` · worktree `/Users/xulater/Code/Chat-things-today-reference-qa` · `docs/design/reference-implementations/things-today` | Take Today × parent context；Adapt 原生移动层级；Refuse 所有对象 checkbox 化 |
| Linear | List / Peek / Detail 三档阅读与负责人 Update | frozen；`14/14`、desktop / mobile console `0`；复用阻断 `1 P2` | branch `codex/linear-reference-v0.1` · commit `a74e088c0f7f1d04c653ae0a18c2487e0dff3879` · worktree `/Users/xulater/Code/Chat-linear-reference-v01` · `docs/design/reference-implementations/linear` | Take 渐进披露；Adapt Update 与 observed change；Refuse Issue 充当全部对象 |
| HEY Calendar | Day / Week / Year 连续时间尺度与 source → candidate → conflict → commit | frozen / QA passed；`15/15`、desktop / mobile console `0`；`P0/P1/P2 = 0` | branch `codex/hey-calendar-reference-v0.1` · commit `87596d433e120fa09c85484bd8591c1c6a4fdd30` · worktree `/Users/xulater/Code/Chat-hey-calendar-reference-v01` · `docs/design/reference-implementations/hey-calendar` | Take 时间尺度与候选；Adapt Today 约束；Refuse Calendar 拥有 Project |
| Microsoft Agent Feed v0.1 | 多 Agent 类型化监督、人工介入、异常与 related record 的原始视觉 freeze | frozen / preserved；`19/19`、console `0`；复核保留 `2 P1 + 4 P2`，只作为 v0.2 source，不直接复用移动 grid 或通用 Undo | branch `codex/microsoft-agent-feed-reference-v0.1` · commit `eed0aa0e4b9fec38fcf7e4eb6684a23e9897e8aa` · worktree `/Users/xulater/Code/Chat-agent-feed-reference-v01` · `docs/design/reference-implementations/microsoft-agent-feed` | Take 风险优先 typed supervision；Adapt 权威对象返回；Refuse Feed 成为事实源、盲目 Retry / Undo |
| Microsoft Agent Feed Human Loop v0.2 | 人—Agent—Run、Agent—Agent 委派、Decision 修订、Assistance、candidate、outcome_unknown 对账 | frozen / QA passed；model/interaction `31/31` + Sites `4/4` = `35/35`；desktop / 391×844 / console / 同屏对照通过；`P0/P1/P2 = 0` | branch `codex/microsoft-agent-feed-human-loop-v0.2` · implementation freeze `8d30cfe5651665407bf6e6dddc0339c075453704` · worktree `/Users/xulater/Code/Chat-agent-feed-human-loop-v02` · `docs/design/reference-implementations/microsoft-agent-feed-human-loop-v0.2` · 本轮 `http://127.0.0.1:4184/` | Take Fluent/Power Apps 监督身份；Adapt typed fact-before-resume 与 delegation；Refuse 万能动作、通用聊天、coordination 伪装事实 |
| Heptabase Workbench | canonical Card identity、Whiteboard placement、显式 AI context、资料编排复用 | frozen / QA passed；模型 / UI 合同 `15/15` + Sites `4/4` + IAB browser E2E gates `9/9` = `28/28`；desktop / mobile console `0`；`P0/P1/P2 = 0` | branch `codex/reference-prototype-combinations` · commit `3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb` · worktree `/Users/xulater/.codex/worktrees/b469/Chat` · `docs/design/reference-implementations/heptabase` · 本轮运行 `http://127.0.0.1:4175/` | Take identity × placement、context panel；Adapt 移动 Section outline、board-scoped permission；Refuse Canvas 默认首页、位置自动成为领域关系 |

完整 6 × 7 事实结论、已知 P1/P2 和引用证据统一见 [`reference-scenario-matrix-v0.1.md`](./reference-scenario-matrix-v0.1.md)。Heptabase 当前一手资料与 Take / Adapt / Refuse 见 [`heptabase-interaction-audit-v0.1.md`](./heptabase-interaction-audit-v0.1.md)。

## 工作台选型与骨架冻结

| 产物 | 状态与冻结范围 | 精确位置 | 后续边界 |
|---|---|---|---|
| Chat 统一工作台骨架 v0.1 | **frozen research reference**；2026-08-12 用户确认冻结当前版本。冻结当前页面结构、路由、折叠与右侧工作区打开方式，不表示已经接入生产前端 | branch `codex/human-agent-workbench-selector-html` · commit `2536cb4d22d9108bf7350dc911f8e9781c4e2f61` · worktree `/private/tmp/Chat-human-agent-workbench-selector-html` · [`chat-unified-workbench-skeleton-v0.1.html`](./chat-unified-workbench-skeleton-v0.1.html) | 作为真实前端三栏适配的视觉与交互输入；左侧导航、中央对话、按需打开的右侧工作区先落骨架，Workflow 具体设计继续延期 |

本冻结继承 [`human-agent-workbench-selector-v0.1.html`](./human-agent-workbench-selector-v0.1.html) 的用户选择结果，但不把九项来源机械拼接为生产 UI。真实前端的首轮改造仍需先审计当前代码与可运行界面，再单独形成实现任务与完成门。

Microsoft Agent Feed v0.2 的稳定输入是 [`README`](../reference-implementations/microsoft-agent-feed-human-loop-v0.2/README.md)、[`current-audit`](../reference-implementations/microsoft-agent-feed-human-loop-v0.2/current-audit.md)、[`design-qa`](../reference-implementations/microsoft-agent-feed-human-loop-v0.2/design-qa.md) 与 freeze `8d30cfe5651665407bf6e6dddc0339c075453704`。现有 literal combination 的 `references/agent-feed` 仍是此前收口副本；只有后续组合接入任务才能按上述稳定合同替换，不能把本轮原型自动宣称为生产或已接入组合。

## 当前组合策略与可运行原型

此前的 `Project Room / Today Rhythm / Evidence Workbench` 抽象重绘方案已被用户退回并废弃。当前实现直接复用 6 个冻结参考原型，只在 Basecamp / Linear 的真实重叠处选择唯一 owner；每套仍包含完整的 Projects、Room、Work、Updates、Today、Calendar、Agents、Knowledge。

| 组合 | Projects / Room / Work / Update 主责 | 采用的原型场景 | 明确拒绝 | 本轮体验 URL |
|---|---|---|---|---|
| `room-linear` 房间优先 | Basecamp / Basecamp / Linear / Linear | Basecamp Home + Room；Linear List / Peek / Detail / Update；其余四来源固定补全 | Basecamp Todo 与 Linear Issue 同时可达 | `http://127.0.0.1:4177/?composition=room-linear&scene=projects` |
| `room-basecamp` 原生房间 | Basecamp / Basecamp / Basecamp / Linear | Basecamp Home + Room + Todo；Linear 只补 Update；其余四来源固定补全 | Linear Issues 与 Basecamp Todo 同时可达 | `http://127.0.0.1:4177/?composition=room-basecamp&scene=projects` |
| `work-linear` 工作优先 | Linear / Basecamp / Linear / Linear | Linear Project + Work + Update；Basecamp 只补 Room；其余四来源固定补全 | Basecamp Home / Todo 成为第二套 Project / Work 入口 | `http://127.0.0.1:4177/?composition=work-linear&scene=work` |

为什么是 3 套：Things、HEY、Agent Feed、Heptabase 分别独占 Today、Calendar、Agent supervision、Knowledge，不需要做变体；Basecamp / Linear 的 Project / Work 重叠产生 3 个有效 ownership 解。第 4 个数学组合 `Linear Project + Basecamp Work` 只增加反向跳转并丢掉 Peek，没有新增能力。完整推导见矩阵第 11～14 节。

主题按钮为 `source / warm-room / quiet-day / graphite-ops / common-thread`；`source` 保留 6 套冻结原貌，其余 4 套只统一视觉 token，不改布局、对象或交互。主题通过独立 `chat:theme` 消息更新，不重放子原型 route。

组合实现位于 `docs/design/combination-prototypes`，branch `codex/literal-reference-compositions`，literal combination freeze commit `58257710cd78285b7616067ba6685271e0c741ff`。Heptabase 独立 freeze 仍为 `3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb`。自动化为宿主 / theme `15/15` + 六来源 `88/88` + Sites `4/4` = `107/107`，production build `4805 modules`；第一阶段桌面与移动残余 `P0/P1/P2 = 0`，主题最终浏览器数字见 [`../combination-prototypes/design-qa.md`](../combination-prototypes/design-qa.md)。

## 任务 2 稳定输入

- 任务：`019fe738-1b0d-70e3-932c-cdad3b702124`（“实现 Chat 多套可运行原型”）
- 任务 worktree：`/Users/xulater/.codex/worktrees/35f2/Chat`
- 稳定 branch：`codex/literal-reference-compositions`
- literal combination freeze commit：`58257710cd78285b7616067ba6685271e0c741ff`
- Heptabase 独立 freeze commit：`3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb`
- 必读输入：本登记册、[`reference-scenario-matrix-v0.1.md`](./reference-scenario-matrix-v0.1.md)、[`../combination-prototypes/README.md`](../combination-prototypes/README.md)、[`../combination-prototypes/design-qa.md`](../combination-prototypes/design-qa.md)
- 稳定实现路径：`docs/design/reference-implementations/heptabase`、`docs/design/combination-prototypes`、`docs/design/combination-prototypes/references`、`docs/design/combination-prototypes/evidence`
- 稳定体验根：`http://127.0.0.1:4177/`；精确 composition / scene / theme query 见组合 README。
- 依赖规则：直接复用 literal-reference surfaces 与当前 owner 矩阵；不得恢复已废弃的抽象重绘方案，不继承矩阵第 6.3 节列出的冻结参考 P1/P2；不修改生产 UI，除非任务 2 获得单独授权。

## 历史决策记录（已完成）

以下命题与锚点是 2026-08-08 UL0 / UL1 的历史审核输入；当前不再要求用户回复或重复过门：

1. **方向命题**：“安静的项目系统，鲜活的 Agent；严肃的事实，轻巧的交接”。
2. **五个锚点**：

   - A. Project 是一个房间
   - B. 工作在空间间不断线
   - C. Today 是一天的节奏
   - D. 个性来自一个机制
   - E. AI 必须显露责任边界

`3/5` 当时只作为设计团队起步旋钮；它没有自动把 Taste Contract 合并进正式规范，也没有授权生产 UI 变更。

历史审核记录：2026-08-08，用户先回复“通过”，随后确认改用 HTML-first；同日用户明确回复“UL0 通过”，6 个锚点产品深审计整体获批。其后已经完成 UL1、6 个参考原型事实复核、Heptabase Workbench 和 3 套组合原型；截至 2026-08-10 仍未授权修改生产 UI。

当前**不要求选择**票据、接力结或落印；这些早期命题不再构成组合原型或任务 2 的阻塞门。

决策更新：2026-08-08，用户认为静态出图不利于指出具体交互问题，确认改用 **HTML-first**。[`UI Interaction Lab v0.1 小任务书`](../../tasks/ui-interaction-lab-v0.1.md) 随后完成了参考状态、桌面 / 移动交互与真实浏览器验证；此前的静态方向只作为历史情绪参考。

## 权威顺序

1. 产品不变量与架构合同
2. [`docs/product/design-guidelines.md`](../../product/design-guidelines.md) 中已经批准的设计规则
3. 本目录中标记为 `candidate` 的研究与提案
4. 当前实现与探索性原型

候选规则只有在用户审核后，才会合并进正式设计规范。这样可以避免长期维护两份互相冲突的“设计宪法”。

## 当前文件

- [`nine-workbench-study-report-v0.1.md`](./nine-workbench-study-report-v0.1.md)：candidate；九项工作台的五类场景、Agent 参与谱系、六层通用骨架、差异机制与场景查表。本报告不选择新 frozen reference，也不授权制作原型。
- [`reference-workbench-mechanism-matrix-v0.1.md`](./reference-workbench-mechanism-matrix-v0.1.md)：candidate；九项工作台的页面中心所有者、连续性、人工介入与结果写回机制矩阵。
- 九份工作台单项研究卡：[`Basecamp`](./basecamp-workbench-study-v0.1.md)、[`Things`](./things-workbench-study-v0.1.md)、[`Linear`](./linear-workbench-study-v0.1.md)、[`HEY Calendar`](./hey-calendar-workbench-study-v0.1.md)、[`Microsoft Agent Feed`](./agent-feed-workbench-study-v0.1.md)、[`Heptabase`](./heptabase-workbench-study-v0.1.md)、[`AnythingLLM / Open Computer`](./anythingllm-workbench-study-v0.1.md)、[`Orca`](./orca-workbench-study-v0.1.md)、[`Plane`](./plane-workbench-study-v0.1.md)。
- [`taste-contract-v0.1.md`](./taste-contract-v0.1.md)：候选的品味合同、反 AI 味硬规则与验收量表。
- [`reference-board-v0.1.md`](./reference-board-v0.1.md)：18 个参考/反参考、Take/Refuse 判断与 5 个设计锚点。
- [`reference-interaction-audit-method-v0.1.md`](./reference-interaction-audit-method-v0.1.md)：统一的对象、点击、状态路径、恢复、证据与 Chat 转译模板。
- [`basecamp-interaction-audit-v0.1.md`](./basecamp-interaction-audit-v0.1.md)：Project room、tool view、item detail 与返回连续性；已通过。
- [`things-today-interaction-audit-v0.1.md`](./things-today-interaction-audit-v0.1.md)：长期 Project 与个人 Today 两条正交轴。
- [`linear-interaction-audit-v0.1.md`](./linear-interaction-audit-v0.1.md)：List / Peek / Project Update 三档阅读速度。
- [`hey-calendar-interaction-audit-v0.1.md`](./hey-calendar-interaction-audit-v0.1.md)：Day / Week / Year 的连续时间尺度。
- [`heptabase-interaction-audit-v0.1.md`](./heptabase-interaction-audit-v0.1.md)：Card identity、Whiteboard placement 与上下文工作台。
- [`microsoft-agent-feed-interaction-audit-v0.1.md`](./microsoft-agent-feed-interaction-audit-v0.1.md)：类型化监督任务与 preview / 权限边界。

## 状态标记

- `candidate`：正在讨论，不能直接当作实现要求。
- `approved`：用户已确认，可提炼后合并进正式规范。
- `rejected`：明确不采用，但保留判断理由，避免以后重复试错。
- `superseded`：已被新版研究替代。

## 参考与版权

1. 外部材料优先使用产品官方页面，并标记为 `external-reference / link-only`。
2. 仓库不复制或内嵌外部界面截图、字体、图标、插画或品牌素材；参考板只提供站外链接，来源页才是权威证据。
3. 参考的目标是抽取结构、节奏、行为与边界，不是复刻像素。
4. `docs/design/screenshots/` 是 Chat 自有原型与 QA 证据，标记为 `own-work`；它与外部参考分开管理。
5. 如果以后必须保存外部截图，需要先确认许可证或仅在不公开的研究环境中使用，并补充来源、日期和用途。

## 审核流程

1. UL0 已于 2026-08-08 整体通过；Take / Adapt / Refuse 作为 UI Lab 的批准输入。
2. UL1、6 个参考原型与 6 × 7 事实矩阵已经完成；冻结实现分别按登记册中的 branch / commit 恢复。
3. Heptabase Workbench 与 3 套 literal-reference ownership 组合已通过自动化、真实浏览器、响应式、控制台、状态连续性和同屏视觉 QA；Heptabase 与 literal combination freeze 均已登记。
4. 下一任务只能把上述 freeze 当作设计输入；是否改生产 UI、怎样进入正式对象 / 权限 / Product Store 合同，必须由任务 2 自己的授权和任务书决定。
