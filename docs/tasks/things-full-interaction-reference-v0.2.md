---
status: approved
version: 0.2
date: 2026-08-09
owner: Chat product design
task_type: reference-study prototype
branch: codex/things-today-reference-qa
---

# Things 完整交互参考实现 v0.2

## 1. 用户结果

用户可以把这个参考原型当成一个可操作的 Things macOS 行为样本，而不只是 Today 的静态高保真截图：侧栏中的 6 个系统列表、Area、Project、Heading、任务详情、日期、Deadline、Tags、Move、Quick Find 和新建入口均能得到符合 Things 心智模型的前端反馈。

本任务只验证 UI 与交互逻辑，数据保存在页面内存中；不接 Things、Chat 后端、同步、账号、通知或系统日历。

## 2. v0.1 为什么不够

v0.1 的批准范围只覆盖 `Today → To-do detail → When → complete/reschedule`。因此它保留了 4 类明显缺口：

1. Inbox、Upcoming、Anytime、Someday、Logbook 被错误地套用通用 Project 页面。
2. Move 错误复用了 When 弹层。
3. Tags、Deadline、New List、Settings、Project/Heading menus、Continue Search 等按钮没有行为。
4. 部分示例 Project 行没有稳定对象身份，点击无法打开同一个 To-do。

v0.2 不是扩大到 Things 的所有系统能力，而是补齐当前原型里已经呈现、且用户会自然尝试的完整桌面交互面。

## 3. 官方依据

| 范围 | 已确认的 Things 行为 | 官方依据 |
|---|---|---|
| 六个系统列表 | Inbox 是暂存区；Today 是今日注意力投影；Upcoming 按未来日期；Anytime 是当前可行动项；Someday 是非活跃项；Logbook 是完成/取消归档 | https://culturedcode.com/things/support/articles/4001304/ |
| When / Deadline | start date 决定何时进入注意力；Deadline 是独立硬期限；Clear 回到 Anytime | https://culturedcode.com/things/support/articles/2803579/ |
| Move | 底栏箭头打开独立 Move dialog；目的地可为 Area、Project、Heading，也可搜索和创建 Project | https://culturedcode.com/things/support/articles/9651894/ |
| Tags | 任务、Project、Area 可带 Tag；列表顶部 Tag 可筛选；多 Tag 是 AND | https://culturedcode.com/things/support/articles/2803581/ |
| Quick Find | 直接键入即可导航；Continue Search 扩展到 Notes、Checklist、Logbook；可进入 Tomorrow、Deadlines、Repeating、All Projects、Logged Projects | https://culturedcode.com/things/support/articles/2803584/ |
| Project / Heading | Heading 只属于 Project；可新建、重命名、复制、移动、归档；移动 Heading 会带走其 To-do | https://culturedcode.com/things/support/articles/2803577/ |
| Area / Project | Project 是多步骤结果；Area 是长期责任域；Project 可处于 Anytime、Upcoming 或 Someday | https://culturedcode.com/things/support/articles/6378414/ |
| 多窗口 | 右上按钮打开 Today；按住 Option 时打开当前列表 | https://culturedcode.com/things/support/articles/2803580/ |

视觉依据继续使用已有 Today、To-do open、When、Quick Find 四张官方源图，并增加官方公开截图：

1. Upcoming: `https://culturedcode.com/frozen/2025/10/dates-upcoming.jpg`
2. Anytime: `https://culturedcode.com/frozen/2025/10/dates-anytime.jpg`
3. Someday: `https://culturedcode.com/frozen/2025/10/dates-someday.jpg`
4. Inbox: `https://culturedcode.com/frozen/2025/10/dates-inbox.jpg`
5. Project / Headings: `https://static.culturedcode.com/things/videos/2017-05-18-website-videos/4-headings-mac.png`

## 4. 对象与不变量

```text
Area
└── Project
    ├── Heading
    └── To-do

To-do
├── parent: Area | Project | null
├── heading: optional; only valid inside its parent Project
├── isInbox: independent capture state
├── start: anytime | someday | on-date
├── startDate / evening: optional scheduling details
├── deadline: optional date
├── tags: zero or more
├── status: open | completed | canceled
└── isLogged: independent archive state
```

必须保持：

1. 同一 To-do 可同时出现在 parent context 和多个派生的时间列表，但只有一个对象身份。
2. Today、Upcoming、Anytime、Someday 是由 start、deadline 与 repeat 推导的投影，不是互斥的单值位置；Today 项也可在 Anytime 出现，只有未来 start date 与 Someday 会退出 Anytime。
3. When 只改 start/startDate/evening；Move 只改 parent/heading；Deadline 独立。
4. 从 Today 改到 Tomorrow、Someday 或 Anytime 不能把任务伪造成 completed。
5. status 与 isLogged 分离。本原型默认“完成后立即记入 Logbook”，这是为了缩短验证路径的明确简化；Undo 恢复快照，Logbook 的 Reopen 恢复为 open。
6. Project 同样拥有 start、deadline、tags、status/isLogged；Area 只拥有 tags，不拥有 When 或 Deadline。
7. 每个模拟写操作都给出原位变化、弹层关闭和可读状态反馈。

## 5. 页面与交互矩阵

### 5.1 系统列表

| 页面 | 内容结构 | 必须可操作 |
|---|---|---|
| Inbox | 未整理 To-do；移出后显示临时 moved-out 区 | 打开、编辑、When、Move、Tags、Deadline、完成、清除 moved-out 提示、新建 Inbox To-do |
| Today | Calendar、daytime、This Evening | 原位详情、When、完成、Undo、新建、切换今晚/今天/未来 |
| Upcoming | 按日期分区，混合 calendar events 与未来 To-do | 打开任务、改期后移动分区、新建到 Tomorrow、筛选 Tags |
| Anytime | loose items 在前，随后按 Area/Project 分组；Today 项带星 | 打开任务、进入父列表、Tag 筛选、Show more、改到 Today/Someday |
| Someday | 按 Area 分组的非活跃 To-do 与 Project | 打开任务/Project、改为 Anytime/日期、筛选 Tags |
| Logbook | 按完成日期分组的 logged completed/canceled 项 | 打开归档视觉详情、Reopen、区分 completed/canceled、筛选 Tags |

### 5.2 Area、Project 与 Heading

1. Area 显示直接 To-do、Projects、Later items，并可进入 Project。
2. Project 显示 notes、Tag filter、Headings、loose To-do 与进度。
3. Project 所有示例行都必须有稳定 id，点击打开同一个详情对象。
4. Project menu 至少支持 Add Tags、When、Deadline、Move、Duplicate、Complete/Cancel。
5. Heading menu 至少支持 Rename、New To-do、Duplicate、Move、Convert to Project、Archive；Archive 后进入原 Project 底部 logged headings。
6. `New List` 打开类型选择，可创建 Project 或 Area；新对象立即进入侧栏并可打开。

### 5.3 To-do detail

1. Title 与 Notes 可编辑并在关闭后保留。
2. Checklist 可勾选、添加和删除；状态在重新打开后保留。
3. When 打开独立日期弹层，支持 Today、This Evening、Tomorrow、Someday、Clear 与自然语言候选。
4. Tags 打开 tag picker，可添加、删除、新建 Tag；列表过滤随数据更新。
5. Deadline 打开独立日期弹层，可选日期、自然语言和 Clear；不能复用 When 的状态语义。
6. Close、Complete、Cancel 与 Undo 都有明确结果。

### 5.4 底栏与全局入口

1. `+` 根据当前页面创建：Inbox→Inbox，Today→Today，Anytime→Anytime，Someday→Someday，Area/Project→当前 parent。Upcoming→Tomorrow 与 Logbook→Inbox 是原型等价约定，提交后必须明确显示目标，不能冒充已证实的原生默认行为。
2. Calendar 只在有选中 To-do 时打开 When；无选择时给出上下文提示。
3. Move 只在有选择时打开独立 Move dialog；无选择时给出上下文提示。
4. Quick Find 搜索 built-in list、Area、Project、Heading、Tag、To-do；Continue Search 扩到 Notes、Checklist、Logbook。
5. 右上角按钮普通点击打开 Today；Option-click 打开当前列表。若浏览器阻止弹窗，必须给出明确反馈。
6. Settings 打开设置浮层；至少让 Calendar 显示与 Today 分组方式产生可见变化。

### 5.5 快速查找隐藏列表

Quick Find 可进入并正确渲染：Tomorrow、Deadlines、Repeating、All Projects、Logged Projects 与 Settings。Tag 结果进入独立 Tag list 并按 parent 分组；这些入口不加入侧栏。

## 6. 状态与可访问性

所有可见控件必须覆盖 default、hover、focus、pressed/open、selected、empty 和 success feedback；不可用控件使用真正的 `disabled` 与解释，不保留静默点击。

键盘路径至少包括：直接键入打开 Quick Find、`Cmd/Ctrl+F`、Escape 逐层关闭弹层、Enter 提交新任务/筛选结果、Tab 可达所有控件。图标按钮必须有可访问名称，弹层使用 `role=dialog`，状态提示使用克制的 `aria-live`。

## 7. 明确不做

1. 不接真实 Things/Chat 数据、云同步、账号、通知、Calendar 权限或系统级 Reminder。
2. 不复制 Things 数据库、私有 API 或专有动画实现。
3. 不把本原型直接变成 Chat 正式 UI。
4. 本轮优先完整点击与键盘路径；原生级多选、跨窗口拖放和触控 Magic Plus 手势只保留等价可点击入口，不冒充已完整模拟。

## 8. 完成门

1. 对当前页面全部 `button/input` 建立清单，静默 no-op 数量必须为 `0`。
2. 至少验证 Inbox、Today、Upcoming、Anytime、Someday、Logbook、Area、Project、Task detail、Move、Tags、Deadline、Quick Find 12 类状态。
3. 对官方源图完成同尺寸 Design QA；保持已通过的 Today 视觉，不因新增交互回退。
4. 浏览器 E2E 覆盖：新建→Move→When→Tags→Deadline→筛选→完成→Logbook→恢复，以及 6 个系统列表和 5 个 Quick Find 隐藏列表。
5. 控制台错误为 0；`npm run build`、`npm run test:sites` 与新增交互测试全部通过。
6. `design-qa.md` 更新后最终结果必须为 `passed`。
