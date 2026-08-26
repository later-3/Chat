# Vercel AI SDK 经验抽取

> 研究快照：<https://github.com/vercel/ai/tree/e21bde74c64351453ac82abeae07e00fe838ee9a>
>
> 快照时间：2026-08-25。研究方式：只读官方仓库的文档、配置、源码和测试；未安装、未运行、未试用。
>
> 本文区分仓库事实、维护者主张和我们的推论。Star、README 宣传和版本号本身不作为效果证明。

## 1. 研究合同

### 1.1 入选理由

Vercel AI SDK 与 Chat 同属 Node.js + TypeScript 生态，也同时面对多 Provider、流式协议、Agent、
Workflow、浏览器/Edge 运行时、公开 API、示例、文档和频繁发布。它适合回答一个具体问题：

> 一个长期公开的 TypeScript SDK，怎样把快速变化的外部 Provider 和 Agent Runtime 限制在稳定接缝后，
> 并用测试、兼容和发布机制降低大量贡献者与 Coding Agent 带来的变化自由度？

它与 Pi、NanoClaw 的互补关系是：

- Pi 更适合研究 Agent loop、工具执行、Session 和 Coding Agent 内核。
- NanoClaw 更适合研究小核心、可组合 Recipe/Skill 和受控扩展。
- Vercel AI SDK 更适合研究公开 Provider 合同、跨运行时兼容、重复 Adapter 的一致性和发布治理。

### 1.2 研究范围

本轮把以下部分视为较成熟、可提供较强工程证据的范围：

- <code>packages/ai</code>、<code>packages/provider</code>、<code>packages/provider-utils</code> 的分层和公共面。
- 多个 Provider 包的结构、按维护流程捕获 Provider 响应的 Fixture、Node/Edge 测试和示例。
- Monorepo 的 build、typecheck、CI、bundle/load-time 预算和跨版本测试。
- Changesets、预发布、维护分支、backport、codemod、npm provenance 和依赖供应链配置。
- <code>AGENTS.md</code>、仓库 Skill、Hook 和结构一致性检查怎样共同服务 Coding Agent。

以下部分只作为新兴观察，不作为已经长期验证的核心经验：

- <code>@ai-sdk/workflow</code>：初版提交于 2026-04-13，固定快照仍依赖 Workflow 5 beta。
- <code>@ai-sdk/harness</code> 及 Codex、Claude Code、Pi Adapter：主要实现提交于 2026-06-10。
- Harness/Workflow 的高版本号：该仓库会让功能和修复都使用 patch，版本号不能换算成使用年限或稳定性。

### 1.3 非目标

- 不判断 AI SDK 的产品功能是否优于其他 SDK。
- 不把 Provider SDK 的分包方式直接映射为 Chat 的 Product Store、Application 或 Workflow 所有权。
- 不把 Vercel 商业产品、内部组织流程或未公开的生产数据当作证据。
- 不通过安装或跑样例验证效果；真实接入和调参属于后续使用阶段。
- 不把测试文件数量、提交频率或维护者主张单独当作因果证明。

### 1.4 项目约束

抽取结论必须考虑 AI SDK 自身的约束：

1. 它是被大量第三方直接依赖的公共 SDK，公共 API 和包体比 Chat 内部模块更敏感。
2. 外部 Provider API 高频变化，且 Node、Edge、浏览器之间存在真实能力差异。
3. Provider、框架和 Harness Adapter 高度重复，结构漂移成本会随包数量放大。
4. 发布对象是多个 npm 包，兼容、版本和供应链治理是核心生产责任。
5. 它不是拥有产品事实、事务、耐久审批和外部副作用终态的业务系统。

### 1.5 证据解释

本文采用以下置信顺序：

1. 固定源码、测试、CI 和机器检查证明“仓库确实这样做”。
2. 贡献规范、项目哲学和 Skill 证明“维护者要求或主张这样做”。
3. 两者一致时，形成较强的机制假设。
4. 只有文字、没有执行载体时，不能称为已经强制生效。
5. 本轮没有对照实验，因此不声称某一机制单独导致了项目质量。

## 2. 成熟度边界

| 子系统 | 阶段判断 | 主要证据 | 本轮使用方式 |
|---|---|---|---|
| AI Core / Provider Spec / Provider Utils | 成熟 | 多代 Changelog、稳定分层、跨运行时测试、公开兼容政策 | 核心证据 |
| Provider Adapter 生态 | 较成熟 | 大量按维护流程捕获响应的 Fixture、重复结构检查、Node/Edge 套件 | 核心证据 |
| Monorepo CI / Release / Supply Chain | 较成熟 | CI Jobs、Changeset 检查、维护分支、provenance、依赖政策 | 核心证据；仓库外 Branch Protection 不作成立主张 |
| 仓库 Agent 指令与 Skill | 演进中 | AGENTS、Skill、Hook 已存在，但可观察到内容漂移 | 条件经验与反证 |
| WorkflowAgent | 新兴 | 2026-04 初版；Workflow 5 beta；Integration lane 未进入默认 CI | 专题观察 |
| Harness 与多 Coding Agent Adapter | 新兴 | 2026-06 才形成主要 Adapter；后续修复频繁 | 专题观察 |

关键时间证据：

- [WorkflowAgent 初始提交](https://github.com/vercel/ai/commit/b3976a2bfedd9e0e25102559a7aeacff4e119336)
- [Claude Code、Codex、Pi Harness Adapter 提交](https://github.com/vercel/ai/commit/3d9a50c17e67f6718e92eac28ec99e369eb9b44c)
- [固定快照中的 Workflow 包合同](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/workflow/package.json)

## 3. S1–S11 覆盖总表

“强/中/弱/—”表示该项目对本规范问题的覆盖，不是对项目总体质量评分。载体强度从强到弱为：
阻断、检测、审查、提示、观察。

| 规则组 | 覆盖 | 主要载体强度 | AI SDK 中的对应做法 | 边界判断 |
|---|---|---|---|---|
| S1 授权与任务合同 | 中 | 审查、提示 | CONTRIBUTING 鼓励先给 Issue/Repro，AGENTS 按任务列完成物 | 没有 Chat 式用户授权和外部动作合同 |
| S2 事实源与规则选择 | 中 | 提示、检测 | AGENTS 路由到架构、贡献文档和 Skill；版本匹配文档优先 | Skill 已出现漂移，冲突处置不完整 |
| S3 设计与复用 | 强 | 审查、检测 | Lean mission、分层 Provider、规则三、实验 API 隔离 | 必要性仍主要依赖维护者判断 |
| S4 分解与所有权 | 弱 | 提示 | Worktree setup、包级任务说明、自动化维护 | 没有多 Agent 写入所有权和唯一集成者合同 |
| S5 变更预算 | 强 | 检测、审查 | 保守公共面、最小 Schema、bundle/load-time 检查、依赖政策 | 固定仓库不证明这些 Job 均为 Required，也没有 LOC、文件或抽象数量总预算 |
| S6 代码与抽象 | 强 | 检测、审查 | Spec→Utils→Provider→Core；Konsistent；自定义 oxlint | 结构通过不等于语义或所有权正确 |
| S7 风险与验证 | 强 | 检测、审查 | Node/Edge、类型、示例、RSC E2E、Provider 响应 Fixture、多 Node | 付费真实 Provider 与 Workflow Integration 并非默认 CI 门；Branch Protection 不可见 |
| S8 独立审查与采用 | 中 | 审查 | PR 自审、E2E Verification、维护者 Review | 没有机器证明 Reviewer 独立，也没有统一风险分级 |
| S9 完成与交接 | 中（发布子域强） | 检测、审查 | Changeset、PR 模板、CI、发布 PR、Commit/Changelog | 公开 Package 发布闭环较强，不等于耐久任务状态、恢复和交接 |
| S10 治理自身 | 中 | 检测、审查 | Philosophy、ADR 起点、codemod、pre-release、Skill | ADR 与 Skill 体系较新，规则漂移尚未被完全阻断 |
| S11 外部动作 | 中 | 执行约束、检测 | 最小 Workflow 权限、trusted publish、provenance、URL 安全规则 | 没有通用 outcome_unknown 和业务对账语义，固定仓库也不证明保护分支配置 |

## 4. 高价值经验卡

### E1. 用稳定 Spec 接缝吸收外部 Provider 变化

- **目标失败**：每个 Provider 把自己的协议、错误、流式事件和选项扩散到 Core，最终形成条件分支网络。
- **项目做法/规范内容**：把能力分为 Provider Specification、Provider Utils、具体 Provider 和高层 Core；第三方 Provider 也能只实现公开 Spec。
- **生效机制**：变化频率最高的外部协议被 Adapter 截止；Core 只依赖稳定能力合同，重复解析和错误归一进入共享 Utils。
- **载体**：包依赖方向、公开类型、Provider 实现、Architecture 文档、TypeScript 编译和测试。
- **固定证据**：[项目哲学](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/project-philosophies.md)、[Provider 架构](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/architecture/provider-abstraction.md)、[根 AGENTS 依赖图](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/AGENTS.md)。
- **底层因果解释（推论）**：当外部变化只能通过一个窄合同进入，单次变化能触达的内部状态空间更小；类型和合同测试又把违反接缝变成更早的失败。
- **失效条件/反证**：Spec 自身如果快速膨胀，复杂度只是被集中而非消除；Provider 语义差异过大时，强行归一会制造最低公分母或隐藏失败。
- **不可照搬**：Chat 的 Product Store、Application、Workflow 和 Provider 不是同一种可替换 Adapter，不能为视觉统一全部套成 Provider 包。
- **映射到 Chat/Codex/Workflow**：Chat 只在真正不稳定且可替换的外部能力使用窄 Port；Codex 设计时必须列出事实所有者和变化方向；Workflow 的设计准入节点检查是否把产品终态交给 Adapter。
- **采用结论**：**核心规则**；映射 S3、S6。**置信度：高**，因为固定快照的文档、包结构、实现和多代
  Changelog 相互印证；未证明它对所有领域都优于其他分层，也不从单一快照声称“长期一致”。

### E2. 用“规则三 + Experimental 隔离”延迟公共抽象承诺

- **目标失败**：Agent 根据一个 Provider 的新能力立即增加通用参数、类型和稳定 API，未来被其他 Provider 语义反噬。
- **项目做法/规范内容**：至少看到三个 Provider 的共同概念再抽象；不确定能力通过 providerOptions 或 Experimental 导出探索；稳定类型不得引用实验类型。
- **生效机制**：规则三要求额外样本，降低偶然相似被误认成共同变化的概率；实验命名和类型隔离限制承诺半径。
- **载体**：项目哲学、命名规范、公开 Export seam、维护者共识和 Major release。
- **固定证据**：[项目哲学的 API Design](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/project-philosophies.md)、[命名规范](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/naming-conventions.md)、[Provider v4 索引](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/provider/src/index.ts)。
- **底层因果解释（推论）**：公共 API 的修改成本通常随消费者数量上升而上升；延迟承诺保留信息，而隔离实验面降低撤回成本。
- **失效条件/反证**：三个实现可能共享表面名称却没有共同失败语义；Experimental 也可能成为长期不清理或逃避设计责任的出口。
- **不可照搬**：数字 3 不是跨项目真理；安全、法律或协议标准要求明确时，一个实现也可能必须先建立合同。
- **映射到 Chat/Codex/Workflow**：Codex 对新接口列出现有消费者和第二种变化；Chat 经验包提供条件式规则三；Workflow 设计节点要求稳定面与实验面不可反向依赖。
- **采用结论**：**条件规则**；映射 S3、S5、S6。**置信度：中高**，规范清楚且类型结构可观察，但抽象质量仍需人工判断。

### E3. 把高频结构约定和安全选择变成 Fail-closed 确定性检查

- **目标失败**：几十个 Provider/Harness Adapter 在文件、导出、认证、桥接或安全参数上逐渐漂移；Agent 忘记一项便留下隐蔽缺口。
- **项目做法/规范内容**：使用 Konsistent 检查 Package、Provider、Harness 和 Sandbox 的文件/导出结构；使用仓库自定义 oxlint 强制每次 getFromApi 调用显式写出 validateUrl。
- **生效机制**：把有限、重复、可静态判断的约定编码为 CI 失败；安全选择必须留在调用现场，不能由默认值或外部对象掩盖。
- **载体**：<code>pnpm konsistent</code>、CI Code Consistency job、自定义 lint plugin 和安全文档。
- **固定证据**：[Konsistent 配置](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.github/konsistent.json)、[CI](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.github/workflows/ci.yml)、[URL lint 实现](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/tools/oxlint-plugin-ai-sdk/index.mjs)、[安全 URL 规则](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/secure-url-handling.md)。
- **底层因果解释（推论）**：机器检查不会疲劳，也不会因 Agent 换模型而忘记；Fail-closed 又把不可证明的动态写法归入失败，显著缩小绕过空间。
- **失效条件/反证**：结构一致可能掩盖语义错误；例外清单会积累；大型规则配置本身也可能成为第二套程序和维护负担。
- **不可照搬**：不要机械要求所有 Chat 包拥有相同文件或导出；只有跨多个真实实现重复、误差高且静态可判定的约定才值得编码。
- **映射到 Chat/Codex/Workflow**：Chat 继续用架构测试阻断事实所有权越界；Codex 在设计阶段区分“可机械判断”和“需要 Reviewer”；Workflow 先跑确定性检查再调用 LLM Reviewer。
- **采用结论**：**核心机制**；映射 S5、S6、S7、S10。**置信度：高**，仓库存在真实确定性检测载体；
  只有这些结果进入受保护采用门后才具有合入阻断力，固定仓库不能证明外部 Branch Protection 配置。

### E4. 用按维护流程捕获的 Provider 响应形成可重复边界语料

- **目标失败**：只用人工构造 Mock，遗漏 Provider 的 null、缺字段、SSE 分帧、错误 Shape 和非标准顺序，Adapter 在真实调用时才失败。
- **项目做法/规范内容**：捕获真实 generate/stream 响应为 Fixture；对流式 Provider 重建各自 SSE envelope；Node 和 Edge 套件消费同一边界语料。
- **生效机制**：真实样本提高测试输入与生产分布的接近程度，保存后又消除付费网络和时间不确定性，使历史问题可稳定回放。
- **载体**：Provider <code>__fixtures__</code>、Test Server、Vitest Node/Edge 配置、Fixture Skill 和贡献测试指南。
- **固定证据**：[测试指南](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/testing.md)、[Fixture Skill](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/skills/capture-api-response-test-fixture/SKILL.md)、[OpenAI Responses Fixture 目录](https://github.com/vercel/ai/tree/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/openai/src/responses/__fixtures__)、[OpenAI Responses 测试](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/openai/src/responses/openai-responses-language-model.test.ts)。
- **底层因果解释（推论）**：边界错误往往来自输入分布而非算法主体；真实语料增加异常 Shape 被覆盖的概率，确定性回放缩短发现—修复反馈距离。
- **失效条件/反证**：Fixture 会陈旧，只证明被捕获的响应；裁剪可能删掉关键语义；它不能证明认证、限流、网络和当前 Provider 仍兼容。
- **不可照搬**：不得把含密钥、隐私、完整 Provider Payload 或许可不明内容提交进 Chat；高风险 Provider 仍需要显式真实门。
- **映射到 Chat/Codex/Workflow**：Chat Provider Adapter 建立脱敏合同 Fixture；Codex Bug 修复先增加真实边界回归；Workflow 风险 Profile 决定 Fixture、合同测试还是付费真实门。
- **采用结论**：**核心测试经验**；映射 S7。**置信度：中高**，捕获流程、静态 Fixture 和消费测试可直接定位，
  但静态文件本身不能逐个证明来源；对未捕获分布的外推有限。

### E5. 用运行时与消费者矩阵证明兼容，而不依赖单一测试总数

- **目标失败**：核心单元测试通过，但包不能发布、类型污染下游、Edge/旧 Node 失败、示例无法构建或浏览器纵向破裂。
- **项目做法/规范内容**：CI 分开运行格式、类型、Package build、Examples build、Node/Edge 测试、Node 版本矩阵、Windows MCP、RSC 浏览器 E2E、bundle size 和 load time。
- **生效机制**：同一变更被不同消费者和运行时重新解释；若兼容问题只在某一环境出现，矩阵提供独立故障表面。
- **载体**：GitHub Actions Jobs、Turborepo task graph、Examples、Playwright、bundle/load-time 阈值；部分 Job 注释表达
  “用于设置为 Required”的维护意图，但保护分支配置不在固定仓库内。
- **固定证据**：[根 CI](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.github/workflows/ci.yml)、[Turbo task graph](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/turbo.json)、[AI bundle 预算脚本](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/ai/scripts/check-bundle-size.ts)。
- **底层因果解释（推论）**：不同运行时和消费者形成不完全相关的 Oracle；多个独立 Oracle 同时通过，比同一层增加相似测试更能减少共同漏检。
- **失效条件/反证**：矩阵会变慢和变贵；重复 Lane 可能只增加等待；固定阈值可被直接上调；默认 CI 没有运行付费 Provider E2E 和 Workflow Integration。
- **不可照搬**：Chat 不需要复制所有 Provider、Node 和浏览器组合；应按实际支持合同和风险选择最小矩阵。
- **映射到 Chat/Codex/Workflow**：Codex 开工时写风险—Lane 映射；Chat 为包、浏览器、真实服务、Fork 漂移建立独立 Lane；Workflow 只为高风险纵向选择真实门。
- **采用结论**：**核心机制**；映射 S7、S9。**置信度：高**，CI Job 与配置载体明确；外部 Branch Protection
  和每条 Lane 的边际收益仍需另行证明与校准。

### E6. 把问题证据、用户纵向和发布后果放进同一个变更闭环

- **目标失败**：贡献者直接提交大实现，没有最小复现、用户可见验证、发布说明或迁移后果；Reviewer 只能从代码猜意图。
- **项目做法/规范内容**：鼓励高质量 Issue、最小复现和 failing test；PR 模板单列 Background、Summary、End-to-End Verification、自审和 Changeset；生产包变化由 Changeset gate 检查。
- **生效机制**：问题证据先定义失败，E2E 说明补足单元测试不能证明的用户路径，Changeset 迫使作者在合入前面对公共行为和发布影响。
- **载体**：CONTRIBUTING、PR Template、Verify Changesets workflow、测试和维护者 Review。
- **固定证据**：[贡献指南](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/CONTRIBUTING.md)、[PR 模板](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.github/pull_request_template.md)、[Changeset gate](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.github/workflows/verify-changesets.yml)。
- **底层因果解释（推论）**：把“为什么改、如何失败、用户怎样验证、发布什么”放在同一审查单元，可减少实现者与采用者的信息差，并让遗漏更容易显性化。
- **失效条件/反证**：Checklist 可以形式化勾选；E2E 文本可能未经复核；模板要求自审但不保证独立审查；“维护越来越自动化”只是维护者主张。
- **不可照搬**：Chat 的完成事实不能由 PR 或 Changeset 拥有；未发布的内部模块也不需要为每次修改制造版本资产。
- **映射到 Chat/Codex/Workflow**：Codex 交付包固定列问题证据、真实纵向、测试和未运行项；Chat Workflow 将任务合同、Executor 证据、确定性门和 Reviewer 结论汇成 Product Commit 候选。
- **采用结论**：**条件机制**；映射 S1、S7、S8、S9。**置信度：中高**，强制 Changeset 可证明，模板内容的实际质量依赖人类审查。

### E7. 将兼容迁移与供应链控制前移到发布之前

- **目标失败**：行为变化静默发布；Breaking change 无迁移路径；依赖刚发布即进入构建；发布密钥和 Action 浮动版本扩大供应链风险。
- **项目做法/规范内容**：生产代码必须有 Changeset；大版本使用 beta 与维护分支并可 backport；Breaking change 尽量配 codemod；包启用 npm provenance；依赖设最小发布时间和 install-script allowlist；Actions 固定 SHA。
- **生效机制**：版本影响成为 PR 中的机器可查资产；预发布和 backport 隔离稳定线；依赖冷却与脚本白名单减少新供应链事件直接执行代码的机会；OIDC provenance 提供发布来源证明。
- **载体**：Changesets、Release workflow、Backport workflow、Codemod tests、pnpm workspace policy、Dependabot 和 GitHub Actions permissions。
- **固定证据**：[发布指南](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/releases.md)、[预发布指南](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/pre-release-cycle.md)、[Release workflow](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.github/workflows/release.yml)、[依赖政策](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/pnpm-workspace.yaml)、[Codemod 指南](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/codemods.md)。
- **底层因果解释（推论）**：不可逆发布的修复成本高于 PR 阶段；把影响声明、迁移和来源证明提前，会提高缺失信息被发现的概率并缩小凭据暴露面。
- **失效条件/反证**：该仓库明确让 feature 和 fix 都使用 patch、minor 用于 marketing，不能视为标准 SemVer；provenance 证明来源不证明代码安全；Release 自动化也可能出错。
- **不可照搬**：Chat 当前以本地分支为默认交付，不应因此自动发布 npm、push 或建 PR；多包高频发布流程的成本不适合所有项目。
- **映射到 Chat/Codex/Workflow**：Codex 只报告发布影响不自动执行；Chat 依赖门采用冷却、来源和退出检查；Workflow 发布节点需要显式授权、幂等身份、回执和对账。
- **采用结论**：供应链部分为**核心机制**，版本策略为**专题经验**，非 SemVer 部分**拒绝照搬**；映射 S5、S9、S11。**置信度：高/中**。

### E8. Agent 指令需要渐进路由，但内容必须接受漂移检查

- **目标失败**：把所有工程知识塞进一个常驻 Prompt，Agent 读不完；或者把流程写成 Skill 后长期无人校验，反而指导 Agent 生成过时代码。
- **项目做法/规范内容**：AGENTS 提供仓库地图和通用完成门；根 <code>skills/</code> 按 Provider、Harness、Fixture、Major release 等任务提供步骤；Codex/Claude/Cursor Hook 在编辑后运行格式化。
- **生效机制**：常驻地图负责触发，任务 Skill 在决策时提供局部流程，Hook 把格式化从记忆要求变成自动反馈。
- **载体**：AGENTS、Skill 目录、<code>.agents/skills</code> 路由、Codex/Claude/Cursor Hook、lint 和 CI。
- **固定证据**：[AGENTS](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/AGENTS.md)、[Add Harness Skill](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/skills/add-harness-package/SKILL.md)、[Codex Hook](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.codex/hooks.json)、[Add Provider Skill](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/skills/add-provider-package/SKILL.md)。
- **底层因果解释（推论）**：决策相关信息越接近决策点，越可能被使用；确定性 Hook 又不依赖模型注意力。但内容正确性仍取决于事实源同步。
- **失效条件/反证**：Add Provider Skill 仍示例 CJS+ESM build，并写“不要创建 CHANGELOG”；固定快照已经 ESM-only，而 Konsistent 要求 Package 有 CHANGELOG。这证明 Skill 存在不等于正确或生效。
- **不可照搬**：不要把整个 AI SDK AGENTS 或 Skill 复制进 Chat；编辑后无条件跑全仓格式命令也可能造成延迟和无关修改。
- **映射到 Chat/Codex/Workflow**：Chat 保持小 Map + Workspace Overlay + 任务 Skill；Codex 只加载相关规则；Workflow 冻结实际规则版本，并让治理变更独立检查 Skill 与当前源码/脚本是否一致。
- **采用结论**：渐进路由为**核心机制**，现有 Skill 内容仅为**条件参考**；映射 S2、S7、S10。**置信度：中高**，路由结构可见，实际触发率和效果未测量。

## 5. 反面经验与未证明主张

### 5.1 不应照搬的做法

1. **Feature 也用 patch、minor 作为 marketing release**：这是项目自己的发布政策，不适合作为跨项目版本规范。
2. **用版本号推断成熟度**：Harness 的 1.0.x 补丁很多，但主要 Adapter 只有数月历史。
3. **用同构包结构代替领域设计**：Konsistent 适合大量相似 Provider/Harness，不适合所有 Chat 包。
4. **用 Fixture 代替真实 Provider**：Fixture 只证明历史响应的解析和归一。
5. **用 Checklist 代替独立 Review**：勾选自审、测试、文档不证明结论被独立核对。
6. **把自动化规模当成目标**：AI SDK 的多包发布、通知和 backport 系统服务于其生态规模，Chat 不应按文件数量复制。

### 5.2 固定快照中的反证

- 根级脚本和 CI 未发现项目自有的覆盖率阈值、Mutation testing 或统一死代码门。
- <code>@ai-sdk/provider</code> 本身测试数量少，很多信心来自下游 Provider/Core 的合同消费，而不是每包均匀覆盖。
- Workflow Integration 测试通过独立 <code>test:integration</code> 执行，默认 Node/Edge 配置明确排除 <code>*.integration.test.ts</code>，固定 CI 未调用该命令。
- 真实付费 Provider 测试存在示例和手工说明，但固定 CI 主要运行确定性测试，不能宣称每个 PR 都验证最新 Provider 服务。
- ADR 体系在 2026-03 才正式采用，固定目录主要是“采用 ADR”本身，不能称为已积累成熟决策史。
- Skill 与现有 ESM、CHANGELOG 规则发生漂移，说明文档、Prompt 和 Skill 需要自己的测试与废弃机制。

证据：

- [Workflow Node 测试配置](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/workflow/vitest.node.config.js)
- [Workflow Integration 配置](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/workflow/vitest.integration.config.mjs)
- [Workflow Integration 场景](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/workflow/src/workflow-agent-e2e.integration.test.ts)
- [ADR 索引](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/decisions/README.md)
- [当前 ESM-only build](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/packages/ai/tsup.config.ts)

### 5.3 尚未证明的维护者主张

- “维护自动化提高质量”缺少本轮可见的前后对照数据。
- “规则三一定产生更好抽象”只有机制合理性，没有独立因果实验。
- “面向 Coding Agent 优化命名会减少幻觉”是合理假设，但固定仓库没有对应 Eval 结果。
- “大量测试意味着高可靠性”不能由文件数量推出；测试价值取决于风险覆盖和 Oracle。
- “Harness 统一多 Coding Agent 后能稳定替换 Runtime”仍属于新兴能力，需要更长升级与失败历史。

## 6. 可升级为 Chat 候选规则

以下结论已有较强源码和机制支持，可以进入跨项目候选池，但仍需结合 Pi、NanoClaw、Vite 或 Chat 事实交叉验证：

1. **不稳定外部能力必须通过窄合同进入，Adapter 不得拥有产品终态。**
2. **公共抽象必须由多个真实变化证明；实验面不得反向污染稳定面。**
3. **高频、重复、可静态判定的约定应优先变成 Fail-closed 检查。**
4. **Provider Bug 应沉淀脱敏的真实边界 Fixture，并明确 Fixture 不等于真实服务验证。**
5. **验证矩阵按运行时和消费者差异设计，而不是按测试数量平均分配。**
6. **每个行为变化必须同时交代问题证据、用户纵向、发布/迁移影响和未运行项。**
7. **依赖采用要包含最小发布时间、安装脚本、来源、许可证和退出路径。**
8. **Agent Map、Skill 和 Hook 必须版本化，并用当前源码/脚本检查漂移。**

## 7. 仍缺证据

在把上述候选升级为 Chat 硬门前，仍需要回答：

1. Chat、Pi、NanoClaw 和 Vite 是否也支持同一条规则，还是只有公共 SDK 才需要？
2. AI SDK 的 Konsistent、bundle/load-time 门实际阻止过哪些事故，误报和维护成本如何？
3. Provider Fixture 多久更新、怎样脱敏、怎样识别陈旧，与真实 Provider 门怎样分工？
4. Skill 在 Codex、Claude Code、Cursor 等宿主中的真实触发率和遵守率是多少？
5. Workflow/Harness Integration 为什么没有进入固定 CI，是成本选择、稳定性问题还是阶段性遗漏？
6. 两个以上独立 Reviewer、确定性 CI 与自审分别贡献了多少缺陷发现？
7. Chat 需要哪些 bundle、load-time、API 和依赖预算，阈值怎样从自身风险得到而不是复制 AI SDK？
8. 治理资产如何计算维护预算，并在低价值或漂移时自动降级、合并或删除？

## 8. 总结判断

Vercel AI SDK 值得作为核心标杆，但核心价值不是“它也做 Agent”，而是它展示了三条更一般的工程路径：

1. 用稳定接缝和保守公共面控制快速外部变化。
2. 把重复结构、安全选择、兼容和发布后果尽可能变成机器可见的失败。
3. 用真实边界语料和多消费者矩阵补足单层 Mock 的盲区。

它也提供了重要反证：Agent 指令和 Skill 会漂移；新兴 Workflow/Harness 不能因版本号高而假装成熟；
测试和自动化很多也不能替代真实服务、独立 Review 和项目自己的风险模型。

因此本项目的采用定位是：

- 成熟 Core/Provider/Release：**核心经验来源**。
- Konsistent、按流程捕获的边界 Fixture、兼容矩阵：**优先迁移的机制候选**。
- Workflow/Harness：**新兴专题观察**。
- 非 SemVer 版本策略和全量发布流程：**拒绝直接照搬**。
