# OpenAI Codex 经验抽取：协作控制、能力边界与采用

> 研究版本：`agent-governance-exemplar.openai-codex.v0.1`。
> OSS 固定快照：[`openai/codex@4347f94`](https://github.com/openai/codex/tree/4347f94d5539880e8583028a50a19df5b202d9fa)。
> 产品层证据：仅引用 2026-08-25 读取的官方 OpenAI 文档；产品文档不是固定 Commit，不能反向归因于 OSS 快照。
> 方法：只读分析作者文档、源码结构和测试，不安装、不试用，不把项目做法自动升级为 Chat 规则。

## 1. 研究合同

### 1.1 研究问题

本研究只回答四组问题：

1. Codex 怎样把权限和沙箱从 Prompt 建议下沉为能力边界及显式批准？
2. Codex 怎样承载父 Agent、子 Agent、任务分解、状态和结果汇合？
3. 独立任务怎样使用 Worktree/Handoff 隔离可变工作状态，边界在哪里？
4. 只读 Review 和 Git 分项采用怎样分离“产生候选”与“进入项目事实”？

### 1.2 明确排除

- 不研究模型调用、上下文循环、Session、通用 Tool loop；这些主要由 Pi 标杆覆盖。
- 不评价具体 Codex 模型质量、价格、速度或基准成绩。
- 不把桌面产品、云端服务或 ChatGPT Work 的行为写成 OSS Harness 已实现事实。
- 不把同模型 Reviewer 称为独立 Oracle，也不把 Review 发现率外推为软件质量提升因果。
- 不假设子 Agent 自动拥有独立 Worktree；公开证据恰好要求保留这项限制。
- 不用 Codex 背书 Chat 的 Product Store、Decision、`outcome_unknown`、对账或 Product Commit。

### 1.3 三层证据必须分开

| 层次 | 本文怎样使用 | 不能怎样使用 |
|---|---|---|
| OSS 固定快照 | 证明公开代码、协议、测试和仓库 Skill 在该 Commit 存在 | 证明桌面或云端产品一定采用同一实现 |
| 官方产品文档 | 说明读取日公开承诺的 Subagent、Sandbox、Worktree/Handoff、Review 行为 | 作为不可变历史，或归因于固定 OSS Commit |
| Chat 迁移推论 | 说明哪些机制值得进入 Chat/Codex/Workflow 候选设计 | 伪装成 OpenAI 作者主张或已验证效果 |

### 1.4 主要证据入口

- OSS：[Linux Sandbox](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/linux-sandbox/README.md)、
  [Permission Handler](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tools/handlers/request_permissions.rs)、
  [Multi-agent Handler](https://github.com/openai/codex/tree/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tools/handlers/multi_agents_v2)、
  [Review Task](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tasks/review.rs)和
  [Code-review Skill](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/.codex/skills/code-review/SKILL.md)。
- 官方产品文档：[Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)、
  [Sandbox](https://learn.chatgpt.com/docs/sandboxing)、
  [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、
  [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)和
  [Code review](https://learn.chatgpt.com/docs/code-review)。

## 2. S1–S11 覆盖总表

强度含义：`强`表示该研究范围内有多种公开代码/协议/测试或明确产品载体；`中`表示只覆盖规则的一部分；
`弱`表示主要是 Prompt、审查启发或间接证据；`—`表示本次研究没有足够证据。载体强度描述项目公开机制，
不表示 Chat 已经拥有同样控制。

| 规则 | 覆盖 | 载体强度 | Codex 证据与限制 |
|---|---|---|---|
| S1 授权与任务合同 | 中 | 阻断 + 审查 | Sandbox、Permission Profile、Approval 只把部分能力升级置于外部控制；没有冻结用户结果、不做事项和范围扩张的完整任务合同 |
| S2 事实源与规则选择 | 中 | 检测 + 提示 | `AGENTS.md` 发现与模型可见状态有源码和测试；产品/OSS/云事实仍可能被误合并 |
| S3 设计与复用 | — | — | 本研究范围没有足以推广的设计准入或上游复用机制 |
| S4 分解与所有权 | 中 | 阻断 + 检测 + 提示 | 有 Subagent 控制面和独立任务 Worktree；没有子 Agent 自动 Worktree 或共享事实写入租约 |
| S5 变更预算 | 弱 | 审查 | 仓库 Review Skill 有 change-size 视角；未见通用 diff/API/依赖预算硬门 |
| S6 代码与抽象 | 弱 | 审查 | Review 可发现维护问题，但没有可信 Oracle 决定“好抽象” |
| S7 风险与验证 | 中 | 检测 + 阻断 | Permission、Sandbox、Multi-agent、Review 有专门测试；不能外推为目标项目业务验证完整 |
| S8 独立审查与采用 | 强 | 审查 + 产品行为合同 + 分项采用 | 专门 Reviewer、官方“不修改工作树”承诺、分轴 Skill、Git stage/revert；固定 OSS 未证明只读 Sandbox，同模型偏见仍存在 |
| S9 完成与交接 | 中 | 检测 + 提示 + 产品 Handoff | Agent 状态、通知及产品 Handoff 提供载体；不等于 Chat 耐久完成事实 |
| S10 治理自身 | 弱 | 检测 + 审查 | 控制协议和模型可见说明有测试；没有证明规则能自动复核、降级或删除 |
| S11 外部动作与不可逆结果 | 中 | 阻断 + 审查 | 文件/命令/网络权限可前置控制；没有 Chat 的幂等、未知结果和外部对账语义 |

## 3. 经验卡

### C1 能力边界应先于 Agent 自律

**关联规则**：S1、S11。

**目标失败**：Agent 把“命令能够执行”误认为“用户已经授权”，或用一般 Shell 绕过本应受控的动作。

**项目做法 / 规范内容**：

- Permission Profile 描述可用的文件系统、网络和批准策略。
- Sandbox 默认缩小命令可访问的资源及其可产生的副作用范围；越界动作走显式批准或被拒绝。
- 子 Agent 继承父任务的权限/沙箱选择，而不是凭角色自行扩大权限。

**生效机制**：OS/进程边界先裁剪动作集合，协议再把必要的权限升级变成可观察请求；模型只能在剩余能力内行动。

**载体**：Sandbox 可执行程序、Permission/Approval 协议、工具 Handler、Guardian/Approval 测试。

**固定证据**：

- [Linux Sandbox 当前行为](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/linux-sandbox/README.md)
- [Permission Profile Catalog](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/config/permission_profile_catalog.rs)
- [Request Permissions](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tools/handlers/request_permissions.rs)
- [Guardian Subagent Authorization 测试](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/tests/suite/guardian_subagent_authorization.rs)

**底层因果解释**：当错误动作在模型外不可达或必须经另一个主体批准，违规不再只取决于注意力和服从度；
这比重复提示“不要越权”少一个单点失效条件。

**失效条件 / 反证**：权限配置过宽、存在未纳管工具旁路、批准者只看命令字符串、把自动升级等同用户授权，都会使控制失效。
Sandbox 只能回答技术能力，不能回答产品授权和副作用结果。

**不可照搬**：Bubblewrap、Seccomp、Landlock 等是平台实现，不是跨项目规范；Chat 仍须由 Application/Decision
拥有产品动作授权，不能把 Sandbox 批准当 Product Decision。

**映射**：Codex 采用 Workspace 写入范围和升级批准；Chat Direct 由 Capability/Profile 限制工具；
Workflow 在外部动作节点前读取产品决定并失败关闭。

**采用结论**：采用“外部化能力控制 + 显式升级”的原则；拒绝复制平台细节或扩大授权含义。

**置信度**：高（固定源码、协议和测试支撑；对业务授权效果只作迁移推论）。

### C2 权限隔离不等于写入隔离

**关联规则**：S1、S4、S8。

**目标失败**：多个 Agent 都在允许写入的同一目录中工作，权限检查全部通过，但相互覆盖文件、切换分支或污染验证基线。

**项目做法 / 规范内容**：Codex 有父/子 Agent 控制面，子 Agent 继承父级权限；官方文档同时建议优先并行只读任务，
谨慎并行写入。Worktree 是独立 chat、后台任务等独立任务的隔离原语，不是每个子 Agent 的自动配置。

**生效机制**：权限控制回答“能否写”；Worktree/文件所有权回答“写哪份状态、谁负责集成”。两种控制解决不同维度，
必须组合才会减少写冲突。

**载体**：Subagent Runtime、父级 Sandbox 继承、产品 Worktree、Git 分支、集成者和任务 Brief。

**证据**：

- OSS：[Multi-agent V2](https://github.com/openai/codex/tree/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tools/handlers/multi_agents_v2)
- OSS：[Multi-agent Handler 测试](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tools/handlers/multi_agents_tests.rs)
- 产品：[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- 产品：[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)

**底层因果解释**：能力集合相同不代表状态空间独立。共享可变状态引入顺序依赖；独立 Worktree 降低文件级耦合，
唯一写入 Owner 和集成者再处理共享 Git 元数据、锁文件和合同冲突。

**失效条件 / 反证**：Worktree 仍共享 Git 元数据；两个分支仍可改同一合同；子 Agent 若没有绑定预期 CWD/基线，
可能审查或修改错误状态。只创建分支而不创建独立目录也不构成写入隔离。

**不可照搬**：不能写成“开启 Multi-agent 就安全并行写入”，也不能把 Worktree 当数据库、外部服务或 Product Store 的租约。

**映射**：Codex 任务默认并行只读；并行写使用独立 Worktree 或互斥文件 Owner。Chat Direct 保存 Workspace/基线；
Workflow 在调度前分配写入 Owner，并由单一集成节点采用候选。

**采用结论**：升级为 S4 的高置信机制依据；Codex 同时是正面原语和“尚未自动闭环”的反证。

**置信度**：高（限制由官方文档明确；产品 Worktree 实现细节为中等置信度）。

### C3 子 Agent 的价值来自有界分解和父级汇合

**关联规则**：S4、S9。

**目标失败**：主线程被搜索结果、日志和中间假设淹没；或为了“多 Agent”把耦合任务切碎，增加重复劳动与整合成本。

**项目做法 / 规范内容**：控制面提供 spawn、follow-up、message、wait、interrupt、list 等生命周期动作；官方说明把探索、
测试、分诊和总结等独立任务交给子 Agent，由父级等待并汇总结果。

**生效机制**：把噪声和局部工作集隔离到子线程，主线程保留需求、决定和最终组合；生命周期工具让父级能观察、追问、停止和收敛。

**载体**：Multi-agent Handler、Agent 状态、通知、子 Agent Brief、父级汇总。

**固定证据**：

- [Multi-agent Context Instructions](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/context/multi_agent_mode_instructions.rs)
- [Multi-agent Spec Tests](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tools/handlers/multi_agents_spec_tests.rs)
- [Subagent Notifications Tests](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/tests/suite/subagent_notifications.rs)

**底层因果解释**：独立上下文能减少主线程的无关 Token，但每个子 Agent 会重新读取和推理；只有任务确实可分、返回结构窄、
父级能验证时，墙钟收益才可能大于协调和 Token 成本。

**失效条件 / 反证**：依赖关系未声明、多个 Agent 搜同一问题、子结果只有结论没有证据、父级未等待或照单全收，都会失效。
并行并不自动产生认知多样性。

**不可照搬**：不要求“计划每一步都生成一个 Agent”；Chat 不能让子 Runtime 拥有 Product Commit 或自动采纳权。

**映射**：Codex 使用有界只读委派；Chat Direct 由主 Agent 汇合候选；Workflow 把任务、状态、证据和停止原因保存为耐久节点事实。

**采用结论**：采用“独立输出 + 有界 Brief + 父级汇合”；拒绝以 Agent 数量作为吞吐或质量指标。

**置信度**：中高（控制面和产品说明明确；质量收益缺少目标项目对照）。

### C4 Worktree/Handoff 是独立任务边界，不是完整事务

**关联规则**：S4、S9。

**目标失败**：后台或并行任务干扰用户当前 checkout；交接后找不到任务使用的工作状态和分支。

**项目做法 / 规范内容**：官方产品文档把 Worktree 用于同一 Git 项目的独立 chat 和后台任务，并提供 Local/Worktree Handoff。
OSS 快照只提供相关 Harness/协议与信任测试线索，本文不声称桌面行为由该 Commit 完整实现。

**生效机制**：独立 checkout 固定文件视图和分支工作状态；Handoff 将任务从一个执行位置移动到另一个位置时显式处理 Git 状态，
比让 Agent 靠聊天记住路径更可观察。

**载体**：产品 Worktree、Handoff UI/流程、Git、任务线程；OSS 的 Worktree Trust 检查属于不同但相关的安全边界。

**证据**：

- 产品：[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- OSS：[Worktree Trust Tests](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/tests/suite/worktree_trust.rs)

**底层因果解释**：把执行位置、Git 基线和线程显式绑定，能够减少“在错误 checkout 工作”的隐性状态；但它只隔离本地文件视图，
不原子化远端 API、数据库或共享依赖缓存。

**失效条件 / 反证**：非 Git 项目、未提交改动、分支漂移、错误 CWD、共享锁文件或外部服务写入，都可能绕过文件隔离收益。

**不可照搬**：Chat 不应把 Handoff 当产品运行终态，也不能把 Worktree 路径当授权身份或事实所有者。

**映射**：Codex 记录 Worktree/CWD/基线；Chat Direct 把它们作为执行资源；Workflow 保存任务到资源的 Binding，
恢复时重新验证资源，不把旧路径直接继承为事实。

**采用结论**：采用为独立实现任务的隔离原语；外部状态仍需产品事务、幂等和对账。

**置信度**：中（产品行为有官方说明；与 OSS Commit 的实现归属刻意不作强结论）。

### C5 Review 应与实现分离，并让采用保持可逆

**关联规则**：S8、S9。

**目标失败**：实现者自行宣布完成；Reviewer 只复述摘要；审查发现只能“全收或全退”，导致缺陷和无关改动一起进入项目。

**项目做法 / 规范内容**：`/review` 使用专门 Reviewer 检查明确 diff；官方产品文档把“不修改工作树”作为行为承诺。
固定 OSS `ReviewTask` 设置专门角色和 `approval_policy = Never`，但没有把文件 Sandbox 机械收窄为只读，不能把产品行为
承诺反写成 OSS 能力隔离。仓库 Review Skill 按 breaking changes、change size、context、testing 等轴委派，并要求文件/行号证据；
产品 Review Pane 支持按范围 stage/revert。

**生效机制**：执行任务和裁决任务使用不同上下文与工具意图，降低 Reviewer 顺手实现的倾向；只有宿主再施加只读能力边界时，
“不能修改”才是机械约束。Git 的 diff、index 和可逆操作把 Reviewer 结果转成可选择的采用动作。

**载体**：Review Task/Skill 的角色与 Prompt、官方产品行为合同、Git diff/index、产品 Review Pane；强度是**审查 + 产品承诺 +
可逆采用**，固定 OSS 证据本身不是只读 Sandbox。

**固定或官方证据**：

- OSS：[Review Task](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tasks/review.rs)
- OSS：[Review Suite](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/tests/suite/review.rs)
- OSS：[Code-review Orchestrator Skill](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/.codex/skills/code-review/SKILL.md)
- 产品：[Code review](https://learn.chatgpt.com/docs/code-review)

**底层因果解释**：能力级只读 Reviewer 无法用修改实现掩盖缺陷；当前公开证据首先证明的是角色、对象和采用分离，而非 OSS
能力级只读。精确 diff 限制审查对象，分项采用降低拒绝一切或接受一切的压力；这些机制提高缺陷暴露机会，但不保证判断正确。

**失效条件 / 反证**：Reviewer 仍有写能力且偏离角色、与实现者共享同模型和错误假设、没有读取真实 diff、测试证据陈旧、
审查中扩大完成门，都会失效。产品 stage/revert 也不能替代最终组合测试。

**不可照搬**：不把多个同模型子 Reviewer 计作多个独立项目证据，不让 Reviewer 自行 push/merge，不复制只适用于 Codex 仓库的审查维度。

**映射**：Codex Reviewer 保持只读；Chat Direct 将结论交集成者；Workflow 将“检查”和“采用”拆成节点，
最终 Product Commit 前重验组合结果。

**采用结论**：采用“Reviewer 默认只读真实差异、缺陷分级、采用可逆”的目标；若要称为机械只读，目标宿主必须另有能力门。
高风险仍需人类或受保护主体裁决。

**置信度**：角色/产品行为合同和可逆采用为高；固定 OSS 的能力级只读为低且不作成立主张；缺陷发现率和同模型独立性仅中低。

### C6 模型可见规则也要接受协议与回归测试

**关联规则**：S2、S7、S10。

**目标失败**：权限、Agent 状态或治理说明虽然存在于代码，却没有正确进入模型上下文；协议变化造成 UI、Agent 和 Runtime 理解不一致。

**项目做法 / 规范内容**：Codex 为 AGENTS 发现、权限消息、Multi-agent 模式、Approval、Review 和 App-server 协议提供单元、集成或快照测试，
验证模型实际可见的结构与工具行为。

**生效机制**：把“规则应该被看到”转成序列化布局和 Handler 行为的可比较输出；协议 Schema 让调用方在变更时暴露不兼容。

**载体**：Rust 类型、JSON/TypeScript Schema、Snapshot、Suite Tests、CI。

**固定证据**：

- [AGENTS Tests](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/agents_md_tests.rs)
- [Permission Message Tests](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/tests/suite/permissions_messages.rs)
- [App-server Review Tests](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/app-server/tests/suite/v2/review.rs)
- [Request Permissions Protocol](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs)

**底层因果解释**：测试能阻止规则载体在重构时静默消失，也能让客户端和 Runtime 对同一结构达成最低一致；
它证明“信息送达/动作受控”，不证明模型理解和遵守语义。

**失效条件 / 反证**：Snapshot 只冻结文本形状、Fixture 不覆盖真实权限组合、测试与产品实现分叉、Agent 找到旁路，都会造成假安全。

**不可照搬**：不把所有 Prompt 文本做巨型 Snapshot；只保护身份、权限、选择、证据、终态等高风险稳定合同。

**映射**：Codex 测模型可见布局；Chat Direct 测规则选择与 Assembly；Workflow 测所选规则快照、权限输入、Reviewer 输出和提交门之间的合同。

**采用结论**：采用“关键治理信息的协议测试”；拒绝把 Snapshot 数量当治理有效性。

**置信度**：高（固定测试存在）；对实际行为改善为中低。

### C7 同模型多 Reviewer 不是独立真相源

**关联规则**：S7、S8、S10。

**目标失败**：看到多个 Agent 都同意便误判为独立验证，忽略它们共享模型、提示、上下文、代码和工具造成的相关误差。

**项目做法 / 规范内容**：仓库 Review Skill 通过不同维度的子 Reviewer 扩大检查面；官方 Subagent 机制由父级汇合。
公开材料没有证明这些 Reviewer 的错误彼此独立，也没有让它们成为合并授权主体。

**生效机制**：正交问题清单可以降低单次注意力遗漏，但真正的裁决强度来自只读角色、确定性测试、权限边界、Git 采用和人类决定，
而不是 Reviewer 数量。

**载体**：分轴 Review Skill、父级聚合、测试、Git、人类裁决。

**固定证据**：

- [Breaking-change Review Skill](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/.codex/skills/code-review-breaking-changes/SKILL.md)
- [Change-size Review Skill](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/.codex/skills/code-review-change-size/SKILL.md)
- [Testing Review Skill](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/.codex/skills/code-review-testing/SKILL.md)

**底层因果解释**：维度分解提高搜索覆盖的理论依据较强；“多人同意即正确”的依据很弱，因为共同误差不会因复制 Agent 而消失。

**失效条件 / 反证**：所有 Reviewer 读取同一错误摘要、缺少真实测试、父级丢弃少数意见、用多数投票替代证据，都会放大假确定性。

**不可照搬**：不把三个 Codex 子 Reviewer 计作三个独立来源，不让 LLM 多数票覆盖项目合同、确定性失败或人工否决。

**映射**：Codex 用分轴 Review 扩面；Chat Direct 对高风险结论增加不同证据通道；Workflow 把 LLM Review 作为候选，
由确定性门和产品决定裁决。

**采用结论**：采用正交审查，不采用同模型投票；规则置信度按证据独立性而非 Agent 数量计算。

**置信度**：高（限制来自基本相关误差原理）；具体收益仍需 Chat 后续校准。

## 4. 必须保留的边界

1. **子 Agent 不自动拥有独立 Worktree。** Subagent 生命周期和 Worktree 产品能力是两个机制；组合必须显式设计。
2. **权限隔离不等于写入隔离。** 两个 Agent 都被允许写同一目录时，Sandbox 不会分配文件所有权。
3. **Worktree 隔离不等于全局事务。** Git 元数据、锁文件、数据库、Provider 和外部副作用仍可能共享。
4. **Reviewer 角色分离不等于认知独立。** 同模型、同上下文和同工具会产生相关偏差。
5. **OSS 不等于桌面产品，也不等于云端服务。** 固定 Commit 只背书可定位的公开代码和测试。
6. **Approval 不等于用户意图。** 技术升级批准不能静默扩大任务范围或替代 Chat Product Decision。
7. **Review 结论不等于采用。** 只有集成者、受保护 Git 门或 Product Commit 能让候选进入权威事实。
8. **Sandbox 不拥有结果语义。** 外部写入成功、失败或未知仍需幂等、回执和对账。

## 5. 反面经验

| 反面经验 | 为什么危险 | 对 Chat 的含义 |
|---|---|---|
| 把父权限继承写成子 Agent 安全 | 继承只保持能力上限，不分离可变状态 | 仍需 Worktree/文件 Owner/唯一集成者 |
| 为每个计划步骤生成 Agent | 耦合任务重复读取、Token 和汇合成本上升 | 只按独立输出和验证边界拆分 |
| 把 Worktree 当万能隔离 | 外部状态和 Git 元数据仍共享 | 资源 Binding 与外部对账另建合同 |
| 用批准弹窗替代授权模型 | 批准者可能只看到命令，不知道产品后果 | 高影响动作先经过 Application/Decision |
| 实现者调用同模型 Review 后自动采用 | 相关偏差和自证闭环仍在 | Review 只产候选，采用权外置 |
| 用 Snapshot 证明治理有效 | Snapshot 只证明形状未变 | 还需行为测试、真实边界和后续 Eval |
| 把产品文档归因于 OSS Commit | 无法复现，也混淆开放与闭源边界 | 证据登记必须标注层次和读取日期 |

## 6. 候选规则

以下结论只是映射到现有 S1–S11 的候选机制，不单独创建新的规范事实源：

| 候选规则 | 建议强度 | 主要映射 | 证据角色 |
|---|---|---|---|
| 危险能力默认不可用，升级必须显式、可审计且不扩大任务授权 | 阻断 | S1/S11 | Codex OSS 强证据 + Chat 条件规则 |
| 并行默认用于只读工作；并行写必须分配 Worktree 或互斥 Owner | 阻断/审查 | S4 | Codex 限制 + Chat 项目合同 |
| 每组委派必须有父级集成者，子结果只作为候选 | 审查 | S4/S8/S9 | OSS 控制面 + 迁移推论 |
| Reviewer 默认只读真实 diff，并返回文件/行号、证据和残余风险 | 审查 | S8 | OSS/产品中强证据 |
| 采用必须可分项、可回退，并在最终组合上重新验证 | 阻断/审查 | S7/S8/S9 | 产品 Git 载体 + Chat 条件规则 |
| 模型可见的权限、规则选择和 Agent 状态必须有协议/回归测试 | 检测 | S2/S7/S10 | OSS 强证据 |
| 同模型多 Agent 不得按人数增加证据独立性权重 | 审查 | S8/S10 | 反证与迁移推论 |
| 外部副作用未知时不得由 Sandbox/Approval 自动重试 | 阻断 | S11 | Chat 项目合同；Codex 不用于背书 |

## 7. 采用总结

Codex 对本规范库最有价值的不是另一套 Agent loop，而是把治理拆成可组合控制面：能力边界、权限升级、
子任务生命周期、独立任务 Worktree、Reviewer 行为合同、Git 分项采用和协议测试。它支持以下初版决策：

- **直接采用原理**：能力最小化、显式升级、Reviewer 默认不修改、候选与采用分离、关键治理协议测试；
  需要机械只读时另配真实 Capability Profile。
- **适配后采用**：父/子 Agent 控制面、独立任务 Worktree/Handoff、分轴 Review。
- **明确拒绝**：默认并行写、同模型多数票、把 Sandbox 批准当产品授权、把 Worktree 当全局事务。
- **留待校准**：哪些任务值得多 Agent、Reviewer 数量与维度、Worktree 创建成本、误报和人类介入阈值。

最终迁移判断仍由 Chat 的授权、Product Store、Application、Workflow、Git 和测试合同裁决；
本项目只提供机制事实、失败边界和设计候选。
