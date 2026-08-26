# Pi 经验抽取：最小内核、稳定接缝与执行纪律

> 研究快照：Later Fork
> [`311d9e6`](https://github.com/later-3/pi/tree/311d9e6da0d468bb9e07e6fdf4f76052f436c971)，
> 官方上游
> [`df018b6`](https://github.com/earendil-works/pi/tree/df018b6020181d4245575fba006361ab69a1408b)。
> 结论类型：固定源码与文档事实 + 明确标记的迁移推论；没有安装试用，也不把项目受欢迎程度当作质量证据。

## 1. 研究合同

### 1.1 为什么选 Pi

Pi 与被治理对象高度同型：它既是 Agent loop、Tool、Session 和多 Provider Runtime，又长期由 Agent
参与开发。它最适合回答三个问题：

1. 怎样让 Agent 内核保持小，而把变化放到稳定接缝之外；
2. 怎样用合同测试约束可替换实现，而不是靠目录命名宣称解耦；
3. 当多个 Coding Agent 共享仓库、测试可能接触凭据、发布具有外部副作用时，工程纪律怎样落到具体控制点。

### 1.2 范围与非目标

本报告只研究：

- 最小核心、Package/Extension/Provider/Session 接缝；
- 多 Agent Git 纪律、依赖与生成物治理；
- 测试隔离、Faux Provider、可复用 Conformance Suite；
- 发布工件验证、幂等发布和延迟公告。

本报告不使用 Pi 背书：

- Chat 的产品权限、Decision、Product Store、耐久 Workflow 或人工审批；
- 一个 Extension/Skill 体系可以无成本承载任意数量能力；
- Pi 的所有风格规则都适用于其他 TypeScript 项目；
- 自动关闭新贡献者 Issue/PR 是通用社区治理答案。

### 1.3 项目约束

Pi 的做法成立于一组具体约束：它是 Node.js/TypeScript Monorepo，发布多个锁步版本的 npm Package，
需要支持多 Provider、可扩展 Coding Agent、Node/Bun 和浏览器相关边界；同时维护者明确把审查注意力视为稀缺资源。
这些约束与内部业务系统、强监管系统或大型多人团队并不相同。

### 1.4 Fork 与上游怎样计证据

固定快照之间，`CONTRIBUTING.md`内容相同；Later Fork 的 `AGENTS.md`主要新增 1 个窄 Overlay：
可复用 Pi 变更写入 Fork 源码与测试，Chat 的产品身份、决定、Workflow 状态和 UI 留在 Pi 之外。
因此 Fork 与上游是 1 个研究单元，不算 2 票。上游证明通用工程机制，Fork 只证明 Chat 的采用边界。

## 2. S1–S11 覆盖

强弱表示这个项目对规则内容和机制的公开证据覆盖，不表示 Chat 已经采用，也不表示因果效果已被实验验证。

| 规则 | 覆盖 | 主要载体与实际强度 | 判断 |
|---|---|---|---|
| S1 授权与任务合同 | 中 | `AGENTS.md`要求回答问题后再改、删除功能和规则冲突先确认、未经请求不 Commit；主要是 Prompt/人工约束 | 能限制常见越权，但没有耐久任务合同 Schema 或统一授权判定器 |
| S2 事实源与规则选择 | 中 | 要求广泛修改前完整读文件、外部 API 查真实类型、生成文件追溯生成器；Prompt + 生成检查 | 强调就近证据，但没有自动解决多个权威事实冲突 |
| S3 设计与复用 | 强 | 最小核心、非核心走 Extension、Extension Hook 也需论证；维护者准入和公共接缝 | 内容明确且会影响采用，但主要裁决仍在人 |
| S4 分解与所有权 | 中 | 多 Session 共享目录的显式文件归属、精确暂存、冲突止损；Prompt + Git 可观察 | 能减小踩踏半径，却不是 Worktree/写租约式机械隔离 |
| S5 变更预算 | 强 | 拒绝核心膨胀、单调用 helper 内联、生成物/Lockfile 差异审查；Review + 部分检查器 | 对新增复杂度施加摩擦，但没有统一 diff/API 数值预算 |
| S6 代码与抽象 | 强 | Biome、tsgo、Pinned Dependency、Import/Browser Smoke 检查及具体 TS 规则；确定性检测 + Review | 机器可判部分很强，设计清晰度仍靠维护者判断 |
| S7 风险与验证 | 强 | 30 个 Session Backend 合同用例、9 个 Telemetry Adapter 合同用例、隔离环境、Faux Provider、CI；确定性检测 | 同一合同跨实现复用，并覆盖并发、失败、幂等与清理 |
| S8 独立审查与采用 | 中 | 新贡献者缓冲区、维护者 `lgtmi/lgtm`、CI、Human final gate；人工裁决 + 检测 | 生成与采用分离，但未证明 Reviewer 必然独立或不会形成偏见 |
| S9 完成与交接 | 中 | Changelog、锁步版本、外部目录 Smoke、CI 后公告；检测 + 发布流程 | 交付工件证据强，通用任务交接 Schema 较弱 |
| S10 治理自身 | 中 | `AGENTS.md`/贡献规则、生成器与 Check 模式、规则冲突需确认；Prompt + 部分检测 | 有防旁路意识，但未见规则命中率、误报率或废弃机制的系统评测 |
| S11 外部动作与不可逆结果 | 强 | 发布前确认、Tag 后禁止重跑、已发布版本跳过、精确可用性核查后才公告；流程阻断 + 对账 | 对 npm 发布场景很强，但不是通用外部副作用协议 |

## 3. 高价值经验卡

### P1. 用“最小内核 + 经论证的扩展接缝”对抗功能堆积

- **目标失败**：每个新需求都进入核心，Agent 为未来可能性添加 Hook、层级和万能扩展点，核心随提交单调膨胀。
- **项目约束**：Pi 既要保持 Coding Agent 的可塑性，又不想替每种 Workflow、权限 UI 或子 Agent 模式作产品决定。
- **规范内容**：非核心能力默认做 Extension；即使只是新增 Extension Hook，也必须证明它不会引入难维护的交互。
- **生效机制**：默认拒绝把新能力并入核心，提高核心变更的论证成本；现成 Extension 接缝给出可行替代路径；维护者拥有最终采用权。
- **载体与强度**：[`CONTRIBUTING.md`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/CONTRIBUTING.md)
  和 [`coding-agent/README.md`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/coding-agent/README.md)；
  属于**审查/采用门**，不是静态架构阻断器。
- **代码/测试证据**：仓库把 AI、Agent、Coding Agent、TUI、Telemetry、Protocol、Server 和 Session Backend
  分成公开 Package；Coding Agent 文档明确列出“不内置 MCP、Sub-agent、Permission Popup、Plan、Todo”等非目标，并给出 Extension/外部 Sandbox 路径。
- **低层因果解释**：核心变化的消费者最多、回归半径最大。把选择性需求移到窄接缝，减少核心状态组合数；同时给出扩展路径，才不会把“拒绝膨胀”退化为功能停滞。
- **失效条件**：Extension 获得全部内部对象、Hook 数量无节制增长、跨 Extension 交互无人测试，或维护者把“极小”当作拒绝必要失败语义的理由。
- **不可照搬**：不能因为 Pi 不内置权限/子 Agent，就让 Chat 放弃自己的产品责任；也不能把所有领域逻辑塞入插件层。
- **映射**：S3、S5、S6；Codex 在设计阶段要求核心归属和真实消费者，Workflow 的设计准入节点检查非目标、事实所有者与退出路径。
- **采用结论**：**核心候选**。采用的是“核心准入问题 + 可行接缝 + 采用裁决”，不是 Pi 的具体 Package 图。
- **置信度**：高（规范、结构和明确非目标相互印证）；对长期降低缺陷率的效果仅为合理推论。

### P2. 让一个合同测试套件审查所有可替换实现

- **目标失败**：接口在类型层看似一致，各 Adapter 对顺序、并发、失败、幂等、资源释放和原子性却各自解释。
- **项目约束**：Session 同时有 Memory、JSONL 与 SQLite 实现；Telemetry 需要多个潜在 Backend，并应与测试框架解耦。
- **规范内容**：稳定接缝不仅定义 Type，还发布 runner-independent Conformance Cases；每个实现用自己的隔离 Fixture 运行同一组可观察行为。
- **生效机制**：把自然语言合同编译成一个共享 Oracle；新增或替换实现若偏离合同，会在同一用例处产生确定性差异。
- **载体与强度**：[`Session Backend conformance`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/agent/src/harness/session/testing/conformance.ts)
  有 30 个 Case；[`Telemetry conformance`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/telemetry/src/testing/conformance.ts)
  有 9 个 Case。属于**确定性检测**；进入 Required CI 后才能阻断采用。
- **代码/测试证据**：Memory、JSONL 和 SQLite 分别注册同一 Session Suite；用例覆盖重复 ID 不改变状态、跨 Lane
  并发线性化、幂等删除、Fork 选择性复制等。Telemetry 的 In-memory Reference Adapter 运行共享 Suite，证明测试合同
  可复用设计；固定快照不据此声称多个生产 Telemetry Adapter 已通过。
- **低层因果解释**：可替换性是实现集合上的关系，单测一个实现无法证明。共享 Suite 把“所有实现必须相同”的比较成本从 `实现数 × 手写测试数`降为“合同用例 + 每实现 Fixture”。
- **失效条件**：Suite 只测 Happy Path、Fixture 绕过生产初始化、调用顺序被误当公共合同，或新 Adapter 没被强制注册。
- **不可照搬**：不是每个 Interface 都值得 Conformance Suite；只有存在真实第二实现或稳定 Provider 边界时收益大于维护成本。
- **映射**：S3、S6、S7、S8；Codex 在新增 Adapter 时要求共享可观察合同，Workflow 验证节点收集每实现结果并由集成门裁决。
- **采用结论**：**核心候选**，尤其适合 Chat 的 Store、Provider、Runtime 与 Browser 接缝。
- **置信度**：高（实现和跨 Backend 调用直接可见）。

### P3. 按副作用风险拆测试 Lane，并从空环境证明测试不偷用本机状态

- **目标失败**：全量测试意外读取开发者 API Key、全局 Git/NPM 配置或本地模型；Mock 通过却无法证明 Tool loop；为避免风险又完全不测跨层行为。
- **项目约束**：Pi 支持真实 Provider/E2E，但普通贡献验证必须免费、可重复，并可在开发者机器与 CI 一致运行。
- **规范内容**：普通测试走 `./test.sh`；它构造临时 HOME、TMP、Cache，从 `env -i`只放行必要变量，并禁用交互式 Git、元数据服务和本地 LLM。Coding Agent 跨层场景使用 Faux Provider；真实 Provider/交互式 Smoke 只在对应风险或发布门运行。
- **生效机制**：能力删除与环境清空消除隐式输入；Faux 保留流式消息、Tool Call、Abort、多轮和状态更新合同；精确命令避免不相关高副作用 Lane 被误触发。
- **载体与强度**：[`test.sh`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/test.sh)、
  [`Agent E2E with faux provider`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/packages/agent/test/e2e.test.ts)、
  [`AGENTS.md`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/AGENTS.md)；
  测试脚本是**执行约束 + 确定性检测**，命令选择仍有 Prompt/人工部分。
- **代码/测试证据**：脚本为临时目录写所有权 Marker，清理前验证路径、非 Symlink 和 Marker；测试输出显式声明无 API Key；Faux 测试覆盖计算 Tool Call、Abort、Reasoning Block 和多轮上下文。
- **低层因果解释**：确定性依赖于输入闭包。先移除宿主环境，再显式加入必要输入，能暴露“只在我的机器通过”的隐藏依赖；Faux 的价值来自保留协议状态机，而不是模拟文字质量。
- **失效条件**：测试代码直接访问未清理的其他系统路径、Faux 与真实 Provider 协议漂移、发布前从未运行真实工件，或 Agent 把未运行 Lane 报告为通过。
- **不可照搬**：Faux 不能背书模型质量、真实鉴权、网络、配额和 Provider 兼容；需要真实边界的声称仍要真实/合同级证据。
- **映射**：S7、S9、S11；Codex 根据风险 Profile 选择 Lane，Workflow 固化“普通确定性门”和“显式付费/外部门”的不同授权。
- **采用结论**：**核心候选**。
- **置信度**：高（隔离脚本和测试用例直接证明机制）；对完全消除环境污染不作绝对声称。

### P4. 共享工作树时，把 Git 防踩踏规则写成可执行的窄动作集合

- **目标失败**：多个 Agent 在同一目录工作，一个 Agent 用 `add .`、`stash`、`reset --hard`、`clean`或冲突处理覆盖另一个 Agent 的未提交修改。
- **项目约束**：Pi 明确认可多个 Session 同时修改同一 CWD；因此不能假设当前未跟踪或未暂存文件都属于自己。
- **规范内容**：只暂存本 Session 的显式路径；Commit 前检查状态；禁止广域暂存、Stash、Hard Reset、Clean、绕过 Hook和 Force Push；冲突出现在非本人文件时终止并询问。
- **生效机制**：把高破坏半径的 Git 操作从默认动作集合删除，并用显式路径建立最小写集合；冲突所有权不明时 Fail Closed。
- **载体与强度**：[`AGENTS.md`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/AGENTS.md)；
  主要是**Prompt/流程约束**，Git Status 提供观测，但未见仓库级工具 Wrapper 全面阻断。
- **代码/测试证据**：Pre-commit 只重暂存原先已暂存文件，避免格式器顺手纳入其他修改；PR 审查要求用 `gh pr diff`/`git show`而非切换当前 Worktree。
- **低层因果解释**：并发安全首先取决于写集合是否相交。显式路径把一个全仓操作缩成已声明集合；遇到未知所有权停止，比事后从 reflog 恢复更便宜。
- **失效条件**：Agent 不遵守文档、两个 Agent 仍编辑同一文件、生成器改写宽范围文件，或外部工具隐式暂存/清理。
- **不可照搬**：共享 CWD 纪律是降险措施，不等于隔离。可独立写入的实现任务仍优先使用 Worktree 或文件租约；同一锁文件/合同必须单写者串行。
- **映射**：S4、S8、S9；Codex 执行时使用明确文件所有权，Workflow/调度层应把写集合冲突变成不可调度条件。
- **采用结论**：**条件规则**：作为共享 CWD 的最低线，不替代更强隔离。
- **置信度**：中高（因果链清晰，有部分 Hook 配合；全面遵守仍依赖 Agent）。

### P5. 把依赖图和生成物当成代码，而不是安装命令的副产品

- **目标失败**：Agent 猜第三方 API、静默引入浮动依赖或生命周期脚本、直接修改生成文件、让 Lockfile 巨幅变化混入功能提交。
- **项目约束**：Pi 发布多个 npm 工件，Coding Agent 的传递依赖会在用户环境执行，生成的模型目录和发布 Lock 必须可复现。
- **规范内容**：直接依赖精确 Pin；安装默认 `--ignore-scripts`；新 Lifecycle Script 必须审核并显式 Allowlist；Lockfile 提交需专用环境开关；生成文件只能改生成器后重建；Check 模式验证 Shrinkwrap/Install Lock/Model 数据是否漂移。
- **生效机制**：确定性生成器将派生文件和源输入绑定；Pre-commit 对高噪声 Lockfile 添加有意摩擦；默认关闭 Lifecycle Script 缩小依赖安装的代码执行面。
- **载体与强度**：[`package.json`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/package.json)、
  [`check-lockfile-commit.mjs`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/scripts/check-lockfile-commit.mjs)、
  [`generate-coding-agent-shrinkwrap.mjs`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/scripts/generate-coding-agent-shrinkwrap.mjs)；
  属于**确定性检测/本地阻断 + 人工审查**。
- **代码/测试证据**：根 `check`同时运行 Pinned Dependency、TS Import、Shrinkwrap、Install Lock、Type 和 Browser Smoke 检查；Pre-commit 默认拒绝实质 Lockfile 变化，并列出版本差异和审核问题。
- **低层因果解释**：Lockfile 与生成物是可执行供应链和发布工件的输入。把其变化显式化，能在采用前暴露未计划代码执行、版本漂移和“手改派生结果”的不可重现状态。
- **失效条件**：开发者设置 Allow 开关却不审查、CI 不运行同一 Check、生成器本身不确定，或精确 Pin 后长期不升级安全补丁。
- **不可照搬**：不能把所有 Lockfile 改动一律禁止；开关代表“进入专门审查路径”，不是规避。不同包管理器需要自己的机制。
- **映射**：S2、S5、S6、S7、S10；Codex 的变更预算必须单列依赖/生成物，Workflow 供应链门读取机器 Check 结果。
- **采用结论**：**核心候选**，具体命令由 Workspace Overlay 决定。
- **置信度**：高（检查器、Hook 和 CI 路径完整可见）。

### P6. 发布分成“构建工件、外部验证、写入、对账、公告”五个不同状态

- **目标失败**：Monorepo 内部路径掩盖缺失发布文件；部分 Package 已发布后重跑整个 Release；npm 刚接受写入就立即对外宣告成功。
- **项目约束**：多个公开 Package 锁步发布，同时提供 Node 安装和 Bun Binary；Tag 会触发 npm、GitHub Release 和 R2 最新版本标记。
- **规范内容**：发布前从仓库外安装本地 Tarball，并对 Node/Bun 做启动、列表、交互和真实 Prompt Smoke；Release Script 创建 Commit/Tag/Push 后不得为同版本重跑；发布 Helper 遇到已存在版本跳过；只有每个公开 Package 的精确版本和 Tarball 均可查询后才更新最新版本标记。
- **生效机制**：仓库外安装切断 Workspace 泄漏；稳定版本号充当幂等键；查询实际 Registry 状态完成对账；延迟公告避免把“请求已发送”误写成“用户可获得”。
- **载体与强度**：[`AGENTS.md` release contract](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/AGENTS.md)、
  [`publish.mjs`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/scripts/publish.mjs)、
  [`build-binaries.yml`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/.github/workflows/build-binaries.yml)；
  属于**执行流程 + 对账阻断**。
- **代码/测试证据**：Publish Helper 先查询 `name@version`，已发布则只校验内容；公告 Job 依赖 Publish Job，并在写 R2 Marker 前验证全部 Package；失败清理 Job 与 Draft Release 分离。
- **低层因果解释**：外部系统调用存在“请求超时但写入已成功”的第三状态。把版本作为稳定身份并查询远端事实，才能在不重复副作用的情况下恢复；公告是另一外部写入，必须以可获得工件为前置条件。
- **失效条件**：Registry 查询不具备一致性保证、同版本内容可以被覆盖、脚本没有保存阶段状态，或人工绕过 CI 直接公告。
- **不可照搬**：Pi 没有给出所有外部动作的通用 `outcome_unknown`协议；Chat 仍需自己的 Operation ID、权限、结果未知和人工处置合同。
- **映射**：S7、S9、S11；Codex 在发布任务中不得把本地构建当发布成功，Workflow 将五阶段建模为可恢复步骤并保留回执。
- **采用结论**：**核心候选**（状态分离与对账）；实现必须按目标外部系统定制。
- **置信度**：高（文档、Script、CI 依赖关系相互印证）。

### P7. 把 Reviewer 注意力当稀缺资源，但让“人类最终裁决”与“苛刻准入政策”解耦

- **目标失败**：Agent 批量制造看似完整、实则不可复现的 Issue/PR，维护者在低信号输入中耗尽审查能力；AI 摘要又被误当最终判断。
- **项目约束**：Pi 的公开贡献量超过维护者能实时负责审查的规模。
- **规范内容**：Issue 必须短、具体、说明价值；新贡献者输入先进入关闭缓冲区，由维护者重开；AI 可归类和发现缺项，但不作最终 Maintainer Decision；贡献者必须能解释 Agent 生成的代码。
- **生效机制**：缓冲队列限制进入昂贵审查阶段的速率；结构化最低信息减少追问；候选生成与最终采用分离。
- **载体与强度**：[`CONTRIBUTING.md`](https://github.com/earendil-works/pi/blob/df018b6020181d4245575fba006361ab69a1408b/CONTRIBUTING.md)
  与仓库自动化；属于**人工审查/采用门**。
- **代码/测试证据**：`lgtmi`只放行未来 Issue，`lgtm`才放行 PR；提交前要求 `check`与隔离测试。公开文档明确说明自动关闭的动机是异步消化审查队列，而不是判断内容必错。
- **低层因果解释**：审查吞吐是有限服务器；不限制低质量到达率会拉长所有任务延迟。机械预筛可以保护注意力，但高语义判断仍需能够承担责任的裁决者。
- **失效条件**：维护者不再复核缓冲区、准入与质量无关、熟人身份替代证据，或人类 Reviewer 只看 AI 摘要不看差异。
- **不可照搬**：自动关闭所有新贡献是强烈的社区取舍，可能压制高质量外部反馈；Chat 内部协作不应复制这项政策。可迁移的是“审查容量预算 + 人类/受保护门最终采用”。
- **映射**：S1、S8、S10；Codex 产出是候选，集成者独立核证；Workflow 可用队列和风险等级分配审查，而不是按身份自动信任质量。
- **采用结论**：**条件采用**“最终裁决分离”；**拒绝**把自动关闭策略升级为通用规范。
- **置信度**：中（机制和动机明确；净社区效果没有公开对照）。

## 4. 负面证据与不能声称的结论

| 未获证明的主张 | 看到的反证或缺口 | 对治理结论的影响 |
|---|---|---|
| 读取 `AGENTS.md` 就能防止 Agent 越权 | 多 Agent Git 规则大多没有工具级强制；Pi README 还明确说明运行时默认继承启动进程权限 | 权限、不可逆动作和共享写入不能只靠 Prompt |
| Extension 天然比核心更易维护 | 文档同时警告 Hook 也会产生复杂交互；第三方 Package 可执行任意代码 | Extension 需要准入、权限、兼容测试和删除路径 |
| Faux Provider 通过等于真实 Provider 正确 | Faux 只保留项目定义的协议行为，不覆盖网络、鉴权、配额和供应商漂移 | 真实边界声称必须单独验证 |
| `npm run check` 等于完成验证 | 项目明确说明 `check`不运行测试；Agent 规则还要求修改测试文件时精确运行 | 完成门必须组合静态检查、风险测试和工件/真实边界门 |
| 人类最终审查必然高质量 | 文档只规定责任归属，没有公开 Reviewer 一致性或缺陷逃逸测量 | S8 仍需风险分级、差异证据和可复核 Oracle |
| Pi 可以替 Chat 决定权限与产品事实 | Pi 明确没有内置 OS 权限系统；Later Fork 又明确将 Chat 产品事实留在 Pi 外 | Pi 只提供 Executor/Agent 能力证据，不拥有 Chat 产品内核 |
| 严格贡献门已被证明提升代码质量 | 只有维护者动机与流程，没有对照或长期量化结果 | 只能作条件观察，不能升级为核心规则 |

## 5. 从 Pi 提出的规则候选

| 候选 | 建议级别 | 目标载体 | 采用前仍需什么 |
|---|---|---|---|
| 核心新增必须证明核心所有权；可选能力优先稳定接缝 | 核心候选 | 设计准入清单 + 架构/公共面 Review | 与 NanoClaw、AI SDK 的独立证据交叉核对 |
| 真实第二实现必须运行共享 Conformance Suite | 核心候选 | `packages/testing`合同套件 + CI | 为 Chat 各接缝定义可观察合同，避免冻结实现细节 |
| 普通测试从清洁环境运行；付费/外部 Lane 显式授权 | 核心候选 | 测试 Launcher + 风险 Profile | 核对 Chat 当前工具链和必要环境变量 |
| 多 Agent 只操作声明写集合；不明归属冲突 Fail Closed | 条件规则 | Worktree/文件所有权 + Git Wrapper/审查 | Codex 的 Worktree/Handoff 证据与 Chat 调度能力 |
| Lockfile、生成物和 Lifecycle Script 进入独立审查路径 | 核心候选 | 生成器 Check、供应链 CI、变更预算 | 适配 pnpm 与 Chat 的依赖合同 |
| 发布完成必须晚于远端工件对账，未知结果不得重放 | 核心候选 | Durable Workflow + Operation ID + Reconcile | 不能直接复用 npm 版本键，需按 Provider 建模 |
| AI 可以生成审查候选，不拥有高风险最终采用权 | 核心候选 | 独立 Reviewer + 受保护提交/人工决定 | 与 Codex Review 和其他项目的采用门交叉核对 |

## 6. 对 Chat、Codex 与 Workflow 的映射

| 经验 | Codex/交互式 Agent | Chat 项目规范 | Chat Workflow 节点 |
|---|---|---|---|
| 最小核心 | 设计前写核心归属、消费者和非目标 | 将事实所有权/依赖方向作为更具体 Overlay | Design Gate 拒绝无消费者抽象和重复能力 |
| Conformance Suite | 新 Adapter 先找共享合同，不各写一套 Happy Path | 每个可替换 Port 由拥有者维护稳定可观察语义 | Verification 对候选实现运行同一 Suite |
| 隔离测试 Lane | 按风险选择精确命令，如实报告未运行项 | 固定 Clean Env、Faux、真实服务和浏览器 Lane | 授权决定哪些高副作用 Lane 可运行 |
| Git 防踩踏 | 独立 Worktree；共享目录时只写/暂存声明路径 | 单一共享事实单写者、唯一集成者 | 调度前检测写集合冲突，Handoff 保存基线 |
| 依赖/生成物 | 单列计划和实际差异，不静默开脚本 | 供应链检查和 Generator 是唯一派生路径 | Dependency Gate 读取 Check 与许可证结论 |
| 发布对账 | 区分 Build、请求、远端可用和公告 | 产品外部副作用合同拥有 Operation 状态 | Durable Step 保存幂等键、回执和未知结果 |
| 最终采用 | 自审不能替代高风险独立复核 | S8 定义风险和裁决责任 | Reviewer 只产出分级结论，Commit 节点拥有采用 |

## 7. 仍然缺失的证据

1. 没有公开对照实验能证明这些规则使缺陷率、返工率或代码增长下降多少。
2. 没有可见的规则路由 Eval，无法知道 Agent 是否在正确时点读取了哪条 `AGENTS.md`规则。
3. 共享 CWD 规则缺少能力级隔离或完整 Git Wrapper，不能独立承担 S4。
4. Conformance Suite 很强，但仍需检查每个实现是否在 Required CI 中注册；“存在测试”不自动等于“采用受阻”。
5. Pi 发布流程只给出 npm/GitHub/R2 的一个具体范例，不能替代 Chat 的通用外部 Operation 状态机。
6. Later Fork Overlay 较窄且是 Chat 自身决策，不能被反向当作外部独立证据投票。

## 8. 总结

Pi 最值得抽取的不是某种代码排版，而是 4 个相互配合的结构：**核心准入、稳定接缝、可复用合同
Oracle、候选与采用分离**。它的测试隔离、依赖生成检查和发布对账已经把若干原则下沉为确定性机制；
多 Agent Git、设计克制和贡献质量仍主要依赖 Prompt 与维护者裁决。对 Chat 最合理的迁移方式，是把前一类接入
检查器/Workflow 门，把后一类编译成设计与审查输入，并继续用权限、Worktree 和独立采用补足其强制性。
