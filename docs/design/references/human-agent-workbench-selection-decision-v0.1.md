---
status: approved
version: 0.1
date: 2026-08-12
scope: 用户在工作台选择器中确认的骨架、场景机制、共同缺口与下一阶段方向
source_selector: human-agent-workbench-selector-v0.1.html
frozen_skeleton: 2536cb4d22d9108bf7350dc911f8e9781c4e2f61
---

# 人—Agent 工作台选择决定 v0.1

## 1. 这份记录解决什么问题

交互式选择器把选择保存在浏览器本地状态，不能独立充当跨 Session 的长期记录。本文件把用户于 2026-08-12 导出的选择结果固化为可审计文档，并说明这些选择怎样影响后续 Chat 前端设计。

这些选择表示“认可、可继续参考”，不等于要求把所有来源同时塞进一个页面，也不表示对应能力已经进入生产前端。

## 2. 已认可的整体骨架

用户认可 9 个方向：

1. `K1` 项目房间 · Basecamp
2. `K2` 今日清单 · Things
3. `K4` 工作列表 + 快速预览 · Linear
4. `K5` Agent 监督队列 · Microsoft Agent Feed
5. `K6` 知识画布 · Heptabase
6. `K7` 对话中心工作台 · AnythingLLM
7. `K8` 执行现场 + 边车 · Open Computer
8. `K9` 任务隔离多窗格工作台 · Orca
9. `K10` 项目对象外壳 · Plane

多选只表示这些骨架分别在某些场景可用，不存在“九套页面同时成为默认首页”的结论。

## 3. 11 组场景选择

| 场景 | 用户认可的机制 | 参考来源 |
|---|---|---|
| S1 对话、目标澄清与计划确认 | 对话内澄清卡片；独立决定详情 | AnythingLLM Survey；Agent Feed |
| S2 项目、工作列表与候选审核 | List → Peek → Detail；多布局看板 | Linear；Plane |
| S3 Agent 执行现场 | 电脑桌面；任务隔离工作间；对话内嵌进度 | Open Computer；Orca；AnythingLLM |
| S4 Agent 身份、团队、参与与权限边界 | 监督身份 + 委派 | Agent Feed |
| S5 Agent 能力、工具、记忆与上下文 | 能力 / MCP 同页管理；显式上下文 + 来源 | AnythingLLM；Heptabase |
| S6 多 Agent 动态、监督与人工介入 | 类型化监督队列 | Agent Feed |
| S7 工作流定义、配置与触发 | Chat 自建；本轮暂缓具体页面 | Chat |
| S8 运行进度、暂停、失败与对账 | 等待 → 决定 → 恢复成功；`outcome_unknown` 对账 | Agent Feed |
| S9 文件、Diff、产物与证据审阅 | Diff 行级批注 | Orca |
| S10 今天、待办与日历 | Today 注意力投影 | Things |
| S11 进展、动态、交付与历史 | 房间 Activity 投影 | Basecamp |

用户明确说明 Workflow 暂时不优先；以后可参考思维导图、树、DAG 或有环图表达，但不能因为有图就跳过 Definition version、发布、审批和运行事实边界。

## 4. 现有参考共同缺口

无论怎样组合，以下 12 项仍需要 Chat 自建：

1. 完整耐久 Agent Profile。
2. 显式 Goal / 假设 / 范围对象。
3. 版本化 Plan 确认完整闭环。
4. 真正 Pause / Resume。
5. Workflow Definition 版本 / 发布 / 审批。
6. 事件触发与对象变化触发。
7. 权限 / 可见 / 写回范围 / consent 完整合同。
8. 正式 Evidence 验证、贡献归属与完成门。
9. 工具授权与外部副作用对账界面。
10. 跨表面连续性：同一 Work 保持 identity、revision、返回位置和草稿。
11. 多人 + 多 Agent 的工作动态流 / 社交互动形态。
12. 移动端等价交互路径。

## 5. 已冻结的统一骨架方向

冻结产物为 [`chat-unified-workbench-skeleton-v0.1.html`](./chat-unified-workbench-skeleton-v0.1.html)，实现 freeze `2536cb4d22d9108bf7350dc911f8e9781c4e2f61`，登记 commit `45dc6394c9fea902a80cdc1525cc52a36e8e0d79`。

它冻结的是参考交互，不是生产 UI：

1. 对话是默认主入口。
2. 左侧导航承载 Workspace / Project / Session 与跨场景入口。
3. 文件、Diff、Artifact、Run、Browser、Canvas 等工作表面按需打开。
4. 进入执行现场时，对话可以退为边车；用户能返回原对话位置。
5. 同一 Work / Run / Artifact 跨表面保持身份和连续性。

## 6. 对生产前端的已确认方向

当前前端差距和第一阶段建议见 [`current-chat-frontend-workbench-adaptation-audit-v0.1.md`](./current-chat-frontend-workbench-adaptation-audit-v0.1.md)。建议不是“重做整套产品”，而是：

1. 复用现有 `WorkspaceShell` 的侧栏、折叠、会话切换和响应式能力。
2. 复用现有 `RealWorkspace` 的真实 Chat、Project、Run、Notes、Rules 与 Workflow Designer 内容。
3. 把两套壳统一成左侧导航 + 中间对话 + 按需右侧工作区。
4. 以 Codex 式按需展开决定工作区开合，以 AnythingLLM 补充左侧 Workspace / Thread 导航。
5. 第一阶段不重做 Workflow、不新增业务对象、不修改后端事实合同。

这仍是下一会话要继续讨论和拆分的实现输入，不表示生产前端已经改造。

## 7. 新 Session 的正确用法

如果下一会话要优化某个具体场景：

1. 先读本文件和 [`README.md`](./README.md)，确认用户已经认可的机制与冻结边界。
2. 再按场景查九项报告或单项研究卡，不要重新扫描整个候选池。
3. 打开选择器或统一骨架查看交互；需要视觉证据时使用对应 `evidence/` 或冻结原型，不只靠文字转述。
4. 明确区分 `Take / Adapt / Refuse`；参考产品不能替代 Chat 的产品对象、权限、Decision、Evidence 和完成事实。
5. 每次只优化一个具体场景或一段纵向路径；得到用户确认后再进入生产实现任务。
