# Microsoft Agent Feed 人—Agent—Run 参考原型 v0.2

这是 Microsoft Agent Feed v0.1 的独立适配原型。它保留 Fluent / Power Apps 的三栏监督语法、紧凑列表、类型色条、side/full 层级和移动端 Feed → Detail → Record 路径；只补齐 Chat 需要的人—Agent—Run 与 Agent—Agent 状态闭环。它不修改生产 UI，也不接真实生产后端。

## 体验与运行

- 本地 URL：`http://127.0.0.1:4184/`
- branch：`codex/microsoft-agent-feed-human-loop-v0.2`
- worktree：`/Users/xulater/Code/Chat-agent-feed-human-loop-v02`
- 实现：`docs/design/reference-implementations/microsoft-agent-feed-human-loop-v0.2`
- 基线：组合登记 commit `4079e3f2133d86421c4128f7f2db01c6790094c9`
- 原始视觉 freeze：`codex/microsoft-agent-feed-reference-v0.1` / `eed0aa0e4b9fec38fcf7e4eb6684a23e9897e8aa`
- 组合适配输入：implementation `58257710cd78285b7616067ba6685271e0c741ff`，registry `4079e3f2133d86421c4128f7f2db01c6790094c9`

本地开发：

```bash
npm install --prefer-offline
npm run dev -- --host 127.0.0.1 --port 4184
```

验证：

```bash
npm test
npm run test:sites
npm run build
```

## 5 条可点击闭环

1. **Decision 修订**：revision 7 → 查看 hash / scope / Evidence → Request changes → 自由文本 + 结构化要求 + Evidence + material filename → Agent revising → revision 8 → diff / 新 hash / 新 Evidence / 逐项响应 → Approve → Decision fact committed → Run resume → 执行 → 权威记录。
2. **Assistance**：权限或材料不足 → 人补充上下文、资源、人工操作结果或材料 filename → Agent 明确 receipt → Run resume → success / failure / 再次介入 → Evidence record。
3. **Structured candidate**：编辑 Health / Summary / Next step → Accept 或 Dismiss → 两种终态都只读；dismissed 再发起生成新 candidate ID。
4. **outcome_unknown 对账**：无普通 Retry → 按 command identity 查询 provider → 展示 query Evidence → Product Commit 或 manual disposition → reconciliation 正式事实无通用 Undo。
5. **多 Agent 委派**：Project Pilot → Evidence Scout，显示 parent/delegated task、dependency、participants、visibility 与 current owner → Evidence 返回 → Project Pilot 消费 → parent 继续；人可加方向、改派或停止。

URL 以 `tab`、`task`、`mode`、`agent`、`project`、`view` 保留投影和焦点。核心 fixture ID：

- `task-decision-retry`
- `task-assistance-source`
- `task-data-project-update`
- `task-outcome-unknown`
- `task-delegation-evidence`

## 状态与事实边界

- `Agent Feed` 只拥有监督投影；Project、Run、Decision、Update、Evidence 由 related Product Store fixture 拥有。
- 人工高影响动作绑定当前 revision、hash、scope 和 Evidence；过期页面审批被状态机拒绝。
- `waiting_human`、`waiting_agent`、`revising`、`resuming`、`executing`、`outcome_unknown`、`reconciling`、`reconciliation_found` 与各终态分开。
- `succeeded`、`failed`、`canceled`、`dismissed`、`reconciled` 不进入一个 Completed 大桶；UI 用 `Needs attention / Active / Recent results` 分投影。
- Agent—Agent coordination 只显示 participant visibility；消息明确标为 `Not Product facts`。
- 打开人工 composer 会暂停 fixture 的模拟 Agent 时钟，提交或取消后才继续。

## Microsoft Take / Chat Adapt / 明确 Refuse

### Take

1. Fluent / Power Apps 顶栏、应用 rail、站点导航与紧凑三栏监督。
2. 风险优先的 typed task、Agent + Project 过滤、side/full 和移动全屏详情。
3. related record + Back 的对象往返；Agent identity 与任务类型共同表达责任。

### Adapt

1. `Needs attention / Active / Recent results` 从同一状态投影计算，不保留硬编码 Insights。
2. Request changes 变为任务内结构化 composer；Decision 明确 revision 7→8、diff、Evidence 与 fact-before-resume。
3. Assistance、candidate、reconciliation、delegation 使用各自命令与状态机。
4. Related record 展示稳定对象 ID、Decision facts、Run timeline、Evidence references 与权威 owner。
5. 移动端改为原生单列层级；全部启用控件热区不小于 44×44。

### Refuse

1. Refuse Feed 成为 Product Run / Decision / Update / Evidence 事实源。
2. Refuse 万能 Approve / Complete / Undo、unknown side effect 的普通 Retry、按钮即成功。
3. Refuse 把 Request changes 扩成通用聊天，或把 Agent—Agent coordination 伪装成正式事实。
4. Refuse 硬编码 Insights、dismissed 可编辑、无限旋转与忽略 reduced-motion。
5. Refuse 虚构跨账户社交网络、好友关系或生产级 Agent 私聊系统。

## 稳定组合输入

组合原型只应复用以下稳定合同：

1. `src/agentFeedModel.js` 的 typed status、human/system action set、非法转换拒绝和 record projection。
2. 核心 fixture ID、4 个角色 Agent、4 个 Project 与 5 条主路径。
3. `Agent Feed projection → related authoritative record → Back` 的身份与焦点连续性。
4. revision/hash/scope/Evidence-bound Decision fact-before-resume；`outcome_unknown → reconciliation → Product Commit/manual disposition`。
5. CSS 的 Fluent tokens、三栏/full/mobile hierarchy、44px、focus-visible、modal 与 reduced-motion 合同。

不得复制本原型的内存存储方式到生产；生产接入必须通过 Chat Application / Product Store / Workflow 权威边界重新实现。

## QA 证据

- 当前 v0.1 复核：`evidence/current-audit/`
- v0.2 真实浏览器截图：`evidence/browser-qa/`
- 同视口同状态对照：`evidence/browser-qa/compare-v0.1-v0.2.jpg`（左 v0.1，右 v0.2）
- 结论与数字：[`design-qa.md`](./design-qa.md)
