# 精选标杆经验目录

> 版本：`agent-governance-exemplars.v0.2`。本目录只保留能直接改善方案、架构、代码、测试和
> Sub-agent 协作的经验。抽取与删除方法见[理论基础](../basis-and-evidence.md)；四份项目报告是固定来源附录，
> 普通工程任务只读取本页中与场景匹配的条目。

## 1. 按目的选择

| ID | 分类 | 要解决的问题 | 主要使用场景 |
|---|---|---|---|
| A1 | 方案与架构 | 核心被可选能力、外部协议和第二事实源持续撑大 | 新功能、Provider、Adapter、插件、复用决策 |
| A2 | 公共面与变更预算 | 一个需求立即制造稳定 API、Hook、层级和无消费者抽象 | 公共 API、接口、配置、持久格式、重构 |
| C1 | 代码与边界 | 输入、Owner、状态、失败和输出去向被抽象或默认值隐藏 | 网络、Store、Runtime、状态机和跨模块接缝 |
| Q1 | 可执行质量门 | 重复且可判定的约束依赖 Agent 记忆 | 重复结构、安全参数、生成物、Prompt/Skill 漂移 |
| T1 | 风险驱动测试 | 测试总数、Mock 或巨型 E2E 冒充真实风险证据 | Bug、Provider、浏览器、消费者、发布工件 |
| T2 | 共享合同测试 | 可替换实现对顺序、失败、幂等和并发各自解释 | 两个以上实现或高风险稳定接缝 |
| M1 | Sub-agent 协作 | 并行写入互相覆盖，子结果无人负责汇合 | 独立调查、并行实现、测试、代码审查 |
| R1 | 检查与采用 | 实现者自证完成，多数 Agent 意见冒充独立证据 | 最终 Diff、架构审查、高风险采用 |
| U1 | 供应链与激活 | 依赖、生成物、升级或发布以半完成状态进入项目 | 依赖升级、迁移、Managed Fork、发布和外部写入 |

一次任务只选择与风险直接相关的最小集合。五道推进门负责选择时点，不要求每轮加载九条全文。

## 2. 保留经验

### A1. 让核心只承担稳定且由本层负责的语义

- **目的**：减少共享变化原因，避免把通用能力、外部协议或产品事实错误塞进核心。
- **场景**：新增能力、选择上游、设计 Provider/Adapter/插件或改变模块依赖时。
- **执行**：先写事实所有者、真实消费者、非目标和变化方向；按“直接使用 → 窄接缝 → 拒绝 → 自研”选择，接缝必须有 Owner、验证和退出路径。
- **Sub-agent 检查**：是否出现第二事实源、反向依赖、万能 Adapter、无退出扩展点，或只是把复杂度搬出核心。
- **固定来源**：[Pi CONTRIBUTING](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/CONTRIBUTING.md)、[NanoClaw 贡献准入](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/CONTRIBUTING.md)、[AI SDK Provider 架构](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/architecture/provider-abstraction.md)；原卡 P1、N1、E1。
- **边界**：小核心不是少文件；产品责任不能为了“可选”被外包给插件或 Skill。

### A2. 用真实消费者和变化证据约束公共面与项目膨胀

- **目的**：阻止 Agent 为一个实例或未来猜测新增稳定 API、Port、Hook、配置、目录和兼容层。
- **场景**：新增公共导出、接口、持久格式、依赖、Workflow 节点或跨模块抽象前。
- **执行**：列出现有消费者和至少一种真实变化；记录计划与实际的生产文件、依赖、公共面、持久格式和配置；超出预算先回到设计，完成前删除无消费者增量。
- **Sub-agent 检查**：新增表面是否服务当前结果，是否存在更窄改法，实验或兼容面是否反向污染稳定层。
- **固定来源**：[AI SDK 项目哲学](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/project-philosophies.md)、[NanoClaw Skill 接缝规范](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/skill-guidelines.md)、[Pi Coding Agent 非目标](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/coding-agent/README.md)；原卡 E2、N2、P1。
- **边界**：“三个实现”只触发 Review，不是机械硬门；安全或标准合同可以在第一个实现前建立。

### C1. 让边界的数据流与失败语义可直接读懂

- **目的**：避免类型看似统一，实际身份、Scope、状态、错误、幂等和资源释放被默认值或宽泛抽象隐藏。
- **场景**：网络输入、Store、Provider、Runtime、状态机和跨所有权调用。
- **执行**：在稳定合同中显式传递身份、Revision、Scope、取消和输出去向；边界输入运行时校验；错误、部分成功和结果未知保持可区分。
- **Sub-agent 检查**：能否从当前模块和合同回答“谁拥有状态、怎样失败、结果去了哪里”；是否用 `catch`、默认成功或最低公分母接口抹平差异。
- **固定来源**：[Pi Session Conformance](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/agent/src/harness/session/testing/conformance.ts)、[AI SDK Provider 架构](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/architecture/provider-abstraction.md)、[AI SDK URL 安全规则实现](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/tools/oxlint-plugin-ai-sdk/index.mjs)；原卡 P2、E1、E3。
- **边界**：固定来源支持可观察合同、窄接缝和显式安全选择；Revision、Scope、结果未知等具体字段仍由目标项目合同决定。不是每个函数都需要接口、Schema 或 Repository。

### Q1. 把可确定约束下沉为会失败的检查

- **目的**：让重复结构、安全选择、生成物和模型可见规则不依赖 Agent 记忆。
- **场景**：多个实现重复同一约定，或遗漏会造成稳定且可机器判定的缺陷时。
- **执行**：优先复用 lint、Schema、生成器 Check、Hook 或合同测试；失败信息指向具体风险。AI SDK 的 Skill 漂移是反证，Chat 因此要求 Prompt/Skill 版本化并在采用前与当前源码和检查器核对。
- **Sub-agent 检查**：Oracle 是否可信、是否保护行为而非偶然形状、是否进入最终采用门、实现是否同时放宽检查器。
- **固定来源**：[AI SDK Konsistent](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.github/konsistent.json)、[AI SDK Add Provider Skill](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/skills/add-provider-package/SKILL.md)、[AI SDK 自定义 lint](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/tools/oxlint-plugin-ai-sdk/index.mjs)、[Codex AGENTS 回归测试](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/agents_md_tests.rs)；原卡 E3、E8、C6。
- **边界**：固定来源证明机器检查存在，也证明 AI SDK Skill 已发生漂移；没有来源证明其已经拥有完整漂移门。结构一致不等于设计正确。

### T1. 按失败模式与消费者选择最小充分测试 Lane

- **目的**：防止测试总数、人工 Mock 或一条巨型 E2E 掩盖未覆盖风险。
- **场景**：Bug 修复、Provider/工具链、不同运行时、浏览器、消费者和发布工件验证。
- **执行**：先把风险映射到纯规则、状态/并发、Adapter、真实边界、消费者、浏览器或发布工件；控制密钥、HOME、网络等隐式输入；只在对应声称需要时运行真实或付费 Lane。
- **Sub-agent 检查**：每条 Lane 证明什么、Fixture 是否绕过生产路径、未运行项是否如实报告、失败是否被重复运行或放宽断言掩盖。
- **固定来源**：[Pi Clean Environment](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/test.sh)、[Pi Faux Agent E2E](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/agent/test/e2e.test.ts)、[AI SDK 测试指南](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/contributing/testing.md)、[AI SDK CI](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/.github/workflows/ci.yml)；原卡 P3、E4、E5、N7。
- **边界**：保存的真实语料不等于当前服务；Faux 不证明模型质量、鉴权、网络或配额。

### T2. 用共享 Conformance 与集成点 Oracle 约束可替换实现

- **目的**：让多个实现对同一合同的顺序、失败、幂等、并发和 Wiring 保持一致。
- **场景**：存在真实第二实现，或 Provider、Store、Runtime 等高风险稳定接缝。
- **执行**：定义 runner-independent 的可观察行为 Suite；每个生产实现使用自己的真实 Fixture 注册；逐个保护有功能后果的导出、配置和启动接缝。
- **Sub-agent 检查**：是否遗漏生产实现或集成点，Fixture 是否走真实初始化，断言是否冻结私有调用顺序。
- **固定来源**：[Pi Session Conformance](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/agent/src/harness/session/testing/conformance.ts)、[Pi Telemetry Conformance](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/telemetry/src/testing/conformance.ts)、[NanoClaw 集成点规范](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/skill-guidelines.md)；原卡 P2、N2。
- **边界**：单一内部实现不值得为“以后可能替换”先造 Conformance 框架。

### M1. 只并行独立工作，并给写入和汇合唯一所有者

- **目的**：利用 Sub-agent 隔离调查噪声，同时避免并行写入覆盖代码、合同和验证基线。
- **场景**：两项以上独立调查、实现、测试或 Review；共享仓库、锁文件或外部资源。
- **执行**：标杆证据支持有界委派、父级汇合和收窄 Git 动作；Chat 进一步采用独立 Worktree 或互斥写集合、共享合同唯一写者和唯一集成者。
- **Sub-agent 检查**：任务是否真独立、CWD/基线是否正确、写集合是否相交、子结果是否带来源和验证、最终组合是否重验。
- **固定来源**：[Pi Git 协作规则](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/AGENTS.md)支持收窄Git动作，[Codex Multi-agent Tests](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tools/handlers/multi_agents_tests.rs)支持有界Sub-agent控制面，[NanoClaw Mount Guard](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/src/modules/mount-security/index.ts)只支持运行时能力Allowlist；原卡 P4、N8、C1–C3。
- **边界**：Codex 固定测试只证明 Sub-agent 控制面，不证明 Worktree 或写入所有权；后两者是 Chat 协作合同。权限只回答“能否写”，Worktree 也不隔离外部事务。

### R1. 分离实现、检查与最终采用

- **目的**：防止实现者自证完成，或把多个同模型 Sub-agent 的一致意见当成独立真相。
- **场景**：最终 Diff、跨所有权变更、迁移、权限、安全和高风险采用。
- **执行**：Codex 固定证据支持专门 Reviewer 检查明确 Diff 并返回文件/位置证据；Chat 进一步要求区分阻断、建议与未来项，由集成者或受保护门决定采用并重验最终组合。
- **Sub-agent 检查**：是否只复述摘要、是否扩大冻结完成门、证据是否新鲜、角色是否具备所声称的只读能力。
- **固定来源**：[Codex Review Task](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/src/tasks/review.rs)、[Codex Review Tests](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/codex-rs/core/tests/suite/review.rs)、[Codex Review Skill](https://github.com/openai/codex/blob/4347f94d5539880e8583028a50a19df5b202d9fa/.codex/skills/code-review/SKILL.md)；原卡 C3、C5、C7。
- **边界**：固定来源不证明 Reviewer 机械只读、同模型独立或最终采用权归属；这些是 Chat 的能力门与治理合同。角色分离只提高发现机会，不证明判断正确。

### U1. 把依赖、生成物、升级与发布当作可恢复状态变化

- **目的**：避免静默执行依赖代码、手改生成物、半升级和“请求已发送即成功”。
- **场景**：依赖/Lockfile/生成器、Managed Fork、持久迁移、发布、部署和其他外部写入。
- **执行**：固定并审核来源和执行面；存在生成器时用 Check 证明派生结果；Chat 在激活前记录可用恢复点和迁移影响、验证最终消费者，并按目标外部合同使用稳定身份和查询对账。
- **Sub-agent 检查**：计划外依赖或脚本、来源漂移、恢复点覆盖、最终工件是否离开仓库环境验证、结果未知是否被盲目重试。
- **固定来源**：[Pi Lockfile Guard](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/scripts/check-lockfile-commit.mjs)、[Pi Shrinkwrap Generator](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/scripts/generate-coding-agent-shrinkwrap.mjs)、[Pi Publish](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/scripts/publish.mjs)、[Pi 发布 Workflow](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/.github/workflows/build-binaries.yml)、[NanoClaw Upgrade Tripwire](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/src/upgrade-state.ts)、[AI SDK 依赖政策](https://github.com/vercel/ai/blob/e21bde74c64351453ac82abeae07e00fe838ee9a/pnpm-workspace.yaml)；原卡 P5、P6、N5、E7。
- **边界**：Pi 证明生成检查、版本查询与公告前对账；NanoClaw只证明启动Tripwire，不证明完整恢复。恢复点、回执和一般外部结果未知仍由Chat合同定义；Pin、Tag或Marker不能单独证明用户可用。

详细证据、反证和项目语境仍可在 [Pi](./pi.md)、[NanoClaw](./nanoclaw.md)、[Vercel AI SDK](./vercel-ai-sdk.md) 和
[OpenAI Codex](./openai-codex.md) 中按卡片 ID 定位。只有质疑来源、调整经验或复核失效条件时才读取这些附录。
