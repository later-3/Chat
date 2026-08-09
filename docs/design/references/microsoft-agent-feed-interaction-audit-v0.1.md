---
status: approved
version: 0.1
date: 2026-08-08
product: Microsoft Power Apps Agent Feed
surface: Needs Attention + Completed + Agent Pane
evidence: official-preview-docs + official-product-screenshots
---

# Microsoft Agent Feed 交互审计 v0.1

## 1. 结论

Microsoft Agent Feed 真正值得借的是“监督分流”，不是社交 Feed：Agent 产生的是带类型的任务，界面先分 `Needs Attention` 与 `Completed`，再由任务类型决定 `Complete`、`Accept and complete`、`Dismiss` 或无动作。

但它不能成为 Chat 的事实模型。当前功能仍是 preview，权限边界存在公开警告，而且 Feed item 只是 Agent Task 的呈现。Chat 必须让 Product Run、Decision、Artifact 和外部副作用各自拥有权威状态；Feed 只是个人监督投影。

## 2. 对象与责任

```text
Agent execution
├── request_assistance → Needs Attention → human Complete → callback / resume
├── invoke_data_entry  → Needs Attention → Accept and complete | Dismiss
└── request_review     → Completed → informational, no user action

Agent Feed projection
├── task title / description / optional steps
├── agent identity + timestamp
├── related Dataverse record link
└── side pane | full screen
```

关键区分：`Needs Attention` 是呈现分组，`task type` 才决定可执行命令；“已显示在 Completed”也不自动证明业务结果成功。

## 3. 点击与操作地图

| # | 入口 / 操作 | 结果与反馈 | 证据 | 设计理由 |
|---|---|---|---|---|
| 1 | App sitemap 的 Agent Feed | 打开统一任务流 | `D+O` | 把 Agent 监督放入业务 App，而非独立聊天窗口 |
| 2 | Side pane / full screen | 在并行工作与集中审核之间切换 | `D` | 同一对象支持两种注意力强度 |
| 3 | Needs Attention | 显示 request_assistance / invoke_data_entry 产生的待处理项 | `D+O` | 用户先看到真正阻塞 Agent 的工作 |
| 4 | Completed | 显示用户完成、Agent 完成及 request_review 信息项 | `D+O` | 将需行动与留痕分开 |
| 5 | Agent filter | 只看选定 Agent 的任务 | `D` | 多 Agent 环境下快速缩小责任范围 |
| 6 | Feed item | 查看标题、描述、步骤、Agent、时间；可进入详情 | `D+O` | 扫描信息与处理上下文分层 |
| 7 | Related record link | 打开关联 Dataverse record | `D` | 从监督任务回到业务事实 |
| 8 | request_assistance 的 Complete | 人工完成 Agent 无法完成的事后移入 Completed | `D` | 人类补全缺口，并向等待中的 Agent 回传 |
| 9 | data entry 的 Accept and complete | 审阅建议后接受并完成 | `D` | “接受建议”与普通完成使用不同命令 |
| 10 | data entry 的 Dismiss | 移除不再相关的待处理项 | `D` | 允许拒绝候选，而不是强迫完成 |
| 11 | request_review item | 仅信息展示，无用户动作 | `D` | Agent 已自主完成时避免伪造审批按钮 |
| 12 | Scroll | 每区默认 20 条，按最后修改时间排序并懒加载 | `D` | 控制初始负载；范围感和位置恢复仍需实测 |
| 13 | Insights 7 / 14 / 30 days | 聚合 Agent 完成与用户完成数量 | `D` | 提供协作分布，但不能代替单项证据 |

## 4. 关键路径

### 4.1 Agent 阻塞，异步等待人类

```text
Agent request_assistance
  → Feed: Needs Attention
  → user opens task + related record
  → performs missing work
  → Complete
  → task moves to Completed
  → callback resumes waiting agent
```

### 4.2 结构化候选需要明确接受

```text
Agent invoke_data_entry
  → suggested changes in agent pane
  → human reviews
  → Accept and complete | Dismiss
```

### 4.3 自动完成只要求复核

```text
Agent request_review
  → Completed
  → open evidence / related record
  → no approval action
```

## 5. 为什么成立

1. Feed 按用户是否需要介入分组，比按 Agent 或时间的纯事件流更接近监督任务。
2. 任务类型决定动作，避免每张卡都出现通用“批准 / 完成”。
3. Side pane 保留业务上下文，full screen 支持批量审核。
4. Agent identity、timestamp、steps 与 related record 提供最低限度可追溯性。
5. Agent 可以异步等待人类输入，监督动作真正影响执行，而非只发通知。

## 6. 风险与证据边界

1. 官方页面明确标记 preview、逐区推出且接口条件会变化，不能据此冻结 Chat 架构。
2. 当前所有能访问 Agent Task table 的用户可能看到 Feed item；官方要求避免定向记录私有任务，这是严重权限警告。
3. `Completed` 同时容纳人类完成、Agent 完成和信息项，无法单独表达 failed、canceled、outcome_unknown。
4. 按 last modification 排序可能让旧的高风险任务被新低价值变化推下去。
5. 懒加载、side pane、图表和 Agent filter 的键盘 / 屏幕阅读器体验无法由文档证明。
6. Insights 的“人完成 vs Agent 完成”数量容易被误读为质量和价值。

## 7. 对 Chat 的翻译

### Take

1. 默认先显示 `需要我介入`，再显示 `最近完成 / 仅供查看`。
2. 每个动态必须显示 Agent、时间、对象类型和关联 Project。
3. 任务类型决定动作；没有通用万能 CTA。
4. Human input 可以暂停和恢复耐久 Run。

### Adapt

1. Feed item 只是 `Decision / Work / Run / Artifact` 的投影，点击回到权威对象。
2. 分组至少区分 `需要决定 / 需要补充 / 运行异常 / 仅供查看 / 最近完成`。
3. 高影响 Decision 使用版本、hash、权限和幂等校验；不能用普通 Complete。
4. `outcome_unknown`、failed、canceled 与 completed 分开，外部副作用提供对账入口。
5. 默认排序结合风险、阻塞关系与时间，不采用纯热度或纯最后修改时间。

### Refuse

1. 不让 Agent 自报的 Feed task 成为产品权威事实。
2. 不复制模糊的 Completed 大桶。
3. 不把接受建议、完成任务、批准高影响动作合并为一个按钮。
4. 不在权限边界不明时展示可能包含私密上下文的动态。
5. 不用 Insights 数量塑造 Agent 排名或社交竞争。

## 8. 对 UI Lab 的约束

1. UL1 Agent surface 必须演示 4 种不同动作：补充信息、版本绑定决定、运行异常处置、只读复核。
2. 每张卡点击后回到权威对象，并显示证据、revision 与受影响范围。
3. 执行动作后提供 pending / succeeded / failed / outcome_unknown，不直接乐观变成 Completed。
4. 需要介入的原因由产品规则投影，不能只信 Agent 文字。
5. Filter、tab、side pane 和移动端页面保持焦点、滚动与返回位置。

## 9. 官方证据与限制

1. [Supervise agents with agent feed](https://learn.microsoft.com/en-us/power-apps/user/supervise-agents-with-agent-feed)。
2. [Power Apps MCP server](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/power-apps-mcp-server)。
3. [Release plan: supervise autonomous agents](https://learn.microsoft.com/en-us/power-platform/release-plan/2025wave2/power-apps/supervise-autonomous-agents-agent-feed)。

截至 2026-08-08，官方用户文档仍将其标记为 preview；本审计只借交互模式，不为当前 API、权限模型或正式可用性背书。
