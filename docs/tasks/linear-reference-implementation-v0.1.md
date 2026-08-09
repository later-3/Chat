---
status: frozen
version: 0.1
date: 2026-08-09
owner: Chat product design
task_type: reference-study prototype
branch: codex/linear-reference-v0.1
---

# Linear Peek、Project Updates 与 Pulse 参考实现 v0.1

> 2026-08-09 完成场景验收并冻结。实现、自动化合同、浏览器交互与视觉对照均通过；冻结结论见 [`linear-scenario-coverage-v0.2.md`](../design/references/linear-scenario-coverage-v0.2.md)，视觉证据见参考实现内的 [`design-qa.md`](../design/reference-implementations/linear/design-qa.md)。

## 1. 用户结果

用户可以在浏览器里实际体验 Linear 如何把工作阅读拆成 3 个速度：列表扫描、Peek 临时理解、完整详情；也可以体验负责人如何从 Project Overview 发布带健康判断、叙事、事实变化与讨论的 Project Update，并在 Pulse 中跨项目阅读。

这个原型用于研究 Linear 解决的场景，不是把 Linear 视觉直接翻译成 Chat。参考实现本身会忠实保留官方当前深色界面的密度、层级和交互节奏；`Take / Adapt / Refuse` 只约束之后的 Chat 转译。

## 2. 当前官方变化

1. Peek 仍由 `Space` 打开，可按住临时预览，使用 `↑ / ↓` 切换相邻对象，`Esc` 关闭。
2. Project Update 仍由健康状态与负责人叙事组成，并附带系统观察到的进度事实、历史、评论与提醒。
3. Pulse 提供 `For me / Popular / Recent` 和个人 custom feeds；默认重点是与用户有关的 Update，不是原始 Issue 事件流。
4. 2026-06-18 起，Project Update 支持 `Write with Agent`：Agent 读取上次更新后的 Issue、Document、Discussion 与关联 Slack，生成候选草稿；用户继续修改后才发布。
5. 2026-07-23 起，Agent 辅助编辑的变化会单独高亮并可通过版本历史恢复；作者归属仍可检查。

## 3. 场景范围

### 3.1 Issue List → Peek → Detail

1. Issue List 支持筛选、选择与清楚的 row focus。
2. 可见 `Peek` 动作与 `Space` 快捷键等价；鼠标用户不依赖隐藏知识。
3. Peek 展示判断是否深入所需的 description、status、priority、assignee、cycle、labels、estimate 与时间。
4. Peek 打开后 `↑ / ↓` 切换相邻 Issue，列表 focus 与 preview 同步。
5. `Esc` 或 Close 关闭 Peek 并恢复列表焦点；Open full issue 进入完整详情。
6. 浏览器 Back 返回 List 时恢复选中 Issue，不复制对象状态。

### 3.2 Project Overview → Update → History

1. Project Overview 显示目标、lead、target date、milestone progress 和 latest update。
2. Write update 打开 composer，必须选择 `On track / At risk / Off track` 并填写叙事。
3. 系统事实与负责人判断分区显示；状态不只靠颜色。
4. `Write with Agent` 产生标记为候选的 draft，列出使用的来源与 observed changes；用户可编辑、重新生成或丢弃。
5. 只有用户点击 Publish 后才进入 latest update、Updates history 和 Pulse；Agent candidate 不自动成为正式 Update。
6. Update 支持 comment 与 reaction；历史同时显示 authored update 和 property changes。

### 3.3 Pulse 与更新节奏

1. `For me / Popular / Recent` 打开不同聚合；默认 For me。
2. 每条 Pulse item 保留 Project identity、health、author、time、narrative、comment/reaction 和 deep link。
3. Update schedule 支持 Default / Custom / Never；过期显示 `Update due / Update missing` 文本与图形，而不是只变灰。
4. Custom feed 只改变个人阅读入口，不改变 Project 或 Update 事实。

## 4. 数据合同

1. `Issue`、`Project`、`ProjectUpdate`、`ObservedChange`、`Comment` 各有稳定 ID。
2. List、Peek、Detail 使用同一 Issue 对象；修改 status/assignee 后所有投影同步。
3. Agent draft 与 published update 是不同状态：`candidate → edited → published | discarded`。
4. Project health 由负责人显式发布，不从 Issue 完成率自动推导。
5. Pulse 只投影 published update；不能显示未发布 Agent draft。
6. Update history 追加新 revision，不以编辑覆盖已有证据。

## 5. UI 完成门

1. 默认视觉以当前官方 Peek、Project Update 和 Pulse 截图为真相，桌面优先，适配 390px。
2. 列表、Peek、Project Overview、composer、Updates history、Pulse、Update schedule 有独立可深链接状态。
3. 触控目标不少于 44px；焦点清楚；Peek 关闭恢复焦点；状态使用图标/文字/颜色三通道。
4. 主要按钮必须导航、改变同一份内存状态、打开可操作弹层，或明确 disabled；无静默 no-op。
5. 参考截图与原型同尺寸比较后修完 P0/P1/P2，`design-qa.md` 为 passed。

## 6. 明确不做

1. 不接 Linear API、Slack、真实 Agent、外部通知或服务端持久化。
2. 不实现完整 Linear Workspace、Roadmap、Cycle、Triage、Diffs、Releases 或 Command menu。
3. 不复制到 Chat 生产 UI，不把 Linear 的 `Pulse`、黑灰、密度或快捷键文化自动变成 Chat 规范。
4. 不让 Agent draft 自动发布，不用 engagement 排序替代“与我有关 / 需要介入”。

## 7. 研究依据

1. [Peek preview](https://linear.app/docs/peek)
2. [Initiative and Project updates](https://linear.app/docs/initiative-and-project-updates)
3. [Pulse](https://linear.app/docs/pulse)
4. [Project overview](https://linear.app/docs/project-overview)
5. [Project status](https://linear.app/docs/project-status)
6. [Agent assisted project updates](https://linear.app/changelog/2026-06-18-agent-assisted-project-updates)
7. [Text attribution and agent-assisted editing](https://linear.app/changelog/2026-07-23-text-attribution-and-agent-assisted-editing)

## 8. 新依赖说明

- `@phosphor-icons/react@2.1.10`：只负责参考原型的一致线性图标；由该原型拥有，不进入 Chat 生产依赖图；MIT License。退出方式是移除包并换成届时选定的 Chat 图标系统，不影响任何数据合同或交互状态机。
