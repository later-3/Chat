---
status: approved
version: 0.1
date: 2026-08-08
product: Linear
surface: Peek + Project Updates + Pulse
evidence: official-docs + official-product-screenshots
---

# Linear Peek 与 Project Updates 交互审计 v0.1

## 1. 结论

Linear 值得借的不是黑灰配色和紧密表格，而是把 3 种阅读速度拆开：

1. 列表负责扫描与定位。
2. Peek 负责不离开列表的临时理解。
3. Project Update 负责由人写出的阶段叙事；Pulse 只是它的聚合阅读面。

Peek 不是新对象，也不是万能详情抽屉；Project Update 也不是活动日志。对 Chat 而言，这意味着 `Work / Decision / Run / Project Update` 必须保留稳定身份，视图只是投影。Agent 生成的事件不能冒充项目负责人的健康判断。

## 2. 范围与对象

```text
Workspace
├── Project
│   ├── Overview
│   │   └── latest Project Update
│   ├── Issues / Board / List
│   └── Updates history
│       ├── authored update: health + narrative
│       └── property changes / progress facts
└── Pulse
    └── Project / Initiative Update projections

Issue or Project row
└── focused item → Peek → same object
```

审计范围：`List / Board → Peek → adjacent item → close`，以及 `Project Overview → draft update → publish → Updates / Pulse / Slack → discussion`。

## 3. 点击与键盘地图

| # | 入口 / 操作 | 结果与反馈 | 证据 | 设计理由 |
|---|---|---|---|---|
| 1 | 聚焦 Issue / Project 后按 `Space` | Peek 保持打开，预览当前对象 | `D+O` | 保留列表位置，不付出完整导航成本 |
| 2 | 按住 `Space` | 只在按住期间显示 Peek，松开即关闭 | `D` | 形成类似 Quick Look 的瞬时阅读模式 |
| 3 | Peek 打开时 `↑ / ↓` | 焦点移动到相邻对象，预览同步更新 | `D` | 连续检查多个对象，不重复开关详情 |
| 4 | `Esc` | 关闭 Peek | `D` | 快速返回扫描；精确焦点恢复仍需实测 |
| 5 | Issue Peek | 显示描述、负责人、状态、优先级、Cycle、标签、估算、创建/更新时间 | `D+O` | 只放判断是否深入所需的高价值字段 |
| 6 | Project Peek | 显示 Project 详情和 Project graph | `D+O` | 在列表上下文内判断健康和进展 |
| 7 | Command menu 移动选择 | 支持的项目自动更新 Peek | `D` | 搜索、命令与预览共享同一阅读机制 |
| 8 | Project Overview 的更新铅笔 | 打开最新 Update 编辑器 | `D+O` | 更新属于项目概览，不另造独立写作入口 |
| 9 | 选择 Health | 明确选择 On track / At risk / Off track | `D` | 先给可扫读信号，再用正文解释 |
| 10 | 发布 Update | 保存 rich text、附件和可选进展细节；最新一条回到 Overview | `D` | 人工叙事与系统变化同框，但不混成一段日志 |
| 11 | Updates tab | 查看历次 Update 与目标日期、成员、里程碑等属性变化 | `D` | 保存阶段性承诺与事实变化的时间线 |
| 12 | Pulse 的 For me / Popular / Recent | 按关系、互动热度或时间聚合 Update | `D` | 允许不同阅读意图；Popular 不适合作为 Chat 默认排序 |
| 13 | Update 评论 / Reaction | 围绕一条项目叙事讨论；可与 Slack 双向同步 | `D` | 讨论锚定在可引用的 Update，而非散落动态 |
| 14 | Reminder / stale health | 到期提醒负责人；长期未更新显示缺失或灰化 | `D` | “没有新判断”本身成为可见事实 |

## 4. 关键状态路径

### 4.1 连续检查而不丢列表位置

```text
List row focused
  → Space
  → Peek(current object)
  → ↑ / ↓
  → Peek(adjacent object)
  → Esc
  → List context preserved
```

### 4.2 从项目事实形成负责人叙事

```text
Project Overview
  → edit latest update
  → choose health + write narrative
  → include / hide system progress details
  → publish
  → Overview latest + Updates history + optional Pulse / Slack
```

### 4.3 更新缺失成为监督信号

```text
Active Project + configured cadence
  → reminder to lead
  → no update
  → follow-up nudges
  → dashed overdue / Update Missing / grey inactivity
```

## 5. 为什么成立

1. Peek 的价值来自“临时表面”，不是抽屉长相：位置、焦点和相邻导航连续。
2. 键盘把频繁阅读压成一个动作，但入口只靠快捷键也造成发现性问题。
3. Update 把 `health signal` 与 `explanation` 绑定：信号方便扫描，正文承担责任。
4. 最新 Update 位于 Overview，历史位于 Updates；当前判断与证据历史分层。
5. 系统自动补充进展事实，但作者可隐藏细节；机器事实没有替作者下结论。
6. Pulse 聚合的是已成形 Update，不把所有 Issue 事件包装成“社交动态”。

## 6. 风险与证据边界

1. Peek 只能键盘启动，首次使用者不容易发现；Chat 必须有可见入口和快捷键等价路径。
2. 高频灰阶、细小图标和密集元数据的对比度、200% 放大及触摸热区不能由截图证明。
3. `Popular` 用 emoji / 评论互动排序，会把工作监督带向参与度竞争。
4. Update 可以被编辑或删除；Chat 的决定与证据历史不能因此被覆盖。
5. Linear Project status 是人工更新，不会因为 Issue 全部完成而自动完成；Chat 也不能由子任务推导权威项目终态。
6. 官方文档证明功能语义，不证明焦点回落、屏幕阅读器播报、移动端等价交互与 Reduce Motion。

## 7. 对 Chat 的翻译

### Take

1. List → Peek → full detail 三档阅读速度。
2. 同一对象在多个表面保持身份与状态一致。
3. Project Update 是负责人署名、带时间和证据的叙事。
4. “未更新”是监督信号，不等于项目失败。

### Adapt

1. Peek 同时支持可见按钮、键盘和移动端半屏，关闭后恢复入口焦点与滚动。
2. Project Update 拆为 `author / health / narrative / evidence / observed changes / timestamp`。
3. Agent 可以起草 Update，但必须标记来源；人工采纳后才成为项目承诺。
4. Agent 动态聚合按“与我有关 / 需介入 / 最近”，不采用 Popular 默认排序。

### Refuse

1. 不复制 Linear 的黑灰、窄行高和快捷键专属入口。
2. 不把所有详情都做成右侧抽屉。
3. 不把事件流、模型摘要或点赞热度当成 Project Update。
4. 不允许 Update 修改覆盖 Decision、Run 或 Artifact 的权威历史。

## 8. 对 UI Lab 的约束

1. UL1 必须验证列表、Peek、详情之间同一 Work 的 revision 与状态一致。
2. Peek 支持相邻切换、Esc、可见关闭、焦点恢复及移动端等价交互。
3. Project Update 与 Agent Activity 必须是不同对象和不同视觉层级。
4. Health 旁必须显示作者、更新时间和证据入口；不能只有颜色圆点。
5. Agent draft 必须明确标识“候选”，采纳动作要版本绑定。
6. Pulse 不按互动热度作为默认顺序。

## 9. 官方证据

1. [Linear Peek preview](https://linear.app/docs/peek)。
2. [Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)。
3. [Pulse](https://linear.app/docs/pulse)。
4. [Project Overview](https://linear.app/docs/project-overview)。
5. [Project status](https://linear.app/docs/project-status)。
