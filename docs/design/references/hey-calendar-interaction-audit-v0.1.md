---
status: approved
version: 0.1
date: 2026-08-08
product: HEY Calendar
surface: Day + Week + Event
evidence: official-help + official-product-screenshots
---

# HEY Calendar 交互审计 v0.1

## 1. 结论

HEY Calendar 最值得借的不是彩色块，而是把“时间”设计成可阅读的尺度：Day 是连续故事，Week 是接下来七天的章节，Year 是全日 / 跨日事件形成的季节轮廓。它还允许 Day name、背景图、圈日、Journal、Habit 和 Countdown 给时间加上人的意义。

对 Chat 的价值是：Calendar 应呈现真实时间约束和个人节奏，但不能拥有 Work、Run 或 Project 的状态。个性可以来自时间阅读方式与少量可重复的个人标记，不需要给所有卡片加渐变和动效。

## 2. 对象与尺度

```text
Calendar
├── Event: time + calendar + invitees + notes + link
├── Habit: recurring personal practice + completion
├── Sometime This Week do
├── Journal entry: one per account per date
└── Day decoration: name / background / circle

Views
Day  → continuous timeline
Week → current seven-day sequence
Year → all-day / multi-day seasonal overview
```

`Event color` 来自所属 Calendar，不能对单个 Event 任意改色。颜色首先表达来源，而非装饰。

## 3. 点击与操作地图

| # | 入口 / 操作 | 结果与反馈 | 证据 | 设计理由 |
|---|---|---|---|---|
| 1 | Day / `D` | 将今天排成一条连续时间线 | `D+O` | 读“接下来发生什么”，而非扫描时间网格 |
| 2 | Week / `U` | 显示当前周，并可查看前后周 | `D+O` | 七天成为连贯章节，保留邻近周背景 |
| 3 | Year / `Y` | 只显示全日与跨日事件 | `D` | 最远尺度只保留季节级信号，主动丢弃小时噪声 |
| 4 | 左 / 右方向键 | Day 视图切换前一天 / 后一天 | `D` | 时间导航具有稳定空间方向 |
| 5 | `+` / `N` 新建事件 | 桌面左上、移动端底部打开 Event composer | `D` | 同一主动作根据设备可达性换位 |
| 6 | Event | 打开或编辑通知、链接、Notes、Location、Invite、Countdown、Repeat | `D+O` | 扫描面保持轻，复杂字段按需出现 |
| 7 | 从 Email 创建 Event | 预填邮件主题并保存回信私有链接 | `D` | 在来源上下文中创建，未来可回到证据 |
| 8 | composer 下方日程 Peek | 查看当天时间线并拖动新事件调整时间 | `D` | 创建与冲突判断同屏，避免往返 Calendar |
| 9 | Calendar 选择 | Event 自动使用所属 Calendar 的颜色 | `D` | 颜色稳定表达来源，避免任意涂色 |
| 10 | Day name / background / circle | 给某一天命名、加图或圈出 | `D` | 让时间具有记忆点，但不改事件事实 |
| 11 | Journal / `K` | 在 Day 打开当天 Journal；输入自动保存 | `D` | 日历不仅记录承诺，也容纳围绕一天的上下文 |
| 12 | Habits | 配置名称、图标、颜色；Day / Week 显示完成轨迹 | `D` | 重复实践进入时间视图，但与 Event 分型 |
| 13 | Search / `S` | 搜索 Event、Sometime、Journal、Time Tracking；隐藏 Calendar 同时隐藏其结果 | `D` | 搜索尊重当前可见范围，Today 分隔过去与未来 |

## 4. 关键路径

### 4.1 从来源创建时间承诺

```text
Email message
  → Create event
  → title prefilled + private source link
  → inspect day timeline
  → drag to time
  → save to selected calendar
```

### 4.2 从一天放大到一年的不同问题

```text
Day: 下一件事是什么？
  → Week: 七天如何衔接？
  → Year: 哪些季节被大事占据？
```

每次放大都主动减少细节，而不是简单把同一网格缩小。

### 4.3 给日期添加个人意义

```text
Day
  → name / background / circle / Journal
  → date becomes memorable
  → Event data remains unchanged
```

## 5. 为什么成立

1. 连续时间线让空白和忙碌都能被直接感知，不依赖统计卡片。
2. 3 个尺度各自回答不同问题；信息密度随尺度下降。
3. 色彩跟 Calendar 来源绑定，因此活泼但仍有语义纪律。
4. 创建 Event 时内嵌当天时间线，把判断冲突放进动作过程。
5. Journal、Habits、Countdown 和 Day decoration 让产品有性格，但没有把 Event 本体变复杂。

## 6. 风险与证据边界

1. Day 的非传统连续布局可能降低精确空档比较效率，需要与传统时间网格实测。
2. 背景图、颜色和圈日可能影响文字对比度；不能作为唯一状态信号。
3. Habit、Journal、Sometime、Event 同屏时会增加类型识别负担。
4. 拖拽排期必须有键盘和辅助技术等价动作；官方快捷键表不能证明完整 WCAG 合规。
5. Journal 当前不支持导出，Chat 不能把不可导出的界面状态当耐久知识。
6. 截图与帮助文档不能证明屏幕阅读器播报、200% 放大、Reduce Motion 和移动端手势回退。

## 7. 对 Chat 的翻译

### Take

1. Day / Week / Year 是不同阅读问题，不是同一网格的缩放。
2. Calendar Event 是外部时间约束，颜色表达来源 Calendar。
3. 创建时间承诺时同屏显示冲突和来源。
4. 少量“给一天命名”的个人表达可形成产品温度。

### Adapt

1. Chat Today 采用连续日序列，但把 Event、Task、Decision、Run window 明确分型。
2. Event 可以链接 Project / Conversation / Artifact，却不拥有这些对象。
3. Day decoration 只影响个人视图；共享 Project 事实不能由背景和圈选表达。
4. Calendar 与 Today 相互跳转时保留日期、滚动与来源上下文。

### Refuse

1. 不复制 HEY 的具体色板、手绘气质和品牌图形。
2. 不把 Work 自动转换成 Calendar Event。
3. 不让颜色、背景图或位置成为唯一状态通道。
4. 不把 Habit completion、Run completion 与项目完成混成一个勾选。

## 8. 对 UI Lab 的约束

1. UL1 Today 同时呈现时间约束与可行动对象，但类型和动作必须不同。
2. Day / Week 切换时保持选中日期与对象身份，不产生重复对象。
3. 新建时间承诺必须可查看冲突、来源和时区。
4. 日历颜色只表达 Calendar 来源；状态另有文字 / 图形通道。
5. 移动端主创建动作至少 44px，拖拽必须有按钮等价路径。

## 9. 官方证据

1. [Calendar Overview](https://help.hey.com/article/800-calendar-overview)。
2. [Events](https://help.hey.com/article/844-events)。
3. [Calendar Day Features](https://help.hey.com/article/837-calendar-day-features)。
4. [Journal](https://help.hey.com/article/907-journal)。
5. [Habits](https://help.hey.com/article/822-habits)。
6. [Keyboard Shortcuts](https://help.hey.com/article/758-keyboard-shortcuts)。
