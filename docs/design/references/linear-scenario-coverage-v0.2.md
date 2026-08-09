---
status: frozen
version: 0.2
date: 2026-08-09
product: Linear
surface: Issue List + Peek + Project Updates + Pulse
evidence: official-docs + official-current-screenshots + runnable-prototype + browser-qa
---

# Linear 场景覆盖与冻结结论 v0.2

## 1. 冻结结论

Linear 参考原型已经覆盖本轮真正要研究的 4 类场景，可以冻结：

1. 高频列表中快速扫描，不因理解一个对象而丢掉位置。
2. 用 Peek 在“列表摘要”和“完整详情”之间增加低成本阅读层。
3. 由项目负责人把系统事实组织成带健康判断的阶段叙事。
4. 通过 Pulse、历史、讨论和更新节奏，让项目判断可回看、可介入、可追责。

冻结的是研究原型与场景结论，不是把 Linear 的黑灰视觉、Popular 排序或快捷键文化冻结为 Chat 规范。

## 2. 已覆盖场景矩阵

| # | 用户场景 | 原型入口 / 操作 | 验收结果 |
|---|---|---|---|
| 1 | 在密集 Issue 中扫描状态、标题、标签、Cycle、估算与负责人 | `My issues` | 已覆盖；6 个稳定对象，Active / Closed 分组与状态筛选有效 |
| 2 | 鼠标用户发现 Peek | 每行 Eye、工具栏 Peek | 已覆盖；可见入口与快捷键等价 |
| 3 | 键盘临时阅读 | 选中行后 `Space`；按住再松开 | 已覆盖；短按保持、长按松开关闭 |
| 4 | 连续检查相邻对象 | Peek 内 `↑ / ↓` 或按钮 | 已覆盖；URL、列表选择与预览同步 |
| 5 | 关闭后继续原位置工作 | `Esc` / Close | 已覆盖；焦点恢复到对应 Issue row |
| 6 | 从临时理解进入完整操作 | Open full issue | 已覆盖；进入稳定深链 Detail |
| 7 | 多表面状态不分叉 | Detail 修改 Status / Assignee，再返回 Peek | 已覆盖；List、Peek、Detail 使用同一 Issue 对象 |
| 8 | 项目负责人理解当前计划与最新判断 | Project Overview | 已覆盖；目标、lead、target、progress、milestone、latest update 分层 |
| 9 | 人工撰写项目健康判断 | Write update | 已覆盖；Health + narrative 是发布前必要条件 |
| 10 | Agent 从近期上下文起草 | Write with Agent | 已覆盖；候选明确标为未发布，列出 sources 与 observed changes |
| 11 | 人对候选负责 | 编辑正文 → Publish update | 已覆盖；候选可编辑、重新生成、丢弃，只有人工 Publish 才发布 |
| 12 | 发布结果进入多个阅读面 | Overview / Updates / Pulse | 已覆盖；发布一次后 3 个投影同步，保留 Agent-assisted 来源标识 |
| 13 | 回看项目判断及系统变化 | Updates history | 已覆盖；署名叙事与 observed project changes 分开保存 |
| 14 | 围绕一条 Update 协作 | Comment / reactions | 已覆盖；评论和两种 reaction 锚定同一 Update |
| 15 | 按责任、热度、时间和个人条件阅读 | Pulse `For me / Popular / Recent / At risk projects` | 已覆盖；默认 For me，Popular 明示不适合作为责任默认序 |
| 16 | 规定更新节奏并识别缺失 | Update schedule `Default / Custom / Never` | 已覆盖；计划变化不修改 health；Relay 显示 Update due / Update missing |
| 17 | 桌面与移动端保持同一任务 | `1440 × 868`、`391 × 844` | 已覆盖；移动端列表、底部 Peek、Project Update composer 无横向溢出 |
| 18 | 识别原型边界而不误点 | 非范围按钮 | 已覆盖；核心控件均有真实状态变化，范围外控件 disabled 或提供明确说明 |

## 3. 关键产品不变量

1. `List → Peek → Detail` 是同一对象的 3 个投影，不复制 Issue。
2. Agent draft 是候选，不是 Project Update；候选不会进入 Pulse。
3. Project health 是负责人判断，不由 Issue 完成率自动计算。
4. observed changes 是系统事实，narrative 是作者解释，两者同时显示但不混为一物。
5. Pulse 只聚合 published update；custom feed 只改变个人阅读入口。
6. Update schedule 改变“何时需要新判断”，不改变当前健康事实。

## 4. Take / Adapt / Refuse

### Take

1. 列表扫描、Peek 临时理解、完整详情 3 档阅读速度。
2. 项目最新判断放在 Overview，历史证据放在 Updates。
3. Health signal 与负责人叙事绑定，Update 可评论、可引用。
4. “应该更新但还没更新”成为明确监督信号。

### Adapt

1. Chat 的 Peek 必须有可见入口、键盘入口和移动端等价表面。
2. Chat 的 Project Update 需要 `author / health / narrative / evidence / observed changes / publishedAt`。
3. Agent 可以起草，但必须显示来源、变更与候选状态，人工采纳后才形成承诺。
4. Feed 默认按“与我有关 / 需介入 / 最近”，热度只作为可选探索视角。

### Refuse

1. 不复制 Linear 的品牌色、细小灰字、密集窄行和快捷键专属入口。
2. 不把所有对象详情都做成 Peek，也不让 Peek 承担完整编辑器。
3. 不把 Issue event stream、模型摘要或互动量伪装为项目负责人 Update。
4. 不允许编辑已发布叙事时覆盖 Decision、Run 或 Artifact 的权威历史。

## 5. 未覆盖但不阻塞冻结

1. 真实 Linear API、Slack 双向同步、通知发送与持久化。
2. 完整 Workspace、Inbox、Cycle、Roadmap、Triage、Command menu 与 Issue 创建。
3. 真实模型生成质量、版本历史 diff 和多人并发冲突。
4. 生产级 WCAG / 屏幕阅读器矩阵；原型已覆盖语义标签、键盘路径、焦点恢复和移动端可用性。

这些项目属于集成或产品化范围，不会改变本轮 4 类设计场景的结论。

## 6. 证据

1. 任务与数据合同：[`linear-reference-implementation-v0.1.md`](../../tasks/linear-reference-implementation-v0.1.md)。
2. 视觉 QA：[`design-qa.md`](../reference-implementations/linear/design-qa.md)。
3. 交互合同：`docs/design/reference-implementations/linear/tests/linear-interactions.test.mjs`，14/14 tests passed（其中 10 条 Linear 状态合同）。
4. 浏览器实测：相邻 Peek、焦点恢复、Detail 同步、Agent candidate、人工发布、历史讨论、计划频率、Pulse 4 个 feed、桌面与移动端。
5. 官方依据：[Peek](https://linear.app/docs/peek)、[Project updates](https://linear.app/docs/initiative-and-project-updates)、[Pulse](https://linear.app/docs/pulse)、[Agent-assisted Project Updates](https://linear.app/changelog/2026-06-18-agent-assisted-project-updates)。
