---
status: approved
version: 0.1
date: 2026-08-08
product: Basecamp 5
evidence: official-help + user-provided-current-screenshot
approved_at: 2026-08-08
approved_by: user
---

# Basecamp Home 交互审计 v0.1

> 审核结果：2026-08-08 用户确认通过。本文作为其余锚点产品交互审计的深度样板；后续可以补充实测证据，但不得降低既定审计结构。

## 1. 结论

Basecamp 值得深挖的不是六宫格 Project 工具，而是一套稳定的**作用域架构**：Account Home 负责“去哪里”，Project Room 负责“在哪里协作”，Tool View 负责“看哪一类对象”，Item Detail 负责“处理哪一件事”。跨项目 Activity、个人事务和定向通知被分开，避免一张万能 Dashboard 同时承担发现、执行和提醒。

用户提供的截图与 2026-07-10 更新的 Basecamp 5 官方 Home 文档一致，能够作为当前版本的 Home 证据，而不是只靠营销页推断。

## 2. 当前截图的页面职责

主问题：**我现在应该进入哪个范围，或者接着处理哪件事？**

界面把 4 类职责放在 4 个稳定空间：

1. 顶部：跨账户/跨项目的浏览入口——Activity、Calendar、Reports、Everything。
2. 左侧：低频创建与管理——新建 Project、Folder、邀请成员、Adminland。
3. 中央：高频 Project 切换——搜索/跳转、Folder、Project 卡片、星标。
4. 右侧：跨项目最近活动——快速扫一眼后深链到具体对象。

底部 My bar 是第 5 个空间：My Tasks、My Events、Do Today、My Bookmarks、My Notes 和 New for you 都以“我”为作用域，而不是以 Project 为作用域。

这不是随意排版。空间位置直接表达作用域：全局在上、管理在左、主要目的地在中、环境变化在右、个人责任在下。

## 3. 对象层级

```text
Account Home
├── Global aggregate: Activity / Calendar / Reports / Everything
├── Personal aggregate: My Tasks / Events / Today / Bookmarks / Notes
├── Notification intake: New for you
├── Folder
│   ├── Project cards
│   ├── folder-scoped Activity
│   └── folder-scoped Mission Control
└── Project
    ├── Project Room
    ├── Tool View
    └── Item Detail / Thread
```

关键价值是“同一对象沿层级下钻”，而不是在多个 Dashboard 小组件里复制同一份内容。

## 4. 点击地图

| # | 入口 | 点击结果与效果 | 证据 | 为什么这样设计 |
|---|---|---|---|---|
| 1 | Home / Basecamp 标识 | 回到 Home；官方另提供 `Shift + H` | `D` | 给所有深层页面一个确定锚点 |
| 2 | Search / Jump | `Shift + J` 打开跳转搜索；可找 Project、Person、Page | `D` | 规模增长后避免依赖卡片墙和目录记忆 |
| 3 | Project card | 进入该 Project 的 Project Room | `O+D` | Project 是长期地点，不是一个过滤标签 |
| 4 | 星标 | 将 Project 加入/移出 Home；Home 显示 Folder、星标项目和最多 10 个最近未星标项目 | `D` | 个性化“常去地点”，但不改变团队事实 |
| 5 | Folder | 原位进入 Folder，查看其中 Project；可看该 Folder 的 Activity / Mission Control | `D` | 用轻量容器控制项目规模，同时保留跨项目观察 |
| 6 | View all activity | 从右侧摘要进入完整 Activity | `O+D` | Home 只提供环境感知，深度回顾另开专门视图 |
| 7 | Activity 中的蓝色对象链接 | 深链到对应 Project 的 To-do、Message、Chat 或 Document | `O` | Feed 是投影，真正处理仍回到底层对象 |
| 8 | Activity / Reports | 进入跨账户 Activity，并切换不同报告；可按 Project/Person 过滤 | `D` | 把“刚发生什么”和“分析什么”放在同一证据源上 |
| 9 | Calendar | 进入跨 Project 的时间聚合 | `O+D` | 时间是横切视图，不属于某一张 Project 卡 |
| 10 | Everything | 进入全账户对象目录/聚合 | `O` | 提供逃生口，但不让 Home 直接承载全部对象 |
| 11 | My Tasks / Events / Today / Bookmarks / Notes | 进入个人聚合视图 | `O` | 把“我的责任”与“整个组织发生的事”分开 |
| 12 | New for you | 打开定向通知；未读数在徽标上，处理后可清除或稍后回来 | `O+D` | 定向输入不能与环境 Activity 混成一条无限流 |
| 13 | 背景水滴 | 浅色模式下循环切换背景颜色 | `O+D` | 个性放在环境层，不改对象与状态语义 |
| 14 | 创建/管理按钮 | 进入独立创建或设置流程 | `O+D` | 低频高影响动作与高频浏览分区，减少误触和视觉竞争 |

## 5. 关键状态路径

### 5.1 回到项目继续工作

```text
Home
  → 点击 Project card
  → Project Room
  → 点击 Tool
  → Tool View
  → 点击 Item
  → Item Detail
  → Back / Breadcrumb
  → 恢复 Tool View 与 Project 归属
```

Basecamp 首页营销演示和产品结构共同证明了 `Project Room → Tool View → Item Detail`。需要继续实测的是：浏览器返回时滚动位置与键盘焦点的精确恢复。

### 5.2 从环境变化进入具体事实

```text
Home recent activity
  → 点击对象链接
  → 对应 Project / Tool / Item
  → 处理或阅读
  → 返回 Home / Activity
```

设计上 Activity 不拥有任务或讨论，它只是可下钻的时间投影。这一点可直接转译到 Chat Agent Activity。

### 5.3 整理 Home，而不改变团队事实

```text
Search project
  → Star
  → Project 出现在 Home
  → Drag / Folder organize
  → 仅改变个人 Home 组织
```

Basecamp 4 官方文档明确说明 Pin/Stack/Color 是个人设置；Basecamp 5 延续为 Folder、Star 和背景主题。值得借的是“个人入口布局”和“权威项目状态”分离。

## 6. UI 风格为什么成立

1. **中心像一张桌面，而不是控制台**：大留白、暖背景、少量项目卡让 Home 感觉像进入工作场所，而不是看指标。
2. **强调层级来自位置和字重**：没有依赖大量彩色标签、阴影或玻璃效果。
3. **颜色承担身份与环境，不承担所有状态**：活动类型图标、Project/Folder 色和背景主题都局部使用。
4. **卡片有边界但不自成宇宙**：Project 卡只提供识别和进入信息，详情留给 Project Room。
5. **人物头像制造在场感**：它回答“谁在这个 Project / 最近谁活跃”，不是装饰性社交证明。
6. **直接链接保持 Web 质感**：Activity 中的对象使用显眼蓝色链接，用户知道它能下钻，而非把整行做成含义不明的卡片。

## 7. 代价与风险

1. 同时存在顶部、左侧、右侧和底部 4 个导航区，新用户需要学习作用域。
2. Project 数量很大时，卡片 Home 必须依赖 Search、Folder、Star 和最近访问，否则会退化为卡片墙。
3. 暖灰背景、浅边框与小图标需要实际测量对比度；仅凭截图不能判定 WCAG 合规。
4. Activity 与 Everything 若没有清楚过滤和返回，会成为信息垃圾场。
5. 个人 Home 可定制意味着团队成员看到的首页不同，沟通时不能假设共同布局。

## 8. 对 Chat 的翻译

### Take

1. Account / Project / Tool / Item 四层作用域必须稳定。
2. Project Room 是长期地点；Activity、Today、Search 都只能深链回来。
3. Agent Activity 是事实投影，不拥有 Work、Decision、Run 或 Artifact。
4. 个人入口布局可以被整理，但不能改变 Product Store 的权威事实。
5. 个性可以主要落在环境主题、空间与一个局部机制上，而不是 AI 渐变皮肤。

### Adapt

1. Basecamp `New for you` → Chat `需要我处理`：只放版本绑定的决定、阻塞、外部副作用确认和定向交付；普通 Agent 动态留在 Pulse。
2. Basecamp Jump → Chat 全局跳转：查 Project、Agent、Work、Artifact、Conversation 和最近路径，并清楚显示对象类型。
3. Basecamp Recent Activity → Chat Agent Pulse：同一 Work 的连续事件折叠为一段叙事，点击回到权威对象和证据。
4. Basecamp Folder / Star → Chat 个人 Project 入口整理：只改变个人导航，不改变 Project 状态和排序事实。
5. Basecamp My bar → Chat 个人事务中心：Today、日历、待办、收藏与草稿共享个人作用域，但不必照抄底栏位置。

### Refuse

1. 不复制六宫格工具首页和等权模块卡。
2. 不把 Conversation、Workbench、Run、Decision、Artifact 都扁平化为 Project 工具。
3. 不让 `Everything` 成为没有对象类型和范围的万能搜索结果。
4. 不用星标、颜色或头像替代 Candidate / Decision / Running / Failed / Formal 等事实状态。
5. 不复制 Basecamp 品牌图形、语气和响应式位置。

## 9. 对 UI Lab 的具体约束

UL1 的 `Project Room` 必须先验证 4 个行为切片：

1. 从 Home/Today/Activity 进入同一个 Project，Project 身份不变。
2. Project → Work/Artifact → 返回，恢复入口和滚动上下文。
3. 个人固定/整理 Project 只改变入口布局。
4. Agent Pulse 动态点击后回到权威 Work / Run / Decision，不在 Feed 内完成高影响动作。

在这 4 个切片通过之前，不做“漂亮的 Project 首页”收尾。

## 10. 仍需实测的问题

1. Project / Activity 深链返回时的浏览器历史、焦点和滚动恢复。
2. Star、Folder 拖拽和背景切换的即时反馈、Undo 与跨设备持久化。
3. Search / Jump 的空态、无权限结果、最近访问排序和键盘循环。
4. New for you 清除、稍后处理和新评论到达时的精确状态变化。
5. 移动端从底栏进入 Project / Item 后的返回语义。

这些问题标记为 `I`，不能在 Chat 原型里伪装成已经由 Basecamp 证明的答案。

## 11. 官方证据

1. [Basecamp 5 · The Home Screen](https://5.basecamp-help.com/article/1159-the-home-screen)，最后更新 2026-07-10。
2. [Basecamp 5 · Notification settings](https://5.basecamp-help.com/article/1177-notifications)，最后更新 2026-07-10。
3. [Basecamp 4 · Reports](https://3.basecamp-help.com/article/93-reports)。
4. [Basecamp 4 · My Stuff](https://3.basecamp-help.com/article/23-my-stuff)。
5. [Basecamp homepage interactive project demo](https://basecamp.com/)。
