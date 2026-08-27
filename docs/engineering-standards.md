# Chat 工程规范

> 本文件是 `agent-engineering-standard.v0.2` 在 Chat Workspace 的具体 Overlay，拥有 Chat 的架构、代码、
> 测试与交付质量门。跨项目原则见[Agent 工程治理规范](./agent-governance/standards.md)，来源与反证见
> [核心标杆横向抽取](./agent-governance/exemplars/README.md)。“能运行”不是通过条件；变更还必须保持事实所有权、
> 最小公共面、明确失败语义和与风险匹配的证据。

## 1. Workspace

目标目录：

```text
apps/dsh-web
apps/api
apps/pi-executor
packages/dsh-lifeos-bridge
packages/contracts
packages/domain
packages/application
packages/product-store-json
packages/memory-runtime
packages/project-runtime
packages/realtime
packages/workflows
packages/pi-runtime
packages/testing
```

根目录只放Workspace配置、治理入口和跨包工具。Feature代码不得直接堆到根入口。

## 2. 依赖方向

```text
DSH Bridge/Hono/Vercel/pi Adapters
            ↓
       Application
            ↓
       Domain + Ports
```

- Domain不依赖React、Hono、数据库、Vercel Workflow、AG-UI或pi。
- Application不依赖具体Router和页面。
- Workflow调用Application Port或Activity Adapter，不直接改产品表。
- DSH Client只依赖浏览器安全合同；Bridge Host只调用公开Chat API，不导入Application或Store实现。

通过架构测试固定依赖方向。

### 2.1 架构与设计质量门

进入实现前，设计结论必须同时回答：用户可观察结果与非目标、权威事实与事务所有者、依赖方向、复用决定、
公共接缝、失败/恢复、兼容/迁移、计划变更面和验证 Lane。缺少其中任何一个与本次风险相关的答案，都不能用
“先写起来再重构”进入实现。

合格架构必须满足：

1. **所有权唯一**：一个事实、状态转换、事务或外部终态只有一个权威Owner；缓存、Runtime Session、前端投影和
   Journal只能拥有自己的运行责任，不能演化成第二事实源。
2. **依赖向内**：不稳定框架、Provider、UI和持久化实现依赖稳定产品合同，Domain/Application不反向认识具体Adapter。
3. **边界有原因**：模块只因事实所有权、变化原因、事务、失败恢复或真实替换接缝而拆分；不得按名词机械制造
   Controller/Service/Repository层。
4. **核心有准入**：Chat核心只容纳产品必须负责的稳定语义；通用能力先审核上游，走直接依赖、Hosted/Sidecar或
   窄Adapter。插件和Fork不是复杂度垃圾桶，也不得拥有Chat产品事实。
5. **公共面有消费者**：新增Port、接口、事件、配置、Hook或公共导出必须列出现有消费者和变化依据；只有一个实现、
   没有策略或隔离价值的转发层应当内联。
6. **失败可恢复**：正常、拒绝、取消、超时、并发冲突、部分成功和结果未知分别有终态与恢复责任；不得用普通重试
   或默认成功抹平差异。
7. **演进可迁移**：公开API、持久格式、Workflow版本和外部协议变化必须说明兼容范围、迁移顺序、恢复点和退出路径；
   内部未承诺路径不为“可能有人用”永久保留双实现。

下列情况直接阻断采用：Router、Workflow Step、UI或Adapter绕过Application写产品事实；同一产品对象出现第二套
权威状态；复制已有上游能力；为未来猜测增加公共抽象；把产品业务写入Pi/DSH等通用Fork；用更多文件、接口或插件
掩盖没有明确所有权的复杂度。

## 3. TypeScript

1. 开启`strict`、`noUncheckedIndexedAccess`和`exactOptionalPropertyTypes`。
2. 禁止在网络、存储和外部SDK边界使用未经校验的类型断言。
3. Zod Schema拥有运行时合同，TypeScript类型从Schema推导或通过测试保持一致。
4. `unknown`优于`any`；必须先缩窄再使用。
5. 公共状态机、Command、Event和Port使用JSDoc解释不变量与失败语义。

### 3.1 代码质量门

合格代码必须让维护者只阅读当前模块、它的稳定合同和直接测试，就能回答“输入从哪里来、状态由谁拥有、可能怎样
失败、结果交给谁”。不能靠聊天记录、调用顺序猜测或隐藏全局状态补全含义。

1. **命名表达领域语义**：同一名词在Contracts、Domain、Application和Adapter中保持同一含义；Product Run、
   Workflow Run、Attempt、Runtime Session等相近对象不得用缩写或泛化名字混用。
2. **数据流显式**：身份、Scope、Revision、幂等Key、取消信号和依赖通过参数或明确Context传递；不得从环境变量、
   单例或可变模块状态偷偷补齐业务输入。
3. **边界只校验一次**：网络、存储、文件和Provider输入在进入稳定内核前完成运行时校验、归一和错误分类；内层依赖
   已建立的不变量，不重复散落防御式解析。
4. **公共面浅，模块内部可以深**：优先用少量稳定操作封装必要复杂度；一层层同参转发、Service-per-method、
   Repository-per-table和万能`utils`都不构成抽象。
5. **控制流可追踪**：优先直线化成功路径并显式处理失败分支；避免宽泛`catch`、隐式布尔状态、跨函数可变标志、
   无边界递归和为了“聪明”压缩成难审表达式。
6. **错误保真**：错误分类、原始Cause、可重试性、未知结果和用户恢复动作不能在层间丢失；日志和返回值不得制造
   假成功或把内部诊断暴露给浏览器。
7. **抽象晚于共同变化**：重复只有在相同所有权、相同失败方式且已经共同变化时才合并；表面相似但事务或恢复不同的
   代码宁可保持局部重复。
8. **注释解释原因**：只注释不变量、身份转换、事务/幂等、失败恢复和反直觉取舍；不逐行翻译语法，不用TODO替代
   Owner、退出条件和可定位后续事实。
9. **完成时收缩**：删除死代码、已到退出条件且无消费者并有迁移/恢复证据的过期兼容支路、调试脚手架、重复
   Helper、无消费者导出和过期注释；生成文件只由受审生成器产生，不直接手改。

代码审查必须能列出新增公共导出及消费者、状态/失败边界、计划外复杂度、删除或替换的旧路径。仅通过Format、
Typecheck或覆盖率不能证明代码质量；这些工具只能检测各自拥有Oracle的部分。

## 4. 事务与状态

1. Application Coordinator是一个用例的唯一产品事务所有者。
2. Repository不自行提交事务。
3. 外部网络调用不放进数据库事务。
4. 本地事实与Outbox同事务提交。
5. 写命令必须支持`commandId`幂等和`expectedRevision`并发控制。
6. 所有终态转换必须有状态机测试和非法转换测试。

## 5. Workflow与副作用

1. Workflow Step输入输出必须可序列化、版本化和校验。
2. Step不接收数据库连接、HTTP Context或浏览器对象。
3. 外部副作用必须有稳定幂等Key和明确的未知结果语义。
4. Hook Token、Workflow Run ID和Checkpoint ID只存在于Runtime Adapter。
5. Workflow Definition变更发布新版本；历史Run继续引用原版本语义。

## 6. 实时事件

当前仓库已经交付单机单写者Run Activity Journal，DSH Bridge仍使用受控Query轮询；SSE只是未来传输层，
不能改变下列顺序与重放合同。Debug Trace与Activity Journal是两个物理目录和两个语义边界。

1. Runtime Journal是公开事件顺序的唯一Owner。
2. 每个Product Run的sequence严格递增。
3. 重放相同eventId必须内容一致。
4. 前端发现缺口或冲突时停止应用Delta并重新Hydrate。
5. Product资源完整内容通过Query读取；事件只携带运行投影或失效提示。

## 7. 错误与日志

- HTTP使用稳定Problem Detail错误族。
- 日志包含`requestId`、`productRunId`、`attemptId`及适用的Workflow/Tool关联引用。
- 日志记录命令入口、状态转换、外部调用、暂停/恢复、接管、对账和失败边界。
- 不记录密钥、Cookie、完整Prompt、完整Provider Payload、用户无关正文或隐藏推理。
- 用户错误与内部诊断分开；浏览器只获得可执行恢复信息。

## 8. 测试门

### 8.1 测试用例质量门

每个测试必须指向一个可命名风险，并让失败信息定位到行为、边界或数据差异。测试文件很多、覆盖率高或Snapshot很大
都不能代替可信Oracle。

1. **名称就是行为合同**：完整的`describe + it`路径共同描述前置条件、动作和用户/消费者可观察结果；单个`it`无需
   机械重复全部信息，但不得使用“works”“handles correctly”或只复述函数名的空名称。
2. **断言稳定结果**：优先断言返回值、持久事实、公开事件、状态转换、错误族和恢复动作；除非调用顺序本身就是合同，
   不冻结私有方法次数、内部对象形状或偶然日志文本。
3. **一个用例聚焦一个风险**：Fixture只包含触发该风险所需的最小状态；一个失败不应同时对应十几个无关原因。
4. **失败路径与正常路径同等重要**：非法状态、边界值、取消、超时、重复、并发、部分成功、未知结果和恢复必须按
   责任风险覆盖，不能只堆Happy Path。
5. **回归证据能识别原缺陷**：Bug修复先形成会在旧实现失败的测试、复现脚本或固定输入；若无法先运行，必须保存
   缺陷输入、旧输出和新Oracle，不能只说“加了测试”。
6. **共享接缝使用共同合同**：Store、Provider、Session Backend或其他多实现/高风险接缝复用同一Conformance Suite，
   每个实现只能提供真实初始化Fixture，不能为测试建立生产不存在的旁路。
7. **Mock不冒充边界**：Mock只证明本方怎样调用；真实响应语料必须脱敏并记录来源阶段，Fixture不能证明当前鉴权、
   网络或Provider仍兼容。声称真实Workflow、Pi、浏览器或存储成立时运行对应合同级或真实门。
8. **环境可重复**：时间、随机数、端口、网络、HOME、全局配置和共享目录必须隔离或注入；不得通过重复运行直到变绿、
   任意延长等待或放宽断言掩盖Flaky。
9. **Snapshot只保护稳定小合同**：禁止用巨型Snapshot替代语义断言；变更Snapshot时必须说明哪个产品合同改变及为何。
10. **最终组合重新验证**：分支、Package或子Agent分别通过不能外推集成结果；采用前在最终Diff和目标Workspace声明的
    完成门上运行新鲜验证，并如实列出未运行项。

### 8.2 纵向风险矩阵

每个纵向能力按风险覆盖：

1. Domain状态机与纯规则单元测试。
2. Command/Query/Event Schema合同测试。
3. Product Store事务、CAS、幂等和并发测试。
4. Workflow重放、Hook和Checkpoint测试。
5. pi Adapter真实事件归一化测试。
6. SSE断线、Cursor重放、缺口和重复测试。
7. DSH Host/Client插件的加载、错误、窄屏、键盘和可访问性测试。
8. Playwright端到端正常与恢复场景。

Mock只能证明调用合同；真实Workflow、真实pi和真实浏览器证据不能被Mock代替。
正式测试分类、默认内存策略、CI调度及付费/外部写三闸门见
[测试lane](./testing/test-lanes.md)。

## 9. 规模审查

Agent开工前必须列出预计变更预算，交付前逐项比较实际结果：触达模块、生产文件、公共API、持久格式、依赖与
Lifecycle Script、配置/权限、Workflow/迁移、测试/文档，以及删除或替换的旧路径。出现未计划的公共面、依赖、
持久事实或跨模块扩张时停止采用，先解释原因并重新取得设计决定；不能在交付摘要里事后合理化。

每次完成前做一次收缩审查：是否可以删除而不是增加，是否把通用能力重复写进Chat，是否把复杂度从核心转移进
无治理插件，是否存在无消费者导出、第二条路径、过期兼容或只为测试存在的生产代码。

以下只触发责任审查，不机械拆文件：

- TypeScript模块超过800行。
- Client插件组件或Hook超过500行。
- 函数超过80行。

拆分必须依据状态所有权、事务边界、失败恢复和变化原因。禁止万能`utils`、Repository-per-table和Service-per-method。

## 10. 依赖与升级

新增依赖必须记录：

- 解决的问题。
- 所在Adapter或核心边界。
- 为什么标准库或现有依赖不足。
- 许可证与维护状态。
- 退出或替换方式。

升级DeepSeek Harness、code-server、Vercel Workflow或pi之前，必须先运行对应插件、代理、事件、Hook、Checkpoint、Tool和恢复合同测试。

依赖或锁文件变化运行标准`pnpm audit --prod`；Managed Fork固定点或CI变化还必须运行
`pnpm managed-sources:verify`与对应接缝测试。安装期脚本只允许
`pnpm-workspace.yaml`登记且逐项说明理由的包；新生产许可证、`Unknown`许可证或许可证例外必须先审查，
不能仅因构建成功而放行。

## 11. 公共面、兼容与ADR

1. 公共HTTP、Browser合同和workspace export由其真实Contracts、Router和消费者测试看护；不得为CI手写第二份路由、Operation、内部调用图或Schema事实表。
2. 网络、Product Store、Bridge State、Workflow/RunSpec、Direct/Generic Journal、Browser DTO/Event统一执行`read old / write current`。
3. 同一`schemaVersion`不得原地新增必填、收窄枚举或改变语义；新写语义升代际，旧代只读不能扩权。
4. breaking change必须有`detect / why / fix / verify / rollback`和用户明确批准；waiver绑定精确before/after digest与diff hash，Agent不得自行写waiver。
5. ADR只用于跨模块、长期且难以从局部代码恢复的决定。普通修复、测试或单包重构不写ADR。

## 12. 中文注释与当前实现文档

### 12.1 Capability与Tool执行

1. 可执行Tool不得只用裸`localName`作为跨边界身份；必须带`runtimeOwner + source namespace`的稳定Capability ID，并冻结descriptor、input schema、实现/工件和scope Hash。
2. Runtime Profile必须来自真实Runtime解析结果。来源碰撞、Extension加载diagnostic、资源不可读或实现Hash缺失时失败关闭，不得静默缩小目录或回退built-in。
   Extension实现Hash必须覆盖受管工件或排序后的本地依赖树；只Hash入口文件不合格。受管名字还必须验证精确SourceInfo，不能凭裸名认领身份。
3. `readiness`只表示部署可用性，不代替Principal、Workspace或Run授权。
   `global/workspace_required/provider_defined`必须分别解析；缺Workspace Grant或Provider Scope时不得复制调用方Scope或回退global。
4. `local_write/shell/external_write`在handler前必须提交Product Intent并消费绑定revision、Capability、参数Hash和scope的一次性Decision；Prompt Review不能代替Tool动作审核。
5. Tool已发出后的不确定结果不得自动重放；记录`outcome_unknown`并进入只读对账/人工处置。只有Product Result提交可用同一commandId安全重放。
6. Product Commit只引用结构化Tool Result Hash；模型自述不是执行证据。Pi Journal继续拥有完整运行证据，Product Store只保存必要引用与采用/终态事实。
7. 事件合同使用通用Capability引用；不得在Protocol、Store、Activity、Trace与UI各复制一套Tool名字枚举。
8. 当前新写代际为Product v21、Bridge v16、Prompt Assembly v4、Direct Protocol/Store v2及`full-operation.v3`；历史代际只读，不得借optional字段获得新授权语义。

### 12.2 注释与文档要求

1. 跨前端、HTTP、Application、Store、Outbox、Workflow、Provider或外部服务的关键边界必须有中文JSDoc或块注释，说明“进入什么、离开什么、谁拥有事实、失败怎样恢复”。
2. 注释优先解释原因和不变量：身份为什么不能混用、为什么需要CAS/Hash/Outbox、为什么不能自动重试；不为显而易见的赋值和语法逐行翻译。
3. 关键数据结构要说明字段角色，尤其是`commandId`、各种revision/Hash、产品ID、Attempt、Outbox与Runtime私有ID；同名或相近对象必须明确“是什么/不是什么”。
4. 新增或改变纵向交互时，同步更新最接近行为的as-built文档。前后端数据流更新`docs/architecture/frontend-backend-interaction.md`，Workflow节点更新`runtime-workflows.md`，启动、断点或排障更新`docs/debug/local-debug.md`。
5. 调试文档以“文件 + 函数/路由 + 观察变量”为稳定入口；行号只能作为临时提示，不能作为唯一定位方式。
6. 当前实现、目标架构和历史任务书必须分开。注释与调试指南只描述当前代码已存在的行为，不把未来SSE、生产Store或未实现节点写成现状。
