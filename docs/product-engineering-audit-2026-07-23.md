# Chat产品级工程审计

> 审计日期：2026-07-23
>
> 结论状态：`已完成静态结构、合同、工程工具、文档和测试资产审计；不等同于生产安全审计或容量实测`
>
> 整改入口：[产品能力与工程质量Todo](./product-engineering-backlog.md)

## 实施后附记

本报告正文保留Q0实施前的审计快照，因此其中“没有CI/覆盖率/Playwright”等内容是问题发现证据，不是当前事实。Q0纵向基线随后已建立并通过本地完整门；当前测试数量、已完成边界和仍存风险只以[项目状态](../PROJECT_STATE.md)为准，后续任务状态见[工程质量Todo](./product-engineering-backlog.md)。

## 1. 结论摘要

当前工程已经是一个**产品能力很强的纵向原型/阶段产品**，不是玩具：

1. Product Session、Run/Attempt、HITL、ExecutionDraft、Harness、MAF Workflow、Checkpoint、Outbox、Runtime Job/Event Cursor/Worker已经形成真实产品链。
2. 12个迁移、100个后端测试、36个前端逻辑测试、真实双Provider和跨OS进程验证，为状态机和关键场景提供了较强证据。
3. Product事实、MAF运行状态、AG-UI实时事件和前端投影的边界清楚，内部Python模块依赖图未发现循环依赖。

但它还没有达到“可以继续长期快速叠加功能而不先收敛”的产品工程状态：

1. 5个后端文件超过1,200行，63个函数超过60行，11个服务类拥有10个以上方法；组合根、路由、应用协调和Workflow定义已经过载。
2. 没有CI、Lint、Python静态类型、覆盖率、自动浏览器E2E或可访问性门；当前验证依赖本机脚本和人工浏览器。
3. 57个HTTP路由缺少统一响应模型和错误合同，至少59处直接把异常字符串放入HTTP响应。
4. 后端只有约31处显式日志调用，没有统一结构化配置、请求关联中间件、Metrics、Trace、Readiness或诊断包。
5. 文档体系丰富，但至少2处“当前状态”已经落后于实现，说明状态同步仍靠人工。

因此建议：**先完成Q0工程安全底座，再进入Tool副作用、Evidence和任意Workflow恢复。** 这不是暂停产品开发，而是避免把下一批高风险状态继续写进已经过大的边界。

## 2. 审计范围与方法

### 2.1 本项目证据

1. 读取项目治理、上下文、状态、计划、概念空间、Session/Runtime/治理/Harness详细设计。
2. 审查`backend/app`、`backend/tests`、12个迁移、`frontend/src`、`frontend/tests`、验证脚本和VS Code配置。
3. 使用项目`.venv/bin/python`执行AST结构统计、内部依赖图、pytest收集和文档校验准备；未使用系统Python。
4. 检查路由、错误映射、日志、异常边界、公开类型说明、前端订阅/轮询和测试类型。

### 2.2 参考项目证据

| 参考 | 固定提交 | 本次限定问题 | 采用的审计基线 |
|---|---|---|---|
| MAF | `9c4cd07899502157284b64a73f9a0adfb4594d96` | Agent/Session/Workflow/Middleware/AG-UI边界与Python质量门 | 中间件和包边界、Ruff/类型/文档/测试规范；MAF能力不替代产品状态 |
| pi | `2b00dade7cec918aefb025c8b7a4fa304a30acdd` | Agent活动状态、追加式Session、工程门 | `npm run check`、固定依赖、TypeScript检查、CI、安全检查和Session/Run分离 |
| nanobot | `2c789767280482f38667044f8a3be5102c71dd26` | 小型Agent Loop、Session、Channel/Bus和测试门 | 显式Turn阶段、边界解耦、Ruff和75%覆盖率门；不采用内存Bus承担耐久执行 |
| QwenPaw | `2134427584c2657bb717bb083a120f2de011d047` | Web/Channel入口、多Agent、治理、可观测性和测试分级 | Feature包、Hook、Tool治理、P0/P1/P2测试标签、覆盖率/假设测试和备份模块 |
| LibreChat | `8e5ef1fb31e9d63b735c089b21cbc82c50acce46` | Web Chat Feature边界、共享合同、E2E和CI | Feature目录、共享DTO、集中错误、Playwright/a11y和多工作流CI；不复制Node/Mongo/Redis |

### 2.3 审计限制

1. 本轮没有进行正式渗透测试、依赖漏洞扫描、生产数据隐私审计或长时间容量压测。
2. 没有改变依赖来生成覆盖率报告，因此“覆盖率未知”是事实，不推测百分比。
3. 没有重新运行付费真实模型；已有真实模型证据仍以`PROJECT_STATE`记录为准。
4. 参考项目只为表中限定范围背书，不代表其整体架构适合直接复制。

## 3. 工程规模快照

| 指标 | 当前值 | 解释 |
|---|---:|---|
| 后端应用Python | 19,472行、42个模块 | 已进入需要稳定模块边界的规模 |
| 后端测试Python | 8,173行、100个测试 | 场景测试投入较强 |
| 前端源码 | 8,132行 | 仍全部平铺在`frontend/src` |
| 前端自动测试 | 36个 | 主要为纯逻辑/合同，不含DOM与浏览器E2E |
| SQLAlchemy表 | 57张 | 产品对象丰富，迁移和关系治理风险高 |
| Alembic迁移 | 12个，均有upgrade/downgrade入口 | 迁移基础较好 |
| 超过60行的后端函数 | 63个 | 应用协调和边界过于集中 |
| 至少10个方法的类 | 11个 | 4个核心Service分别有25-41个方法 |
| `main.py`公开主路由 | 30个 | 组合根同时承担DTO、路由、生命周期和装配 |
| Harness路由 | 24个 | Router工厂177行，仍较集中 |
| Runtime管理路由 | 3个 | 已开始形成Feature边界 |
| 显式logger调用 | 约31处 | 与运行对象和故障面不成比例 |
| `detail=str(error)` | 59处 | 错误合同和信息泄漏风险 |
| Markdown | 95个文件；`docs/`与概念空间约8,734行 | 含本轮新增审计与Backlog；资料丰富，但维护成本和过期风险已出现 |

## 4. 分项评级

评分只表达本次快照相对“可持续运营产品”的成熟度，不是功能完成百分比。

| 维度 | 评分（5分） | 判定 |
|---|---:|---|
| 产品对象与状态语义 | 4.5 | 强；对象边界、版本、CAS、HITL和恢复语义清楚 |
| 架构边界与可维护性 | 2.5 | 中风险；无循环依赖，但核心服务和组合根过载 |
| 代码质量自动门 | 1.5 | 高风险；无Lint、后端静态类型、覆盖率和CI |
| API合同与安全错误 | 2.0 | 高风险；响应模型和错误Envelope不统一 |
| 日志、指标与调试 | 2.0 | 高风险；有关键Worker日志，但无全链路关联和运营面 |
| 测试与验证 | 3.5 | 行为场景强；缺覆盖率、组件/E2E/a11y、容量和完整故障矩阵 |
| 文档与概念治理 | 4.0 | 强；职责和概念清楚，但当前状态已有漂移 |
| 前端工程结构 | 2.5 | 功能完整度较高；文件平铺、超大组件和轮询需要收敛 |
| 运维、备份与SLO | 1.5 | 仍未形成产品运营体系 |

## 5. 做得好的部分

### 5.1 产品状态没有被框架对象吞掉

Product Session、MAF AgentSession/Checkpoint、AG-UI Thread和Product Run明确分开；Runtime Job/Event Journal也没有冒充长期产品事实。这一点比许多参考Agent项目更适合本产品目标。

### 5.2 高风险执行拥有版本和失败语义

ExecutionDraft、ModelCallDraft、Decision、Grant/Consumption、Run/Attempt、Lease Epoch和Checkpoint都使用版本、Hash或Fence；放弃、未知结果和失败不会产生假成功。

### 5.3 测试覆盖了大量真实反例

测试不是只有Happy Path，已经覆盖并发领取、重复输入、跨进程Outbox、Checkpoint损坏、游标缺口、旧Epoch、跨天Harness场景、审批修改与重新发送。

### 5.4 数据迁移和秘密边界有基础

应用使用项目虚拟环境和`uv.lock`；私有`backend/config.json`不进入Git；12个迁移具备升降入口；`.gitignore`覆盖数据库、日志、构建产物和私有配置。

### 5.5 内部模块依赖目前无环

AST静态分析得到42个后端模块、105条内部依赖，未发现循环依赖。问题主要是职责集中和扇出过大，而不是已经形成依赖环。

## 6. 主要问题与证据

### 6.1 P0：核心服务和组合根过载

证据：

1. `ExecutionGovernanceService` 2,496行、41个方法，同时承担Policy、Decision、ExecutionDraft、RunSpec、ModelCall和Summary。
2. `HarnessService` 1,894行、34个方法，同时承担Project、Work、Plan、Action、Note、Memory、Search和Context。
3. `continuous_chat.py` 2,130行，同时定义State、17类Executor、Decision Spec、Prompt任务和25节点Graph Factory。
4. `create_app`单函数726行，组合依赖、启动/关闭、后台循环、30个路由和错误映射混在一起。
5. `ProductSessionService` 1,258行、29个方法；`model_call_review.py` 1,503行。

影响：

- 新功能难以只修改一个职责。
- 事务边界与应用流程隐藏在大方法中。
- 单元测试倾向通过大Service入口完成，隔离失败分支更困难。

建议：执行Q02的分步无行为重构；先拆组合根和错误边界，再拆Service和Workflow，禁止同时改状态机。

### 6.2 P0：自动质量门不足

证据：

1. Python开发依赖只有`httpx`和`pytest`，没有Ruff、Pyright/Mypy、pytest-cov。
2. 前端只有`test/typecheck/build`，没有Lint、格式、覆盖率和组件测试。
3. 仓库没有`.github/workflows`。
4. `verify.sh`只运行概念校验、compileall、pytest、前端test/typecheck/build。
5. 没有自动密钥扫描、依赖漏洞、许可证、OpenAPI漂移和迁移升降门。

影响：本机测试通过不能保证每个提交满足相同质量条件，依赖升级和合同漂移容易漏检。

建议：Q01优先于新高风险Schema。

### 6.3 P0：API错误合同不稳定

证据：

1. 主应用和Harness中共有至少59处`detail=str(error)`。
2. Runtime端点已经局部使用`{"code","message"}`，其余端点大多返回裸字符串，前端必须靠状态码或文案猜恢复动作。
3. 除AG-UI端点外，主要路由没有统一`response_model`和错误响应Schema。
4. `main.py`重复捕获相同领域异常并映射HTTP状态。

影响：

- 内部错误字符串可能暴露路径或实现细节。
- 错误文案变化会破坏前端逻辑和外部Client。
- 无法统一表达`retryable`、`outcome_unknown`和冲突恢复。

建议：Q03建立统一Problem Detail、全局异常映射和OpenAPI合同。

### 6.4 P0：可观测性不能支撑跨进程产品

证据：

1. 日志集中在Worker、Outbox、Checkpoint和少数治理状态，API请求、Context编译、MAF节点、Provider阶段和数据库提交缺少统一链路日志。
2. 只有Worker CLI调用`logging.basicConfig`，FastAPI没有统一结构化日志和脱敏配置。
3. 没有请求关联中间件、OpenTelemetry、Metrics、告警、队列/Lease仪表或诊断包。
4. `/api/health`返回配置快照和“ok”，没有区分Liveness、Readiness、数据库、Worker和积压。
5. 一些日志包含`worker_id/job_id/run_id`，但没有一套自动贯穿全部对象的关联上下文。

影响：系统停在多个进程和状态门之间时，开发者仍需要从数据库和日志人工拼接事实。

建议：Q04先建立关联ID、错误/状态事件和基础指标，再扩大Worker/Tool能力。

### 6.5 P0：测试广度强，但自动产品验证仍有空洞

证据：

1. 100个后端测试覆盖大量领域、合同、恢复和长场景。
2. 36个前端测试使用TypeScript编译加Node Test，主要验证纯函数、DTO和投影。
3. 没有DOM组件测试、Playwright、自动可访问性、视觉回归和跨浏览器。
4. 没有覆盖率数据或高风险状态转换覆盖门。
5. Runtime完整SIGKILL、多标签/换设备、真实410、事件保留、背压、容量和Lease风暴仍未验证。

影响：当前最强证据在后端状态机，用户界面、容量和真实故障恢复仍依赖人工。

建议：Q05建立分层覆盖与故障实验室，不能用一个总覆盖率替代风险矩阵。

### 6.6 P1：前端文件平铺且组件过大

证据：

1. `frontend/src`没有Feature目录。
2. `styles.css` 1,163行、`model-call-review.tsx` 868行、`use-chat-agent.ts` 767行、`App.tsx` 736行、`workflow-run-view.tsx` 519行。
3. `App.tsx`有14个`useState`和5个`useEffect`；多个Hook自行管理fetch、订阅、轮询和恢复。
4. Workflow View以700ms轮询，App另有1.8秒轮询；缺少统一查询缓存和失效策略。

影响：页面状态、服务端状态、实时订阅和轮询容易出现重复请求、竞态和跨Feature耦合。

建议：Q06按Feature拆分，统一Request/错误/缓存/订阅生命周期；Zustand继续只保存页面状态。

### 6.7 P1：公开说明完整度不均

证据：

1. 42个后端应用模块全部有模块级docstring，这是优点。
2. 机械统计231个公开顶层类/函数中157个没有docstring；其中包含DTO、异常类，也包含边界服务和CLI入口。
3. 私有MAF API使用点有局部注释和版本风险记录，但尚未统一映射到依赖升级检查清单。

影响：复杂状态机的“为什么、保证和不能保证什么”主要存在于外部文档，源码附近不总能恢复。

建议：Q07只为公开边界、状态机和非显然恢复逻辑补说明，不要求为每个DTO制造空洞docstring。

### 6.8 P1：文档状态发生漂移

证据：

1. `概念空间/Chat/Workflow.md`仍把“活动流游标重连”列为未来交付，但Runtime Event Cursor纵向切片已经实现。
2. `session-capability-catalog.md`末尾仍写“当前仍不兑现R2-R6；活动流重连、Worker接管、Workflow Checkpoint和跨重启HITL仍必须验收”，没有区分已完成纵向切片与完整阶段验收。
3. 研究文档保留历史快照是合理的，但“当前状态”文档若不自动检查就容易被误读。

影响：设计者可能重复实现已有能力，或反向把部分切片误标为完整阶段。

建议：本轮修正2处已确认漂移；Q07增加状态/链接/版本校验。

### 6.9 P1：本地调试可用但不可移植

证据：

1. VS Code后端正确使用项目`.venv`，并有定向端口清理。
2. 前端启动命令硬编码`/Users/xulater/.nvm/versions/node/v24.8.0`和全局npm路径。
3. 没有Outbox Worker、Execution Worker、并发多进程、故障注入和数据库检查的独立调试配置。

影响：换机器或Node版本后，全栈调试入口失效；跨进程问题仍需手工拼命令。

建议：Q01移除绝对路径，Q04增加Worker与故障场景调试入口。

### 6.10 P1：运维、安全和容量尚未形成目标数值

证据：

1. 当前固定本地Principal/Scope，无正式认证和Channel Binding。
2. SQLite只验证了窄并发；没有容量、保留、备份恢复和磁盘故障演练。
3. Provider配置启动时只读，缺版本化发布、热重载和运行绑定快照管理界面。
4. 安全、容量、SLO、数据保留和灾难恢复目标仍待审核。

影响：工程可以本地稳定运行，但不能证明持续运营和多用户安全。

建议：F07-F08在前述质量底座后进入详细设计。

## 7. 参考项目的采用、改造与拒绝

| 来源 | 采用 | 改造 | 不采用 |
|---|---|---|---|
| MAF | Agent/Chat/Function Middleware、Session/Checkpoint分离、包级质量门 | 用产品治理和Product Store包住MAF运行时 | 不把MAF Session或Checkpoint当Product Session |
| pi | 活动Agent与长期Session分离、严格检查和固定依赖 | RPC/pi只作为受治理Tool Runtime | 不用进程内Agent对象拥有跨进程Product Run |
| nanobot | 显式Turn阶段、小型边界、覆盖率门 | 将状态阶段映射到耐久Job/Trace | 不用内存Bus承担持久Run |
| QwenPaw | Feature模块、Hook、Tool治理、测试分级、备份/可观测入口 | 用于本项目Worker/Channel/治理的产品化表达 | 不复制其工作空间和AgentScope为本项目事实源 |
| LibreChat | Feature目录、共享合同、集中错误、Playwright/a11y、CI | 借鉴Web产品工程方法，保留Python/MAF架构 | 不复制Node/Mongo/Redis和私有SSE |

## 8. 建议的整改顺序

### Gate A：不改变行为的工程收敛

1. Q01：质量门、CI、可移植调试。
2. Q03：统一错误Envelope和响应合同。
3. Q04第一段：关联ID、结构化日志、Readiness和基础指标。
4. Q02：拆`main.py`、治理/Harness Service和Workflow文件。
5. Q05：覆盖率、浏览器E2E和故障注入框架。

Gate A必须保持数据库、Workflow Definition/节点ID、AG-UI事件、Provider Payload和用户界面行为不变。

### Gate B：执行可信闭环

1. F01 Tool Operation Ledger。
2. F02 Evidence/Artifact/Provenance。
3. F03 Runtime完整故障与容量矩阵。

### Gate C：连续协作和外部运营

1. F04-F06完成Session、Workflow和Intent/Harness/Context。
2. F07-F08完成身份、Channel、Delivery、Provider配置、备份、保留和SLO。

## 9. 本轮审计后的明确判断

1. **需要优化架构**：是，而且应在Tool/Evidence大规模实现前完成最小无行为收敛。
2. **代码质量已经产品级吗**：领域语义接近，自动工程门和模块维护性尚未达到。
3. **文档是否做好**：总体强，但当前事实同步需要自动门，不能继续完全依赖人工。
4. **注释是否做好**：模块说明较好；边界、不变量和私有API升级说明需要补齐，不应追求每个DTO都有空洞注释。
5. **日志是否做好**：没有。当前日志只能辅助局部Worker/Checkpoint诊断，不能支撑全链路运营。
6. **调试手段是否做好**：本地前后端基础可用；跨进程、故障注入、诊断包和可移植性不足。
7. **测试是否做好**：后端场景和恢复测试较强；覆盖率、组件/E2E/a11y、容量与完整故障矩阵不足。
8. **能否继续开发**：可以，但下一步应先通过Gate A，不建议继续把高风险能力直接叠加到当前大文件中。
