# Chat 可配置工作流阶段总纲与验证闭包

> 文档类型：阶段总纲，不是实现任务书  
> 状态：阶段总纲、全任务地图、详细方案与测试设计已获用户批准；实现进行中  
> 日期：2026-08-09  
> 架构依据：[可配置工作流技术研究](../architecture/configurable-workflow-research.md)  
> 当前项目顺序：本稿规划P6能力，不改变PROJECT_PLAN中Project Solution与Rules的当前实现顺序

本文的“交付阶段S1～S7”只表示P6能力的建设与验收顺序，不是Chat产品中的Project Stage对象，也不改变任何真实Project的Stage Goal。

## 0. 为什么先写阶段总纲

用户已经确认以下方向：

1. 保留Vercel Workflow作为耐久执行底座。
2. 建设注册节点和受约束Definition，不做任意自动化平台。
3. 使用结构化IR表达顺序、有限分支、有上限循环和人工审核。
4. 前端默认从左到右显示运行图，图只是Chat产品事实的投影。
5. 先建立Node Run投影和真实Viewer，再迁移配置化Runner。
6. 人工批准与策略自动继续必须是两种不同事实。
7. 使用第二条真实工作流证明复用，Reminder延后到外部副作用底座完成。

这些决定只确认了方向，不能直接推出第一个PR。总纲阶段先证明：

- 每个阶段到底交付什么用户结果。
- 每个阶段必须守住哪些产品和技术约束。
- 阶段之间是否有缺口、重复或错误顺序。
- 所有阶段完成门同时成立时，整体目标是否一定成立。
- 整体方案和测试方案是否能产生上述证据。

因此，本稿只负责“阶段闭包”。阶段总纲现已获确认，后续全任务设计仍不安装依赖、不修改生产Workflow；只有用户最终批准全部任务设计后才创建第一个实现worktree。

## 1. 整体目标

用户能够在Chat中选择或配置一条由系统支持的工作流，在发送消息前决定本次使用哪些上下文、规则、Skill和审核方式；运行后能从左到右看见真实节点状态，点击节点查看安全的输入、输出、证据和时间线，在需要时修订、批准或拒绝；用户以后还能保存和调整受约束的Definition，并用同一套底座运行不同业务工作流。

整体完成不是“画布可以拖拽”，而是以下闭环同时成立：

~~~text
选择/配置
→ 服务端校验
→ 生成本次RunSpec
→ Vercel Workflow耐久执行
→ Chat提交Node Run与产品事实
→ Web显示真实运行图和节点详情
→ 人工决定或策略自动继续
→ 刷新/重启后恢复
→ 历史Run保持原语义
→ 第二条业务工作流复用同一底座
~~~

## 2. 整体完成标准

整体验收使用O1～O14作为固定追踪身份。

| ID | 整体必须证明的结果 |
| --- | --- |
| O1 | 当前和历史Product Run都能投影为稳定、可解释的工作流图 |
| O2 | 用户能查看每个可见节点的状态、输入、输出、证据、错误和安全时间线 |
| O3 | 用户发送前能选择已支持的Workflow/Preset及允许覆盖的配置 |
| O4 | 服务端能校验Definition、风险策略、资源引用和本次RunSpec，前端不能绕过 |
| O5 | manual、policy auto-continue、revise、approve、reject和bounded loop语义真实且可恢复 |
| O6 | 用户能保存、复制、修改和发布受约束Definition，非法定义无法进入运行 |
| O7 | Planning与至少一条不同业务生命周期的工作流复用Catalog、Runner、Node Run API和Viewer |
| O8 | Definition修改不改变已经发起或历史Run的语义和查看结果 |
| O9 | 页面刷新、API/Workflow Worker重启、重复命令和Hook竞态不造成重复执行或假终态 |
| O10 | 浏览器不获得Workflow Run ID、Hook Token、pi Session、隐藏推理或未过滤正文 |
| O11 | 大输入输出、循环深度、节点数、布局规模和保留期有明确上限与降级表现 |
| O12 | 桌面和375/390px手机均可观察、审核和配置；键盘与非画布列表入口可用 |
| O13 | 当前B2规划—审核—执行、Memory、Project和Rules产品事实与恢复边界不回归 |
| O14 | 全部能力从干净基线、真实Workflow、真实模型/服务及真实浏览器完成组合验收 |

任何阶段或任务都必须映射到至少一个O项；没有映射的工作默认是范围外技术扩张。

## 3. 全局约束

### 3.1 产品与事实所有权

1. Product Store继续拥有Definition、RunSpec引用、Product Run、Node Run、Decision和正式结果。
2. Vercel Workflow只拥有耐久执行、Hook、Checkpoint和Runtime状态。
3. pi只拥有Agent loop和模型/Tool运行，不拥有产品完成事实。
4. 浏览器只显示Query投影和提交Command，不解释权威执行语义。
5. Trace记录系统路径和对象引用，不复制产品正文，也不直接作为Web API。
6. Model输出、Node输出和Tool结果在确定性校验与产品提交前都只是候选。

### 3.2 工作流定义边界

1. 前端只能组合后端Node Catalog已经注册的节点类型。
2. 首期只支持sequence、有限choice、bounded loop、human review和composite。
3. 不支持任意JavaScript/Python、任意表达式、任意回边、多输入Join和局部重跑。
4. Semantic Definition是权威；React Flow节点、边和坐标只是View投影。
5. 跳过语义按节点类型声明，Human Review不能使用通用pass-through。
6. policy auto-continue必须记录系统策略身份，不能伪装成人工批准。
7. 高影响动作的人工审核要求由服务端风险策略强制。

### 3.3 运行与兼容

1. definitionNodeId、nodeRunId和Runtime私有Step/Run ID严格分开。
2. 同一Definition节点在循环、修订和重试中产生独立nodeRun与iterationPath。
3. Runner/Bundle版本、Node Executor schema、Definition revision/hash和RunSpec hash分开记账。
4. Definition修改只影响后续Run；旧Run按原RunSpec和结果快照查看。
5. 外部副作用继续遵守幂等、outcome_unknown、查询对账和人工处置。
6. 当前固定Planning Workflow在迁移前后都必须保持既有Plan、Approval、Decision和Product Commit语义。

### 3.4 前端与可访问性

1. 运行图默认从左到右。
2. React Flow只在真正需要Viewer的阶段引入；首期不引入ELK。
3. 运行更新不能抢走用户当前选择、视口或输入焦点。
4. 状态使用文字、图标/形状和颜色三通道表达。
5. 画布不是唯一入口；移动端和辅助技术必须有顺序列表与详情入口。
6. 页面本身在375px无横向滚动；横向平移只发生在画布容器内。

### 3.5 交付与验证

1. 阶段总纲通过前不拆实现任务。
2. 阶段总纲通过后，一次性拆出全部阶段的小任务依赖图，不只拆最近一个任务。
3. 任务地图通过后，所有任务先完成方案与测试设计，再开始第一个实现。
4. 每个任务只有一个主要结果，默认0.5～2个单人开发日，独立worktree、分支和PR。
5. 确定性测试、真实Workflow、真实服务/模型和真实浏览器按风险分层，付费测试物理隔离。
6. 每个阶段结束时执行阶段门；全部实现结束时重新执行整体门，Task全完成不等于目标完成。

## 4. 初始阶段候选

依据技术研究，初始候选是：

1. Definition Lab与合同。
2. 当前固定Workflow的Node Run投影。
3. 左到右运行Viewer。
4. 发起前配置。
5. 配置化Planning Runner。
6. 受约束Definition编辑器。
7. 第二条Note Capture工作流。

这只是研究稿中形成的候选，不直接采用。下一节先做反向审查。

## 5. 阶段自审与优化

### 5.1 发现的问题

| 问题 | 为什么不合适 | 优化 |
| --- | --- | --- |
| 研究稿直接出现PR 1A、1B、2A | 尚未证明阶段集合能闭合整体目标 | 撤回全部PR级拆分，先固定阶段总纲 |
| Definition Lab排在真实可观察性之前 | 容易先为未来抽象建平台，用户仍看不到当前运行 | 先把当前固定Workflow变成Chat可查询、可观看的真实图 |
| 发起前配置与Runner分成两个孤立阶段 | UI配置若不能真实影响运行，会形成假能力 | 合并为一条配置化Planning纵向阶段 |
| 配置化Runner阶段过大 | 同时含Catalog、Compiler、迁移、UI和真实执行 | 把生产中立的Definition Kernel证明单列，再做Planning纵向迁移 |
| 编辑器早于第二条业务工作流 | 编辑器会被Planning一个样本绑死，形成伪通用设计 | 先用预置Definition跑通Note Capture，再设计编辑器 |
| 没有整体收口阶段 | 各局部门通过仍可能留下旧Run、性能、安全和组合缺口 | 增加独立组合验收与迁移收口阶段 |
| Reminder混入近期验证 | 当前没有可靠外部调度和Tool Ledger | 明确排除，只允许提醒草稿；不作为本计划完成证据 |
| SSE可能被误当成前置条件 | 当前Query polling已经能表达权威状态 | 首期继续Query；SSE只作为后续失效提示/Delta，不阻塞P6闭环 |

### 5.2 优化后的原则

1. 先观察当前真实系统，再改变它的执行方式。
2. 先用后端合同证明复杂状态，再接真实前端。
3. 任何配置UI必须在同阶段真实改变服务端RunSpec和运行结果。
4. 通用编辑器必须建立在至少两条真实业务工作流之上。
5. 每个阶段都交付可复核的新保证，并明确仍不保证什么。
6. 最后用组合场景证明阶段之间没有缝隙。

## 6. 最终阶段结构

~~~mermaid
flowchart LR
    G0["G0 阶段总纲审核"] --> S1["S1 当前运行产品投影"]
    S1 --> S2["S2 左到右真实Viewer"]
    S2 --> S3["S3 Definition Kernel与耐久Lab"]
    S3 --> S4["S4 配置化Planning纵向闭环"]
    S4 --> S5["S5 Note Capture复用证明"]
    S5 --> S6["S6 受约束Definition设计器"]
    S6 --> S7["S7 组合验收与收口"]
~~~

G0是当前规划门，不是实现阶段。S1～S7是需要在后续任务地图中继续拆分的交付阶段。

| 阶段 | 一句话结果 | 主要覆盖 |
| --- | --- | --- |
| S1 | 当前固定Workflow先成为Chat可查询的真实节点图 | O1、O2、O8、O10、O13 |
| S2 | 用户能从左到右查看并检查当前真实运行 | O1、O2、O10、O12、O13 |
| S3 | 受约束Definition可确定性校验、编译并由同一耐久Runner解释 | O4、O5、O8、O11 |
| S4 | 用户发消息前的配置真实决定Planning Workflow运行 | O3、O4、O5、O8、O9、O13 |
| S5 | Note Capture用同一底座完成另一种产品生命周期 | O7、O9、O13 |
| S6 | 用户基于两条已证明工作流设计、验证和发布Definition | O3、O4、O6、O11、O12 |
| S7 | 旧Run、恢复、安全、容量和组合真实E2E全部收口 | O8～O14 |

## 7. 整体方案设计

### 7.1 五个稳定层次

~~~text
Node Catalog
  代码拥有可执行节点、Schema、风险与跳过策略

Workflow Blueprint
  代码拥有某类工作流允许怎样组合和覆盖

Workflow Definition
  用户保存的受约束语义结构和节点配置

Run Configuration → RunSpec
  本次发起覆盖经Application校验和编译后的运行输入

Node Run Projection
  Chat拥有的运行状态、输入输出引用、证据和公开时间线
~~~

### 7.2 前后端责任

| 层 | 责任 | 禁止 |
| --- | --- | --- |
| Web | 选择、配置、画布投影、节点检查、提交决定 | 直接启动Workflow、持有Hook、解释权威终态 |
| API/Hono | 身份、协议终止、Schema校验、流式传输 | 直接拥有产品事务 |
| Application | Definition校验、RunSpec编译、Command、Query、事务 | 把外部网络调用塞进事务 |
| Domain/Product Store | Definition、Run、Node Run、Decision及不变量 | 保存Runtime私有身份为产品授权 |
| Workflows | 解释受约束RunSpec、耐久步骤、暂停与恢复 | 直接写Product Store |
| Realtime/Trace | 诊断路径；未来公开事件失效提示/Delta | 保存正文或成为第二产品事实源 |

### 7.3 稳定身份

1. definitionNodeId标识Definition中的稳定节点。
2. nodeRunId标识一次具体节点执行。
3. iterationPath标识循环或修订位置。
4. Product Run连接用户可见生命周期。
5. Runtime Step/Workflow Run只在私有Adapter中关联。

### 7.4 数据和内容

1. Node Run摘要可内联状态、耗时、短预览和对象引用。
2. 完整Plan、Note、Project Resource和Evidence仍由各自产品资源拥有。
3. 大输入输出使用Artifact Ref、Hash、类型和权限，不复制进Trace。
4. Public Timeline由严格allowlist投影，不直接返回原始Trace。

## 8. 逐阶段方案、约束与完成门

### S1：当前运行产品投影

#### 阶段目标

不改变当前PlanningExecutionWorkflow行为，把其用户有意义的步骤映射为稳定Definition Node和Node Run，使Chat API能完整查询运行图、节点详情、输入输出引用和公开时间线。

#### 必须输入

- 当前Run、Plan、Approval、Decision、Attempt和Execution Candidate事实。
- 当前严格Trace与私有Workflow关联。
- 已确认的definitionNodeId/nodeRunId/iterationPath语义。

#### 方案边界

1. 建立最小代码拥有的当前Workflow语义图，不建立用户编辑器。
2. Product Store拥有Node Run及状态机，Application拥有推进Command和Query。
3. 当前Workflow只增加稳定映射和产品投影写入，不改变规划、审核和执行顺序。
4. Node详情只返回安全预览和产品对象引用。

#### 本阶段不做

- 不动态解释Definition。
- 不增加React Flow。
- 不改变Composer。
- 不引入SSE。

#### 阶段完成门

1. 现有B2正常、修订、拒绝、失败和恢复测试全部保持。
2. API能查询稳定图和每次修订的独立nodeRun。
3. Plan、Approval、Execution Step与Node Run终态一致。
4. 浏览器可获得的DTO不含Runtime私有ID、正文泄漏或隐藏推理。
5. API/Workflow重启后投影可恢复，不依赖浏览器缓存或原始Trace重建权威终态。

#### 覆盖

O1、O2、O8、O10、O13。

### S2：左到右真实Viewer

#### 阶段目标

用户在现有工作区看到真实运行图，默认从左到右展开；点击节点查看概览、输入、输出、Evidence和时间线，并能在Human Review节点完成现有修订、批准和拒绝动作。

#### 必须输入

- S1稳定的workflow-view和node detail合同。
- 现有PlanPanel审核能力。
- 现有响应式PWA、主题与可访问性Token。

#### 方案边界

1. Viewer只读取服务端投影。
2. 使用确定性结构化LR布局；React Flow只负责渲染和交互。
3. 保留用户选择和视口，不随轮询强制跳转。
4. 移动端提供画布容器平移、Drawer和顺序列表入口。

#### 本阶段不做

- 不设计或保存Definition。
- 不允许拖拽改变执行顺序。
- 不引入ELK。
- 不把Fixture节点混入真实运行。

#### 阶段完成门

1. 真实Planning Run从发送到修订、批准和完成全程可见。
2. waiting、running、failed、skipped等状态三通道可区分。
3. 节点详情与正式Plan/Approval/Result一致。
4. 375/390px无页面级横向溢出，键盘和列表路径可完成检查与审核。
5. 刷新和轮询后选择、视口和权威状态行为正确。

#### 覆盖

O1、O2、O10、O12、O13。

### S3：Definition Kernel与耐久Lab

#### 阶段目标

在不切换生产Planning路由的前提下，证明Node Catalog、Blueprint、结构化IR、Definition、Run Configuration和RunSpec可被确定性校验、编译和Hash，并由同一编译后的Vercel Workflow Runner解释多份Definition。

#### 必须输入

- S1已验证的稳定节点身份和Node Run语义。
- 当前Vercel Workflow版本与源码证据。
- 研究Spike中的动态定义、Hook和重启结论。

#### 方案边界

1. Definition只允许已注册类型和结构化控制流。
2. 校验包含节点数、深度、循环次数、输入绑定、skip/risk policy和版本。
3. Compiler输出规范化RunSpec与确定性Hash。
4. Lab必须进入仓库测试，但不进入生产Message路由。

#### 本阶段不做

- 不增加用户配置入口。
- 不迁移当前Planning Workflow。
- 不建立编辑器。
- 不执行真实外部副作用。

#### 阶段完成门

1. 同一Runner执行至少三份合法Definition并产生预期不同路径。
2. manual、policy auto-continue、approve/reject分支和bounded loop均有确定性测试。
3. Worker/Local World重启后Hook继续；start后调用方对象变化不影响RunSpec。
4. 非法类型、非法回边、超限、风险绕过和版本不兼容在启动前拒绝。
5. Definition/RunSpec Hash和规范化在平台支持范围内稳定。

#### 覆盖

O4、O5、O8、O9、O11。

### S4：配置化Planning纵向闭环

#### 阶段目标

用户在发送消息前选择Planning Preset并配置Memory、Project、Rules、Skills和审核方式；服务端编译本次RunSpec，配置化Runner真实完成调研、规划、审核循环、执行、验证和产品提交。

#### 必须输入

- S1/S2的Node Run API与Viewer。
- S3的Definition Kernel。
- 到P6实施时已经交付的Project Context和Rules正式资源。
- 当前B2 Planning/Approval/Execution产品事实与真实Provider门。

#### 方案边界

1. Composer只显示Blueprint允许的本次覆盖项。
2. Application在Message事务中校验并固定RunSpec引用与Hash。
3. 既有Plan、Approval和Decision保持权威，不建立第二套审核事实。
4. manual与policy auto-continue使用不同Decision/Resolution事实。
5. required/optional Context失败语义明确。

#### 本阶段不做

- 不允许用户新建Definition。
- 不允许任意拖拽。
- 不执行尚未治理的外部Tool副作用。
- 不为了配置化重写Project、Rules或Memory产品模型。

#### 阶段完成门

1. 至少两种Planning配置从同一Composer产生可观察的不同真实路径。
2. manual支持revise、approve、reject；低风险auto-continue不伪造人工批准。
3. 高风险配置即使篡改HTTP请求也无法关闭人工审核。
4. API/Workflow重启、重复发送、Hook竞态和旧Decision均安全收敛。
5. 真实Memory、Project Context、Rules、百炼模型和真实浏览器纵向门通过。
6. 当前B2无配置默认路径保持兼容或有显式迁移与回滚证据。

#### 覆盖

O3、O4、O5、O8、O9、O10、O12、O13。

### S5：Note Capture复用证明

#### 阶段目标

用一条不同于Planning生命周期的Note Capture工作流证明：同一Catalog、Compiler、Runner、Node Run API和Viewer可以完成内容提取、分类/标签建议、可选确认和正式Note写入。

#### 必须输入

- S3/S4已经投入生产的Definition Kernel与Runner。
- Chat正式Note资源、revision、标签和候选/确认语义。
- S2的Viewer。

#### 方案边界

1. Note必须是Product Store正式资源，不是Assistant文本或Trace附件。
2. 模型分类和标签只是候选；正式写入由Application校验和提交。
3. 预置Definition即可，不依赖尚未完成的编辑器。
4. 重复Command和重启不能产生重复Note。

#### 本阶段不做

- 不做Reminder、Calendar或通知。
- 不为了证明复用复制一套Note专用Runner/Viewer。
- 不把通用Node Catalog扩成任意metadata袋子。

#### 阶段完成门

1. Planning与Note两条Definition共享同一核心合同和Runner Registry。
2. Note正常、修订/确认、拒绝、重复提交和重启恢复通过。
3. Viewer使用同一API显示Note节点和正式Note引用。
4. 代码审查没有复制第二套定义解析、运行状态或画布模型。
5. 如果正式Note产品边界不能在本阶段合理建立，必须回退修订阶段总纲，不能用假Note替代完成证据。

#### 覆盖

O7、O9、O10、O13。

### S6：受约束Definition设计器

#### 阶段目标

用户能基于Planning和Note两类已证明Blueprint，创建、复制、排序、启停、配置、验证和发布受约束Definition；保存失败、revision冲突和非法结构都有可修复反馈。

#### 必须输入

- 两条真实工作流反推的Catalog、Blueprint和配置Schema。
- S3 Compiler与服务端validate。
- S2已验证的图、Inspector、移动端和可访问性交互。

#### 方案边界

1. 设计器只暴露Blueprint允许的节点和结构操作。
2. 循环使用专门容器，不允许随意画回边。
3. 保存和发布使用Command ID、expectedRevision和服务端校验。
4. View State与Semantic Definition分离。
5. 发布前必须显示风险策略和验证结果。

#### 本阶段不做

- 不开放任意代码、任意表达式、多输入Join或局部重跑。
- 不开放未注册节点。
- 不自动迁移有歧义的旧Definition。
- 不建设节点市场。

#### 阶段完成门

1. 用户能从两个Blueprint分别保存并运行合法Definition。
2. 非法结构、风险绕过、未知版本和并发修改不能发布。
3. Definition修改只影响新Run；旧Run图和节点详情保持不变。
4. 桌面和手机均能完成核心配置；键盘和非画布表单入口可用。
5. Editor输出经服务端重新读取和编译后与预览一致。

#### 覆盖

O3、O4、O6、O8、O11、O12。

### S7：组合验收与收口

#### 阶段目标

从干净基线执行跨Planning、Note、Definition编辑、历史Run、恢复、安全、容量和移动端的组合验收，修正阶段之间暴露的缺口，并把当前实现文档、调试导航和版本证据更新为as-built事实。

#### 必须输入

- S1～S6全部阶段证据。
- 当前冻结依赖、Store迁移链、调试启动器和真实服务环境。
- O1～O14整体完成标准。

#### 方案边界

1. 本阶段主要收口跨阶段问题，不增加第三类Workflow或新控制流。
2. 任何修复都回映到出错阶段的合同和测试，不只在E2E绕过。
3. 干净基线、旧Store/旧Run和大数据边界必须独立验证。
4. 完成后更新唯一as-built文档，不让研究稿冒充现状。

#### 本阶段不做

- 不做Reminder/Calendar。
- 不引入任意脚本节点。
- 不把未完成项改名为“后续优化”后宣布整体完成。

#### 阶段完成门

1. O1～O14逐项有可复核证据且无空白。
2. Planning主链完成Memory/Project/Rules→Plan v1→revise→v2→approve→execute→commit。
3. Note主链完成提取→标签建议→确认→正式写入。
4. 手工与自动审核、重启、竞态、旧Run、Definition修改、超限和安全攻击场景通过。
5. 全仓format、lint、typecheck、test、build、生产依赖审计和架构测试通过。
6. 真实Workflow、真实Memory/Project/Rules、真实模型和桌面/手机浏览器门通过；付费证据与普通回归隔离。
7. README、frontend-backend-interaction、runtime-workflows、local-debug和version-evidence与代码一致。

#### 覆盖

O8～O14，并复验O1～O7。

## 9. 整体测试设计

### 9.1 五层证据

| 层级 | 证明什么 | 主要运行时机 |
| --- | --- | --- |
| T1 纯规则/状态机 | Definition、状态转换、风险和Hash确定性 | 每次相关提交 |
| T2 合同/Store | DTO、迁移、CAS、幂等、引用和安全投影 | 每个相关PR |
| T3 Workflow集成 | Runner、Hook、Checkpoint、重启、循环和恢复 | 相关阶段里程碑 |
| T4 纵向E2E | 真实服务、模型、Product Store和浏览器形成用户结果 | S2、S4、S5、S6 |
| T5 组合验收 | 两类Workflow、历史兼容、容量、安全和干净基线 | S7 |

### 9.2 固定测试族

1. Definition合法/非法结构与版本。
2. RunSpec规范化、Hash、资源引用和风险策略。
3. Node Run状态机、循环、attempt和iterationPath。
4. manual/auto/revise/approve/reject/HITL竞态。
5. API/Worker重启、Outbox、重复Command和结果未知。
6. 输入输出截断、Artifact Ref、保留期和权限。
7. Public Timeline与Runtime身份/正文泄漏哨兵。
8. LR布局、选择稳定、移动端、键盘和可访问性。
9. 旧Definition、旧Run和Store迁移。
10. Planning与Note组合真实E2E。

### 9.3 阶段测试不能互相冒充

- S1的API测试不能证明S2用户可用。
- S2的Fixture/组件测试不能证明S4配置真实影响运行。
- S3的Lab不能证明生产Planning已经迁移。
- S4的Planning复用不能证明第二业务生命周期成立。
- S5的预置Definition不能证明用户能安全设计和发布。
- S6的编辑器Happy Path不能证明旧Run、容量和整体恢复。
- 只有S7能对整体完成作最终声明。

## 10. 整体追踪矩阵

| 整体标准 | 主证明阶段 | 最终复验 | 闭包说明 |
| --- | --- | --- | --- |
| O1 真实运行图 | S1、S2 | S7 | 后端事实与前端可用性都成立 |
| O2 节点详情 | S1、S2 | S7 | 数据合同和交互同时验证 |
| O3 发起前配置 | S4、S6 | S7 | 本次覆盖与保存Definition两层成立 |
| O4 服务端校验 | S3、S4、S6 | S7 | Kernel、生产发起、发布均不可绕过 |
| O5 审核与循环 | S3、S4 | S7 | 纯规则、耐久集成和真实纵向均覆盖 |
| O6 保存/发布 | S6 | S7 | 不由运行配置或Lab冒充 |
| O7 两类工作流复用 | S5 | S7 | 以真实Note生命周期反证Planning特化 |
| O8 历史语义稳定 | S1、S3、S4、S6 | S7 | 身份、RunSpec和旧Run查看共同覆盖 |
| O9 恢复和幂等 | S3、S4、S5 | S7 | Runtime与两个业务链都验证 |
| O10 安全边界 | S1、S2、S4、S5 | S7 | DTO、UI和真实运行均有泄漏哨兵 |
| O11 容量与上限 | S3、S6 | S7 | 编译限制和UI/存储降级都验证 |
| O12 响应式与可访问 | S2、S4、S6 | S7 | 查看、发起、设计三个界面覆盖 |
| O13 现有能力不回归 | S1、S2、S4、S5 | S7 | 每次迁移有回归门，最终再全量验证 |
| O14 干净真实组合门 | S7 | S7 | 只有最终阶段可声明 |

### 10.1 闭包结论

在不降低任何阶段完成门的前提下：

1. S1 + S2证明“真实运行可观察”。
2. S3 + S4证明“受约束定义能够真实决定Planning运行”。
3. S5证明“底座不是Planning专用实现”。
4. S6证明“用户能够安全设计和发布已有能力”。
5. S7证明历史兼容、恢复、安全、容量、响应式和跨阶段组合。

这五组证据并集覆盖O1～O14。因此，只有S1～S7全部通过并由S7复验，才能声明整体目标达成。

## 11. 规划风险的设计收敛状态

| 原风险 | 当前设计结论 | 仍需实现证据 |
| --- | --- | --- |
| Note是否属于P6及最小边界 | S5纳入最小Note/Revision/Candidate/Decision；明确排除Reminder、分享、附件和同步 | S5真实第二纵向与复用审计 |
| S4依赖Project Context与Rules | 保持PROJECT_PLAN顺序，S4只能在二者完成后开始并重新读取其真实合同 | S4.2资源冻结和S4.7真实全链 |
| React Flow版本/依赖 | 架构只批准用途，不提前安装；S2.1设独立证据与退出门 | bundle、许可证、兼容和Spike |
| 大输出与结构上限 | 不在设计稿拍整数；S3实验初定安全预算，S7.2按真实样本最终收敛 | limit/limit+1、性能和Checkpoint扫描 |
| 旧Run投影方式 | 采用产品拥有的View Snapshot + Node Run；只按既有事实诚实回填 | S1.3迁移与S7.1全版本兼容 |
| Timeline与SSE关系 | Product Transition由Query拥有，SSE只发失效/兼容事件；不新建竞争协议 | S1.6、S2.2与S7.3断连恢复 |

任一实现证据推翻这些结论时，先修订本总纲、详细架构和受影响任务，再继续下游实现。

## 12. 总纲通过后的交付状态

总纲确认后已按以下顺序形成实现前审核包：

1. 一次性列出S1～S7全部候选小任务。
2. 为每个任务标注上游输入、下游消费者、用户结果、主要变更层和阶段完成门映射。
3. 建立任务依赖DAG、Store Schema串行顺序、依赖安装点和真实E2E里程碑。
4. 检查每个阶段是否被任务完整覆盖，是否存在孤立DTO/Adapter任务或巨大纵向任务。
5. 合并、拆分或重排直到每个任务都能独立审核、回滚且默认0.5～2日。
6. 为全部任务分别完成方案设计、测试设计、不做事项、迁移/回滚和完成门。
7. 再做一次“全部任务通过是否必然通过S1～S7和O1～O14”的反向审查。
8. 只有任务地图与全部任务设计都通过审核，才从第一个独立worktree开始实现。

对应产物：

- [全任务地图与依赖DAG](./configurable-workflow-task-map.md)
- [详细架构与方案设计](../architecture/configurable-workflow-design.md)
- [S1到S7逐任务设计入口](./configurable-workflow-task-map.md)
- [实现前整体自审](./configurable-workflow-self-review.md)

### 12.1 任务进入实现前的固定门

每个任务必须同时满足：

- 有且只有一个主要用户或工程结果。
- 映射到明确阶段完成门和整体O项。
- 上游合同已经合并或任务内完整交付。
- 方案说明事实所有权、跨层数据流、失败、幂等、版本和回滚。
- 测试说明确定性门、集成门、真实门及付费隔离。
- 不做事项能阻止范围扩张。
- 预计超过2个单人开发日则继续拆分。
- 用户审核通过后才创建worktree、分支和PR。

### 12.2 实现中的变更控制

如果真实实现或测试证明阶段假设错误：

1. 暂停当前及下游实现。
2. 保留已经得到的证据，不用兼容层掩盖问题。
3. 修订阶段目标、约束、方案、测试和追踪矩阵。
4. 重新审查受影响的全部任务设计。
5. 只有闭包重新成立后继续。

这保证规划不是一次性文档，也不会因为已经拆了Task就强行走完错误路线。
