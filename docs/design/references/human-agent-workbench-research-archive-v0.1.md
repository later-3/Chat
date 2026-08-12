---
status: archived
version: 0.1
date: 2026-08-13
scope: 参考原型、九项工作台研究、用户选择、冻结骨架与生产前端适配输入的跨 Session 总览
---

# 人—Agent 工作台研究归档 v0.1

## 1. 最终停点

本轮研究已经收口，不再扩大候选池，也没有修改生产 UI。

已经完成：

1. 恢复并登记 6 个既有参考原型及其精确 freeze。
2. 补充 AnythingLLM / Open Computer、Orca、Plane，形成 9 项完整工作台研究集。
3. 从 9 项中归纳通用骨架、差异机制、Agent Constitution 与 Workflow Lifecycle。
4. 制作可视选择器，用户完成 9 个骨架方向和 11 组场景机制选择。
5. 把用户选择固化为文档，避免依赖浏览器本地状态。
6. 制作并冻结 Chat 统一工作台骨架 v0.1。
7. 审计当前真实前端代码和可运行 fixture，明确第一阶段适配范围。

没有完成：

1. 没有把研究原型接入 `apps/web`。
2. 没有修改后端、Product Store、Workflow、Agent Runtime 或公开 API。
3. 没有完成 Agent Profile、真正 Pause / Resume、Workflow 发布审批、移动端等价路径等共同缺口。
4. 没有决定所有具体场景的最终生产页面；后续按用户指定的单个场景逐步优化。

## 2. 恢复入口

新 Session 不需要顺序阅读全部文件。按任务选择：

| 要回答的问题 | 先读 | 需要视觉时 |
|---|---|---|
| 我们研究过什么、结果是什么 | 本文件；[`README.md`](./README.md) | [`reference-workbench-mechanism-index-v0.1.png`](./evidence/reference-workbench-mechanism-index-v0.1.png) |
| 用户到底选了什么 | [`human-agent-workbench-selection-decision-v0.1.md`](./human-agent-workbench-selection-decision-v0.1.md) | [`human-agent-workbench-selector-v0.1.html`](./human-agent-workbench-selector-v0.1.html) |
| 9 项工作台有哪些共性和差异 | [`nine-workbench-study-report-v0.1.md`](./nine-workbench-study-report-v0.1.md) | 报告第 2 节同屏视觉索引 |
| 某个来源具体怎样工作 | 对应单项研究卡 | 对应 `evidence/` 或冻结原型 |
| 当前统一骨架怎样交互 | [`chat-unified-workbench-skeleton-v0.1.html`](./chat-unified-workbench-skeleton-v0.1.html) | 直接运行 HTML |
| 现有前端第一步改哪里 | [`current-chat-frontend-workbench-adaptation-audit-v0.1.md`](./current-chat-frontend-workbench-adaptation-audit-v0.1.md) | 审计第 3 节与同屏对照 |
| 6 个早期原型和组合怎样恢复 | [`README.md`](./README.md) 的登记册与 freeze | `docs/design/reference-implementations/`、`docs/design/combination-prototypes/` |

## 3. 研究演进

### 阶段 A · 6 个冻结参考原型

早期研究覆盖：

- Basecamp：Project room、Activity 和跨工具返回。
- Things：Today 注意力投影。
- Linear：List / Peek / Detail 与 Project Update。
- HEY Calendar：Day / Week / Year 与来源候选。
- Microsoft Agent Feed：多 Agent 类型化监督、HITL、委派和对账。
- Heptabase：Card identity、Whiteboard placement 和显式上下文。

这些原型仍是场景级视觉与交互证据，不是要求生产前端维持 6 套独立壳层。

### 阶段 B · 从“第 7 个项目”转为工作台差异研究

最初扫描过 ChatGPT agent、Claude、Manus、Devin、Replit Agent、Gemini、Microsoft Researcher 等候选，记录在 [`human-agent-chat-reference-selection-v0.1.md`](./human-agent-chat-reference-selection-v0.1.md)。

用户随后把目标收窄为：先弄清“工作台怎样组织对话、运行、文件、项目和人工介入”，优先使用有一手画面或开源代码的来源。因此没有继续强行选一个品牌作为“第 7 个完整原型”，而是把以下 9 项作为完整研究集：

1. Basecamp
2. Things
3. Linear
4. HEY Calendar
5. Microsoft Agent Feed
6. Heptabase
7. AnythingLLM / Open Computer
8. Orca
9. Plane

### 阶段 C · 选择器与统一骨架

九项研究被整理为骨架与有限场景机制。用户通过 HTML 选择器完成选择；最终结果见 [`human-agent-workbench-selection-decision-v0.1.md`](./human-agent-workbench-selection-decision-v0.1.md)。

随后使用 Pi Agent + Kimi K3 生成并迭代 HTML，Codex负责范围、监督、视觉检查和收口。最终冻结的统一骨架是 `2536cb4d22d9108bf7350dc911f8e9781c4e2f61`。

### 阶段 D · 当前前端适配审计

本轮最后没有直接改生产 UI，而是检查了：

- `WorkspaceShell` 已有全局栏、会话栏、折叠、Today、分栏和移动切换。
- `RealWorkspace` 已有真实 Chat、Project、Run Viewer、Notes、Rules 和 Workflow Designer。
- 当前阻断是两套壳分离：真实入口绕开侧栏，并把工作区固定常驻。

因此建议的第一阶段是统一壳层，而不是重做内容。

## 4. 最终设计输入

### 4.1 基础壳层

后续生产设计以三个可独立开合的区域为基础：

1. 左侧导航：Workspace / Project / Session、Today 和全局入口。
2. 中间对话：默认主表面，承载 Goal、澄清、Plan 摘要和轻量运行入口。
3. 右侧工作区：默认关闭，打开 File、Diff、Artifact、Run、Browser、Canvas 或 Project detail。

Codex 主要提供“按需打开工作区和返回对话”的节奏；AnythingLLM 主要提供 Workspace / Thread 导航与配置入口。两者不是两套骨架并列实现。

### 4.2 场景机制

后续若优化具体场景，优先从用户已认可的机制中选择：

- S1 澄清 / Plan：AnythingLLM Survey + Agent Feed Decision。
- S2 项目 / 工作：Linear List / Peek / Detail + Plane 多布局。
- S3 执行现场：Open Computer + Orca + AnythingLLM 内嵌进度。
- S4～S6 Agent Constitution / 多 Agent：Agent Feed、AnythingLLM、Heptabase。
- S8 运行 / 失败 / 对账：Agent Feed。
- S9 文件 / Diff / 证据：Orca。
- S10 Today：Things。
- S11 Activity / 交付历史：Basecamp。
- S7 Workflow：Chat 自建，当前延期。

### 4.3 必须拒绝的误用

1. 不把 9 个来源的页面机械拼成默认首页。
2. 不让 Feed、Canvas、Workflow 图或外部工具成为 Chat 的产品事实源。
3. 不把模型 Thinking、普通进度文字或“已完成”声明当 Evidence。
4. 不把 Stop 写成 Pause / Resume，不把普通 Retry 用于 `outcome_unknown` 副作用。
5. 不因参考来源开源就直接复制源码到生产；先迁移交互语法，再接 Chat 的对象和权限合同。

## 5. 稳定提交与路径

| 产物 | 稳定提交 |
|---|---|
| Heptabase 与早期组合原型 | `3f9d9b5bf70f315580fa0d3f831f45f87a3d95eb` |
| literal-reference combinations | `58257710cd78285b7616067ba6685271e0c741ff` |
| Microsoft Agent Feed Human Loop v0.2 | `8d30cfe5651665407bf6e6dddc0339c075453704` |
| 九项工作台研究与选择器历史 | 当前归档分支提交历史 `050aa2d` → `72bfa6f` |
| 统一工作台骨架实现 freeze | `2536cb4d22d9108bf7350dc911f8e9781c4e2f61` |
| 统一骨架登记 | `45dc6394c9fea902a80cdc1525cc52a36e8e0d79` |
| 当前前端适配审计 | `2a20a3c` |

原本散落在独立 branch / worktree 的产物已通过归档 merge 纳入主线历史；精确 freeze 仍保留用于复现和比较。

## 6. 下一会话怎样继续

下一会话应由用户指定一个具体场景，例如文件/Diff、Agent Profile、任务看板或多 Agent 监督。新 Agent 应：

1. 严格按 `AGENTS.md` 顺序恢复项目事实。
2. 读本文件、用户选择决定和该场景对应的单项研究卡。
3. 先用现有冻结原型与证据解释“准备 Take / Adapt / Refuse 什么”。
4. 只为该场景形成小范围视觉或交互方案，继续让用户审核。
5. 在用户明确授权生产改造前，不修改 `apps/web`。

若用户决定进入第一阶段生产适配，则以 [`current-chat-frontend-workbench-adaptation-audit-v0.1.md`](./current-chat-frontend-workbench-adaptation-audit-v0.1.md) 第 6 节作为任务书输入，另开 worktree / branch / PR；不得把本归档提交与生产 UI 改造混在一起。

