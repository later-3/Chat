---
name: chat-engineering-governance
description: Govern non-trivial implementation, bug fixes, refactors, migrations, tests, code review, and multi-agent engineering work in the Chat repository by controlling architecture ownership, change scope, and end-to-end evidence. Use when Codex may change or adopt production code, dependencies, public contracts, persistence, workflows, or tests. Do not use for factual read-only questions, product discussion without implementation, or typo-only documentation edits.
---

# Chat 工程治理

把用户已经授权的工程目标连续推进到可验证交付。你负责在执行过程中自行把关和纠偏；不要把每道治理门变成让用户逐条
审核的暂停点，也不要把治理文档本身当作用户结果。

本 Skill 只拥有工作路由，不拥有规范正文、Chat 产品事实或额外权限。

## 读取最小事实

1. 先读[治理 Map](../../../docs/agent-governance/README.md)，按任务类型和当前推进门选择最少的 S1–S11 与经验 ID，不机械加载整个目录。
2. 读[Chat 工程规范](../../../docs/engineering-standards.md)中与本次架构、代码、测试和规模风险直接相关的部分。
3. 架构、持久化、Workflow、公共合同或运行时任务再读
   [技术合同](../../../docs/architecture/technology-contract.md)、[当前状态](../../../PROJECT_STATE.md)、相关 as-built、源码和直接测试。
4. 需要标杆经验时只读[精选目录](../../../docs/agent-governance/exemplars/README.md)中匹配场景的条目；只有修改、质疑或评估来源时，才读取 `basis-and-evidence.md` 和四份项目附录。

## 连续执行闭环

### 1. 冻结本次任务

从用户对话和当前事实中确定：用户可观察结果、非目标、事实/事务所有者、预计触达模块、公共面/依赖/持久格式预算、
主要风险 Lane 和最终完成门。信息足以安全推进时作最小假设并继续；只有缺少的决定会实质改变结果、权限或外部副作用时
才向用户请求方向。

### 2. 在写入前纠偏方案

核对当前源码、消费者、稳定接缝和失败恢复。优先满足结果的最小完整纵向；发现第二事实源、反向依赖、无消费者公共面、
重复上游能力、万能层或无法验证的抽象时，先修改方案再写代码。研究或计划不扩大授权。

### 3. 控制实际变化

在独立 Worktree 和明确写集合内实现。持续比较计划与实际 Diff；一旦出现未计划的依赖、公共 API、持久格式、配置、
Workflow、跨模块扩张或无关重构，立即收窄、删除或回到设计判断，不等到交付时事后合理化。并行 Agent 只产生候选，
唯一集成者负责最终组合。

### 4. 用用户场景验证

把风险映射到最小充分的纯规则、Schema、状态/并发、Adapter、真实服务、浏览器、消费者、发布工件或恢复 Lane。
Bug 修复建立能识别原缺陷的回归证据；Mock 不冒充真实边界。完成前在最终组合上运行新鲜验证，做一次简化审查，
并列出未运行项。需要真实用户纵向时启动隔离服务或 Sandbox，而不是只证明文件存在或测试总数增加。

### 5. 自审、采用和一次性交付

同时检查“用户结果/合同”和“架构/代码/测试质量”两个轴。高风险变更按 Map 要求交给未实现者复核；Reviewer 结论仍是
候选。只有最终 Diff、完成门和组合证据成立时才提交本地采用结果。一次性交付实际结果、精确 Commit、验证、未覆盖项和
残余边界；不要在每个内部步骤后要求用户审核。

## 停止条件

- 当前授权目标和适用用户场景已经完整实现并验证后停止。
- 发现合同冲突、需要新的外部写入授权，或关键用户选择会改变产品结果时，保存可恢复状态并请求决定。
- 不因已经写出规范、计划、单元测试或局部组件而提前宣布总目标完成。
