# NanoClaw 经验抽取：小核心、可组合定制与升级控制

> 研究版本：`agent-governance-exemplar.nanoclaw.v0.1`。
>
> 固定快照：[`nanocoai/nanoclaw@0c0f4c2`](https://github.com/nanocoai/nanoclaw/tree/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9)。
>
> 方法：只读官方仓库的文档、配置、源码和测试；未安装、未运行、未试用。本文区分仓库事实、维护者主张和
> Chat 迁移推论。Star、功能数量和作者承诺不作为效果证据。

## 1. 研究合同

### 1.1 入选理由

NanoClaw 与 Chat 都面对同一个长期问题：Agent 会持续改变项目，而项目又需要吸收上游更新、按需增加能力、
隔离危险动作并保留恢复路径。它提供了一套明确但仍在演进的答案：

> 稳定核心只保留多数用户需要的基础设施；定制通过 Skill 以可重放增量叠加；每个真实集成点携带防漂移测试；
> 升级只允许走带预览、备份、迁移、验证和恢复的受控路径。

它对四个核心标杆的边际贡献是：

- Pi 主要回答 Agent loop、Session、Tool 和执行内核怎样组织。
- Vercel AI SDK 主要回答公共 Provider/API 和现代 TypeScript 生态怎样兼容演进。
- OpenAI Codex 主要回答权限、沙箱、多 Agent 控制和独立采用。
- NanoClaw 主要回答个人化 Fork 怎样用 Skill、Recipe、集成点测试和升级流程维持可组合性。

### 1.2 研究范围

本轮只研究：

1. “稳定小核心 + 按需 Skill”的规范内容与仓库载体。
2. Skill 的 additive apply、REMOVE、reapply 和依赖/顺序声明。
3. 为什么集成点数量可以作为升级风险信号，以及测试怎样保护这些点。
4. Fork 正常升级、从 Recipe 重建、Migration、Rollback 和启动 Tripwire。
5. Registry branch、公开 Registry 复审、依赖供应链与运行时安全边界。
6. 固定快照中设计承诺、已实现机制和缺失机制之间的差距。

主要证据入口：

- [Skills model](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/skills-model.md)
- [Skill guidelines](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/skill-guidelines.md)
- [Contributing](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/CONTRIBUTING.md)
- [Update Skill](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.claude/skills/update-nanoclaw/SKILL.md)
- [Upgrade Tripwire](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/src/upgrade-state.ts)
- [Security model](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/SECURITY.md)

### 1.3 非目标

- 不评价 NanoClaw 是否适合作为 Chat 产品或 Runtime 依赖。
- 不复制它的目录、Claude Code 命令、Registry branch 或个人 Fork 模式。
- 不把 README 的“小到可理解”“升级不会破坏你”当作已经证明的项目结果。
- 不用单个 Skill 的测试证明所有 Skill 都满足幂等、可移除或可组合。
- 不把“第 500 个 Skill 与第 1 个同成本”视为成立；该主张没有规模化组合证据。
- 不用 Container 隔离替代 Chat 的 Product Decision、权限、幂等、`outcome_unknown` 和对账。
- 不在本阶段通过安装、应用 Skill 或构造实验来验证效果。

### 1.4 项目约束

抽取必须保留 NanoClaw 的特殊约束：

1. 它面向个人或小规模定制安装，鼓励用户维护自己的 Fork，不是统一运营的多租户产品。
2. Trunk 主要保留 Registry 和基础设施；Channel、非默认 Provider 等代码由 Skill 从长期分支复制进安装。
3. Host 使用 Node/pnpm，Agent Runner 使用 Bun，并以 Container、挂载和 Session DB 分隔运行时。
4. Skill 的 Apply/Remove 主要是 Coding Agent 执行的 Markdown 步骤，不是事务化 Package Manager。
5. Breaking change 被允许，但必须提供 Agent 可执行的迁移路径；发布仍由维护者手工完成。
6. 运行时 Agent 有 Container 边界；应用仓库 Skill 的宿主 Coding Agent 在固定快照中关闭了 Claude sandbox，
   两个权限面不能混为一谈。

### 1.5 证据强度

- **强事实**：固定源码、测试、CI 或可执行检查证明该载体存在。
- **中等事实**：Skill/贡献文档明确规定步骤，并有部分实例与之吻合。
- **弱主张**：未来时态的 Registry Harness、真实 Fork fleet、Recipe stack test 或规模承诺。
- **迁移推论**：解释机制为什么可能降低风险，但不伪装成 NanoClaw 已做过的因果实验。

## 2. S1–S11 覆盖总表

“强/中/弱/—”表示 NanoClaw 对规则问题的覆盖，不是总体质量评分；“阻断/检测/审查/提示/观察”表示
固定快照中最接近的载体强度，不表示 Chat 已经拥有同样控制。

| 规则组 | 覆盖 | 主要载体强度 | NanoClaw 对应做法 | 关键边界 |
|---|---|---|---|---|
| S1 授权与任务合同 | 中 | 审查、提示 | Customize/Update Skill 在关键分支询问用户，贡献要求一事一 PR | 没有冻结用户结果、非目标和外部动作的统一任务合同 |
| S2 事实源与规则选择 | 中 | 提示、检测 | README/CONTRIBUTING/Skills model/Skill guidelines 分层，升级先刷新自身 Skill | 同一快照仍存在新旧分支安装文档冲突，路由未消除漂移 |
| S3 设计与复用 | 强 | 审查、提示 | Core 只接收修复、安全和简化；能力优先放入 Skill；真实热点才增加 Hook | “多数用户需要”和 Hook 准入仍由维护者判断 |
| S4 分解与所有权 | 弱 | 提示、观察 | 一个定制一个 Skill，Recipe 声明顺序/依赖，迁移建议并行只读探索 | 未见通用多 Agent 写入所有权、租约或唯一集成者控制 |
| S5 变更预算 | 强 | 审查、检测 | Mostly-add、最小 reach-in、逻辑归 Skill 文件、PR 可选 Simplification | 没有机器化 Core LOC/API/依赖总预算，复杂度可能只是移出 Trunk |
| S6 代码与抽象 | 中 | 审查、检测 | 薄入口、Registry/Hook、单行 Wiring、Pin 依赖、功能集成点定义 | 不提供可推广到所有项目的模块质量 Oracle |
| S7 风险与验证 | 中 | 检测、部分阻断 | 每个功能集成点测试、Build/Typecheck、Host/Bun CI、行为优先于结构 | Bare Trunk CI 不应用全部 Skill；公开 Conformance Harness 尚是承诺 |
| S8 独立审查与采用 | 中 | 审查、提示 | CODEOWNERS 区分 Core/Skill，公开 Registry 声称逐版本复审 | CODEOWNERS 是否成为 Required Review 未由仓库证明；Registry Gate 未见实现 |
| S9 完成与交接 | 中 | 检测、提示 | Update 输出备份/冲突/验证/残余差异；Migration Guide 保存意图 | 主要是 Prompt 流程，缺少统一结构化交接和事务提交 |
| S10 治理自身 | 中 | 阻断、审查、观察 | Skill guidelines 可演进；Tripwire 阻断未走受控升级的启动 | 规则文档和测试发现范围已出现漂移，治理自身没有完整 CI |
| S11 外部动作与不可逆结果 | 中 | 阻断、审查、提示 | Container、Mount allowlist、Role/Approval、凭据代理；更新前备份 | Host Skill 可执行 Git/安装/删除；没有通用未知结果与外部对账 |

## 3. 高价值经验卡

### N1. 用稳定核心与 Skill 准入边界抵抗功能膨胀

- **关联规则**：S3、S5、S6。
- **目标失败**：每个新需求都直接进入核心，导致所有用户继承无关功能，Fork 与上游在同一文件持续冲突。
- **项目做法 / 规范内容**：Core 只接受 Bug、安全、简化和减少代码；Channel、Provider、兼容增强等能力进入
  Skill 或 Registry branch。Skill 尽量只增加文件、依赖或一行注册，真实逻辑留在 Skill-owned 文件。
- **生效机制**：把高变化、低普适的能力移出共享写热点，降低 Core 的变化频率和不同 Fork 修改同一位置的概率；
  选择安装也使未选择的能力不进入具体安装。
- **载体**：CONTRIBUTING、PR 类型、CODEOWNERS、Channel/Provider Registry、薄的 `src/index.ts` 编排入口。
- **固定证据**：[贡献准入](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/CONTRIBUTING.md)、
  [README Philosophy](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/README.md)、
  [Host 入口](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/src/index.ts)。
- **底层因果解释（推论）**：冲突概率取决于同时修改的共享表面，不只取决于总 LOC；减少 Core reach-in 可以让多数
  上游变化与 Fork 能力变化落在不同文件。然而，复杂度可能只是从 Core 转移到 Skill 和组合关系，并未消失。
- **失效条件 / 反证**：没有明确核心责任时，维护者会把必要能力错误外置；大量 Skill 都插入同一热点时，冲突仍回归；
  固定快照没有 Core 大小或依赖增长的硬预算，README 的“小”主要是主张。
- **不可照搬**：Chat 的 Product Store、Application、Workflow 和安全合同不能为了“核心小”被做成可选 Skill；
  多租户产品也不能把产品行为改成每个用户维护源码 Fork。
- **映射**：Codex 设计前先判断核心责任/可替换能力；Chat Base 保留不可覆盖不变量，Workspace/用户经验包按需叠加；
  Workflow 设计准入节点阻止非核心能力直接进入共享内核。
- **采用结论**：采用“稳定核心 + 条件扩展”的原则，拒绝“所有定制都必须改源码”。**类型：条件规则；置信度：中高**。

### N2. 把 Integration Point 当作升级风险的计量单位

- **关联规则**：S3、S5、S7。
- **目标失败**：只说“这个 Skill 有测试”，却遗漏 Barrel import、Config、Dockerfile、依赖、Mount 等某一个接缝；
  上游改变后单元测试仍绿，实际 Wiring 已断。
- **项目做法 / 规范内容**：枚举每个具有功能后果的 reach-in；每一点都必须有会在删除、错位或漂移时变红的 Guard，
  Build/Typecheck 始终开启；可调用接缝优先行为测试，无法调用才用 AST/结构测试。
- **生效机制**：把“一个 Skill”分解为多个独立失效边，逐边选择 Oracle；集成点数量也成为升级暴露面的可观察近似。
- **载体**：Skill guidelines、随 Skill 携带的测试、真实 Registry import、Host Vitest、Container Bun test、CI。
- **固定证据**：[集成点测试规范](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/skill-guidelines.md)、
  [Codex CLI Pin Guard](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.claude/skills/add-codex/codex-cli-tools.test.ts)、
  [CI](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.github/workflows/ci.yml)。
- **底层因果解释（推论）**：升级破坏通常发生在跨所有权的边，而非 Skill 内部算法；把 Oracle 放在真实入口可减少
  “测试了组件却没测试接线”的共同漏检。接缝更少也使定位和修复集合更小。
- **失效条件 / 反证**：结构测试容易冻结源码形状；行为测试若 Mock 了被保护的 Package 会产生假阳性；集成点计数不含
  每一点的风险权重；Bare Trunk CI 没有先应用所有 Registry Skill，所以不能证明所有 Skill 与当前 Core 兼容。
- **不可照搬**：不能要求每行跨包调用一个测试，也不能用集成点数量替代安全、并发或真实服务风险分析。
- **映射**：Chat Adapter/Provider 逐项记录身份、权限、生命周期、协议和失败接缝；Codex 先列 reach-in 再选测试；
  Workflow 验证节点在最终组合工作区运行测试，而不是只运行经验包自测。
- **采用结论**：采用“功能集成点—Oracle”映射，集成点数量只触发审查。**类型：核心候选机制；规范方法置信度：高，
  全库实际强制性：中低**，因为最终组合与全 Skill CI 尚不存在。

### N3. Apply、Remove 与 Reapply 必须属于同一个变更合同

- **关联规则**：S5、S7、S9、S10。
- **目标失败**：能力能装不能卸、重复应用产生重复 Wiring、升级后靠手工猜测刷新步骤，最后只能保留僵尸代码。
- **项目做法 / 规范内容**：Apply 应可重复执行；留下文件或状态时必须有 REMOVE；Remove 删除而非注释每个 Wiring、文件、
  测试和依赖；`/update-skills` 通过重新运行各 Skill 自己的 Apply 刷新代码。
- **生效机制**：同一变更单元同时携带正向、反向和重放知识，降低知识分散；幂等使升级重放不因次数产生额外状态。
- **载体**：SKILL.md、REMOVE.md、Registry 文件清单、Barrel 检测、串行 Reapply 和完成后的 Build/Test。
- **固定证据**：[Skill anatomy](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/skill-guidelines.md)、
  [Codex Remove](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.claude/skills/add-codex/REMOVE.md)、
  [Update Skills](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.claude/skills/update-skills/SKILL.md)。
- **底层因果解释（推论）**：把撤销路径与创建路径共同维护，比事后恢复逆操作更不容易漏掉资源；幂等重放把“当前是否已经
  做过”从隐含历史变成可容忍状态。
- **失效条件 / 反证**：固定快照中 Apply/Remove 仍是 Agent 执行的 Prose，没有事务安装器或全 Skill round-trip CI；
  `update-skills` 遇到单项错误会记录后继续，最后统一验证，可能留下部分刷新状态；Remove 直接删除已被用户二次修改的文件。
- **不可照搬**：Chat 不应让经验包执行未声明的 `rm`、`git reset --hard` 或覆盖共享事实；外部资源删除还需权限、幂等和对账。
- **映射**：Codex 在独立 Worktree 先 dry-run，并比较资源 Owner；Chat 经验包保存所拥有 Delta 与版本；Workflow 以阶段 Commit、
  补偿或人工恢复替代假事务，并在每项后验证而非全部结束后才验证。
- **采用结论**：采用同单元维护 Apply/Remove/Reapply 的思想；实现必须比 Markdown 命令更强。**类型：条件机制；置信度：中**。

### N4. Recipe 应当描述组合，而不是把最终 Fork Diff 当成事实源

- **关联规则**：S2、S4、S9、S10。
- **目标失败**：一个定制安装只能通过巨大 Diff、聊天记忆或人工清单恢复；多个 Skill 的顺序、依赖和冲突无人拥有。
- **项目做法 / 规范内容**：Skills model 把 Fork 定义为按顺序列出 Skill 与依赖的 Recipe；单 Skill 测试自身，Recipe 负责组合测试；
  `/migrate-nanoclaw` 则从既有 Fork 抽取意图和实现信息，在干净 Worktree 重放。
- **生效机制**：从“最终状态差异”提升为“生成状态的有序操作”，理论上可重建、比较和交接；组合测试针对交互，而非重复单项测试。
- **载体**：Skills model 的 Recipe 约定、Migration Guide、Worktree 重建步骤和人工冲突说明。
- **固定证据**：[Recipe 设计](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/skills-model.md)、
  [Intent-based migration](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.claude/skills/migrate-nanoclaw/SKILL.md)。
- **底层因果解释（推论）**：有序依赖图比无语义 Diff 更接近变化原因，因而更易恢复；但组合数随共享接缝、版本和条件增加，
  可能从线性增长转为组合爆炸。
- **失效条件 / 反证**：固定 Main 快照未见统一 Recipe Schema、解析器、示例 Recipe 或自动 Stack CI；Migration Guide 明确是
  Markdown，重放依赖新 Agent 理解；“第 500 个 Skill 与第 1 个同成本”没有组合规模、冲突率或升级耗时证据。
- **不可照搬**：Chat 的任务、规则选择、版本和证据不能只存在 Markdown Recipe；也不能把运行结果重新解释成安装成功。
- **映射**：Codex 使用小 Map 路由到已选经验；Chat 把 Base、Workspace Overlay、任务规则、用户经验和例外冻结为结构化规则快照；
  Workflow 解依赖、验证冲突，并保存实际组合及每项结果。
- **采用结论**：Recipe 作为组合概念可用，NanoClaw 当前实现只作观察。**类型：条件规则；置信度：中低**。

### N5. 受控升级应把预览、恢复点、迁移、验证和启动资格串成闭环

- **关联规则**：S2、S7、S9、S10、S11。
- **目标失败**：Agent 直接拉取新代码，遗漏依赖、Migration、Container rebuild 或 Skill refresh，随后以半升级状态继续运行。
- **项目做法 / 规范内容**：`/update-nanoclaw` 先自刷新、要求 Clean Tree、建立 Branch/Tag、预览和冲突分类，再执行选择的
  Merge/Cherry-pick/Rebase，运行 Build/Test、检查 Breaking change、重应用 Skill，成功后才写 Upgrade Marker；Host 启动时校验 Marker。
- **生效机制**：危险动作前暴露影响并保存代码恢复点；Marker 把“经过批准路径”变成运行前可检查前置条件，缺失或损坏时 Fail closed。
- **载体**：Update Skill、CHANGELOG `[BREAKING]`、`upgrade-state.json`、`enforceUpgradeTripwire()` 及其测试。
- **固定证据**：[Update workflow](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.claude/skills/update-nanoclaw/SKILL.md)、
  [Tripwire code](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/src/upgrade-state.ts)、
  [Tripwire tests](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/src/upgrade-state.test.ts)、
  [Recovery doc](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/upgrade-recovery.md)。
- **底层因果解释（推论）**：把升级资格放在启动边界，比事后发现遗漏更短反馈；恢复点降低试错不可逆性，差异预览减少无关扫描。
- **失效条件 / 反证**：当前 Branch/Tag 只保护 Git Code，不是文档承诺的全项目快照；数据迁移需各自备份；Marker 可被手工
  `set`，只能证明有人声明到达版本，不能证明所有验证真实通过；恢复命令可能覆盖未保存工作。
- **不可照搬**：Chat 禁止把 `git reset --hard` 作为默认恢复；Product Store、外部 Provider 和未知副作用需要独立快照、对账和人工决定。
- **映射**：Codex 在 Worktree 预览并保留可定位基线；Chat Upgrade Profile 固定来源、版本和迁移计划；Workflow 分设备份、迁移、
  验证、裁决和激活节点，只有最终裁决能写运行资格。
- **采用结论**：采用受控路径与 Fail-closed Tripwire，扩大恢复范围后再用于高风险迁移。**类型：核心候选机制；置信度：中高**。

### N6. Registry 是供应链边界，代码版本必须重新复审而非永久信任

- **关联规则**：S3、S8、S10、S11。
- **目标失败**：用户点选一个经验或 Skill 后，后续版本获得永久信任；Apply 可复制代码、改 Dockerfile、安装依赖，却只按名称授权。
- **项目做法 / 规范内容**：大 Channel/Provider 代码留在长期 Registry branch，Skill 只逐文件 Fetch，不 Merge 分支；设计要求公开
  Registry 每个版本重新审查，并计划用 Fresh upstream → Apply → Test → Remove → Apply twice Harness 清理机械问题。
- **生效机制**：逐文件复制缩小来源和变更面；版本复审把信任绑定具体工件而非名字；Round-trip Harness 可检查残留与重放。
- **载体**：Registry branches、SKILL.md 固定文件清单、CODEOWNERS、PR 模板、依赖 Pin、pnpm 三天冷却和 Build-script allowlist。
- **固定证据**：[Registry model](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/skills-model.md)、
  [CODEOWNERS](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.github/CODEOWNERS)、
  [PR Template](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.github/PULL_REQUEST_TEMPLATE.md)、
  [pnpm policy](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/pnpm-workspace.yaml)。
- **底层因果解释（推论）**：Skill 的真实权限等于其 Apply 能做的动作；版本绑定和重新审查减少供应链在一次批准后静默扩权的空间。
- **失效条件 / 反证**：固定快照未见公共 Registry、Conformance Linter 或全流程 Harness 的实现；CODEOWNERS 本身不证明分支规则
  强制 Review；PR 模板“Fresh clone”仍是自报；宿主 `.claude/settings.json` 明确关闭 Sandbox，Apply 的破坏半径较大。
- **不可照搬**：Chat 不应从移动 Branch 直接取代码，也不把用户点选经验等同执行权限；规则内容与可执行工件应分级。
- **映射**：Codex 在固定 Commit/校验和与受限权限下读取经验；Chat Catalog 保存来源、版本、权限、复审状态和退出方式；Workflow 在
  安装/升级前做供应链审查，外部写入另走批准与对账。
- **采用结论**：采用版本化复审和权限分级；当前 NanoClaw Public Registry 只作设计来源和缺口反证。
  **类型：条件候选原则；置信度：中**。

### N7. 混合流程应把确定性步骤与 Agent 判断分开

- **关联规则**：S1、S2、S7、S9。
- **目标失败**：整个安装、迁移或升级都交给 Agent 临场推理，重复任务耗费上下文且难以复现；反过来，脚本遇到语义冲突又盲目继续。
- **项目做法 / 规范内容**：Setup/迁移的环境探测、复制、DB 处理和 Build 使用脚本；失败诊断、冲突解释、用户选择和非标准定制转交
  Coding Agent；Migration 使用独立 Worktree 验证后再影响 Live install。
- **生效机制**：确定性步骤减少相同输入的行为方差；语义判断只在脚本不能可靠决定的位置发生；Worktree 限制候选失败影响线上安装。
- **载体**：`nanoclaw.sh`、Setup 模块、Update/Migrate Skills、AskUserQuestion、Git Worktree 和 Tests。
- **固定证据**：[README Setup 说明](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/README.md)、
  [Migration Skill](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.claude/skills/migrate-nanoclaw/SKILL.md)、
  [CI](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.github/workflows/ci.yml)。
- **底层因果解释（推论）**：把可判定行为交给程序能缩短反馈并形成复现证据；把不确定判断显式升级给 Agent/人类，避免脚本把未知
  当成功。两者边界清楚时，Agent Token 用于高信息增益决策。
- **失效条件 / 反证**：Skill 自身仍包含大量 Shell Prose，执行路径依赖模型；Migration Guide 是 Markdown；Agent 可能遗漏步骤或
  在冲突中做错保留决定；没有统一状态机证明每一步恰好执行一次。
- **不可照搬**：不能以“Agent 会修”为由弱化失败语义；Chat Workflow 已有耐久状态，不应再用 Git/Markdown 构造第二控制面。
- **映射**：Codex 使用脚本获取 Diff/状态并只审读冲突；Chat Direct 通过 Map 选择最小规则；Workflow 把确定性 Gate、LLM Reviewer、
  人工 Decision 和 Product Commit 分成不同节点。
- **采用结论**：采用“确定性执行 + 语义升级”分工。**类型：核心候选机制；置信度：中高**。

### N8. 运行时能力隔离与治理 Skill 权限必须分别建模

- **关联规则**：S1、S8、S11。
- **目标失败**：项目有 Container 便宣称所有 Agent 都安全，忽略负责安装、升级和改源码的宿主 Coding Agent 拥有更高权限。
- **项目做法 / 规范内容**：运行时 Agent 使用非 Root Container、显式 Mount、外部 Allowlist、Role/Approval、OneCLI 凭据代理；
  Mount 校验缺失时 Fail closed，并解析真实路径防 Symlink 绕过。
- **生效机制**：OS/Container 和 Host 校验从 Agent 外缩小可见文件、凭据和命令集合；授权被持久 Role 与 Approval 截止，而非只写在 Prompt。
- **载体**：Container Runner、Mount Security、Command Gate、Permission/Approval 模块、OneCLI Gateway 与对应测试。
- **固定证据**：[Security model](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/SECURITY.md)、
  [Mount guard](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/src/modules/mount-security/index.ts)、
  [Command gate tests](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/src/command-gate.test.ts)、
  [Host Agent settings](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/.claude/settings.json)。
- **底层因果解释（推论）**：外部能力边界不依赖模型记忆，因此对 Prompt injection 和误操作更稳；但安全性取决于所有高权限路径都被纳管。
- **失效条件 / 反证**：Egress Lockdown、CPU 和 Memory 限制默认关闭；未知 Slash Command 默认通过；Host Skill Agent sandbox 关闭；
  OneCLI 是另一个外部可信组件；Container 不能阻止 Host Apply 修改仓库或执行安装脚本。
- **不可照搬**：Chat 不能把 Container 视为产品授权，也不能把 Prompt Fragment 获得的经验自动升级为 Tool 权限。
- **映射**：Codex 的 Workspace Permission 与 Skill 来源分开批准；Chat Catalog 记录“内容可读”和“代码可执行”两种信任；Workflow 在
  执行前绑定 Principal/Scope，在执行后记录回执、未知结果和对账。
- **采用结论**：采用分层能力边界和 Fail-closed Allowlist；默认关闭的强门只作反证。**类型：核心原则；置信度：高/中**。

## 4. 反面经验与未证明主张

### 4.1 固定快照中的反证

1. **新旧安装模型同时存在**：`docs/skills-model.md` 和 `docs/skill-guidelines.md` 明确禁止 Skill Merge，
   [Branch/Fork maintenance](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/docs/BRANCH-FORK-MAINTENANCE.md)
   仍指导用户 Merge Channel Fork 和 Skill branch。若没有权威路由和漂移门，Agent 可能选择错误流程。
2. **Skill 测试并未在 Bare Trunk 全覆盖**：根
   [Vitest config](https://github.com/nanocoai/nanoclaw/blob/0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9/vitest.config.ts)
   只收集 `src/setup/scripts/container`；`vitest.skills.config.ts` 只匹配 `.claude/skills/**/tests/*.test.ts`，
   而固定快照可见的多个 Skill 测试直接位于 Skill 根目录。CI 也没有 Apply 全 Skill 后再测的 Lane。
3. **Public Registry Gate 是未来设计**：文档使用“will clear”等未来表述，固定树未见 Registry、Conformance Linter 或
   Apply→Test→Remove→Apply twice Harness 实现。
4. **Rollback 范围不足**：Update Skill 当前只创建 Git Branch/Tag；文档承认完整 Code/DB/Data/File Snapshot 尚未落地。
5. **Reapply 不是事务**：单 Skill 失败后流程可继续，最终测试前可能形成部分更新；没有每项 Commit 或自动补偿。
6. **小核心缺少机器预算**：入口确实较薄，但仓库已有完整 DB、CLI、Setup、Runtime、Modules 和大量 Skills；没有证据证明
   总复杂度或升级成本持续下降。
7. **安全默认值并不全是 Fail closed**：额外挂载无 Allowlist 会阻断，但 Egress Lockdown 和资源上限默认关闭，
   宿主 Coding Agent sandbox 也关闭。

### 4.2 未证明的主张

- “第 500 个 Skill 与第 1 个 Skill 同成本”。缺少大规模 Recipe、组合测试、升级时长和冲突率数据。
- “测试失败列表就是全部需修 Skill”。Bare Trunk 未运行所有 Skill，隐性语义耦合也可能没有 Oracle。
- “Apply 安全重跑、Remove 完整恢复”。只有规范和个别实例，没有全库 Round-trip 验证。
- “维护者在发布前运行真实 Fork fleet 并负责修复所有破坏”。固定公开 CI 未提供对应 Lane。
- “走过受控升级路径就代表安装正确”。Tripwire Marker 可手工写入，只证明声明，不证明全部步骤和外部状态。
- “把功能移到 Skill 就消除了膨胀”。它可能减少共享 Core，却增加 Recipe、版本、组合和供应链复杂度。

## 5. 候选规则与采用边界

以下只形成 NanoClaw 单项目观察或与 Chat 高匹配的条件候选；是否升级到通用规则仍按
[理论基础的证据升级规则](../basis-and-evidence.md)执行。

| 候选 | 初步采用 | 适用条件 | 需要补足的控制 |
|---|---|---|---|
| 非核心能力优先通过最小稳定接缝叠加 | 条件规则 | 能力可替换、可退出，不拥有产品事实 | 复用审核、Owner、公共面与依赖预算 |
| 每个功能集成点都有匹配 Oracle | 核心候选 | 接缝可识别，Oracle 能在删除/漂移时失败 | 最终组合环境运行、真实边界分层 |
| Apply/Remove/Reapply 同单元维护 | 条件机制 | 资源 Owner 明确、逆操作安全 | Dry-run、Owned-resource manifest、阶段 Commit/补偿 |
| 组合由有序 Recipe/规则快照表达 | 条件规则 | 依赖、冲突、版本可结构化 | Schema、Resolver、组合测试、冻结证据 |
| 未走受控升级路径时 Fail closed | 核心候选 | 系统能可靠识别版本和最后成功裁决 | 防伪 Marker、全状态快照、迁移与验证回执 |
| Skill/经验版本更新必须重新复审 | 条件候选 | 内容或可执行工件来自可变外部来源 | 固定工件、权限清单、来源证明、复审记录；当前 Public Registry Gate 未实现 |
| 确定性步骤和 Agent 判断分离 | 核心候选 | 可判定行为拥有可靠脚本或 Schema | 状态机、失败边界、人工升级 |
| 运行时 Agent 与治理 Agent 分别授权 | 核心候选 | 两类 Agent 的工具和破坏半径不同 | 独立 Capability Profile、前置批准和审计 |

### 5.1 明确拒绝

- 拒绝把所有项目定制等同源码 Fork 或 Skill Apply。
- 拒绝从移动 Registry branch 复制代码而不固定版本、来源和文件清单。
- 拒绝仅靠 Agent 遵循 Markdown 就宣称幂等、可撤销、可组合或已验证。
- 拒绝让经验包选择自动获得 Shell、依赖安装、外部写入或删除权限。
- 拒绝用单项 Skill 测试外推最终组合正确，也拒绝用 README 的“小”替代变更预算。
- 拒绝在没有全状态恢复点时把 `git reset --hard` 描述成完整 Rollback。

### 5.2 后续校准问题

真实接入后再观察，而不是在本轮试用：

1. 规则路由是否能正确识别哪些任务需要“Skill/经验组合”而不是直接核心修改？
2. 一个经验包实际增加多少 Integration Point、公共面、依赖和组合测试成本？
3. Apply twice、Remove、Reapply 和跨版本 Upgrade 的残留率、失败率、人工修复时间是多少？
4. 组合规模增加后，冲突来自共享文件、隐性语义、依赖版本还是规则优先级？
5. 哪些提示性要求应升级为 Hook/CI/Workflow 阻断，哪些只需 Reviewer？
6. 用户点选经验包后，Chat 是否保存了来源版本、选择、权限、验证和例外的完整快照？
7. 治理资产自身是否出现重复、过时路由、无效测试或“为了通过检查而做题”？
