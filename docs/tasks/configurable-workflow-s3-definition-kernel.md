# S3任务书：Definition Kernel与耐久Runner实验室

> 状态：已批准，待实现验收  
> 阶段目标：在不接入用户真实Run的实验室边界内，证明有限节点目录、结构化IR、编译器和Vercel耐久Runner可成立  
> 前置完成门：S2真实Run Viewer通过  
> 设计依据：[详细架构第4到8节](../architecture/configurable-workflow-design.md)

## 0. 阶段约束

1. S3只运行版本化Fixture RunSpec，不创建正式Workflow Definition、不修改Composer默认路径、不切换生产Runner。
2. 内核只执行Chat实现并注册的Node Type；不支持任意代码、任意HTTP、任意表达式、任意JSONPath和插件市场。
3. 语义结构是Sequence、Task、Choice、BoundedLoop、Composite的受限递归树，不是自由有向图。
4. 前端类型、React Flow节点/边、持久化坐标不得进入IR、Compiler或Runner。
5. 新抽象必须在S3实验中被执行，并在已设计的S4/S5中有明确消费者；没有消费者的扩展点删除。

## S3.1 Node Catalog、Blueprint与Executor注册一致性

### 目标与结果

建立一份后端权威的有限节点能力目录，并证明每个可编译Node Type都具备配置解析、输入输出、风险和真实Executor映射。

### 方案

1. packages/domain定义NodeTypeKey、NodeConfig版本、slot、outcome、skip/risk/executor kind等纯值类型和不变量。
2. packages/application组合NodeCatalog与WorkflowBlueprintRegistry；Catalog descriptor包含服务端config parser、公开字段描述、slot/outcome、策略和支持的Blueprint。
3. packages/workflows维护静态ExecutorRegistry，键为nodeType + schemaVersion；Executor只能调用私有Application API或已批准Runtime Port，不打开Product Store。
4. packages/testing增加Catalog Conformance：Catalog、Blueprint和Executor三方集合对齐，防止“前端可选但无法执行”或“有Executor却绕过Catalog”。
5. 首批节点只覆盖Planning与Note明确需要的类型；未实现节点不以disabled或experimental假装存在。

### 首批目录

| 类别 | Node Type | Executor kind | 关键输出 |
| --- | --- | --- | --- |
| context | context.memory、context.project | step | context_package/project_context ref |
| policy | policy.rules、capability.skills | step | rule/skill resolution ref |
| agent | agent.research、agent.plan | step | evidence/plan_revision ref |
| human | human.plan_review、human.note_review | human_review | decision outcome |
| execution | execute.plan | composite | execution_candidate ref |
| validation | result.validate | step | validation_result ref |
| commit | product.commit、note.commit | step | artifact/note_revision ref |
| note | note.extract、note.classify | step | note_candidate ref |

实际实现前逐项核对现有Application用例；若某类型没有独立业务边界，应合并而不是创建“看起来更细”的伪节点。

### 约束与失败

- config parser使用strict运行时Schema；公开field descriptor只是受控表单投影，不是校验权威。
- secret、provider、endpoint、模型凭据不能作为Node config field。
- Blueprint声明required role、允许Node Type、结构槽位、分支和循环预算；Catalog不能自行决定整个流程结构。
- 重复键、Schema版本无Executor、公开默认值不能被parser接受、outcome未覆盖时启动失败。

### 测试设计

1. 每个Descriptor的默认配置通过parser；每个公开字段的name/type/default/range与parser一致。
2. 删除任意Executor或添加孤立Executor，Conformance test必失败。
3. Blueprint引用未注册类型、错误版本、重复required role、未声明outcome均失败。
4. 配置拒绝未知字段、secret形态字段、超长字符串和非法资源ID。
5. 架构测试：domain不依赖Zod以外的网络/运行时对象；application不依赖Vercel Workflow；Executor不依赖web。

### 完成门

- 目录能完整描述S4 Planning和S5 Note所需能力，且无通用Code/HTTP节点。
- 每个注册节点都有负责产品事实的Application用例或明确的S4/S5任务；无万能Executor。
- 公开字段投影与真实Parser的漂移由自动测试阻止。

## S3.2 Sequence、Task、Choice、BoundedLoop、Composite结构化IR

### 目标与结果

定义能表达当前Planning、Note、审核修订和有界循环，同时从结构上排除任意回边、Join和脚本条件的递归语义IR。

### 方案

1. 手写TypeScript判别联合WorkflowElement，不依赖无界z.infer推断递归类型。
2. 网络/持久边界用z.lazy strict Schema，parse后立即运行显式iterative walker计算深度、节点数、分支数和循环预算。
3. Root固定为Sequence；元素仅允许：
   - Task：definitionNodeId、nodeType、schemaVersion、config；
   - Choice：读取一个前序节点的枚举outcome，分支键必须全由Catalog声明；
   - BoundedLoop：body、continue/exit outcomes、maxIterations、exceededPolicy；
   - Composite：声明运行时有界展开的容器角色，不允许内嵌任意动态结构。
4. 每个definitionNodeId在整个Revision内唯一；display label不参与身份。
5. Choice/Loop引用必须指向结构上先执行且支配当前位置的节点，不能读取未来、兄弟分支或任意深层输出。

### 明确不支持

- 任意edge列表、任意DAG、多输入Join、跨分支变量合并。
- JavaScript/Python、表达式、模板求值、truthy条件和用户上传模块。
- 无上限while、递归子工作流、运行时修改当前RunSpec。
- partial execution、pin data和从任意节点继续一次新Run。

### 验证算法

1. 用显式栈遍历，携带scope、dominators、loopDepth和nodeBudget；避免恶意深递归造成调用栈溢出。
2. Sequence保持语义顺序；Choice分支各自新scope，离开分支后只暴露Choice outcome，不隐式合并内部slot。
3. BoundedLoop body内部可读取loop-local prior outputs，迭代之间只传Catalog声明的loop state ref；首期可不开放用户可配state。
4. Composite不携带子IR；Executor运行时返回受限Action manifest，Node Run子节点由产品事实展开。

### 测试设计

1. Planning、Note、review loop、choice、nested sequence和composite合法Fixtures。
2. 重复ID、未来引用、兄弟分支引用、漏分支、额外outcome、零/负/过大iteration、非法回边表示全部失败。
3. depth/node/branch/loop各自测试limit-1、limit、limit+1。
4. 生成式测试随机产生合法IR，parse→normalize→parse保持语义；随机破坏一个不变量必被定位到稳定path。
5. 构造极深JSON，验证先受DTO字节限制，再由iterative walker拒绝且不栈溢出。
6. TypeScript编译性能基线，防止递归类型导致编辑器/tsc显著退化。

### 完成门

- IR能逐字表达两个Blueprint，不需要escape hatch。
- 所有不支持结构在Schema或结构验证阶段失败，不能留给Runner“尽量执行”。
- 错误包含stable code、element path和安全参数，S6可直接投影诊断。

## S3.3 规范化、Hash与RunSpec编译器

### 目标与结果

把合法Definition语义和一次运行的资源选择编译为确定、不可变、可验证的RunSpec；相同输入产生相同Hash，任何影响执行的输入变化都能被检测。

### 方案

1. Compiler输入为：Blueprint ref、Definition Revision、Run Configuration、授权Principal、可用资源快照、Catalog/Executor版本清单和Runner版本证据。
2. 明确分阶段：parse → structural validate → catalog validate → policy validate → resource resolve → normalize → hash → build RunSpec。
3. Definition规范化保留Sequence顺序；对无序集合按稳定key排序；展开声明默认值；删除view state、时间和空的等价表示。
4. Definition Hash只覆盖Definition语义；RunSpec Hash另外覆盖实际资源revision/hash、resolved policy、limits、executor schema manifest、runner family/bundle version。
5. RunSpec通过strict schema再次自验证；Compiler返回success或有限diagnostic列表，不抛出含正文的任意Error作为业务结果。
6. Hash采用仓库既有稳定序列化与sha256工具；若现有工具不能处理递归联合，先扩展并复用，不引入第二Hash库。

### 资源解析规则

- explicit selection优先；引用不存在、归档、无权限或revision/hash不符时required失败关闭。
- optional资源缺失产生显式exclusion记录和outcome，不静默忽略。
- Memory、Project、Rule、Skill只存精确产品引用；endpoint、Provider配置和Credential不进RunSpec。
- Run Configuration只能覆盖Blueprint声明的definitionNodeId + field；未知覆盖、重复覆盖和高风险skip均失败。

### 测试设计

1. Determinism：相同语义不同JSON字段顺序、默认值省略/显式、无序集合重排得到相同Definition Hash。
2. Sensitivity：Sequence顺序、Node config、资源revision、policy、executor version、runner version任一变化改变相应Hash。
3. Separation：仅资源选择变化不改Definition Hash但改RunSpec Hash；仅view label允许的变化按明确规则测试。
4. 资源：缺失、归档、无权、旧revision、Hash错误、optional exclusion、重复选择。
5. 并发：编译读取后资源revision变化，最终创建事务通过expected refs拒绝陈旧RunSpec。
6. Snapshot test只锁规范结构和diagnostic code，不锁随机ID/时间。
7. 安全扫描确保RunSpec无secret、endpoint、Hook Token、Provider payload和用户未选择的全文资源。

### 完成门

- Compiler是纯协调逻辑，可用内存Fixture完整测试，不依赖浏览器或活动Workflow。
- RunSpec足够Runner执行，不需回读可变Definition；业务资源需要正文时按固定ref通过私有Query读取并校验hash。
- S3.5只接受经过Compiler和Schema验证的RunSpec Fixture。

## S3.4 风险策略、skip、资源绑定与结构/数据限制

### 目标与结果

把“哪些节点能跳、哪些审核能自动通过、哪些资源必须存在、Definition能有多复杂”变成可测试的后端策略，而不是前端开关约定。

### 方案

1. SkipPolicy有限联合：never、allowed_with_default_outcome、allowed_with_explicit_value；首期不允许用户提交任意跳过输出。
2. RiskPolicy有限等级：read_context、generate_candidate、human_decision、external_effect、product_commit；Blueprint规定不可降低的最低策略。
3. ReviewMode为manual、auto_continue_if_policy_allows、always_auto的受限联合；Planning高影响执行前的Decision规则不可由普通用户配置绕过。
4. Limits分四类：请求字节、结构预算、运行预算、预览/Manifest预算。数值在本任务用代表Definition基准测量后确定，配置在单一服务端模块并写理由。
5. 运行预算包含最大总节点执行、每Loop最大迭代、最大嵌套、Composite最大子项和总等待次数；编译时能证明的先拒绝，运行时仍二次计数。
6. 错误码分为definition_invalid、policy_denied、resource_stale、limit_exceeded，避免一律500。

### 安全规则

- human_decision、external_effect、product_commit默认skipPolicy never。
- auto_continue必须生成system_policy证据与解析后的policy revision/hash；不能伪造用户Decision。
- 用户可选Skill只从已批准Capability目录选择；Skill正文/工具权限不由Definition直接覆盖。
- 前端传来的limit、risk或executor key全部忽略并因unknown field拒绝。

### 测试设计

1. Catalog每个Node Type的风险/skip矩阵golden，并测试Blueprint不能降低。
2. 手工审核、允许自动继续、禁止自动继续、高风险伪skip、optional context skip。
3. 四类预算的limit-1、limit、limit+1；错误path与code稳定。
4. 编译通过后RunSpec被篡改预算、policy或resource ref时，Runner加载Hash失败。
5. 基准记录小Planning、最大受支持Planning、Note和恶意Definition的验证耗时/内存。
6. 权限属性测试：降低Principal能力集合不会产生更多可编译Node或资源。

### 完成门

- 所有数字有代表Fixture和测量记录，不用“业界通常”作为唯一依据。
- S6设计器即使被绕过，服务端也会拒绝非法skip/auto/limit。
- S3.5运行时有独立预算计数，不能只信编译期。

## S3.5 固定Vercel Workflow Runner解释RunSpec

### 目标与结果

在真实本地Vercel Workflow环境中执行Fixture RunSpec，证明代码定义的固定Runner可以耐久解释受限结构，而不为每个用户Definition生成代码。

### 方案

1. 新增版本化runner family，不原地修改活动planning-execution-workflow；入口只接受Product Run/RunSpec产品身份和Runtime Credential引用。
2. Runner启动先经私有API加载RunSpec并校验schema/hash/runner bundle/executor manifest；不从浏览器或Outbox正文接收整张任意图。
3. executeSequence按语义顺序推进；Task调用静态Executor；Choice只读取已提交outcome；BoundedLoop每迭代更新显式executionPath和预算；Composite读取已提交Action manifest展开子Node Run。
4. 每个耐久step的输入输出保持小型产品ref或控制outcome；大正文通过私有API按ref读取，不进入Checkpoint。
5. Human Review由专用Runner分支：先确认业务Review事实，再创建typed Hook；恢复后重新读取Decision事实，不信任Hook payload正文。
6. 所有Executor以NodeExecutionContext接收runSpec ref、definitionNodeId、executionPath、attempt、command identity；不能拿到整个Store或任意网络Client。

### 耐久确定性

- 当前节点选择只由不可变RunSpec和已提交Node outcome决定，不读取当前时间、随机数或最新Definition。
- step/command identity由RunSpec ID、definitionNodeId、executionPath、attempt和operation组成并稳定派生。
- Runner重放允许再次调用幂等私有Command，但不能依赖进程内Map或可变单例决定是否已执行。
- bundle/version不兼容按现有local-version-recovery收敛，不能冒险用新Executor继续旧语义。

### 实验Fixtures

1. Sequence：三个静态step成功。
2. Choice：success与needs_review两个枚举分支。
3. BoundedLoop：第二轮退出、达到上限fail、达到上限request_human。
4. Human Review：等待、批准、修订后循环、重复resume。
5. Composite：三个有界子Action，其中一个失败/未知。
6. Mixed：Planning形状但全部用静态业务Fixture，不调用付费模型。

### 测试设计

1. 真实Workflow运行时执行六组Fixture，断言Checkpoint、Product Node Run、业务Fixture事实和最终settlement。
2. 在每个step前、外部调用后/提交前、提交后/响应前、hook创建后、resume后注入进程退出并恢复。
3. 同一Checkpoint重放2次/5次，不增加业务事实；显式retry增加attempt但不覆盖历史。
4. RunSpec hash、executor version、未知node type、预算被篡改时启动前失败关闭。
5. 大ref测试证明Checkpoint只增长固定元数据，不包含大正文或Provider payload。
6. Runtime Credential过期、私有API 401/409/500、暂时网络失败分类正确。

### 完成门

- 六组Fixture在真实本地Workflow环境全部通过，不能只用直接函数调用测试。
- Runner源码没有按用户Definition动态eval/import/codegen，也没有通用HTTP/脚本Executor。
- 活动旧Runner路径、Outbox kind和Bundle未切换。

## S3.6 恢复、版本、并发、性能与生成式阶段门

### 目标与结果

用独立于实现细节的验证套件攻击Kernel，证明它在重放、版本漂移、并发、极端结构和资源变化下失败可预期，并给出是否允许接入真实Planning的结论。

### 测试设计与验证矩阵

| 风险 | 必须证明 |
| --- | --- |
| Workflow重放 | 相同operation identity不重复Node Run、Transition或业务事实 |
| Hook重复/乱序 | 只接受已提交Decision；重复resume无副作用；错误Review拒绝 |
| Definition漂移 | RunSpec继续按旧Revision；当前Definition修改不影响活动Run |
| Executor漂移 | manifest不兼容失败关闭，兼容版本按明确表执行 |
| 资源漂移 | 编译与创建事务间变化被拒绝；运行中按冻结ref/hash读 |
| 并发 | 两个Run互不串状态；同一Run冲突命令由revision/receipt收敛 |
| 结构攻击 | 深度、宽度、分支、循环和Composite预算均有限 |
| 数据攻击 | 超大正文不进Checkpoint/Manifest；错误与日志脱敏 |
| 性能 | 最大受支持IR验证、编译和调度有测量基线 |

### 方案

1. packages/testing建立黑盒Kernel harness，只通过Compiler、私有Runtime合同和真实Workflow入口操作。
2. 生成式测试随机合法IR与随机单点破坏；seed写入失败报告，可本地重放。
3. 版本矩阵至少含当前Runner/当前Executor、旧兼容Runner/当前Definition拒绝、当前Runner/未知未来Executor拒绝。
4. 并发测试使用可控barrier制造同一Decision、同一Node complete和资源revision变化竞态。
5. 性能报告记录机器、数据规模、warm/cold、p50/p95/峰值内存；不把本机毫秒数直接承诺为生产SLO。
6. 对S3.1到S3.5做删除测试：移除Catalog项、策略校验、Hash字段或运行预算时，对应测试必须失败，防止“有测试但没测到保证”。

### 阶段完成门

- 所有矩阵格有自动化测试ID和实际通过证据；不能用“由单元测试间接覆盖”填空。
- 生成式测试在固定seed集合和至少一轮随机seed通过，失败可重复。
- 真实Workflow恢复测试没有依赖进程内状态；Checkpoint内容通过敏感/大正文扫描。
- S4接入风险清单只允许已知非阻断项；Node身份、Hash、HITL、重放、预算任一未证明均为阻断。
- 输出Kernel as-built文档和最小新Node Type接入清单，明确需要Catalog、Parser、策略、Executor、版本证据和测试，不宣传“零代码节点”。

## 7. S3阶段反向验证

| 原始问题 | S3回答 |
| --- | --- |
| 底座是否只能代码定义工作流 | Runner仍由代码定义，但执行的是运行前编译的不可变RunSpec；新增节点仍需代码，组合与配置无需改Runner |
| 前端拖拽能否构建 | 语义IR和Blueprint提供可编辑边界；前端只能构造受限结构，不能直接构造可执行任意图 |
| 能否有分支和循环 | Choice只匹配枚举outcome；BoundedLoop必须有上限和超限策略 |
| 节点能否“死人/不死人” | skipPolicy与riskPolicy决定，不是通用disabled布尔值 |
| 如何避免自己造一坨屎 | 有限联合、静态Executor、编译失败关闭、真实恢复实验和第二场景消费计划 |

S3通过只代表技术内核可行；只有S4和S5真实纵向通过，才证明该内核有产品价值。
