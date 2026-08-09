# Chat 设计参考区

这里保存 Chat 的视觉研究、参考证据与待审核的设计假设。它帮助我们讨论“为什么这样设计”，但不自动改变产品规范。

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

审核记录：2026-08-08，用户先回复“通过”，随后确认改用 HTML-first；同日用户明确回复“UL0 通过”，6 个锚点产品深审计整体获批。当前进入 UL1，只实现独立 UI Lab 的 Project Room、Today、三主题与响应式壳层；尚未授权修改生产 UI。

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
2. 当前进入 UL1，只实现 Lab 壳层、主题、Project 与 Today，不先写生产 UI。
3. 用户先审核 Project / Today 的结构与主题，再审核 Peek / Decision、Agent Activity 和 Workbench 的交互连续性。
4. HTML 原型通过品味合同、可访问性与产品事实完整性验收后，再考虑合并到实现规范。
