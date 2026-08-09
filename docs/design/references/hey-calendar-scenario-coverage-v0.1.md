---
status: frozen
version: 0.1
date: 2026-08-09
product: HEY Calendar
prototype: ../reference-implementations/hey-calendar
---

# HEY Calendar 场景覆盖与冻结记录 v0.1

## 1. 冻结结论

本参考实现已覆盖 HEY Calendar 对 Chat 最有价值的 2 个场景簇：

1. **时间作为可阅读约束**：Day、Week、Year 不是同一网格缩放，而是分别回答下一件事、七天衔接和季节级占用。
2. **来源形成时间承诺**：Email 先生成独立 Event candidate，用户在当天日程中判断冲突、调整时间并保存；保存后才成为同一个可跨视图读取的 Event。

它不是 HEY 皮肤复刻，也不把未接入的真实 Calendar、Email、通知和邀请伪装成可用功能。v0.1 因此可以冻结，用于以后设计 Chat Today 与 Calendar constraint 时回看对象边界和交互选择。

## 2. 场景覆盖矩阵

| 场景 | 用户问题 | 原型结果 | 状态 |
|---|---|---|---|
| Day | 接下来发生什么、空白在哪里 | 横向连续时间、夜晚边界、当前时间、按时长伸缩的 Event；手机改为纵向日程 | 已覆盖 |
| Week | 这七天怎样衔接 | 当前周有强边界，同时保留前后周；选日期进入对应 Day | 已覆盖 |
| Year | 一年哪些季节被大事占据 | 只显示 all-day / multi-day Event，小时事件被主动丢弃 | 已覆盖 |
| Email → candidate | 来源中提到的约定如何进入日历 | 预填标题、参与者、地点和私有 source provenance；正式 Event 数量不变 | 已覆盖 |
| Conflict peek | 新约定是否撞时间 | Composer 同屏投影当天 Event，显示重叠名称和数量 | 已覆盖 |
| Adjust → Save | 怎样修订后形成承诺 | 空档按钮与 Earlier / Later 等价动作调整时间；Save 后进入 Day / Week / Search | 已覆盖 |
| Edit / Calendar | 改来源时颜色和对象怎样变化 | 更新同一 Event ID；颜色始终由 `calendarId → Calendar.color` 推导 | 已覆盖 |
| Cancel / Escape | 不想保存时怎样退出 | 丢弃 candidate，不产生假 Event；输入框聚焦时 Escape 也可关闭最上层 | 已覆盖 |
| Calendar visibility | 暂时不看某来源时怎样保持一致 | Day、Week、Year 与 Search 同时隐藏，但不删除 Event | 已覆盖 |
| Search | 怎样跨类型找时间上下文 | 可找 Event、Sometime、Journal；结果进入真实所属投影 | 已覆盖 |
| Sometime | 不值得占具体时间的事放哪里 | 独立新建 / 完成，不冒充 Event | 已覆盖 |
| Journal / Habit | 日历怎样容纳回顾与实践 | 按日期自动保存 Journal；Habit 有独立完成轨迹 | 已覆盖 |
| Day decoration | 怎样给一天加个人意义 | Day name 与 Circle 只改个人日期视图 | 已覆盖 |
| Keyboard | 高频动作怎样不依赖鼠标 | D / U / Y / T / N / S / J / B、左右日期与 Escape | 已覆盖 |

## 3. 对象边界验证

```text
Email source ──provenance──▶ Event candidate ──Save──▶ Event
                                                     │
Calendar ──owns color────────────────────────────────┘

Event ──projection──▶ Day / Week / Year / Search
SometimeTask ───────▶ Sometime this week
JournalEntry ───────▶ date journal
Habit ──────────────▶ personal practice trail
DayDecoration ──────▶ personal date view
```

验证不变量：

1. Candidate 与 saved Event 分离，Cancel 不写正式集合。
2. Day / Week / Year / Search 复用同一 Event 对象与 ID，不因投影复制。
3. Event 没有任意 `color` 字段；Calendar visibility 只影响投影。
4. Journal、Habit、Sometime、Day decoration 的动作不修改 Event。
5. Conflict 是判断信息，不自动拒绝保存，也不冒充 Project 优先级。

## 4. 例外与恢复覆盖

1. 标题为空或结束时间早于开始时间时，保存按钮禁用并有原因。
2. 候选时间重叠时显示冲突对象；用户可保留、前后移动或选时段，不发生隐式改期。
3. 隐藏 Work Calendar 后，Work Event 同步退出所有可见投影和 Search；重新勾选可恢复。
4. Escape 只关闭最上层弹层；未保存草稿不残留到时间线。
5. 手机不缩放桌面横轴：Day 改为纵向日程，底部保留 44px 以上主导航和新建入口。

## 5. 明确未覆盖

1. 真实 HEY / Google / Apple / Outlook 同步、认证和持久化。
2. 真实邀请、Email 发送、通知、时区转换与重复规则执行。
3. Day background 上传、Time Tracking 与服务端全文检索。
4. 拖拽手势本身；原型用空档按钮与 Earlier / Later 作为可测、可键盘操作的等价路径。

这些缺口不影响本轮研究结论；若未来成为 Chat 产品需求，应以新的数据所有权和纵向任务书实现，而不是继续扩张参考原型。

## 6. 验证结果

1. Model / contract：11 / 11 通过。
2. Sites worker：4 / 4 通过。
3. Browser：8 个核心交互簇通过，console error / warning 为 0。
4. Responsive：`1440 × 900` 与 `391 × 844` 通过，无页面级横向溢出。
5. Visual QA：官方 Day 与 Event composer 同状态组合对照完成，`final result: passed`。

## 7. 对 Chat 的可复用结论

1. Calendar Event 是外部时间约束，不拥有 Work / Project / Run 状态。
2. Today 的价值来自时间、注意力与人工介入在同一叙事中相遇，而不是统计卡片。
3. 创建时间承诺时应同时显示来源与冲突；模型或解析结果只能先成为 candidate。
4. 颜色适合表达 Calendar 来源，但 blocked / failed / outcome_unknown 仍需独立文字与图形通道。
