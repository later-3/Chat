# Agent 工程治理 Map

> 版本：`agent-governance-map.v0.5`。本 Map 只负责把当前任务路由到最少的规范、项目事实和精选经验；
> 它不替代用户授权、目标 Workspace 合同或源码事实。当前规范为 `agent-engineering-standard.v0.2`，
> 抽取方法为 `agent-governance-basis.v0.6`，精选经验为 `agent-governance-exemplars.v0.2`。

## 1. 唯一入口

| 要回答的问题 | 入口 |
|---|---|
| Agent 必须怎样推进、验证和交付工程任务 | [Agent 工程治理规范](./standards.md) |
| 哪些标杆经验值得选择、用于什么场景、来源在哪里 | [精选标杆经验目录](./exemplars/README.md) |
| 为什么这些机制可能生效、怎样判断与删除 | [理论基础与抽取方法](./basis-and-evidence.md) |
| Chat 当前实际架构、代码、测试和状态是什么 | [项目协作规则](../../AGENTS.md)、[当前状态](../../PROJECT_STATE.md)、[技术合同](../architecture/technology-contract.md)、[工程规范](../engineering-standards.md)、[项目经验](../../PROJECT_LESSONS.md) |

普通工程任务不读取四份完整标杆报告；只有复核来源或修改治理内容时才按经验 ID 打开对应附录。

## 2. 本次有效输入

```text
系统和工具的不可绕过安全边界
+ 当前用户授权的结果、范围和例外
+ 目标 Workspace 的合同、源码、测试和 as-built
+ 当前任务或 Workflow Profile
+ 用户选择的最少规范/经验组件
= 本次 Agent 或检查 Sub-agent 的有效输入
```

组合遵守四条边界：

1. 标杆经验是可选判断方法，不能扩大工具权限、外部副作用或产品范围。
2. 项目 API、架构、状态机等事实不是经验偏好；任务涉及它们时必须按 Workspace 路由读取。
3. 同一义务只保留一个规范事实源；Prompt、Skill 和 Map 只做摘要与路由。
4. 规则、来源、检查器或最终组合变化后，旧证据不能证明新快照。

## 3. 选择什么

| 当前任务 | 最少经验入口 | 仍须读取的项目事实 |
|---|---|---|
| 方案、新功能、复用或架构调整 | A1、A2；跨边界再加 C1 | 技术合同、模块 Owner、消费者、相关 as-built |
| API、Store、Provider、Runtime 或 Adapter | C1；多实现时加 T2 | Schema、错误/状态语义、生产初始化与消费者 |
| Bug、测试设计或真实边界验证 | T1；多实现时加 T2 | 原缺陷、风险 Lane、项目测试命令和运行合同 |
| 重复结构、生成物或治理资产 | Q1 | 现有 lint、生成器、Hook、CI 和唯一事实源 |
| 多 Sub-agent 实现或 Review | M1；最终采用加 R1 | Git 基线、写集合、最终 Diff 和新鲜证据 |
| 依赖、迁移、升级、发布或外部写入 | U1 | 许可证、来源、恢复、授权、幂等和对账合同 |

经验 ID 的目的、场景、动作、Sub-agent 检查点和固定来源只由[精选目录](./exemplars/README.md)拥有。

## 4. 五道推进门

五道门只是选择时点，不是第二套规范，也不要求填写仪式性表格。

| 门 | 必须回答 | 主要规则 | 未通过 |
|---|---|---|---|
| 开工 | 当前结果、范围、事实和适用输入是否明确 | S1/S2 | 不开工、补事实或重新授权 |
| 设计 | 方案是否保持 Owner，并以最小完整变化满足结果 | S3/S5 | 继续调查、拒绝方案或收窄范围 |
| 执行 | 谁能在什么写集合和能力范围内产生候选 | S4/S6/S11 | 停止写入、重分配 Owner 或回到设计 |
| 验证 | 最终组合是否有与风险匹配的新鲜证据 | S7 | 修复、补证、对账或保留未通过状态 |
| 采用 | 哪些候选可由谁进入权威事实并交接 | S8/S9 | 拒绝采用、回到验证或取得明确例外 |

## 5. 当前载体

| 使用面 | 当前保证 | 当前不保证 |
|---|---|---|
| Codex/仓库 Agent | [Chat工程治理 Skill](../../.agents/skills/chat-engineering-governance/SKILL.md)按场景路由本 Map、Workspace 事实和相关经验 | 宿主外机器规则快照、自动合规判定 |
| Chat Direct Agent | 用户显式选择 Prompt 组件；v4 Assembly 冻结正文、Revision、Hash并进入 AgentSession | 默认全选、自动分类、仅靠文字保证遵守 |
| Chat Workflow | 同一选择经 v3 Assembly 进入 Planner、Executor与独立`agent.governance_check`；Reviewer只提交结构化候选，Application复核证据并决定Validation采用门 | 自动修改Workspace、自动架构裁决、以模型意见绕过确定性合同 |
| 其他 Coding Agent | 读取 Workspace 指令后可复用同一 Map 和精选目录 | 各宿主的权限、Hook 和合并门适配 |

Chat 当前提供三个 v3、非默认、可显式选择的文字组件：

- [方案、架构与代码变更](../../prompts/fragments/rules/controlled-project-change.md)：A1/A2/C1/Q1。
- [工程验证与交付证据](../../prompts/fragments/requirements/engineering-evidence.md)：Q1/T1/T2/R1/U1。
- [Sub-agent协作与汇合](../../prompts/fragments/experience/multi-agent-delivery.md)：M1/R1。

选择、版本和 Hash 只证明“本次给 Agent 看了什么”。确定性约束仍由项目脚本、Schema、测试和权限负责；
语义检查由实现者自审或检查 Sub-agent 产生候选，最终采用权仍属于集成者、受保护门或产品责任主体。

## 6. 维护边界

- `standards.md`拥有跨项目义务；本 Map 只路由。
- `exemplars/README.md`拥有当前保留经验及来源索引；四份项目报告只作冷证据。
- `basis-and-evidence.md`拥有证据强度和保留/删除方法，不拥有新规则。
