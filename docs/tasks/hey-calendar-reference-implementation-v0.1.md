---
status: frozen
version: 0.1
date: 2026-08-09
owner: Chat product design
task_type: reference-study prototype
branch: codex/hey-calendar-reference-v0.1
---

# HEY Calendar 时间阅读与来源建约参考实现 v0.1

## 1. 用户结果

用户可以实际体验 HEY Calendar 如何用 3 个尺度回答不同问题：Day 读下一件事，Week 读七天怎样衔接，Year 读一年哪些季节被大事占据；也可以从一封邮件创建时间承诺，在 Event composer 内看见当天冲突、调整时间并保存，再从 3 个视图读取同一 Event。

这个原型用于研究 HEY 解决的场景，不是把 HEY 的彩色、手绘或品牌皮肤直接翻译成 Chat。

## 2. 当前官方事实

1. Calendar Overview 于 2026-08-04 更新，仍明确提供 Day / Week / Year 3 个阅读尺度。
2. Day 是连续时间线，Week 是顺序展开的七天章节，Year 只保留全日 / 跨日事件。
3. 桌面从左上 `+`、移动端从底部创建 Event；Event 可包含通知、链接、Notes、Location、Invite、Countdown 与 Repeat。
4. 从 Email 创建时标题会预填，并保存回邮件的私有来源链接；composer 底部的当日日程可用于判断和调整时间。
5. Event 色彩由所属 Calendar 决定，不能对单个 Event 任意涂色。
6. 2026-04 的当前快捷键仍包括 Day `D`、Week `U`、Year `Y`、New `N`、Search `S`、Journal `J` 与前后日期方向键。

## 3. 场景范围

### 3.1 Day → Week → Year

1. Day 以连续时间线显示夜晚、空白、当前时间和时长不同的 Event，不回退成 24 个等权方格。
2. Week 同时显示当前周与相邻周，保持选中日期；点击日期返回对应 Day。
3. Year 只投影 all-day / multi-day Event；点击日期进入 Day，不把小时事件缩成噪声。
4. Day / Week / Year、方向键、Today 和浏览器 URL 同步。
5. 桌面用横向连续时间，移动端改为纵向时间故事，不把桌面画布缩小塞进手机。

### 3.2 来源 → Event composer → 保存

1. `Create from message` 打开带标题和 source link 的 Event candidate。
2. Composer 支持 Calendar、标题、开始/结束、All day、Location、Notification、Notes、Invite、Repeat、Countdown 与 Circle。
3. Composer 底部显示当天现有 Event 与 candidate；点击空档或 Earlier / Later 调整时间。
4. Save 后同一 Event 出现在 Day、Week 和搜索；编辑 Event 更新同一 ID。
5. 切换 Calendar 改变来源与颜色，不允许 Event 自己保存任意颜色。
6. Cancel / Escape 丢弃 candidate，不产生假 Event。

### 3.3 时间周边对象

1. Sometime This Week 是独立待办，可新建、完成；不冒充 Event。
2. Journal 按日期自动保存草稿；它不改变 Event。
3. Habit 有独立完成轨迹；完成 Habit 不代表 Project / Work 完成。
4. Day name 与 Circle 只改变个人日期视图；不修改 Event 事实。
5. Search 同时找 Event、Sometime、Journal，并尊重 Calendar 可见性。

## 4. 数据合同

1. `CalendarSource`、`Event`、`SometimeTask`、`Habit`、`JournalEntry`、`DayDecoration` 各有稳定 ID / key。
2. Day、Week、Year、Search 使用同一 Event 对象；视图切换不复制 Event。
3. `event.calendarId → calendar.color` 是唯一颜色来源；Event 不拥有 `color` 字段。
4. `draftEvent` 与 saved Event 分离；只有 Save 写入正式 events。
5. Email source link 是 provenance，不把 Email 变成 Event 所有者。
6. 时间冲突是可见判断信息，不自动拒绝保存或改变 Work 优先级。

## 5. UI 完成门

1. 官方 Day、Week、Year、Event composer 截图分别作为视觉真相；桌面优先并适配 `390 × 844`。
2. 主要导航、事件创建/编辑、冲突调整、搜索、Journal、Habit、Sometime 与日期装饰全部可操作。
3. 颜色同时有 Calendar 名称；当前时间、选中日期、冲突和完成状态不只靠颜色。
4. 可点目标不少于 44px；键盘路径和 Escape 层级清楚；移动端无横向溢出。
5. 参考截图与原型同尺寸组合比较，修完 P0/P1/P2，`design-qa.md` 为 `passed`。

## 6. 明确不做

1. 不接 HEY、Google、Apple、Outlook API，不发送邀请、通知或邮件。
2. 不实现账户、共享 Calendar、真实时区换算、重复规则引擎或服务端持久化。
3. 不把 Work / Run / Project 自动转换成 Calendar Event。
4. 不让 Day background、圈选、Habit 勾选或 Event 颜色成为权威工作状态。
5. 不复制 HEY 商标素材、真实用户身份或邮件正文；使用 study-safe fixture。

## 7. 新依赖说明

- `@phosphor-icons/react@2.1.10`：提供接近参考的圆润线性 UI 图标；由该参考原型拥有，不进入 Chat 生产依赖图；MIT License。退出方式是替换成届时选定的 Chat 图标系统，不影响任何状态合同。

## 8. 研究依据

1. [Calendar Overview](https://help.hey.com/article/800-calendar-overview)
2. [Events](https://help.hey.com/article/844-events)
3. [Calendar Day Features](https://help.hey.com/article/837-calendar-day-features)
4. [Journal](https://help.hey.com/article/907-journal)
5. [Habits](https://help.hey.com/article/822-habits)
6. [Search](https://help.hey.com/article/845-search)
7. [Keyboard Shortcuts](https://help.hey.com/article/758-keyboard-shortcuts)

## 9. 冻结证据

1. `node --test tests/hey-interactions.test.mjs`：11 / 11 通过。
2. `node --test tests/sites-worker.test.mjs`：4 / 4 通过。
3. `npm run build`：Vite 生产构建与 Sites 打包通过。
4. 浏览器验证：Day / Week / Year、Email candidate、冲突、时间调整、保存、编辑换 Calendar、Calendar visibility、Search、Sometime、Journal、Habit、Day name、快捷键与 Escape 均通过；页面 console error / warning 为 0。
5. 响应式验证：`1440 × 900` 桌面与 `391 × 844` 手机 CSS viewport 均无页面级横向溢出，移动端 composer 的固定保存动作可见。
6. [场景覆盖与冻结记录](../design/references/hey-calendar-scenario-coverage-v0.1.md) 与 [视觉 QA](../design/reference-implementations/hey-calendar/design-qa.md) 已通过。

冻结结论：v0.1 已覆盖“时间尺度阅读”和“来源形成时间承诺”两条研究主路径，以及隐藏 Calendar、取消草稿、冲突提示和移动端按钮等恢复 / 例外路径；超出边界的真实同步、邀请、时区与重复规则不补成假功能。
