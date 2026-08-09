---
status: approved
version: 0.1
date: 2026-08-09
branch: codex/microsoft-agent-feed-reference-v0.1
worktree: /Users/xulater/Code/Chat-agent-feed-reference-v01
---

# Microsoft Agent Feed 交互参考实现 v0.1

## 1. 目标

制作一个可运行、可点击、可验证的前端参考原型，研究多 Project、多 Agent 环境中，用户如何从统一监督 Feed 进入具体对象，完成一次类型正确的人机交接，再回到原位置。

本任务不修改 Chat 生产 UI，不冻结生产数据模型，不把 Microsoft preview API 当成技术合同。

## 2. 用户结果

1. 用户能先看到跨 Agent、跨 Project 的 `Needs attention`，而不是所有运行事件。
2. 用户能按 Agent、Project 和完成状态缩小范围。
3. 用户能在 side pane 与 full screen 之间切换。
4. 用户能完成 assistance、data entry、decision、outcome unknown 四种不同处置。
5. 用户能打开 related record，理解 Feed 是投影而非事实源。
6. 用户能通过 Undo 恢复最后一次可逆的原型动作。
7. 移动端先看到 Feed，进入 detail 后可返回。

## 3. 必须覆盖的交互

| ID | 场景 | 验收 |
|---|---|---|
| AF-01 | Needs attention / Completed | 同一对象只在正确投影中出现，计数随动作更新 |
| AF-02 | Agent / Project filter | 组合过滤，无重复对象，可清除 |
| AF-03 | Side pane / full screen | 同一 task、tab、filter 在两种布局间保留 |
| AF-04 | Assistance | Complete 后进入 Completed，并可 Undo |
| AF-05 | Data entry | 字段可编辑；Accept 提交接受值；Dismiss 不创建事实 |
| AF-06 | Decision | 显示 revision/hash；Approve 与 Request changes 语义不同 |
| AF-07 | Outcome unknown | 只允许 Reconcile；明确不发送 Retry |
| AF-08 | Informational review | Completed 中展示证据，不出现审批 CTA |
| AF-09 | Related record | 明确 Product Store 对象拥有权威状态 |
| AF-10 | Insights | 7/14/30 日可切换，并警告数量不等于价值 |
| AF-11 | Mobile | Feed-first；detail 全屏；Back 回列表 |
| AF-12 | Accessibility | 无静默按钮；禁用控件有原因；键盘焦点可见 |

## 4. 状态与不变量

1. Feed item ID 稳定；tab/filter/action 不复制或丢失对象。
2. `candidate` 与 `accepted` 分开；数据候选只有 Accept 后才成为接受结果。
3. `completed`、`dismissed`、`approved`、`in_progress`、`outcome_unknown`、`reconciling` 不合并。
4. `outcome_unknown` 不提供 Retry。
5. request review 没有用户动作。
6. Feed 中 Project、Agent、Run 状态只是投影；相关对象才是权威事实。

## 5. 验收命令

```bash
cd docs/design/reference-implementations/microsoft-agent-feed
npm test
npm run build
npm run test:sites
```

还必须完成 1440×900 桌面、390×844 移动端的真实浏览器主路径、控制台和视觉对照 QA，并在 `design-qa.md` 记录结果。

## 6. 完成记录

2026-08-09 已完成 15 项模型/交互合同、4 项 Sites 合同、生产构建，以及桌面与移动端浏览器验证。最终场景覆盖见 `docs/design/references/microsoft-agent-feed-scenario-coverage-v0.1.md`，视觉和交互证据见原型根目录 `design-qa.md`。

## 7. 原型依赖

| 依赖 | 用途与所有权 | 退出方式 | 许可证 |
|---|---|---|---|
| `@fluentui/react-icons` | 只在独立参考原型中提供与 Microsoft 视觉语言一致的系统图标；不进入 Chat Domain | 替换 `App.jsx` 图标 import，不影响状态模型 | MIT |
| `recharts` | 只渲染 Insights 7/14/30 天柱状图；图表数据仍由本地 fixture/model 拥有 | 更换图表 renderer；`insightsByPeriod` 合同保持不变 | MIT |

两个依赖都不进入生产 Workspace，也不拥有网络、存储、Agent 或 Product 事实。
