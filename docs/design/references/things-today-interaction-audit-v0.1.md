---
status: approved
version: 0.1
date: 2026-08-08
product: Things 3
surface: Today
evidence: official-support + official-product-screenshots
---

# Things Today 交互审计 v0.1

## 1. 结论

Things Today 值得借的不是黄色星标或极简清单，而是两套互不冲突的组织轴：

1. `Area → Project → To-do` 回答“这件事属于什么长期语境”。
2. `Inbox / Today / Upcoming / Anytime / Someday / Logbook` 回答“什么时候值得进入我的注意力”。

Today 不是新的工作容器，而是跨越所有 Area / Project 的个人时间投影。任务在 Today 中仍显示来源，完成、改期或进入详情都作用于同一个 To-do。这个模型与 Chat 的 `Project Room + 个人事务中心` 很匹配，但 Things 的单用户待办语义不能直接覆盖 Decision、Run、Blocker 和 Artifact。

## 2. 审计范围与用户目标

范围：Things 3 的 `Today → To-do detail → When / This Evening → complete or reschedule`，并补充 Quick Find 和 Upcoming 作为进入与退出路径。

用户目标：在一天开始时形成有限承诺；工作过程中不丢失任务的 Project 语境；未完成时可以诚实改期；晚上仍有一个存在但不打扰白天主序列的区域。

## 3. 对象与作用域

```text
Context axis
Area
└── Project
    ├── Heading
    └── To-do
        └── Checklist item

Attention axis
Inbox        capture, not yet organized
Today        start / deadline / repeat matches today
├── Calendar events (read-only mirror)
├── daytime to-dos
└── This Evening
Upcoming     future start date
Anytime      active and available now
Someday      intentionally inactive / unclear
Logbook      completed or canceled history
```

一个 To-do 同时拥有 `parent context` 与 `attention horizon`，但不是被复制两份。Today 行下方的 Project / Area 名称负责保留来源。

## 4. Today 页面职责

主问题：**在今天真实的时间约束下，我愿意承诺处理什么？**

页面从上到下形成 4 层节奏：

1. 标题与星标：明确当前是 Today 作用域。
2. Calendar events：先呈现不可压缩的外部时间约束。
3. Daytime to-dos：今天主动承诺的可执行事项，可人工排序。
4. This Evening：仍属于今天，但降低视觉权重并延后注意。

这不是 Dashboard。它不展示项目健康度、统计和完整未来，只展示会影响今天行动的内容。

## 5. 点击与操作地图

| # | 入口 / 操作 | 结果与反馈 | 证据 | 为什么这样设计 |
|---|---|---|---|---|
| 1 | Sidebar `Today` | 进入跨 Area / Project 的 Today 投影；显示今日数量 | `O+D` | 一键回到一天的主序列 |
| 2 | Calendar events | 在 Today 顶部显示 Apple Calendar 事件；事件为本机只读镜像 | `O+D` | 先让承诺服从真实时间约束；不把会议伪装成待办 |
| 3 | 点击 To-do 行 | To-do 原位展开为白色“纸面”，显示 Notes、Checklist、When、Tags、Deadline 等 | `O+D` | 详情渐进展开，同时保持列表位置和上下文 |
| 4 | 点击 Checkbox | To-do 状态变为 Completed；之后进入 Logbook 的时机受 Logging 偏好影响 | `O+D` | 完成反馈直接、局部，不需要单独详情页 |
| 5 | Project / Area 来源 | 通过 `Show in Project` 等动作回到父语境；精确的单击行为需实测 | `D+I` | Today 是投影，复杂处理仍应回到长期语境 |
| 6 | Deadline 标记 | 打开 Deadline 设置；Deadline 回答“最晚何时完成”，与 When/start date 分开 | `O+D` | 外部硬约束不能和个人计划日期混为一谈 |
| 7 | 拖拽 To-do | 改变 Today 内的人工执行顺序 | `D` | 顺序是用户当日计划，不需要额外优先级字段 |
| 8 | `This Evening` | 通过 When popover 或移动端手势分配；To-do 移到底部独立区域 | `O+D` | 保留晚间承诺，同时降低对白天注意力的竞争 |
| 9 | `+` / Magic Plus | 点击创建 To-do；移动端可拖到精确位置、Heading、Upcoming 日期或 Inbox | `O+D` | 一个可触摸机制同时承担创建和落点，个性来自行为而非装饰 |
| 10 | When / calendar button | 打开 Jump Start；可选 Today、This Evening、Someday、具体日期，Clear 后回到 Anytime | `O+D` | 把注意力日期作为一个连续决策，而不是多个分散按钮 |
| 11 | Natural language in When | 输入 `tomorrow`、`in 3 days` 等并即时得到日期候选 | `O+D` | 让计划动作保持在当前 To-do 附近，减少日历滚动成本 |
| 12 | Quick Find / 直接键入 | 即时搜索 To-do、Project、Area、Tag 或作为导航；Continue Search 扩到 Notes、Checklist、Logbook | `O+D` | 同一个轻量入口先服务快速跳转，再按需扩大搜索成本 |
| 13 | Upcoming / Anytime / Someday | 切换不同注意力范围；未来 start date 到期时自动进入 Today | `O+D` | 未到时机的内容退出视野，但不会消失 |
| 14 | Reschedule unfinished | 未完成事项通过 When 改到另一天、This Evening、Someday 或清除为 Anytime | `D` | 未完成不等于失败；用户明确重做承诺，而非保留虚假 Today |

## 6. 三条关键状态路径

### 6.1 从长期 Project 形成今日承诺

```text
Project / Anytime To-do
  → When
  → Today
  → Today list 显示同一个 To-do + parent subtitle
  → 拖拽确定当日顺序
```

值得借的是对象不移动所有权：Today 只增加时间投影，Project 仍然是它的父语境。

### 6.2 白天事项降到 This Evening

```text
Today To-do
  → When / swipe
  → This Evening
  → 从 daytime sequence 移到底部
  → 仍在 Today，但视觉权重降低
```

这是很少见的“同一天内软分层”：没有增加精确时间，也能表达“现在先别打扰我”。

### 6.3 未完成时重新承诺

```text
Today unfinished To-do
  → 打开 When
  → 明天 / 具体日期 / Anytime / Someday
  → 从 Today 离开
  → 到新 start date 时重新出现
```

Things 不用逾期红色长期惩罚用户的所有计划失误；它鼓励重新决定注意力日期。Deadline 仍独立保留硬约束。

## 7. UI 风格为什么成立

1. **大片空白不是“高级感”，而是有限承诺的反馈**：Today 内容越少，用户越能感到一天可完成。
2. **Calendar、daytime、evening 用垂直节奏而非卡片墙分层**：时间顺序能直接阅读。
3. **行本身极简，来源放在灰色副标题**：主动作清楚，同时保留 Project 语境。
4. **复杂字段只在 To-do 展开后出现**：Tags、Checklist、When 和 Deadline 不污染快速扫描。
5. **开始日期与 Deadline 使用不同入口和视觉**：个人计划与外部压力不会在一个“日期”字段里失真。
6. **一个 Magic Plus 形成触觉记忆**：点击、拖动和落点是同一个连续动作，而不是增加动画装饰。
7. **颜色少但有固定职责**：黄色属于 Today，红色属于 Deadline，蓝色属于创建/编辑动作；结构仍由排版承担。

## 8. 优势

1. Today 是有限、可人工整理的每日承诺，不是所有逾期和通知的垃圾桶。
2. Project / Area 与时间列表正交，同一 To-do 不会因进入 Today 丢失来源。
3. This Evening 在不要求精确排期的情况下提供有效的时间分层。
4. Calendar 作为只读约束呈现，避免把任务和事件混为同一种对象。
5. Start date、Reminder 与 Deadline 分责清楚。
6. 详情原位展开、Quick Find 和 Magic Plus 都强化“不中断当前思路”。

## 9. 风险与证据边界

### UX 风险

1. Today 仍可能被塞满；Things 依赖用户自律，没有容量预算或冲突解释。
2. 手工排序只表达一个人的当日意图，不适合作为团队或系统全局优先级。
3. Things 是单用户产品，不处理负责人、审批、并行 Agent、证据或结果未知。
4. `This Evening` 只有一个粗粒度时间段，不能表达运行窗口或精确依赖。
5. 未来 start date 会让对象暂时退出主视野；若用户不了解 Upcoming，可能误以为任务丢失。

### 可访问性风险

1. 从截图可见的 checkbox、灰色副标题、细图标和部分标签可能尺寸偏小或对比度不足；截图不能证明实际热区和 VoiceOver 标签。
2. 拖拽排序、移动端滑动和 Magic Plus 必须有键盘/辅助技术等价动作，官方文档证明部分键盘入口存在，但不能据此宣称完整 WCAG 合规。
3. 完成与重排动画是否尊重 Reduce Motion 需要实机验证。
4. Today / Deadline 的黄色与红色不能成为唯一状态通道；Things 同时有文字和图形，但 Chat 仍须独立验证。

## 10. 对 Chat 的翻译

### Take

1. Project 是长期语境，Today 是个人注意力投影；两者不能合并。
2. Today 只放今天可理解、可介入、可看护的有限事项。
3. 日历事件是约束，不自动变成 Work。
4. Today 行必须显示来源 Project / Agent / Work。
5. `This Evening` 可作为低权重的同日后段，而不是另一张 Dashboard 卡。
6. 一个可反复使用的直接操纵机制，比到处加装饰更能形成产品个性。

### Adapt

1. Things To-do → Chat `Today item projection`：可投影用户 Task、待决定 Decision、需看护 Run、Blocker 和 Calendar constraint，但保留对象类型与真实状态。
2. Things When → Chat `attention date`：只决定何时提醒用户介入，不代表 Run 执行时间、Deadline 或完成承诺。
3. Things Deadline → Chat 外部硬约束：必须保留来源和后果，不能只显示一个红日期。
4. Things checkbox → 只用于用户可直接完成的 Task；Decision、Run、Artifact 必须使用自己的权威命令和状态机。
5. Quick Find → 全局跳转与最近路径；先查对象名和类型，按需扩展到全文和证据。
6. Magic Plus → Chat 可探索“抓起一个输入，落到 Conversation / Today / Project / Workbench”的单一机制，但先在 HTML 行为切片验证。

### Refuse

1. 不把 Work、Decision、Run、Artifact 全部变成 checkbox。
2. 不复制黄色星标、蓝色圆形 Plus 和 Things 图标体系。
3. 不把人工排序写成团队权威优先级。
4. 不因从 Today 移除就改变 Work 的真实状态或归属。
5. 不让极简视觉隐藏 blocked、failed、outcome_unknown 或版本冲突。
6. 不把单用户本地 Today 当作共享 Project 的事实源。

## 11. 对 UI Lab 的行为约束

UL1 的 Today 场景至少验证：

1. 同一个 Work 在 Project 与 Today 中保持身份、来源和状态一致。
2. `设为今天 / 移到今晚 / 改到明天` 只改变个人 attention projection，并提供可撤销反馈。
3. Calendar、Task、Decision、Run 使用不同对象样式和动作，不能全部出现 checkbox。
4. Today 的人工排序不改变 Project 中的权威优先级。
5. `blocked / outcome_unknown` 不允许用普通改期隐藏。
6. 从 Today 打开详情再关闭，恢复入口焦点、滚动和分组位置。

## 12. 仍需实测

1. macOS 当前版本 To-do 原位展开和关闭时的焦点、滚动及动画细节。
2. Checkbox 完成后的 Undo、Logging 偏好与跨设备同步反馈。
3. Calendar event 的精确点击结果和无权限/日历失效状态。
4. Today 拖拽进入 This Evening、跨 Project 分组和空态的反馈。
5. Dynamic Type、200% 放大、Reduce Motion、VoiceOver 与完整键盘路径。

以上标记为 `I`，不进入 Chat 正式交互合同。

## 13. 官方证据

1. [Today, Upcoming, Anytime, and Someday](https://culturedcode.com/things/support/articles/4001304/)。
2. [Scheduling To-dos](https://culturedcode.com/things/support/articles/2803579/)。
3. [Calendar Integration](https://culturedcode.com/things/support/articles/2803583/)。
4. [Quick Find](https://culturedcode.com/things/support/articles/2803584/)。
5. [Things Features](https://culturedcode.com/things/features/)。
6. [Moving Items](https://culturedcode.com/things/support/articles/9651894/)。
7. [Natural Language Input](https://culturedcode.com/things/support/articles/9780167/)。
