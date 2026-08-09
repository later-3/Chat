---
status: approved
version: 0.1
date: 2026-08-09
reference: Microsoft Power Apps Agent Feed
prototype: docs/design/reference-implementations/microsoft-agent-feed
---

# Microsoft Agent Feed 场景覆盖 v0.1

## 1. 冻结结论

本原型已经覆盖 Chat 当前需要的“多 Agent 动态与监督”参考场景，可以冻结。这里的动态不是社交帖子或底层事件流，而是由 Project、Run、Decision、Update、Evidence 投影出的类型化监督任务。

Microsoft 原型回答了“怎么把多个 Agent 的待办交给人处理”；Chat 还必须回答“对应哪个长期 Project、动作影响哪个 Run、候选何时成为事实、外部结果未知怎么恢复”。这些差异已经在原型中显式补齐。

## 2. 场景覆盖矩阵

| 场景 | 当前覆盖 | 原型证据 | 结论 |
|---|---|---|---|
| 多 Agent 汇总 | 完整 | 4 个有身份、职责、运行状态的 Agent；统一 Feed | Take |
| 多 Project 动态 | 完整 | 4 个 Project；task 同时显示 Agent 与 Project | Take + Adapt |
| 用户优先看到需要介入 | 完整 | Needs attention 默认；critical/high risk 排序先于时间 | Take + Adapt |
| Agent 请求人工补充 | 完整 | Assistance → Complete → Completed → Undo | Take |
| Agent 提出结构化变更 | 完整 | 可编辑 Project Update candidate；Accept / Dismiss | Take + Adapt |
| 高影响人工决定 | 完整 | revision、hash、scope、evidence；Approve / Request changes | Chat 增补 |
| Agent 运行异常 | 完整 | `outcome_unknown` → Reconcile → provider result；无 Retry | Chat 增补 |
| Agent 自动完成后只读复核 | 完整 | Completed request review；证据可读；无假审批按钮 | Take |
| 回到权威业务对象 | 完整 | Open record 展示对象类型、status、Product Store owner | Adapt |
| 轻量扫视与集中处理 | 完整 | side pane / full screen；URL 保留 tab/task/filter/mode | Take |
| Agent / Project 过滤 | 完整 | filter popover + full-screen agent column；列表详情同步 | Take |
| 多 Agent 活动洞察 | 完整 | 7/14/30 天切换；Agent/user completed；价值警告 | Take + Refuse 排名 |
| 移动端监督 | 完整 | Feed-first；detail full-screen；Back 保留挂载列表位置 | Chat 增补 |
| 个人生活/兴趣 Project | 边界覆盖 | `Personal Studio` fixture 与已 dismiss 候选 | 后续项目深化 |
| 用户与其他用户互动 | 未在本参考实现 | 当前权限警告与 participant-private 风险已记录 | 未来单独研究 |
| 用户 Agent 与其他用户 Agent 互动 | 未在本参考实现 | 不让 Feed 在权限不清时充当定向消息系统 | 未来单独研究 |

## 3. Chat 可复用的交互语法

```text
Authoritative object changes
  → projection rule decides whether user intervention is needed
  → typed Feed task appears with Agent + Project + object type
  → user opens related context
  → task-specific command
  → pending / in_progress / completed / dismissed / outcome_unknown
  → authoritative object records result
  → Feed updates projection
```

这条语法可用于软件项目、内容调研、生活安排和兴趣计划，因为它不要求所有事务变成 Issue，也不要求所有 Agent 动态都进入同一个社交流。

## 4. 不进入生产规范的部分

1. Microsoft preview API、Power Apps MCP 限制和 Agent Task table 不是 Chat 架构。
2. Fluent 紫色壳层、Power Apps sitemap 和示例信息架构只用于视觉/交互参考。
3. fixture 内的 Agent 数量、名称、任务数、Insights 数字都不构成生产要求。
4. `Needs attention / Completed` 两个 tab 不足以表达 Chat 全部终态；生产设计仍要区分 failed、canceled、dismissed、outcome_unknown。
5. 当前原型不证明跨用户隐私、通知投递、Agent-to-Agent 协议或生产权限模型。

## 5. 对产品路线的价值

1. **当前多项目推进**：已经证明统一入口可以承载跨 Project 的决定、补充、更新和运行异常，而不吞掉对象身份。
2. **后续多个 Agent 发动态**：已经证明动态需要先类型化再展示，Agent identity 与 task action 必须分离。
3. **未来生活/娱乐/爱好管理**：同一投影语法可复用，但需要在 Heptabase/Workbench 与 Calendar 参考中继续验证资料编排和长期节奏。
4. **未来用户/Agent 社交互动**：本轮只冻结权限和事实边界，不提前设计社交 Feed；需要另立 participant、visibility、consent、moderation 场景研究。

## 6. 下一参考

进入 Heptabase Workbench：验证 Card identity、资料/想法的空间关系、多个 Project 的知识编排，以及 Agent 贡献如何落到可复用工作台，而不是停在 Feed 中。
