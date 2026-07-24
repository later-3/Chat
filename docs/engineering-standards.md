# 工程编码与模块设计规范

## 1. 目的与比例原则

本规范把“产品级、可持续维护”落实为可以审查和验证的工程行为。它不追求文件越小、层级越多越好；只增加能够保护状态所有权、事务原子性、恢复语义、可测试性或生产故障定位的结构。

判断顺序固定为：

```text
用户场景与产品不变量
-> 状态/事务/失败所有者
-> 模块与合同
-> 注释、日志和测试证据
-> 规模信号与生产构建
```

## 2. 参考证据与取舍

本轮只抽取与当前风险直接相关的实践，固定源码提交如下：

| 参考源 | 固定提交 | 采用 | 改造或不采用 |
|---|---|---|---|
| Microsoft Agent Framework | `9c4cd0789950` | 公共合同有Docstring、类型服务于边界、异常按领域分组、显式参数优先 | 不复制SDK的包级懒导出和全部严格类型配置；本项目先保护应用合同与运行接合 |
| pi | `2b00dade7cec` | Agent事件先归约到单一运行状态，再有序通知订阅者；订阅必须可释放，Run完成包括监听器收敛 | 不复制其内存Transcript作为产品事实；本项目仍以Product Store和AG-UI Journal为权威 |
| nanobot | `2c7897672804` | 核心保持小、扩展放边缘；结构只在保护真实边界时增加；Hook故障隔离；运行事件与Channel/Web投影分开 | 不采用“为了DRY建立复杂基类”；不把其进程内Hook当成耐久恢复 |
| QwenPaw | `2134427584c2` | P0/P1/P2测试分层、合同/集成/E2E标记、锁定运行环境、能力放在明确Package | 不复制其整套插件/Workspace平台；当前只采用质量分层和入口边界 |
| LibreChat | `8e5ef1fb31e9` | 新后端逻辑进入清晰Package、旧入口保持薄；前端按Feature组织；测试真实逻辑和真实存储优先 | 不复制Node/Mongo/React Query栈，也不照搬“绝不动态导入”；本项目在Workbench等真实加载边界使用懒加载 |
| Codex CLI | 本机`0.144.5`、官方Tag `rust-v0.144.5`（`87db9bc18ba5`） | 初始上下文与后续增量分开；注入片段有明确类型和预算；项目规则、Skill、Tool、环境与会话分别装配；压缩不冒充原始历史 | 不把Codex自动Memory或会话摘要当Product Harness事实；不假设其存在通用的“用户Prompt自动优化器” |
| Claude Code | 2026-07-23官方文档行为；核心实现未开源 | `CLAUDE.md`/Skill负责指导，Hook/权限负责保证；子Agent隔离上下文；用可验证标准驱动执行与检查 | 不把官方行为说明冒充源码事实；不复制其单项目会话上下文作为本产品Project、Work或Memory权威状态 |

证据路径包括：

- `/Users/xulater/Code/opc-os/agent-framework/python/CODING_STANDARD.md`
- `/Users/xulater/Code/opc-os/pi/packages/agent/src/agent.ts`
- `/Users/xulater/Code/opc-os/nanobot/.agent/design.md`
- `/Users/xulater/Code/opc-os/nanobot/nanobot/agent/hook.py`
- `/Users/xulater/Code/reference-agent-sources/QwenPaw/pyproject.toml`
- `/Users/xulater/Code/opc-os/LibreChat/CLAUDE.md`
- `/Users/xulater/.nvm/versions/node/v24.8.0/lib/node_modules/@openai/codex/package.json`
- `https://github.com/openai/codex/tree/rust-v0.144.5/codex-rs/core/src`
- `https://code.claude.com/docs/en/how-claude-code-works`
- `https://code.claude.com/docs/en/hooks`

参考项目只证明其真实实践；本项目的Governance、Harness、Approval、Evidence和产品事务边界仍来自Chat自身产品需求。

## 3. 模块与依赖

### 3.1 后端

1. Router/协议层：解析与校验网络DTO、调用应用合同、映射稳定错误；不直接写数据库。
2. Application Coordinator：组织一个用例的调用顺序、授权门、唯一事务和失败语义。
3. Domain Rule/Contract：纯状态机、Hash、条件解析和公开投影；不依赖FastAPI、MAF或数据库Session。
4. Query Service：只读权威事实并产生稳定投影；不能产生隐式副作用。
5. Adapter：MAF、Provider、pi、数据库和外部Runtime细节；不能反向成为产品事实所有者。

同一产品事务只由一个Coordinator开启和提交。需要把Trace/Outbox与领域事实原子提交时，协作者接收现有`AsyncSession`，不能自己再开事务。

### 3.2 前端

1. Feature拥有自己的API适配、纯投影、组件和测试。
2. Agent Hook只协调AG-UI生命周期；Interrupt解码、Runtime回放和恢复轮询分别放在可独立测试的边界。
3. 页面容器只组装Feature、布局和短期UI状态，不复制服务端权威状态。
4. Workbench、配置中心和重型审批编辑器按用户真实打开时机懒加载；共同首屏、同一交互内必用的小组件保持同步加载。

## 4. 规模审查，不做机械限行

以下是审查阈值，不是自动失败线：

| 对象 | 触发审查 | 审查问题 |
|---|---:|---|
| Python/TypeScript模块 | 800行 | 是否混合命令、查询、投影、协议或外部适配？ |
| React组件或Hook | 500行 | 是否同时拥有网络、运行状态、恢复、表单和展示？ |
| 函数/方法 | 80行 | 是否包含多个状态转换、事务或失败所有者？ |

允许超过阈值的条件：拆分会破坏一个必须共同演进的不变量；代码已有清晰内部分段；最近邻测试能够覆盖完整状态机；原因在审计或邻近Docstring中可见。

禁止为了数字达标创建薄转发、单方法Service、`common/utils/helpers`垃圾桶或循环依赖。

## 5. 注释与日志

### 5.1 注释

应该解释：

1. 为什么一个事务、Fence、Hash或Checkpoint必须这样处理。
2. 失败、取消、结果未知和恢复之间的区别。
3. 使用MAF/AG-UI私有API或兼容层的版本原因与移除条件。
4. 容易被“简化”后破坏的安全或产品不变量。

不应该解释：

1. 下一行代码的语法。
2. 已由清晰命名表达的循环、赋值或条件。
3. 已过期的实现计划和聊天式开发记录。

### 5.2 结构化日志

必须记录的边界：

1. 请求/命令接纳与稳定错误分类。
2. Product Run、Attempt、Runtime Job、Workflow节点、Decision和Outbox的关键状态转换。
3. Provider、Tool和外部Runtime调用的开始、完成、超时、取消、结果未知。
4. Lease领取/丢失、Checkpoint恢复、Cursor缺口、重试、对账和死信。

日志字段至少包含事件名、结果或状态及可用的`request_id/session_id/product_run_id/attempt_id/job_id/workflow_id/executor_id/worker_id`；外部调用、Worker任务和可重试操作还要记录耗时或Attempt。日志不得包含密钥、认证Header、完整Prompt、完整Provider Body、隐藏推理或未经授权的私密内容。

## 6. 测试与完成门

每次边界拆分至少提供：

1. 依赖无环和禁止依赖测试。
2. 原Schema、OpenAPI、Workflow Definition/节点ID等行为指纹。
3. 被提取纯规则/投影的单元测试。
4. 事务原子性、CAS、幂等和失败路径的集成测试。
5. 前端类型、逻辑测试和生产构建；代码分割需验证生成真实独立Chunk且首屏入口不再承载重型工作台。
6. 受影响的桌面、窄屏和关键浏览器路径。

测试绿灯不表示用户体验已批准。涉及理解成本、长回复性能、键盘/读屏和真实Provider Payload时，自动门之后仍保留人工体验。

## 7. 产品协议、权威状态与运行投影

开发任何长期协作能力时，必须先区分3种东西：

1. **产品协议**：说明某类工作怎样理解、规划、执行、验证和回写；它可以版本化、可查看和可配置，但不直接等于运行状态。
2. **权威产品状态**：Project、Work、Plan、Note、Memory、Run、Evidence等已经通过提交门的事实，只由对应产品模块和Product Store拥有。
3. **运行投影**：MAF Workflow、Checkpoint、AG-UI事件、Worker Job、前端视图和Agent上下文；它们可以引用产品事实，但不能反向成为第二事实源。

代码必须强制协议版本、产品对象revision、Approval hash和RunSpec绑定；协议正文、场景规则与用户标准不应只散落在Prompt字符串、条件分支或页面文案中。尚未批准的协议对象只能作为候选设计存在，不得提前建立正式Schema或兼容层。

## 8. 上下文编译与执行层输入

### 8.1 有界上下文

1. 完整Conversation History保留为证据源，不作为每轮默认模型上下文。
2. Context装配必须分阶段：先使用当前输入、最近重点和轻量目录召回候选，再在目标绑定后读取相关Project/Work/Plan/Note/Accepted Memory/Evidence。
3. 每个Context Item必须带来源、revision、采用或排除原因、Token估算和有效性；没有来源的复制文本不得进入权威ContextPackage。
4. 大文件、低频知识和旧原始片段优先作为可定位引用交给Tool按需读取，不为“完整”提前内联。
5. 注入模型或Agent的每个逻辑块必须有明确预算和裁剪规则；超限时保留目标、约束、已接受决定、验证与停止条件，不能静默截断安全或验收要求。

### 8.2 最小充分执行工作包

执行Runtime收到的是RunSpec针对当前步骤的受控投影，不是Product数据库转储。至少包含：

1. 当前任务、背景、目标和期望结果。
2. 已接受决定、范围、非目标和禁止事项。
3. 当前步骤、上游公开结果、依赖和允许分支。
4. 资源清单及优先读取顺序。
5. 能力Allowlist、工作目录、路径/网络/副作用边界。
6. 模型、Token、费用、时间和调用次数预算。
7. 完成标准、验证命令、Evidence要求和回归范围。
8. 输出格式、允许提出的产品Patch和停止/询问条件。
9. Product Run、Attempt、Workflow、步骤和幂等关联信息。

不同Agent或步骤只能收到完成其职责所需的投影。Planner不自动获得写能力，Reviewer不自动继承Executor的副作用权限，pi等执行层无权查询未列入Scope的项目或扩大RunSpec。

## 9. 确定性代码、模型、Skill、Tool和Hook的分工

1. **确定性代码**拥有状态机、权限、版本、Hash、预算、路由、Schema校验、事务、幂等、提交门和恢复判断。
2. **模型或Agent**处理意图理解、语义提取、方案候选、开放式规划、内容生成和确定性规则无法覆盖的质量判断；其输出默认是候选。
3. **Skill**表达可复用的方法、检查表和领域知识，按任务需要加载；Skill不能代替产品权限或状态提交。
4. **Tool**表达真实存在且受Catalog约束的能力；Tool定义、参数、授权、执行、结果和对账必须可关联。
5. **Hook/Middleware**在生命周期边界补充上下文、检查或阻止动作；关键安全与产品保证不能只依赖一段自然语言指令。

能用权威查询、状态机或Schema回答的问题不得先调用模型再覆盖结果；需要模型判断时必须保存公开依据、置信度、输出Disposition和后续采用方式，不保存隐藏推理。

## 10. 合同、版本与失效

1. 网络DTO、领域命令、事件、协议定义、ContextPackage、ExecutionDraft、RunSpec、ModelCallDraft和Tool请求都必须有明确版本或兼容边界。
2. 用户目标、上下文、计划、协议、Agent、Runtime、能力、模型、预算、验证或作用域发生语义变化时，相关旧Approval必须失效。
3. 运行中不得原地修改RunSpec；需要改变时在安全点形成Amendment或新Run，并保留血缘。
4. Provider/Tool/Delivery结果未知时不得自动重放；先查询、对账、补偿或交给人工处置。
5. 公开错误使用稳定错误码和脱敏说明；内部异常、Provider响应正文和凭据不能直接穿过协议边界。

## 11. 场景驱动设计门

新增或修改核心能力，在建立正式Schema或实现前必须用场景证明设计。每个核心场景至少写清：

1. 参与者、前置权威状态、用户触发和期望结果。
2. 前端动作、协议入口、Application Coordinator、Product Store、MAF/Worker/Runtime和外部系统的顺序。
3. 每一步输入、输出、状态所有者、版本、事务和用户可见变化。
4. 采用与排除的上下文，以及发给每个Agent/执行步骤的具体逻辑块。
5. HITL决策点、策略作用域、允许动作、用户回答方式和重新暂停条件。
6. 模型、Tool、Artifact、Evidence、Delivery及最终产品提交的边界。
7. 重复、并发、超时、断线、进程退出、结果未知、来源失效、CAS冲突和用户中途纠正。
8. 最终留下的Message、TurnSummary、Project/Work/Memory候选、Artifact、Evidence、Trace和Delivery状态。

场景验证发现方案缺口时，先修正候选设计再交用户审核；禁止为了让场景“跑通”而假设不存在的对象、权限或恢复保证。

## 12. 变更完成检查表

一次产品级变更只有同时满足以下条件才可宣称完成：

1. 相关概念、产品合同、代码、数据库、API、前端投影和文案没有语义漂移。
2. 正常、拒绝、修改、取消、失败、重复、并发和恢复路径均有与风险相称的证据。
3. 真实Provider、真实Agent或真实浏览器行为不能被Mock替代的部分已经验证。
4. Trace和结构化日志能从可见Product Session定位到Product Run、Attempt、Workflow节点、Model/Tool Attempt和最终提交。
5. 用户能看见系统理解、采用内容、当前步骤、暂停原因、执行结果和完成证据，并能在授权范围内纠正或停止。
6. 已兑现与未兑现保证分别写入项目状态；没有把纵向切片外推成通用能力。
