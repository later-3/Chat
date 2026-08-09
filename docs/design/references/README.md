# Chat 设计参考区与原型总入口

这里是换 Session、换 Agent 后恢复参考研究、冻结原型与组合策略的**唯一登记入口**。它记录“为什么这样设计”、精确分支 / commit / worktree、可运行路径和 QA；任何参考结论都不自动改变生产 UI 或产品事实合同。

## 参考原型登记册

更新日期：2026-08-10。跨分支文件必须按表中 branch / commit 读取，或使用 `git show <commit>:<path>`；不能因为当前工作树没有某个目录就误判为未完成。

| 参考原型 | 事实场景主责 | 冻结状态与本轮 QA | 精确实现位置 | Take / Adapt / Refuse |
|---|---|---|---|---|
| Basecamp | 多 Project、Project room、事务 / 资料 / Update 的地点感与返回连续性 | frozen；`21/21`、console `0`；本轮复核发现复用阻断 `1 P1 + 1 P2` | branch `codex/basecamp-full-interaction-v0.2` · commit `13656c41f0407e24d94a2f174a71525f21c2fc9c` · worktree `/Users/xulater/Code/Chat-basecamp-reference-v02` · `docs/design/reference-implementations/basecamp` | Take 房间与返回；Adapt Project 对象层；Refuse 工具列表成为事实模型 |
| Things | 长期 Project 与个人 Today 的正交投影；工作、生活、爱好共存 | frozen desktop scope；`21/21`、console `0`；组合复用阻断 `1 P1 + 1 P2` | branch `codex/things-today-reference-qa` · commit `2b431c0942b7747e4c56210ada148e37684f109d` · worktree `/Users/xulater/Code/Chat-things-today-reference-qa` · `docs/design/reference-implementations/things-today` | Take Today × parent context；Adapt 原生移动层级；Refuse 所有对象 checkbox 化 |
| Linear | List / Peek / Detail 三档阅读与负责人 Update | frozen；`14/14`、desktop / mobile console `0`；复用阻断 `1 P2` | branch `codex/linear-reference-v0.1` · commit `a74e088c0f7f1d04c653ae0a18c2487e0dff3879` · worktree `/Users/xulater/Code/Chat-linear-reference-v01` · `docs/design/reference-implementations/linear` | Take 渐进披露；Adapt Update 与 observed change；Refuse Issue 充当全部对象 |
| HEY Calendar | Day / Week / Year 连续时间尺度与 source → candidate → conflict → commit | frozen / QA passed；`15/15`、desktop / mobile console `0`；`P0/P1/P2 = 0` | branch `codex/hey-calendar-reference-v0.1` · commit `87596d433e120fa09c85484bd8591c1c6a4fdd30` · worktree `/Users/xulater/Code/Chat-hey-calendar-reference-v01` · `docs/design/reference-implementations/hey-calendar` | Take 时间尺度与候选；Adapt Today 约束；Refuse Calendar 拥有 Project |
| Microsoft Agent Feed | 多 Agent 类型化监督、人工介入、异常与 related record | frozen implementation / QA reopened；`19/19`、console `0`；当前 `2 P1 + 4 P2`，不得直接复用移动 grid 或通用 Undo | branch `codex/microsoft-agent-feed-reference-v0.1` · commit `eed0aa0e4b9fec38fcf7e4eb6684a23e9897e8aa` · worktree `/Users/xulater/Code/Chat-agent-feed-reference-v01` · `docs/design/reference-implementations/microsoft-agent-feed` | Take 风险优先 typed supervision；Adapt 权威对象返回；Refuse Feed 成为事实源、盲目 Retry / Undo |
| Heptabase Workbench | canonical Card identity、Whiteboard placement、显式 AI context、资料编排复用 | freeze pending；模型 / UI 合同 `15/15` + Sites `4/4` + IAB browser E2E gates `9/9` = `28/28`；desktop / mobile console `0`；`P0/P1/P2 = 0` | branch `codex/reference-prototype-combinations` · commit `FREEZE_COMMIT_PENDING` · worktree `/Users/xulater/.codex/worktrees/b469/Chat` · `docs/design/reference-implementations/heptabase` · 本轮运行 `http://127.0.0.1:4175/` | Take identity × placement、context panel；Adapt 移动 Section outline、board-scoped permission；Refuse Canvas 默认首页、位置自动成为领域关系 |

完整 6 × 7 事实结论、已知 P1/P2 和引用证据统一见 [`reference-scenario-matrix-v0.1.md`](./reference-scenario-matrix-v0.1.md)。Heptabase 当前一手资料与 Take / Adapt / Refuse 见 [`heptabase-interaction-audit-v0.1.md`](./heptabase-interaction-audit-v0.1.md)。

## 组合策略与可运行原型

矩阵按“用户此刻要回答的问题”和注意力强度推导出最小且有区分度的 **3 套**，不是把 6 个参考产品拼成 6 个区块：

| 组合模式 | 主问题 | 采用的参考语法 | 明确拒绝 | 本轮体验 URL |
|---|---|---|---|---|
| Project Room | 长期 Project 现在处于哪里，下一段 Work / Scope / Action、Update 与 Evidence 怎样推进 | Basecamp room / return + Linear list / detail / Update + Heptabase stable Resource identity | 六宫格全局骨架、Issue 万能化、Canvas 默认首页、Today / Feed 侵入项目叙事 | `http://127.0.0.1:4176/?mode=project&view=overview` |
| Today Rhythm | 今天真正关注什么，何时做，怎样不丢长期 Project 来源 | Things parent × Today + HEY 的时间约束和候选冲突 | 所有对象 checkbox 化、Calendar 拥有 Work、自动滚动无记录 | `http://127.0.0.1:4176/?mode=today&view=overview` |
| Evidence Workbench | 哪些 Agent 现在需要人，Decision / Candidate / Run 异常应如何处置 | Agent Feed typed supervision + Linear detail / return + Heptabase explicit context / provenance | 社交 Feed、Completed 大桶、正式决定 / 对账通用 Undo、`outcome_unknown` 普通 Retry | `http://127.0.0.1:4176/?mode=workbench&view=overview` |

为什么不是 2 或 4 套：2 套会让个人主动选择的 Today 与系统中断式 Agent 风险争抢同一默认入口，或让监督 Feed 侵入 Project room；4 套会把 Resource Workbench 从 Project Room 重复拆出，造成同一 Project / Resource / Evidence 的双导航和归属冲突。完整推导见矩阵第 7～9 节。

组合实现位于 `docs/design/combination-prototypes`，branch `codex/reference-prototype-combinations`，共同 freeze commit `FREEZE_COMMIT_PENDING`。自动化合同 `17/17` + Sites `4/4` = `21/21`；真实浏览器覆盖 6 个桌面 / 移动表面、10 条核心路径，`391 × 844` 横向溢出 `0`、未命名控件 `0`、小于 `44px` 的启用控件 `0`、console `0`，残余 `P0/P1/P2 = 0`。视觉证据见 [`../combination-prototypes/design-qa.md`](../combination-prototypes/design-qa.md)。

## 任务 2 稳定输入

- 任务：`019fe738-1b0d-70e3-932c-cdad3b702124`（“实现 Chat 多套可运行原型”）
- 任务 worktree：`/Users/xulater/.codex/worktrees/35f2/Chat`
- 稳定 branch：`codex/reference-prototype-combinations`
- freeze commit：`FREEZE_COMMIT_PENDING`
- 必读输入：本登记册、[`reference-scenario-matrix-v0.1.md`](./reference-scenario-matrix-v0.1.md)、[`../combination-prototypes/README.md`](../combination-prototypes/README.md)、[`../combination-prototypes/design-qa.md`](../combination-prototypes/design-qa.md)
- 稳定实现路径：`docs/design/reference-implementations/heptabase`、`docs/design/combination-prototypes`、`docs/design/screenshots/heptabase`、`docs/design/screenshots/combinations`
- 依赖规则：只复用冻结对象 / 交互 / token，不继承矩阵第 6.3 节列出的参考原型 P1/P2；不修改生产 UI，除非任务 2 获得单独授权。

## 本轮唯一决策入口

推荐工作假设：

1. **方向命题**：接受“安静的项目系统，鲜活的 Agent；严肃的事实，轻巧的交接”。
2. **五个锚点**：整体接受；只需指出是否有某一个明确不属于 Chat。

   - A. Project 是一个房间
   - B. 工作在空间间不断线
   - C. Today 是一天的节奏
   - D. 个性来自一个机制
   - E. AI 必须显露责任边界

`3/5` 只作为设计团队起步旋钮，不要求用户在看图前批准。下一轮会用实际画面比较“更安静 / 当前 / 更冒险”。如果上面两项都接受，回复“通过”即可；有修改时使用：

```text
结论：修改后通过 / 退回
命题：
明确反对的锚点：
```

这里的“通过”最初只授权我们基于命题与锚点制作 3 个视觉方向；Taste Contract 的详细规则继续保持 `candidate`，不会自动合并进正式规范，也不授权生产 UI 变更。

历史审核记录：2026-08-08，用户先回复“通过”，随后确认改用 HTML-first；同日用户明确回复“UL0 通过”，6 个锚点产品深审计整体获批。其后已经完成 UL1、6 个参考原型事实复核、Heptabase Workbench 和 3 套组合原型；截至 2026-08-10 仍未授权修改生产 UI。

现在**不要求选择**票据、接力结或落印。它们将在可操作的 HTML 场景中验证，届时再基于真实交互比较。

决策更新：2026-08-08，用户认为静态出图不利于指出具体交互问题，确认改用 **HTML-first**。下一设计门因此改为 [`UI Interaction Lab v0.1 小任务书`](../../tasks/ui-interaction-lab-v0.1.md)：先收集少量参考状态，再通过 5 个场景、3 个主题和桌面/移动交互进行标注。此前的静态方向只作为情绪参考，不再要求用户先选 A/B/C。

## 权威顺序

1. 产品不变量与架构合同
2. [`docs/product/design-guidelines.md`](../../product/design-guidelines.md) 中已经批准的设计规则
3. 本目录中标记为 `candidate` 的研究与提案
4. 当前实现与探索性原型

候选规则只有在用户审核后，才会合并进正式设计规范。这样可以避免长期维护两份互相冲突的“设计宪法”。

## 当前文件

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
3. Heptabase Workbench 与 3 套组合原型已通过自动化、真实浏览器、响应式、控制台和同屏视觉 QA；共同 freeze commit 在本任务最终提交后写回本入口。
4. 下一任务只能把上述 freeze 当作设计输入；是否改生产 UI、怎样进入正式对象 / 权限 / Product Store 合同，必须由任务 2 自己的授权和任务书决定。
