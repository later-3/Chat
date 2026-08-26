# Chat 项目管理三真实项目验证

> 文档类型：已执行验证事实与首轮适用边界
>
> 验证日期：2026-08-25
>
> 样本：Mini-Claw、Ziji Content Lab、Pipecat
>
> 外部副作用：无；三个样本仓库和Pipecat上游均只读，未创建Issue、评论、PR、发布或外部事项对象

## 1. 结论

本轮不再用“AI学习”“摄影学习”或虚构Backlog证明方案。验证对象固定为三个真实项目：

1. **Mini-Claw**：已有大量代码、文档、研究与历史决定，当前工作树不干净，适合验证旧项目接手、候选与已确认事实分离、暂停、证据等级、功能开发和跨Agent恢复。
2. **Content Lab**：以内容发布为结果，拥有来源、Brief、Draft、媒体、审核、发布包、归档、案例和工作流，适合验证非软件对象、Revision、发布事实、历史和方法演进。
3. **Pipecat**：真实活跃开源软件项目，拥有Issue、PR、Checks、Changelog、单元/集成测试和行为评测，适合验证外部协作、Bug修复、Review、合并阻塞与Release规则。

验证结果分为两层：

- **来源层通过**：只读脚本在三个真实仓库执行17项检查，全部通过，场景不是模型编造。
- **内核层通过当前纵向**：已有Project Intake可以进入Profile/Configuration采用；通用软件Work已经贯通Create、Claim、Block、Resume、Handoff、Evidence、Review、用户Decision与Done；Content Lab专用状态机继续贯通发布和Practice采用。

本轮证明了**软件交付和内容生产**可以共享同一个项目身份、配置、权限、协作、事件、证据和上下文内核，同时保留不同完成门。它**没有**证明学习、个人日报、财务、客户关系等Profile已经经过真实项目验证；这些类别仍只是可扩展边界或设计样本，不能写成已验证能力。

## 2. 不从零发明的方法来源

Chat吸收已经被广泛使用的方法，但只保留满足用户场景的产品语义：

| 已有方法 | 采用的稳定做法 | Chat对象或规则 |
|---|---|---|
| [Scrum Guide](https://scrumguides.org/scrum-guide.html) | Product Goal、Backlog、Increment、Definition of Done | Objective、Requirement/Work、Artifact、Acceptance/Evidence Gate |
| [Kanban Guide](https://kanbanguides.org/the-kanban-guide/) | 明确工作流、开始/完成点、显式政策、WIP、Work Item Age与Cycle Time | Work状态、Claim、Block、Policy、Event/时间、Metric |
| [GitHub Issues与Projects](https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/planning-and-tracking-work-for-your-team-or-project) | Issue承载Bug/Feature/Release工作，Project汇总当前协作状态 | 外部Issue Resource/Projection、Chat Work、Provider Binding |
| [GitHub Pull Requests](https://docs.github.com/en/pull-requests/get-started/about-pull-requests) | 变更提议、讨论、Review、Checks和合并 | Artifact、Evidence、Review、Decision、Event |
| [PDCA](https://asq.org/quality-resources/pdca-cycle) | Plan、Do、Check、Act循环改进 | Need/Requirement、Work、Review/Metric、Case/Practice Revision |
| Content Lab现有规则 | Source→理解→选题→Draft→媒体/QC→Review→Publish→Archive→Case | Content Work、Artifact Revision、Publication Outcome、Case、Practice |

这些方法不是新的权威事实源。Chat仍以用户需要、真实项目资源和采用Decision决定当前Project Configuration。

## 3. 真实来源快照

以下是2026-08-25只读核验时的快照。SHA用于说明本轮看了哪一版，不把本机路径写入产品文档。

| 项目 | Git快照 | 工作树 | 规模证据 | 决定管理规则的事实 |
|---|---|---:|---:|---|
| Mini-Claw | `37007949d06dcec2477867d596e094e23a7576e1` | 23个未提交条目 | 356个tracked文件、30个测试文件 | D10/G-P0明确暂停；37个商业产品、36个开源仓库、86条对象台账；最高仅E1代理证据，没有E2老师、E3儿童、E4效果 |
| Content Lab | `e7ddb70fee24c67e3075eb66b6cdd01770fe459e` | clean | 917个tracked文件 | 每次任务以可发布内容为目标；Brief/Draft/Review/Publish/Archive齐全；案例必须反哺Workflow/Template/Rule |
| Pipecat | `cc740d701bcf7e625ce17cc28581f2055cecf86d` | clean | 1415个tracked文件、195个测试文件 | 官方origin；pytest/Pyright/Ruff；PR需要changelog fragment；还有真实Bot行为eval和发布前suite |

Mini-Claw没有仓库内`AGENTS.md`，但继承父Workspace治理规则，并在项目内维护`PROJECT_CONTEXT.md`和`PROJECT_STATE.md`。因此接手规则必须支持“继承治理规则 + 项目内路标”，不能要求每个仓库复制一份同名文件。

Pipecat还核验了两个当前真实协作样本：

- [Issue #5110](https://github.com/pipecat-ai/pipecat/issues/5110)仍为Open，已有生产通话日志、机制说明、建议修复和关联的[PR #5118](https://github.com/pipecat-ai/pipecat/pull/5118)；PR检查成功但仍未合并。
- [Issue #5151](https://github.com/pipecat-ai/pipecat/issues/5151)仍为Open，关联[PR #5185](https://github.com/pipecat-ai/pipecat/pull/5185)；PR仍Open且合并状态为`DIRTY`。

这两条事实特别适合反证“有PR或Checks通过就等于Done”。

## 4. 对象、管理规则与可见性

| 对象 | 权威内容 | 主要管理规则 | 用户应该看见 | Agent必须恢复 |
|---|---|---|---|---|
| Project | 长期身份、目标、状态 | 不等于仓库、Session或Provider Project | 项目目标、健康、当前重点 | 稳定Project ID和当前Revision |
| Profile Revision | 类别级对象、时间、权限、证据、Context和View政策 | 版本化；项目名不能进入Profile分支 | 当前采用类型和版本 | Profile ID、Hash和政策 |
| Configuration Revision | 具体项目目标、范围、术语、参与者、资源、节奏、Presentation Binding和必读路标 | Candidate经用户Decision后采用；旧版本不重写 | 本项目实际怎么管理 | Configuration ID、Hash、必读资源、时区和节奏 |
| Need | 用户、资源或外部事实产生的需要 | 捕获不等于承诺 | 原始需要和来源 | 与Requirement/Work的关系 |
| Requirement | 可验收结果、行为、质量或约束 | 先Proposal，接受仍需Decision | 验收标准 | 与当前Work相关的精确Requirement |
| Work | 当前要推进的结果 | Profile决定状态机和完成门 | 状态、优先级、依赖、负责人、证据 | 稳定Work Key、Revision和完成门 |
| Action | Work内下一步 | 可指派、阻塞、完成；不替代Work验收 | 可执行下一步和期限 | 当前与后续Action |
| Claim | Agent对Work的有租约执行权 | 单一活动Claim；过期可接管；Session不是锁 | 当前谁在做、租约到期 | 是否由自己持有及允许动作 |
| Block | 可恢复的阻塞事实 | 原状态、停在哪里、原因、恢复条件、恢复Evidence | 为什么停、怎样恢复 | 精确恢复条件和相关Evidence |
| Handoff | 跨Agent交接 | 必须记录已完成、剩余、风险、下一步、必读、Evidence | 谁交给谁、接下来做什么 | 最新结构化交接，不读取旧Session猜测 |
| Artifact Ref | 代码、文档、Draft、媒体、PR、Case等外部产物的稳定引用 | 正文仍由Resource拥有；Chat保存Revision/Hash/Provenance | 可打开、比较Revision | 与当前Work有关的最小资源集合 |
| Evidence | 观察或验证结果 | Agent自报不能自动满足验收；必须绑定精确Work Revision | 证据类型、来源、验证级别 | 完成门所需和已有证据 |
| Review | 待用户或维护者检查的Candidate | Agent只能请求；接受、退回或拒绝按Authority | 变更、风险、Checks和缺口 | Reviewer需要的Requirement、Artifact和Evidence |
| Decision | 用户或受权维护者的选择 | Hash绑定所见语义和Revision | 问题、选项、选择、理由 | 不得重复询问已决定事实 |
| Event | 发生、观察、记录时间 | 同一历史派生Timeline/Report；不手工双写 | 昨天/上周发生了什么 | 增量恢复、最近变化和遗漏说明 |

## 5. Mini-Claw场景验证

| 场景 | 生效对象和规则 | 用户结果 | Agent动作 | 验证结论 |
|---|---|---|---|---|
| M1 接手已有且脏的仓库 | Intake、Resource Observation、Configuration、Artifact Ref | 先看到23个未提交条目和现状，不把仓库初始化或覆盖 | 只读观察；采用前不修改；采用后使用独立worktree | **通过设计与来源门**；未对真实仓库写入 |
| M2 D10明确暂停 | Decision、Work/Stage状态、Attention、Event | 能看见为什么暂停、何时暂停、恢复条件 | Agent不得根据旧计划自动重启D10 | **通过来源门**；验证了“计划不等于授权” |
| M3 研究候选选择 | Need、Requirement、Artifact、Evidence、Decision | 区分37/36/86台账、候选和最终选择 | Agent可比较和提案，不把研究数量冒充采用 | **通过来源门** |
| M4 真实用户证据不足 | Evidence verification、Acceptance Gate | 明确当前只有E1，E2/E3/E4缺失 | Agent不能宣称儿童或教学效果已验证 | **通过来源门和证据政策** |
| M5 功能/Bug开发 | Generic Work、Claim、Commit/Test Evidence、Review、Decision | 看见当前开发、阻塞、变更与质量门 | Codex/Pi Claim、Handoff、请求Review；用户决定Done | **通过通用软件Work纵向测试** |

Mini-Claw揭示的关键规则不是“教育项目Profile”，而是：已有软件产品接手时，研究、产品证据和代码证据必须分层；工作树保护和暂停Decision必须进入开工Context。

## 6. Content Lab场景验证

| 场景 | 生效对象和规则 | 用户结果 | Agent动作 | 验证结论 |
|---|---|---|---|---|
| C1 新来源进入 | Source/Need、Content Work、采用Decision | 看见来源、主题、目标平台和当前阶段 | 先读案例与Workflow，再形成可审核Brief | **通过来源门与既有内容纵向** |
| C2 多Revision生产与审核 | Artifact Revision、QC Evidence、Review | 比较Draft、媒体、QC与修订历史 | 提交精确Revision，不用“已完成”口头报告 | **通过内容Work测试** |
| C3 发布 | Publication Outcome、verified回执、Decision | 看见平台、时间、最终版本和回执 | 没有回执不能标Published | **通过内容Work测试** |
| C4 昨天/前天历史 | Event、Artifact、Publication、Timeline/Report | 按实际发生时间查看生产与发布历史 | Agent按Delta恢复，不扫描所有历史 | **通过事件/查询合同；实际UI仍待接入** |
| C5 案例反哺流程 | Case、Practice Work/Revision、采用Decision | 看见哪次问题改变了哪版工作流 | Agent提交案例和方法修订，用户决定Adopt | **通过Practice纵向测试** |

Content Lab继续使用`content_delivery`和`workflow_improvement`两类专用Work。它不需要伪装成Bug/Feature，也不使用Commit数量作为发布成功指标。

## 7. Pipecat场景验证

| 场景 | 生效对象和规则 | 用户/维护者结果 | Agent动作 | 验证结论 |
|---|---|---|---|---|
| P1 Issue #5110生产竞态 | External Issue、Generic Work、生产日志Evidence、PR #5118、Checks | 同时看到问题、复现、修复Candidate、Checks和仍Open状态 | Claim后复现/测试/PR；未合并前不能Done | **通过真实Issue事实 + 软件Work纵向** |
| P2 Issue #5151与冲突PR #5185 | Issue、PR Artifact、Block/Attention、Review | 看见PR存在但`DIRTY`，下一步是解决冲突/更新 | Handoff保留剩余、风险和必读；不能重复开PR | **通过真实Issue/PR事实 + Handoff纵向** |
| P3 新Agent接手 | Configuration requiredReads、Claim、Handoff | 不依赖旧聊天了解贡献规则和当前Work | 读取AGENTS、CONTRIBUTING、相关Issue/PR和测试入口 | **通过来源门与Opening/Handoff Context测试** |
| P4 质量与发布 | Commit、Test、Behavioral Eval、Changelog Artifact、Review/Decision | 单元测试、代码质量、行为效果和发布说明分别可见 | 按变更风险选择测试；用户可见变更补Changelog | **通过来源门；未运行Pipecat自身测试** |
| P5 外部协作边界 | Provider Resource/Projection、Inbound Change | GitHub仍拥有Issue/PR/Checks，Chat呈现受限快照 | 默认只读；外部写需单独Binding、幂等和授权 | **边界通过；本轮无GitHub写入** |

Pipecat证明同一个Generic Work可以关联Issue、PR、Checks和Changelog，但这些外部对象仍由GitHub/Git拥有；Chat不能复制或篡改其权威状态。

## 8. 已执行的内核纵向

### 8.1 真实仓库接手到管理配置

```text
受管Git/文档/脚本只读观察
→ Intake Candidate
→ 用户修订/确认
→ Project + Method Snapshot + Stage + Participant + Resource + Observation + Evidence
→ software-delivery Profile/Configuration Candidate
→ 用户采用Configuration
→ 新Agent Opening恢复Profile Hash、Configuration Hash、requiredReads和Maintenance
```

确定性测试：`packages/testing/src/project-intake-use-cases.test.ts`。

### 8.2 通用软件Work跨Agent协作

```text
Generic Work(approved)
→ Codex Claim(in_progress)
→ Block(原因、停点、恢复条件)
→ Handoff(Codex → Pi)
→ Pi Claim
→ Recovery Evidence
→ Resume
→ Commit + Test Evidence
→ Agent Request Review
→ 缺Test时Done失败关闭
→ 用户Decision
→ Done
```

Project Home能统计Work、2个Claim、Block、Handoff和Review；Timeline包含Created、Claimed、Blocked、Handed-off、Resumed、Review-requested和Transition-decided事件；Handoff/Review Context分别选择所需对象。

确定性测试：`packages/application/src/project-coordination-use-cases.test.ts`。

### 8.3 Content Lab专用纵向

```text
Content Work intake
→ 用户selected
→ Agent Claim/producing
→ Content Revision + QC Evidence
→ Request Review
→ 用户ready
→ Publication Outcome + verified receipt
→ 用户published

Case Evidence
→ Workflow Improvement Work
→ Practice Revision Candidate
→ 用户adopted
```

同一测试文件继续验证租约冲突、过期接管、跨Work Evidence拒绝、Block恢复、Handoff、Provider投影Dry Run和未知外部对象保留。

## 9. 用户视图与Agent Context验证

### 用户至少需要的表面

| Capability | 三个项目中的内容 | 当前结论 |
|---|---|---|
| Project Home | 目标、Profile/Configuration、Attention、最近事件、对象计数 | Query合同和测试已存在；具体DSH页面未在本轮实现 |
| Work | Work/Action/Claim/Block/Handoff/Review | 对象投影已补齐；外部表面只是可选Presentation Provider |
| Document | Mini-Claw状态/研究、Content Brief/Draft/Case、Pipecat贡献规则/Changelog | 由Resource/Viewer打开；不写死Obsidian |
| Code | Mini-Claw/Pipecat源码、Diff、Commit、测试 | Git拥有版本事实；代码工作台负责查看和修改 |
| Media | Content Lab图片、音频、视频、发布包 | Content Profile要求；软件Profile不强制 |
| Timeline | 所有协作Event、发布时间、Revision变化 | 协作事件已落Product Store；UI待接入 |
| Review | Requirement、Artifact、Evidence、风险和Decision | 软件与内容完成门均已测试 |
| Report | 周期窗口、趋势、例外和解释边界 | 合同存在；三项目真实报表尚未运行 |

### Agent的六种Context

| Context | 必须回答 |
|---|---|
| Opening | 我在哪个Project、采用什么配置、当前重点和Attention是什么 |
| Work Execution | 这个Work的Requirement、Artifact、Evidence、Decision和资源是什么 |
| Delta | 上次以后哪些Event和Revision发生变化 |
| Review | Candidate改了什么、满足哪些条件、缺什么证据 |
| Handoff | 谁做了什么、剩什么、风险、下一步和必读是什么 |
| Maintenance | 哪些观察、对账、Attention、Review或Report到期 |

Generic Work现在已进入Opening的当前Work选择和允许动作；Claim、Block、Handoff、Review也已进入Project Home计数和相应Context，不再只支持Content Lab。

## 10. 明确未验证和后续门

1. **没有迁移三个真实项目**：本轮只读核验真实资源，并在Chat测试Store执行管理纵向；没有把Mini-Claw或Pipecat正式写入Chat Product Store，也没有修改Content Lab项目数据。
2. **没有真实外部事项写入**：当前验证只读，按fail-closed规则没有绕过Chat直接修改外部系统。
3. **没有真实UI验收**：Project Home、Timeline、Review和Resource跳转目前验证的是Query/Context合同，不代表DSH用户表面已经完成。
4. **没有运行Pipecat测试套件**：本轮只读检查它的质量合同和当前Issue/PR；没有改Pipecat源码，因此不运行其付费或长时行为评测。
5. **学习和个人日报尚未获真实样本背书**：它们不能列为本轮已验证Profile。
6. **Maintenance目前只产生计划**：Agent started等触发已经可评估，但定时调度、真实Report生成和外部提醒仍不是本轮完成项。
7. **Provider入站写冲突未用GitHub真实事件演练**：已有Provider合同测试，但Pipecat场景保持只读。

## 11. 可重复验证

真实仓库来源门：

```bash
node scripts/project-management/validate-three-project-sources.mjs \
  --mini-claw "$MINI_CLAW_ROOT" \
  --content-lab "$CONTENT_LAB_ROOT" \
  --pipecat "$PIPECAT_ROOT"
```

脚本只调用Git只读命令并读取公开项目文件，输出`chat-project-source-validation.v1` JSON，不修改任何样本仓库。

相关确定性测试：

```bash
pnpm --filter @chat/application test -- project-coordination-use-cases.test.ts
cd packages/testing
pnpm exec vitest run src/project-intake-use-cases.test.ts --pool=threads --maxWorkers=1
```

注意：`@chat/testing test -- <file>`的现有package脚本会先运行整个testing套件，不能把它误报为单文件命令。本轮第一次误用该命令时触发Vitest fork worker约4GB堆上限；精确单文件测试随后通过。为让仓库规定的根级命令稳定可重复，testing的unit project固定为单thread worker，真实Local World仍保持serial隔离；调整后根级`pnpm test`完整通过。
