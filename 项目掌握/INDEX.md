# 项目掌握 — 全局索引

这里不是另一份架构设计或项目状态，而是Later掌握Chat源码的**可执行学习入口**。项目事实仍以
`PROJECT_CONTEXT.md`、`PROJECT_STATE.md`、源码和测试为准。

## 从这里开始

| 文档 | 先解决什么 | 掌握级别 |
|---|---|---|
| [Chat全盘掌握范围与覆盖审计](./00-从这里开始/全盘掌握范围与覆盖审计.md) | 用11目标模块、27学习单元和当前全仓实现账证明没有只讲阶段A | 全局总账 |
| [Chat系统总地图与学习方法](./00-从这里开始/Chat系统总地图与学习方法.md) | 区分产品架构、Workflow、代码地图和交付计划；建立一条消息的总链 | L1入口 |
| [recent_turn_summaries与ContextPackage为什么存在](./Context与回合沉淀/recent_turn_summaries与ContextPackage为什么存在.md) | 用一个具体回合讲清摘要候选、Context Item、版本、Hash与持久化原因 | L1-L2专题 |
| [第1课：从点击发送到ContextPackage](./调试实战/第1课-从点击发送到ContextPackage.md) | 用断点、只读SQL和Trace亲眼验证前端到节点3 | L2实验 |

先读“全盘掌握范围”，确认完整边界；再完成总地图、Context样本和第1课。之后按M00-M26逐单元推进，
不要从项目阶段清单开始背系统。

## 掌握标准

每个主题都按3级验收：

1. **L1能讲懂**：用自己的话解释对象、相邻概念和设计原因。
2. **L2能定位**：给一个Product Run ID，能在界面、源码、Product Store和Trace找到对应事实。
3. **L3能安全修改**：能预测版本/Hash/恢复/测试影响，完成修改并用质量门验证。

“读过文档”“知道文件名”或“背出节点顺序”都不算掌握。

## 全项目学习覆盖

完整覆盖不再由一张容易漏项的手写概览表承担：

1. 人读总账见[Chat全盘掌握范围与覆盖审计](./00-从这里开始/全盘掌握范围与覆盖审计.md)。
2. 机器映射见[`coverage-manifest.json`](./coverage-manifest.json)。
3. 运行`.venv/bin/python scripts/check-project-mastery.py`检查目标模块、源码面、Workflow和节点是否漏项。

当前是27个学习单元（M00-M26）。后续Agent必须优先补其中明确标为“待补”的单元，并按
[本目录协作规则](./AGENTS.md)提供具体对象、断点、查询和掌握验收，不能继续只追加节点摘要。

## 分类目录

### 00-从这里开始

本分类建立全局心智模型、学习顺序和掌握标准。

| 文档 | 问题摘要 | 归档日期 |
|---|---|---|
| [Chat全盘掌握范围与覆盖审计](./00-从这里开始/全盘掌握范围与覆盖审计.md) | 用目标能力账、当前实现账、学习单元账和缺口账定义全盘范围 | 2026-07-29 |
| [Chat系统总地图与学习方法](./00-从这里开始/Chat系统总地图与学习方法.md) | 以一条Product Run为标本掌握产品、运行时、协议、存储和代码 | 2026-07-29 |

### Context与回合沉淀

本分类解释完整Message、派生摘要、本轮Context、长期Memory和回合写回之间的边界。

| 文档 | 问题摘要 | 归档日期 |
|---|---|---|
| [recent_turn_summaries与ContextPackage为什么存在](./Context与回合沉淀/recent_turn_summaries与ContextPackage为什么存在.md) | 从第一性原理解释节点1-5的候选、持久化、revision与恢复 | 2026-07-29 |

### 调试实战

本分类不重复概念说明，而是让用户通过断点、数据库和Trace验证一条实际链路。

| 文档 | 实验目标 | 归档日期 |
|---|---|---|
| [第1课：从点击发送到ContextPackage](./调试实战/第1课-从点击发送到ContextPackage.md) | 命中8组关键断点，核对TurnSummary和ContextPackage的运行/持久状态 | 2026-07-29 |
| [Chat与pi的两种调试模式](./调试实战/Chat与pi的两种调试模式.md) | 分别运行“只调试Chat但正常使用pi”和“双窗口联合调试Chat+pi”，验证Inspector与产品审批的边界 | 2026-07-29 |

### 执行层与pi运行时

本分类覆盖 pi 编码 Agent 的启动、通信、治理和运行时管理相关问题。

| 文档 | 问题摘要 | 归档日期 |
|------|----------|----------|
| [pi子进程在哪里启动](./执行层与pi运行时/pi子进程在哪里启动.md) | 找到调用执行层的地方，即 pi 子进程的启动入口和调用链 | 2026-07-28 |
| [从用户点击发送到pi执行的完整链路](./执行层与pi运行时/从用户点击发送到pi执行的完整链路.md) | 前端点击发送到最终交给 pi 的完整前后端链路梳理 | 2026-07-28 |

### Workflow架构与ProductAwareWorkflow

本分类覆盖 ProductAwareWorkflow 设计、Workflow 定义注册、前端设计者视图和 MAF 节点执行链相关问题。

| 文档 | 问题摘要 | 归档日期 |
|------|----------|----------|
| [ProductAwareWorkflow设计与全部Workflow的关系](./Workflow架构与ProductAwareWorkflow/ProductAwareWorkflow设计与全部Workflow的关系.md) | 展开 ProductAwareWorkflow.run() 设计，澄清 39 节点持续协作 Workflow、设计者视图和系统执行链的关系 | 2026-07-28 |
| [持续协作主Workflow的39节点设计](./Workflow架构与ProductAwareWorkflow/持续协作主Workflow的39节点设计.md) | continuous-collaboration v1.8.0 的整体设计、39 个节点逐一说明和代码组织方式 | 2026-07-28 |

### Session与状态持久化

本分类覆盖 Product Session、消息、Run 等产品事实的存储形式，以及它们与 MAF 运行时状态（Checkpoint）的边界问题。

| 文档 | 问题摘要 | 归档日期 |
|------|----------|----------|
| [前端会话面板的数据来源与保存形式](./Session与状态持久化/前端会话面板的数据来源与保存形式.md) | 前端面板展示的会话是否由 MAF 保存、以什么形式保存；Product Session 表结构与 MAF Checkpoint 的分离 | 2026-07-28 |

### Trace与可观测性

本分类区分Product过程事实、终态双报告、Runtime诊断时间线和进程JSONL日志。

| 文档 | 问题摘要 | 归档日期 |
|------|----------|----------|
| [每轮双Trace如何保存、分析与可视化](./Trace与可观测性/每轮双Trace如何保存、分析与可视化.md) | 每轮机器版/人读版Trace的生成方式、数据库位置、空值原因、分析顺序和前端可视化 | 2026-07-28 |
