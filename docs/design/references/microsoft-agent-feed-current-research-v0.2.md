---
status: approved-input
version: 0.2
date: 2026-08-09
product: Microsoft Power Apps Agent Feed
surface: Agent Feed preview
evidence: official-docs + official-release-plan + locally-inspected-link-only-screenshots
---

# Microsoft Agent Feed 当前研究快照 v0.2

## 1. 本次复核结论

Microsoft Agent Feed 截至 2026-08-09 仍是 preview。它最有价值的不是“Agent 发动态”，而是把多 Agent 工作投影成少量、类型化、可处置的监督任务：用户先区分 `Needs attention` 与 `Completed`，再根据任务类型执行不同命令。

对 Chat 的直接启发是：Agent 可以持续产生更新，但统一 Feed 必须回答“为什么现在需要我、我在决定什么、动作会恢复哪个 Run、结果记录在哪里”。它不能成为 Project、Run、Decision 或 Evidence 的权威事实源。

## 2. 2026-08-09 官方事实

1. [用户文档](https://learn.microsoft.com/en-us/power-apps/user/supervise-agents-with-agent-feed)最后更新于 2026-04-07，功能仍标为 preview。
2. [Release plan](https://learn.microsoft.com/en-us/power-platform/release-plan/2025wave2/power-apps/supervise-autonomous-agents-agent-feed)最后更新于 2026-07-23，仍描述为逐步推出。
3. 自 2026-05-01 起，Agent Feed 只支持使用 Power Apps MCP server 的 Agent。
4. 当前只支持英语；可用性依赖环境与逐步发布。
5. 所有拥有 Agent Task table 访问权的用户都可能看见 Feed item。官方因此警告不要用它向特定用户定向发送可能私密的任务。
6. 官方主要分组仍是 `Needs attention` 与 `Completed`。
7. `request_assistance` 提供 `Complete`；`invoke_data_entry` 提供 `Accept and complete` 与 `Dismiss`；`request_review` 是只读信息项。
8. Full screen 支持 Agent filter；Side pane 保留当前业务上下文；related record 返回 Dataverse 业务对象。
9. 每个分区初始最多 20 条，继续滚动后懒加载，默认按最后修改时间排序。
10. Insights 提供 7、14、30 天的 Agent 完成数与用户完成数，但数量不是质量或价值。

## 3. 当前界面结构

```text
Model-driven app shell
├── sitemap / current business app
├── Agent Feed side pane
│   ├── Needs attention | Completed
│   ├── filter / full-screen controls
│   └── compact feed rows
└── related record / task detail

Full-screen Agent Feed
├── agent filter column
├── task feed
└── task detail or Insights
```

视觉上使用 Fluent 的白色/浅灰壳层、细分隔线、低圆角、紧凑列表、紫色品牌强调。Feed row 不是独立营销卡片；选择状态通过浅色底与窄强调边表达。

## 4. 场景翻译

| 官方类型 | 官方动作 | Chat 中验证的场景 | Chat 必须增加的边界 |
|---|---|---|---|
| `request_assistance` | Complete | Agent 缺来源、权限或用户输入 | 显示阻塞对象与恢复的 Run |
| `invoke_data_entry` | Accept and complete / Dismiss | Agent 提出结构化 Project Update | 候选与正式事实分离，接受后才提交 |
| `request_review` | 无动作 | Agent 完成参考冻结或证据刷新 | 不伪造审批；链接到真实证据 |
| 无直接对应 | 无 | 高影响 Decision | revision、hash、权限、幂等绑定 |
| 无直接对应 | 无 | 外部副作用 `outcome_unknown` | 只能对账，不能普通重试 |

## 5. Take / Adapt / Refuse

### Take

1. 默认把真正需要用户介入的工作放在第一视图。
2. 任务类型决定动作，不提供万能 CTA。
3. Agent、Project、时间、类型和 related object 同时可见。
4. Side pane 与 full screen 支持轻量扫视和集中处理两种注意力强度。

### Adapt

1. Feed item 只做 Product Store 权威对象的投影。
2. 把 `Completed` 大桶扩展为明确 outcome；本原型至少显示 approved、accepted、dismissed、succeeded。
3. 排序先考虑 critical/high impact，再考虑时间，避免旧高风险任务被覆盖。
4. 为 Chat 增加 Decision 与 `outcome_unknown` 两种监督任务。
5. 图表只表达工作负载，不做 Agent 排名。

### Refuse

1. 不复制权限边界不明的定向 Feed。
2. 不让 Agent 自报完成等于业务成功。
3. 不把 Agent 动态做成连续事件火hose或社交 Feed。
4. 不合并接受候选、普通完成、批准决定和对账。
5. 不用纯最后修改时间决定风险排序。

## 6. 证据边界

官方截图仅在本地临时研究目录中用于同屏视觉对照，未复制进仓库。仓库长期保留官方链接、观察结论、Chat 转译、自己实现的原型与 QA 证据。
