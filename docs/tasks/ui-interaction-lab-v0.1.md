---
status: approved
version: 0.1
date: 2026-08-08
owner: Chat product design
task_type: frontend interaction prototype
implementation_status: ul1-ready-for-review
---

# UI Interaction Lab v0.1 小任务书

## 0. 已确认的设计决定

2026-08-08，用户确认下一轮采用 **HTML-first**：先把参考产品中值得借鉴的 UI 与交互做成可运行、可标注的浏览器实验，再从实验中收敛 Chat 的正式原型。

本决定替代“先从 3 张静态视觉方向图中选 1 张”的审核方式。静态图片只保留为情绪和构图参考，不再作为实现的唯一视觉源；HTML 实验才是后续交互讨论的主要证据。

这不是授权修改生产 UI。本任务书通过后，下面每个实现任务仍应使用独立 worktree、分支和 PR。

## 1. 先回答：这次到底做什么

建立一个与 `apps/web` 隔离的 **UI / Interaction Lab**。它用相同的项目、Work、Agent、Decision、Run 和 Artifact 模拟数据，呈现 5 个核心场景、3 个主题预设和桌面/移动两种布局。

用户可以直接在浏览器中：

1. 比较 Project、Today、Peek、Agent Activity 和 Workbench 的结构与交互。
2. 对具体元素、状态和转场进行标注，而不是抽象讨论“高级感”或“AI 味”。
3. 判断哪些参考模式适合 Chat、哪些应该拒绝。
4. 在不触碰生产状态机和真实后端的前提下，先冻结 UI 与交互合同。

## 2. 交付结果

UI Lab v0.1 完成后应提供：

1. 一个本地可运行、可直接刷新和深链接的 HTML 原型入口。
2. 5 个场景：`Project Room`、`Today`、`Peek / Decision`、`Agent Activity`、`Workbench`。
3. 3 个主题预设：`Thread Light`、`Paper`、`Graphite Dark`。
4. 桌面 `1440×900`、移动 `390×844` 与最低 `375px` 三个验证视口。
5. 统一的真实感中文 fixture，保证同一对象跨场景不改名、不换身份、不改变状态含义。
6. 可通过 URL 指定场景、主题和关键状态，便于用户标注与复现。
7. 自有截图、关键交互短录屏和验收记录；外部产品截图不进入 Git，除非许可证明确允许。

## 3. 参考产品如何组合

参考按职责组合，不按外观拼贴；任何区域都不能成为“换 Logo 的参考产品”。

| Chat 设计问题 | 主参考 | 只吸收 | 明确拒绝 |
|---|---|---|---|
| Project 如何成为长期地点 | Basecamp Home / Project Page | 稳定房间、共享语境、对象按职责聚合；Project room → tool view → item detail → back 的连续路径 | 六宫格首页、品牌插画与语气复刻 |
| Today 如何形成有限承诺 | Things Today | Today / This Evening 节奏、渐进信息 | 把所有工作都变成待办、复制黄色星标 |
| 时间如何成为连续约束 | HEY Calendar | 连续时间叙事、事件长度和时间边界 | 手机照搬桌面横轴、趣味压过扫描效率 |
| 详情如何不打断当前工作 | Linear Peek | 原位展开、上下文保留、关闭后返回原焦点 | 通用详情抽屉、所有内容都 Peek |
| 项目变化如何成为可信叙事 | Linear Project Updates | 作者、时间、变化、健康与下一步 | 只靠红黄绿、自动摘要冒充人类承诺 |
| 同一对象如何进入空间视图 | Heptabase | 同一对象的列表/画布/详情多视图 | 无限画布作为默认入口、复制对象 |
| 多 Agent 如何被监督 | Microsoft Agent Feed | Needs Attention / Completed 分流、可回到具体工作 | 事件刷屏、Feed 拥有产品事实、互动量排序 |
| 全局壳层如何克制而有辨识度 | Threads | 黑白骨架、轻量内容流、清楚的列与切换 | 社交指标、成瘾 Feed、照搬品牌细节 |
| 主题如何可扩展 | Obsidian / Bear | 语义稳定、外观可替换、整套界面协调变化 | 主题改变状态语义、插件化视觉失控 |
| 次级动作如何可发现 | Raycast | 主动作直接可见、次级动作集中、键盘提示 | 把高影响动作只藏在命令面板 |

## 4. 五个场景

### 4.1 Project Room

**主问题**：这个项目现在在哪里，我下一步需要关心什么？

必须出现：

1. 项目目标、阶段和最近一次可信更新。
2. 当前 Work、需要介入、正式产物和参与 Agent。
3. 从 Project room 进入 Workbench、Conversation、Artifact 或具体 Work 后，仍保留项目归属和可预测的返回路径。
4. 至少演示一次 `Project room → tool view → item detail → back`，验证同一个 Project 外壳不因工具切换而消失。

主要参考：Basecamp Home / Project Page、Linear Project Updates。

不得出现：统计仪表盘、等权卡片墙、虚构完成百分比。

### 4.2 Today

**主问题**：今天真正需要我承诺、决定或看护什么？

必须出现：

1. 时间约束与 Today / This Evening 节奏。
2. 人的待办、等待决定、正在运行和阻塞事项。
3. “设为今天”和“移到今晚”等直接但可撤销的整理反馈。

主要参考：Things Today、HEY Calendar。

不得出现：全产品摘要、模块拼盘、为了热闹而展示普通 Agent 事件。

### 4.3 Peek / Decision

**主问题**：我正在看什么版本，批准后会发生什么？

必须出现：

1. 从 Today、Project 或 Agent Activity 原位打开同一个 Work。
2. Plan Candidate、revision、采用来源、风险和明确主动作。
3. `等待决定 → 正在提交请求 → 决定已记录 → 后台恢复中` 的可辨状态。
4. 关闭后恢复触发元素焦点、滚动位置和原页面上下文。

主要参考：Linear Peek、Raycast Action Panel。

不得出现：点击批准后直接显示执行中、抽屉关闭后跳回首页、隐藏高影响主动作。

### 4.4 Agent Activity

**主问题**：哪些 Agent 变化需要我介入，哪些只需要回顾？

必须出现：

1. `Needs Attention`、`Running`、`Completed` 的清楚分流。
2. 每条动态回答谁、在哪个 Project / Work、发生了什么、用户能做什么。
3. 同一 Work 的连续事件折叠为一段叙事，并能下钻证据。
4. `failed` 与 `outcome_unknown` 使用不同文案和处置入口。

主要参考：Microsoft Agent Feed、Linear Project Updates、Threads。

不得出现：点赞、热门、互动量排序、逐条直播低层 Runtime 事件。

### 4.5 Workbench

**主问题**：当前工作中的对象有什么关系，我应当在哪里继续？

必须出现：

1. 同一个 Work / Artifact 在列表、画布和 Peek 中保持同一身份。
2. 只有关系确实重要时才进入空间视图。
3. 从会话票据进入 Workbench、查看运行证据、返回原对话的连续路径。
4. 移动端把空间关系改写为可阅读的顺序关系，不压缩成迷你画布。

主要参考：Heptabase、Basecamp、Linear Peek。

不得出现：所有任务默认无限画布、拖拽产生对象副本、装饰性连线。

## 5. 共用模拟数据

所有场景固定使用同一组内容，避免因为换了“更好看的示例”而掩盖结构问题。

| 对象 | 固定内容 |
|---|---|
| Project | `Chat · 长期上下文与知识复用` |
| 当前 Work | `定义 Agent 动态首版交互` |
| 负责人 Agent | `阿橘 · 项目推进` |
| 协作 Agent | `墨尺 · 证据核验` |
| Plan Candidate | `Agent Activity 交互方案 v3` |
| 待决定事项 | `批准 v3，并进入 HTML 原型验证` |
| 当前 Run | `交互合同验证` |
| Artifact Candidate | `Agent Activity 行为清单` |
| 正式 Artifact | `UI Lab v0.1 小任务书` |

fixture 必须覆盖：正常、等待决定、运行中、失败、结果未知和正式提交 6 类事实。它们只能驱动 UI，不得冒充当前生产能力或真实服务结果。

## 6. 跨场景交互合同

以下规则比单个页面的视觉更优先：

1. **对象连续**：同一个 Project、Work、Decision、Run、Agent 或 Artifact 在所有场景保持名称、身份标记和状态语义。
2. **一次一个主动作**：每个场景只突出 1 个主动作；其余进入局部菜单或 Action Panel。
3. **Peek 不夺走位置**：打开时保留背景上下文；关闭后恢复触发元素焦点和滚动位置。
4. **返回可预测**：深链接、浏览器返回和移动端返回都回到进入前的场景与状态。
5. **状态不抢导航**：后台更新可以改变局部状态和提醒数量，不得自动切换标签、打开 Peek 或抢焦点。
6. **事实分层**：Draft、Candidate、Decision、Running、Validation、Formal 必须在文字、结构与动作上可区分。
7. **动态只是投影**：Agent Activity 只能聚合 Project、Work、Run、Decision 和 Artifact 事实，不能创造新事实。
8. **移动端重排而非缩小**：桌面的并列关系在手机上变成有返回路径的顺序关系。
9. **键盘优先但不排斥鼠标**：主动作直接可见；次级动作可通过按钮与 `⌘/Ctrl + K` 发现。
10. **异常保持诚实**：失败、结果未知和后台恢复中不得合并为同一种“出错”或“处理中”。

## 7. 主题架构

### 7.1 三个首轮预设

| 主题 | 目的 | 约束 |
|---|---|---|
| `Thread Light` | 产品默认方向；验证黑白骨架、留白和内容流 | 近黑/纸白、高对比、0 渐变 |
| `Paper` | 验证温暖笔记感是否能增加亲和力 | 只改变外观 Token，不增加拟物纹理 |
| `Graphite Dark` | 验证深色长时间工作与 Agent 身份色 | 真黑/石墨分层、0 发光阴影 |

### 7.2 不允许被主题修改

1. Candidate、Decision、Running、Failed、Formal 等状态含义。
2. 成功、警告、失败与 Agent 身份色的职责边界。
3. 页面结构、操作顺序、焦点逻辑和最小触控范围。
4. 对比度、减少动态、200% 缩放与键盘要求。

### 7.3 Token 分层

1. `semantic`：背景、文字、结构、状态、焦点和 Agent 身份语义。
2. `theme`：为语义 Token 提供每套主题的值。
3. `component`：只消费语义 Token，不直接读取主题名称或硬编码色值。

首轮不开放社区主题、主题商店和自由 CSS。UI Lab 只验证架构是否允许未来扩展。

## 8. 原型技术边界

UI Lab 放在 `docs/design/ui-lab/`，不放进 `apps/web` 的生产路由。使用多文件 HTML、CSS 和 JavaScript 模块，由仓库现有 Vite 工具启动，不新增生产依赖。

建议结构：

```text
docs/design/ui-lab/
  index.html
  styles/
    tokens.css
    themes.css
    base.css
    components.css
  src/
    app.js
    router.js
    fixtures.js
    scenes/
    interactions/
```

约束：

1. 不复制当前 2654 行单体原型；结构、样式、fixture 和交互分文件维护。
2. 不修改后端、Domain、Workflow、Product Store 或真实网络合同。
3. 不引入新的 UI 框架、状态管理库、图标库或动画库。
4. 可复用正式设计 Token 的命名和数字，但不得直接依赖生产组件。
5. 所有关键状态可由 URL 重现，例如：

```text
?scene=peek&theme=paper&state=decision-pending
```

6. 主题选择和面板宽度可以写入 `localStorage`，但只能作为界面偏好，不是产品事实。
7. 关键区域使用稳定的 `data-annotation-id`，便于把用户标注定位到场景、对象和状态。

## 9. 实现拆分

在原型实现前增加 `UL0`，先把参考从视觉索引升级为交互证据。整个 UI Lab 拆成 4 个可独立审核的任务：

### UL0 · 锚点产品交互审计

**用户结果**：可以基于真实 UI、完整点击路径和设计理由审核参考，不再从单张营销截图猜交互。

**范围**：Basecamp 先做样板；Things、Linear、Heptabase、HEY Calendar 和 Microsoft Agent Feed 使用同一模板补齐至少 1 条完整路径和 1 条恢复/例外路径。

**完成门**：满足[参考产品交互审计方法](../design/references/reference-interaction-audit-method-v0.1.md)；每个关键判断区分 `Observed / Documented / Inferred / Chat hypothesis`；输出仓库外可标注参考页。

**当前结果（2026-08-08）**：6 个锚点产品均已按同一模板形成深审计与仓库外交互页：

1. [Basecamp Home / Project](../design/references/basecamp-interaction-audit-v0.1.md) — 用户已通过。
2. [Things Today](../design/references/things-today-interaction-audit-v0.1.md) — 已通过。
3. [Linear Peek + Project Updates](../design/references/linear-interaction-audit-v0.1.md) — 已通过。
4. [HEY Calendar](../design/references/hey-calendar-interaction-audit-v0.1.md) — 已通过。
5. [Heptabase Workbench](../design/references/heptabase-interaction-audit-v0.1.md) — 已通过。
6. [Microsoft Agent Feed](../design/references/microsoft-agent-feed-interaction-audit-v0.1.md) — 已通过；官方当前仍标记 preview。

审核记录：2026-08-08，用户明确回复“UL0 通过”。UL0 关闭，授权进入 UL1；不自动授权 UL2、UL3 或生产 UI 修改。

### UL1 · Lab 骨架、主题、Project 与 Today

**用户结果**：可以在同一壳层中比较 Project 和 Today，并切换 3 个主题与桌面/移动布局。

**不做**：Peek、Agent Activity、Workbench 和复杂状态转场。

**完成门**：两个场景可深链接；同一 fixture 身份连续；375px 无横向滚动；三主题无硬编码组件色值。

**当前结果（2026-08-08）**：已完成，等待 Gate B 用户结构审核。实现位于 [`docs/design/ui-lab/`](../design/ui-lab/)，Design QA 见 [`design-qa.md`](../design/ui-lab/design-qa.md)。已验证：

1. `Project Room` 与 `Today` 可通过 URL 深链接并刷新恢复。
2. `Thread Light / Paper / Graphite Dark` 共用结构与语义 Token。
3. Project Overview → Work → Work detail → 浏览器返回路径成立。
4. Today 的时间约束、白天、今晚分层成立；“移到今晚 → 撤销”可复现。
5. `1440×900`、`390×844` 与约 `375px` 无页面级横向溢出，移动端可见控件最小高度 44px。
6. 本轮没有实现 UL2 的 Peek / Decision / Agent Activity，也没有修改生产 UI。

### UL2 · Peek / Decision 与 Agent Activity

**用户结果**：可以标注原位详情、计划审核、控制权交接和 Agent 监督分流。

**不做**：真实 Command、SSE、Workflow Resume 和通知。

**完成门**：焦点恢复；浏览器返回可预测；6 类事实状态可辨；后台状态变化不抢焦点或切换页面。

### UL3 · Workbench、连续路径与原型 QA

**用户结果**：可以从 Today / Project / Activity 进入同一个 Workbench 对象，再返回原位置；桌面空间关系在手机上成为可读顺序。

**不做**：正式白板编辑器、多人实时协作、持久化对象或生产组件迁移。

**完成门**：完成跨场景路径；键盘、375px、390px、200% 缩放、reduced motion 和主题检查；输出自有截图与关键交互短录屏。

## 10. 验收标准

### 10.1 交互

1. 5 个场景的直接 URL、刷新和浏览器返回都能恢复同一状态。
2. Peek 打开和关闭不丢失背景滚动位置，关闭后焦点回到触发元素。
3. 主动作可见；次级动作可通过鼠标和键盘发现。
4. 后台 fixture 更新不自动切场景、不打开浮层、不抢焦点。
5. `Decision recorded`、`resuming`、`running`、`failed`、`outcome unknown`、`formal` 不得共用模糊完成样式。

### 10.2 视觉与主题

1. 三主题使用同一组件结构和语义 Token。
2. 0 渐变、0 发光表面、0 重阴影、0 默认 Sparkle / Robot / Magic Wand 图标。
3. 一个常规视口不超过 3 个明显信息层级；超过 5 个同级对象改用列表、时间线或空间分组。
4. Agent 身份色保持局部，且不与成功、警告、失败状态色混淆。
5. 去掉 Logo 后，原型不能被误认成 Linear、Things、Basecamp 或 Threads 的换皮版本。

### 10.3 响应式与可访问性

1. `1440×900`、`390×844` 和 `375px` 无内容遮挡或横向滚动。
2. 200% 缩放仍可完成 Project → Peek → Decision → 返回路径。
3. 所有交互键盘可达、焦点清楚；可点击热区至少 `44×44px`。
4. 正文对比度至少 4.5:1；状态使用文字 + 图标/形状 + 颜色。
5. `prefers-reduced-motion` 下取消非必要位移、缩放和脉冲。

### 10.4 产品事实

1. 原型清楚标记为 fixture，不暗示接入真实服务。
2. Candidate、Decision、Run、Validation 和正式 Artifact 的视觉与文案可辨。
3. Agent Activity 不显示 Runtime 私有 ID、隐藏推理或原始 Provider Payload。
4. 失败不能产生假成功；结果未知不能提供无条件“重试”假象。

## 11. 参考采集与用户介入的 3 个审核门

### Gate A · 参考交互审计（设计方负责）

设计方从官方站点或官方帮助中心为每个锚点产品采集足以证明 1 条完整路径和 1 条恢复/例外路径的真实状态，并记录页面职责、点击结果、返回逻辑、设计理由与 `Take / Adapt / Refuse`。用户不需要自行截图。截图只用于私下研究，不直接提交 Git。

状态：2026-08-08 **已通过**。6 个锚点产品均已形成深审计与仓库外交互页；用户已整体批准 UL0，当前进入 Gate B / UL1。

审计结果与批准记录见本任务书“UL0 · 锚点产品交互审计”及 [`docs/design/references/README.md`](../design/references/README.md)。

### Gate B · UL1 结构审核

用户只标注 3 件事：壳层是否舒服、信息密度是否合适、3 个主题中哪些值得保留。此时不讨论所有按钮和微文案。

状态：2026-08-08 **等待用户审核**。可运行入口为 `http://127.0.0.1:8100/`。

### Gate C · UL2 交互审核

用户实际操作 Peek、Decision 和 Agent Activity，标注哪里打断思路、哪里像传统后台、哪里仍有 AI 味。

### Gate D · UL3 收敛审核

用户完成一次 Project / Today → Peek → Workbench → 返回路径，确认保留、修改或删除的模式。通过后才把选定规则提炼进正式设计规范，并另开生产实现任务。

## 12. 本任务明确不做

1. 不接真实 API、Workflow、SSE、模型、日历或通知。
2. 不把 UI Lab 组件直接移动进生产应用。
3. 不建立完整组件库、主题商店、插件 API 或社区主题系统。
4. 不做成熟白板编辑器、Workflow 图编辑器、项目管理全功能和多人协作。
5. 不逐像素复刻参考产品，不复制其品牌资产、图标、字体、插画或识别性动效。
6. 不要求用户在 HTML 可操作之前批准抽象的圆角、色值或“个性强度”数字。

## 13. 任务书审核出口

批准本任务书只意味着：使用已完成的 Gate A 参考包，为 UL1 单独创建实现 worktree、分支和 PR；不自动授权 UL2、UL3 或生产 UI 修改。
