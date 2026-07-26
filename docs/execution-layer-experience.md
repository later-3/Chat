# 执行层经验手册：用案例传递判断，不用口号限制实现

> 状态：已启用（首批经验来自 SD4-A Evidence/Artifact 实现审查）
> 更新日期：2026-07-26
> 适用对象：Kimi Code CLI、pi Agent及后续受治理执行层
> 不替代：需求、详细设计、工程规范、源码与测试

## 1. 为什么需要这份手册

执行层只拿到“Hash要完整”“失败要关闭”“代码要产品级”一类口号时，仍然不知道：

1. 哪些字段改变会改变业务后果。
2. 哪种占位实现会制造假成功。
3. 什么必须由权威状态推导，什么可以由调用方提供。
4. 本次任务应怎样证明实现正确，而不只是测试通过。

本手册把已经发生的缺陷转化为**经验卡**。经验卡传递的是判断方法，不规定类名、文件布局或唯一算法。

### 1.1 三种约束等级

| 等级 | 含义 | 执行层自主空间 |
|---|---|---|
| 硬不变量 | 违反后会破坏权限、事实、事务、版本、Hash或完成语义 | 可自由选择实现方式，但结果不可放宽 |
| 情境建议 | 在当前架构和阶段中通常更安全、更易维护 | 有更小、更清晰且可验证的方案时可以替代，并说明原因 |
| 自主空间 | 命名、局部抽象、查询写法、测试组织等实现选择 | 执行层自行决定，审查只看可读性和证据 |

### 1.2 使用方法

1. 任务协调者先根据风险标签选择相关经验卡，不把整份手册无界加入每个Prompt。
2. 执行层先复述本次命中的硬不变量和准备采用的验证方式，再实现。
3. 执行完成后逐卡报告：满足、未满足、未涉及，并给出文件和测试证据。
4. 审核者独立运行质量门并尝试经验卡中的反例，不能只接受执行层自述。
5. 经验卡造成机械实现或没有降低返工时，应修订或停用，而不是继续增加规则。

## 2. 本次 SD4-A 修复的选卡结果

| 卡片 | 本次命中原因 | 约束等级 |
|---|---|---|
| E01 Hash覆盖业务后果 | `claim_hash`漏绑5个可改变完成语义的字段 | 硬不变量 |
| E02 未交付能力必须关闭 | Result Commit占位逻辑可直接制造accepted/waived | 硬不变量 |
| E03 泛型引用必须解析归属 | Provenance和Invalidation接受不存在的UUID | 硬不变量 |
| E04 转换来源必须是权威状态 | Claim信任调用方提供的from/target状态组合 | 硬不变量 |
| E05 并发追加必须有竞争语义 | Revision、Assessment、Invalidation使用`MAX+1` | 硬不变量 + 情境建议 |
| E06 测试要攻击语义 | 旧测试把随机UUID和占位成功当作正确行为 | 硬不变量 |
| E07 交付声明要暴露边界 | 阶段A的记录层容易被描述成完整提交能力 | 硬不变量 |

## 3. 经验卡

### E01：Hash必须绑定所有会改变批准后果的字段

- 风险标签：`hash`、`approval-binding`、`immutable-command`
- 适用条件：Hash被用于审批绑定、幂等、去重、缓存身份或不可变声明。
- 要保护的目标：用户批准的版本与真正执行、提交的业务内容必须是同一份内容。
- 约束等级：硬不变量。

#### 真实反例

SD4-A提交 `6ca8b5f` 中，`claim_hash()`只包含主体、目标转换、Artifact Revision、Repository Snapshot、适用策略和Requirements，却遗漏：

- `validation_contract_id`
- `expected_subject_version`
- `from_state`
- `target_state`
- `expected_artifact_record_version`

这意味着用户批准Claim后，只改`target_state`或期望版本，Hash仍然相同；审批表面没变，实际提交前提已经改变。

#### 正例结果

1. 先列出对象中所有会改变权限、前提、目标、验证要求、输入或副作用的字段。
2. 对集合和对象做稳定排序与规范化。
3. Hash函数显式接收并绑定这些字段；不要依赖“以后调用方会检查”。
4. 非业务字段如数据库ID生成时间、展示摘要，只有确实不影响后果时才可排除，并留下理由。

#### 反例测试

基于同一个合法Claim基线，分别只改变上述每个字段，断言每次Hash都变化；Requirements顺序在业务语义不变时应保持稳定Hash。测试如果只验证“Hash长度为64”不算覆盖本经验。

#### 自检问题

- 用户批准之后，哪个字段还能变但Hash不变？
- 该字段变化是否会改变执行对象、完成状态、版本前提或验证合同？
- 是否有一个字段一变一测的变异测试？

#### 允许的自主空间

可以使用DTO规范化、专用canonicalizer或现有`content_hash`；不强制函数签名和测试参数化方式。

#### 来源与信心

- 来源：`docs/evidence-artifact-detailed-design.md`的Claim Hash约束；SD4-A源码审查。
- 信心：高。
- 停用条件：Claim不再通过Hash绑定批准或幂等时重新评估，而不是直接删除。

### E02：后续阶段才交付的成功路径必须fail closed

- 风险标签：`completion`、`placeholder`、`phase-boundary`
- 适用条件：当前阶段只搭记录或Schema，真正的校验协调器在后续阶段实现。
- 要保护的目标：系统不能把“字段已存在”冒充“完成门已经通过”。
- 约束等级：硬不变量。

#### 真实反例

SD4-A的`create_result_commit()`使用：

```python
pre_commit_validity_check_passed = commit_status in {"accepted", "waived"}
```

它没有检查Requirement是否被支持、Adoption是否仍是最新、来源是否有效、Waiver是否完整，就可把Claim改为`committed`。旧测试还把accepted、rejected、waived三种结果都成功写入当作正确行为。

#### 正例结果

在完整Result Commit Gate尚未交付时，有两种合格做法：

1. **首选情境方案**：只开放当前阶段真正能证明的`rejected`记录路径；accepted/waived返回稳定领域错误。
2. 如果必须提前保留低层写入函数，它必须是非公开或要求不可伪造的已验证门结果，并且只能由后续Coordinator调用；普通Repository调用不能自己把布尔值设为真。

禁止用`TODO`注释、默认`True`或“空集合自然通过”代替缺失的产品保证。

#### 反例测试

- 没有Assessment/Adoption/Waiver时，accepted必须失败，Claim仍是candidate。
- 未实现Coordinator时，waived必须失败，Claim仍是candidate。
- rejected可以记录，但不能修改Work/Action的权威完成状态。
- 失败事务后不得留下ResultCommit半记录。

#### 自检问题

- 这条成功路径当前真的验证了什么？
- 如果进程在这里退出，数据库是否已经陈述用户未批准或系统未验证的事实？
- 阶段说明和方法可见性是否让调用者误以为能力可用？

#### 允许的自主空间

可以选择稳定异常类型、拆分方法或引入门结果值对象；不要求现在实现完整SD4-C。

#### 来源与信心

- 来源：产品规则“模型输出只是候选”“失败不能产生假成功”；SD4-A真实占位代码。
- 信心：高。

### E03：泛型引用写入前必须解析存在性、所有者和Scope

- 风险标签：`generic-reference`、`ownership`、`scope`
- 适用条件：一张表使用`kind + id`指向多种领域对象，数据库无法用单一FK表达完整约束。
- 要保护的目标：不能形成悬空引用、跨用户引用或跨Product Scope污染。
- 约束等级：硬不变量。

#### 真实反例

SD4-A的`create_provenance_edge()`只检查kind/relation方向矩阵，测试用两个随机UUID即可创建合法Edge；`create_source_invalidation()`也可以对不存在的Artifact Revision或Blob创建失效事件。

结果是Trace看似完整，但源对象可能从未存在；在多用户场景中，相同接口还可能把另一个Scope的对象写进当前Scope图。

#### 正例结果

1. 通过一个显式Owner/Scope Resolver解析每个支持的kind。
2. 同一事务内确认对象存在、属于当前Scope，并在必要时确认父对象归属。例如Artifact Revision通过父Artifact确定Scope。
3. 未支持的kind或尚未接入Resolver的未来能力应稳定失败，而不是先写后补。
4. Resolver参与调用方事务，不自行提交。

#### 反例测试

- 随机UUID必须失败。
- 真实但属于另一个Scope的ID必须失败。
- Artifact Revision父Artifact属于当前Scope时成功。
- 删除/不存在、错误kind与正确ID组合必须失败。

#### 自检问题

- 数据库FK能否证明这个多态引用？不能时谁负责？
- Scope来自当前Principal、父对象还是调用参数？
- 错误kind能否碰巧命中另一张表中的相同ID？

#### 允许的自主空间

可以用Resolver类、类型注册表或小型显式分支；当前kind数量少时，清晰分支优于过度抽象的插件系统。

#### 来源与信心

- 来源：SD4设计OwnershipResolver要求；产品多会话/多用户共享Harness但隔离授权的目标。
- 信心：高。

### E04：状态转换必须从权威对象推导，不能相信调用方叙述

- 风险标签：`state-machine`、`authoritative-state`、`claim`
- 适用条件：命令包含`from_state`、`target_state`、`transition`或期望版本。
- 要保护的目标：Claim准确描述权威对象当前状态和允许的下一状态。
- 约束等级：硬不变量。

#### 真实反例

SD4-A的`create_claim()`会检查`expected_subject_version`，但把调用方传入的`from_state`和`target_state`直接保存；只要`target_transition`在全局集合里，调用方就能声明与Action/Work真实状态不一致的转换组合。

例如Action实际为`pending`，调用方却可声称`from_state=in_progress`并创建`action_result_accepted -> completed`的Claim。

#### 正例结果

1. 从当前事务读到的Subject得到真实`from_state`。
2. 用`subject_kind + actual_state + target_transition`解析唯一允许的`target_state`。
3. 调用方若仍提供from/target字段，它们只能作为乐观断言；不一致立即冲突，不能成为事实来源。
4. Subject版本和Artifact版本共同参与Claim Hash与提交前CAS复检。

#### 反例测试

- 传入错误from_state必须失败。
- 该subject_kind不支持的transition必须失败。
- 正确transition但错误target_state必须失败。
- 创建Claim后Subject版本变化，后续提交必须失败。

#### 自检问题

- 状态是从数据库对象读出来的，还是从HTTP/函数参数相信来的？
- 全局允许的transition是否对当前subject kind和当前状态也允许？
- 冲突是ValidationError还是版本Conflict，调用方能否理解和恢复？

#### 允许的自主空间

可以使用映射表、领域对象方法或现有Harness状态机；不强制新建通用状态机框架。

#### 来源与信心

- 来源：Harness权威状态边界；SD4 Claim DTO约束；SD4-A源码审查。
- 信心：高。

### E05：追加序列必须定义竞争、重放和恢复语义

- 风险标签：`concurrency`、`sequence`、`cas`、`idempotency`
- 适用条件：代码用`MAX(sequence)+1`、读取当前Revision再追加或读取row_version后更新。
- 要保护的目标：并发命令不能生成重复序号、覆盖新版本或把正常竞争暴露成不明500。
- 约束等级：序号唯一和不丢更新是硬不变量；锁、CAS或冲突重试属于情境选择。

#### 真实反例

SD4-A的Artifact Revision、Assessment和Source Invalidation先查询当前最大序号，再加1。唯一约束只能让一个事务失败，却没有稳定的冲突翻译、幂等重放或有界重试语义；Artifact Revision追加也没有要求调用方声明它看到的Artifact版本。

#### 正例结果

1. 写命令携带稳定`command_id`和必要的`expected_row_version`。
2. 在支持的数据库上选择行锁或CAS；唯一约束保留为最后防线。
3. 正常竞争翻译为稳定领域冲突，或在确保命令幂等时做有界重试。
4. 重放同一命令返回原结果；不同命令抢同一序号时只有一个成为事实。

#### 反例测试

- 两个事务基于同一版本追加Revision，最多一个成功，另一个得到稳定冲突。
- 同一`command_id`重放不新增Revision/Assessment/Invalidation。
- 唯一约束冲突不能以原始数据库异常泄漏到API。

#### 自检问题

- `MAX+1`查询与INSERT之间谁可能插入？
- SQLite测试通过是否掩盖了生产数据库行为差异？
- 重试会不会重复Outbox、Artifact或外部副作用？

#### 允许的自主空间

由执行层根据当前SQLite/SQLAlchemy约束选择CAS、锁、重试或先fail closed；不得为未来规模预建分布式锁平台。

#### 来源与信心

- 来源：工程并发与恢复规则；SD4设计的CAS/唯一约束要求；源码审查。
- 信心：高。

### E06：测试必须攻击业务语义，不能替错误实现背书

- 风险标签：`test-quality`、`negative-path`、`quality-gate`
- 适用条件：状态机、权限、Hash、泛型引用、完成门、并发或阶段占位能力。
- 要保护的目标：测试证明产品保证，而不是复述当前代码输出。
- 约束等级：硬不变量。

#### 真实反例

SD4-A测试曾明确断言：

1. 随机UUID可创建Provenance Edge。
2. 没有Requirement满足检查也可创建accepted/waived Result Commit。
3. Claim Hash没有逐字段变异测试。

这些测试覆盖了行数，却把产品缺陷固化为预期。

#### 正例结果

每个高影响保证至少包含：

1. 一条合法成功路径。
2. 一条越权/跨Scope/不存在对象路径。
3. 一条陈旧版本或竞争路径。
4. 一条事务失败后无半写路径。
5. 对Hash使用逐字段变异，对状态机使用非法边，对完成声明使用缺失证据攻击。

项目质量门必须使用仓库正式命令；单独跑一组测试不能代替Pyright、Ruff、迁移回放和相关全量回归。

#### 反例测试

审查者应先问“如果我想让系统撒谎，最小输入是什么”，再写测试。例如：传随机UUID、把状态参数写成另一个合法值、让版本落后一拍、只提供一个非mandatory Evidence、重复同一个命令。

#### 自检问题

- 测试名称表达产品保证，还是表达实现细节？
- 把校验删掉后测试是否仍会通过？
- 覆盖率上升是否伴随失败路径和恢复路径增加？

#### 允许的自主空间

不规定每个函数固定测试数量；低风险纯映射不必机械套五类场景。

#### 来源与信心

- 来源：项目验证规则；SD4-A测试审查与74%目标模块覆盖结果。
- 信心：高。

### E07：执行层交付声明必须区分“实现了什么”和“仍不保证什么”

- 风险标签：`handoff`、`phase-scope`、`evidence`
- 适用条件：阶段性交付、多个后续Coordinator/Worker仍未完成、真实模型或浏览器验证尚未运行。
- 要保护的目标：审核者和下一执行层不会把局部记录能力外推成完整用户能力。
- 约束等级：硬不变量。

#### 真实反例

SD4-A目标是记录层和Schema基础，但仓库中已经出现可直接写accepted Result Commit的方法。如果交付只说“Result Commit三种结局已实现、测试通过”，下一阶段会误以为Evidence有效性复检、Work原子提交和用户批准已经闭合。

#### 正例结果

交付必须列4组事实：

1. 已实现：具体对象、状态、合同和验证命令。
2. 明确未实现：后续阶段能力及当前调用时的失败方式。
3. 风险与不确定性：并发、数据库差异、真实Runtime、前端等未验证项。
4. 可复现证据：文件、测试名、命令和结果，不能只写“全部通过”。

本卡也适用于模型执行结果：模型自述“完成”只是候选，必须由确定性验证和Evidence支持。

#### 反例测试

让一个未读设计的审核者只看交付说明，询问“现在能否让用户批准并原子完成Work”。如果说明会让他错误回答“能”，交付边界不合格。

#### 自检问题

- 当前阶段交付的是数据结构、记录能力、协调能力还是用户闭环？
- 哪个成功入口仍然存在但实际上不应开放？
- 是否把Mock、单测或模型输出外推成真实Provider/浏览器保证？

#### 允许的自主空间

交付格式可以是对话、PR描述或状态文档；四组事实必须可定位。

#### 来源与信心

- 来源：Session阶段保证规则、产品Evidence规则、SD4阶段划分。
- 信心：高。

## 4. 本轮 Kimi StepInput 的硬验收条件

Kimi可以自行决定代码组织，但本轮修复至少满足：

1. Claim Hash逐项绑定`validation_contract_id`、`expected_subject_version`、`from_state`、`target_state`和`expected_artifact_record_version`，并有逐字段变异测试。
2. SD4-C完整Coordinator未实现前，Repository不能直接产生未验证的accepted/waived Result Commit；rejected路径保持可记录且不改Harness主体。
3. Provenance与Source Invalidation不能接受不存在或跨Scope引用；Observation/Claim本轮接触到的泛型或可选引用同样遵循存在性与Scope检查。
4. Claim的from/target状态与transition由权威Subject状态机校验，错误组合稳定失败。
5. Revision和序列追加具备清楚的expected-version/冲突语义；若本轮无法安全交付并发重试，选择稳定冲突而不是伪装成功。
6. 修复`PAYLOAD_VALIDATORS`的Pyright类型错误。
7. 测试删除原有错误预期，新增不存在对象、跨Scope、陈旧版本、Hash变异、未实现成功门关闭和事务无半写场景。
8. 不提前实现完整SD4-B/C/D，不修改无关前端或配置，不读取私有`backend/config.json`。

## 5. 经验生命周期与效果度量

经验状态使用`候选 -> 已确认 -> 已修订/已停用`，不按模型贴标签。评价一次经验是否有用，至少观察：

1. 首轮正式质量门通过率。
2. 独立审查发现的高影响缺陷数。
3. 同类缺陷是否重复出现。
4. 从执行到验收的返工轮数。
5. StepInput长度是否明显增加却没有改善结果。

本批经验在本轮Kimi修复和独立审核后复盘。若某卡导致过度设计或超出SD4-A边界，应调整适用条件，不把局部实现偏好升级成全局规范。
