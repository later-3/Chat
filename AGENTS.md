# Chat 项目协作规则

## 1. 产品身份

Chat 是独立开发、独立运行、独立运营并持续演进的完整产品。它以对话为入口，自己承担工作推进、耐久执行、人工审核、知识沉淀、证据、交付和治理责任。

不得把 Chat 缩小为聊天页面、Agent 外壳、Workflow Demo 或外部系统的适配器。

## 2. 当前阶段

Chat的产品后端、Workflow与Agent Runtime基线已经冻结。唯一产品前端是Chat公开派生仓库维护的固定DeepSeek Harness Web窄派生，由本仓库维护的LifeOS桥接插件接入Chat公开Query/Command；仓库不再维护第二套自研Chat页面，也不包含Agent Canvas/OpenHands前端。插件优先但不是绝对限制：公开扩展点无法表达必要的原生宿主语义时，经源码证据和用户确认可以在单独公开DSH派生分支做最小通用扩展，Chat直接链接该受管分支的源码构建并在启动前执行漂移门。

DSH前端切换与Code Workbench已经完成。当前阶段优先处理Browser Provider；Memory及其他长期能力暂停，只有新的用户场景和明确授权出现后才重新启动。阶段顺序和历史任务书都不是实现授权，Agent只能依据当前对话中用户的明确请求开工。任务书只约束已授权任务的范围和完成门。

每个实现任务默认使用独立worktree和`codex/`分支。本地分支是默认交付单元；push、PR、部署和其他外部副作用仅在用户明确授权后执行。验证按风险选择：确定性合同测试是每个任务的基础；用户可见纵向使用真实服务和浏览器E2E；只有Provider/模型接入任务或用户明确要求时才运行显式的真实模型付费门。

当前事实以[PROJECT_STATE.md](./PROJECT_STATE.md)为准，技术边界以[技术合同](./docs/architecture/technology-contract.md)为准。
全新克隆、工具链、配置和统一启动以[本地安装指南](./docs/getting-started/local-install.md)为准；
不得继续引用历史`apps/web`、个人绝对路径或额外手工克隆上游仓库的安装方式。

### 2.1 Pi与DSH受管Fork（所有Agent必读）

Chat当前开发阶段直接集成Later维护的Fork分支，不再对Pi或DSH发布包维护下游`pnpm patch`：

- Pi Fork：<https://github.com/later-3/pi>，稳定集成分支`codex/later-custom`，官方只读上游<https://github.com/earendil-works/pi>；本机受管checkout为Chat同级目录`../opc-os/pi`。
- DSH Fork：<https://github.com/later-3/deepseek-harness-chat>，稳定集成分支`codex/chat-trajectory-location-rc6`，官方只读上游<https://github.com/deepseek-ai/deepseek-harness>；本机受管checkout为Chat同级目录`../deepseek-harness-chat-trajectory`。

Chat的`packages/pi-runtime`和`packages/dsh-lifeos-bridge`必须直接链接上述稳定分支的源码构建。修改Pi或DSH时，在对应Fork建立独立功能worktree和分支，提交源码与测试，通过Fork自己的质量门后合入稳定集成分支并重新构建；Chat业务对象、Decision、Workflow和UI不得写入Fork。每次启动与测试必须验证实际解析路径、Fork origin、分支和通用能力标记，缺失时失败关闭。不得重新添加等价Pi/DSH package patch、依赖官方包掩盖Fork缺失，或让未提交的Fork工作树成为运行来源。

### 2.2 项目管理知识路由

项目管理、Content Lab、AI学习或多Agent协作先读取[全项目生命周期蓝图](./docs/product/project-management-system-blueprint.md)、[K1合同](./docs/architecture/project-management-k1-contracts-as-built.md)、[K2 Store](./docs/architecture/project-management-k2-store-as-built.md)、[K2 Application](./docs/architecture/project-management-k2-application-as-built.md)、[Agent开工包](./docs/architecture/project-agent-coordination-as-built.md)和[DSH四视图](./docs/architecture/project-management-dsh-as-built.md)。Project、Profile/Configuration、Work、Decision、Evidence、Event和Agent Context由Chat拥有；外部事项系统、目录、Git仓库、DSH Session和Agent Session都不是第二事实源。

Plane已退出默认运行图、Prompt/Agent/Workflow目录、普通Opening Packet和DSH导航。历史Store事实、旧Run恢复代码及专项Provider研究可以保留；只有用户明确授权的专项任务才允许设置`CHAT_PLANE_ENABLED=1`，且不得把专项启用扩展为正式数据迁移或外部写授权。

## 3. 开发边界：核心自研、能力复用

Chat的核心是“产品责任”，不是“代码量必须最大”。整个系统可以很大，但Chat自研代码应集中在最小、最关键的产品差异上；文件、编辑器、Terminal、Git、Browser、Memory、前端宿主等成熟能力默认复用高质量上游。

### 3.1 Chat必须自研的核心

1. **产品内核**：Contracts、Domain、Application、Product Store事实、权限、版本、幂等、Decision、Evidence和Product Commit。
2. **Workflow编排**：Chat的步骤、产品级暂停/恢复命令、Binding、Outbox、对账与终态政策，以及规划—审核—执行—验证—提交链路；Checkpoint、重放和Worker恢复机制仍由Vercel Workflow拥有。
3. **规划层与执行层**：Planner/Executor属于Workflow内的Chat业务节点。Chat自研Prompt、上下文组装、Tool白名单、Candidate Schema、验证和事实提交；Planner底层loop复用`pi-agent-core`/`pi-ai`，完整Executor通过Chat私有Operation Port复用独立`pi-coding-agent AgentSession`服务。
4. **产品后端**：公开Query/Command、认证上下文、事务、Outbox、Runtime绑定与收敛政策、Trace和对账语义。
5. **窄集成面**：为上述产品责任编写必要的Port、Provider、Adapter、Gateway和投影，但不在其中复制上游产品。

### 3.2 默认从高质量上游复用的能力

- 主前端、会话与插件宿主：DeepSeek Harness。
- Files、Editor、Terminal、Git/Diff与扩展系统：code-server/Code OSS。
- Agent loop与通用模型调用：`pi-agent-core`/`pi-ai`。
- Memory引擎：memmy、Tencent MemoryCore等；Chat只拥有选择、采用、来源、对账和产品事实。
- Browser、Calendar、Obsidian/VS Code生态等后续能力：先寻找可持续维护的Provider、Service或插件宿主，不默认自研。

复用形式可以是固定依赖、Hosted App、Sidecar、远程Service、REST/WebSocket/SSE/MCP Provider或DSH公开Slot插件。**不要把所有能力强行塞进DSH插件层**；前端表面、Host能力和产品事实可以分属不同组件。

### 3.3 最小适配原则

1. 优先使用上游公开API、Slot、插件、协议和进程边界；默认不拆源码、不复制UI、不改造成仓库内Fork。若公开扩展点不能表达必要的原生宿主语义，只有在源码证据、窄差异、退出路径与用户授权齐全时，才允许在独立公开派生仓库维护通用宿主扩展；不得把派生源码复制进Chat仓库。
2. Adapter只做身份/namespace映射、外部Credential与资源Scope、Principal传递、生命周期、协议转换、严格校验、失败归一、产品投影和升级隔离；产品对象访问权与高影响动作授权只能由Application决定。Adapter不重写上游已成熟的业务实现，也不编排产品用例、直接写Product Store或拥有产品终态。
   “最小”指最小上游修改面和最窄稳定边界，不是最少代码。每个边界逐项记录适用的鉴权、运行时校验、生命周期、审计和合同测试；外部写副作用必须有幂等、`outcome_unknown`和对账，持久格式变化必须有迁移，只读Adapter不制造无意义的写入语义。
3. 上游暂时不用的功能可以禁用或不挂载，只要不绕过Chat产品边界；不为了“代码看起来少”去拆除上游内部模块。
4. 上游必须固定版本/工件、记录许可证和来源，拥有升级合同测试和可退出的Provider/Adapter边界。
5. 代码总量不等于改造成本。评估时分开生产代码、测试/资产、实际需要的模块、稳定接缝、文档、升级成本和故障边界。

### 3.4 新能力的强制决策顺序

1. 先用普通话写清用户结果、高风险动作和恢复场景。
2. 判断它是Chat核心产品责任，还是可替换的通用能力。
3. 若是通用能力，先审核真实上游源码/工件：覆盖范围、维护活性、许可证、安全、文档、接缝、测试和退出路径。
4. 在实现前明确写出“直接使用 / 窄Adapter / 明确拒绝 / Chat自研”的结论和证据。
5. 候选能力或接缝存在实质不确定性时，先取得用户对PoC范围、临时代码/下载和外部调用的明确授权，再做不Fork上游的最小真实PoC；已固定且合同充分的低风险Package不重复做仪式性PoC。
6. 只有证明没有可用的高质量上游或稳定接缝，并得到用户确认后，才能从零开发非核心能力。

### 3.5 明确禁止

- 不得再写一套Chat前端、文件树、编辑器、Terminal、Git Diff、Browser或Memory引擎，只因为自研看起来更易定制。
- 不得引入与Product Store、Application、Workflow或pi责任重复的第二套控制面。
- 不得把DSH Session、code-server Workspace、外部Memory ID或Provider Session当成Chat产品事实。
- 不得为了统一视觉而给完整上游应用大规模换皮；先保留能力和升级路径，只在Chat自有表面上使用Chat交互规则。
- 不得用“先抄过来再说”代替依赖、协议、许可证、权限和升级审核。
- 不得只凭Star、README、功能数量或“少写代码”批准依赖，也不得为一个小能力引入无法隔离的整套平台。
- 不得为未来阶段提前安装依赖；研究证据通过并获得当前纵向授权后才进入生产依赖。

## 4. 上下文恢复顺序

新Session、接手现有任务或用户说“继续Chat项目”时，按顺序读取：

1. `AGENTS.md`
2. `docs/getting-started/quick-context.md`
3. `PROJECT_LESSONS.md`
4. `docs/product/concept-space.md`
5. `PROJECT_CONTEXT.md`
6. `PROJECT_STATE.md`
7. `PROJECT_PLAN.md`
8. `docs/product/flywheel.md`
9. `docs/product/design-guidelines.md`
10. 与任务直接相关的`docs/`

随后读取与当前任务直接相关的合同、as-built文档和测试。历史任务书只从Git历史按需读取，不保留在当前树，也不授予实现、下载、外部调用、push或PR权限。同一Session后续回复不机械重复全文。

## 5. Agent开工与交付闭环

1. **确认授权与范围**：把用户当前请求写成用户结果、不做事项、事实所有者和完成门。`PROJECT_PLAN.md`中的“下一阶段”和任何历史任务书都不能替代当前用户授权；范围仍不明确时先停下来报告。
2. **隔离工作区**：从用户指定基线或当前`main`创建独立worktree与`codex/`分支；先检查并保留已有改动。不得直接在用户主checkout叠加实现。
3. **恢复源码事实**：读取任务相关Schema、状态机、Application用例、组合根、测试和as-built文档。源码描述已实现事实，`AGENTS.md`和技术合同描述规范边界；二者冲突时停止并报告，不能让偶然实现静默覆盖冻结合同。
4. **作出复用决策**：非核心能力在编码前完成上游源码/工件审核，明确“直接使用 / Hosted App或Sidecar / 窄Adapter / 明确拒绝 / Chat自研”及退出路径。没有这个结论不得先加依赖或复制源码。
5. **交付最小纵向**：只实现当前用户结果，保持Product Store、Application、Workflow和外部Provider所有权分离；行为变化同步更新合同测试、中文代码导航与唯一as-built事实源。
6. **分层验证并交付**：文档/注释改动至少运行格式、链接或相关架构测试；代码改动先跑受影响包的build、typecheck与test；跨层纵向在交付前运行根级`pnpm build`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`和`pnpm test`；依赖或运行工件变化再运行标准`pnpm audit --prod`，Managed Fork固定点变化还运行`pnpm managed-sources:verify`与Chat接缝测试。用户界面运行适用的真实浏览器E2E；Provider/模型接入才运行显式真实Provider/付费模型门。所有报告都列出实际运行与未运行项，授权push/PR前必须满足CI同等根级门；未经授权不push、不建PR。

## 6. 已冻结架构规则

1. 唯一前端使用Chat维护的固定DeepSeek Harness Web窄派生；`packages/dsh-lifeos-bridge`仍是唯一Chat业务前端集成面。DSH派生只补公开插件合同无法表达的通用宿主能力，不得另建自研Chat壳、把Chat业务写入DSH或复制DSH源码到本仓库。
2. 后端使用 Node.js + TypeScript；Hono只负责HTTP、认证上下文、校验和流式传输，不拥有产品事务。
3. Vercel Workflow负责耐久步骤、暂停、恢复、重放和运行时Checkpoint。
4. Planner使用`pi-agent-core`作为Workflow中的Agent节点；完整Executor由独立Pi Coding Executor Service承载`AgentSession`、Pi Session和Tool Journal。两者都不拥有产品会话、产品运行、审批、记忆或完成事实。
5. 产品资源通过REST Query/Command访问；写命令必须携带幂等身份和预期revision。
6. 当前活动运行由桥接插件通过Chat公开Query恢复；未来SSE仍只能是Chat拥有的事件投影，不能建立第二套产品事实。
7. Product Store拥有权威产品事实；Workflow Store、pi Session、事件Journal和浏览器缓存分别只拥有自己的运行责任。
8. 浏览器不得直接调用Workflow或pi，不得把Workflow Run ID、Hook Token或pi Session ID作为授权或产品身份。
9. HITL决定先经过Chat权限、版本、Hash和幂等校验并提交产品事实，再由后端恢复Workflow Hook。
10. 外部副作用必须有幂等、结果未知、查询对账和人工处置语义；不得把普通异常重试用于未知副作用。

## 7. 模块与依赖

目标代码按以下责任拆分：

```text
apps/dsh-web       固定DSH Web启动、Profile与运行编排
apps/api           Hono协议入口与组合根
apps/pi-executor   私有Pi Coding Executor Service进程入口
packages/dsh-lifeos-bridge DSH Host/Client桥接、HITL投影与Workbench表面
scripts/workbench  固定code-server供应链、生命周期与真实验证
packages/contracts 网络合同与事件类型
packages/domain    产品对象、状态机与不变量
packages/application 用例协调与事务边界
packages/product-store-json 当前JSON Product Store Adapter与迁移
packages/memory-runtime Memory Port的memmy与Tencent MemoryCore Adapter
packages/project-runtime 受权Project/Workspace资源观察Adapter
packages/realtime  当前Trace与Replay；未来Runtime Journal与SSE投影
packages/workflows Vercel Workflow定义与活动
packages/pi-runtime pi适配、AgentSession、Operation Journal与Executor Client
packages/testing   合同、Fixture与测试工具
```

依赖方向必须指向内部：服务端Store、Workflow、Memory和Project Adapter实现Application Port；DSH Bridge只依赖公开Contracts；pi Adapter只依赖稳定运行合同；Application依赖Domain/Port。Domain不能依赖Hono、React、DSH、Vercel Workflow、AG-UI或pi。

## 8. 产品不变量

1. 模型输出只是候选，不自动成为长期事实。
2. 高影响动作执行前必须经过可读、可修订、版本绑定的决定。
3. 前端只显示和提交动作，不拥有权威历史、审批或运行终态。
4. 完整历史是证据，不是每轮默认模型上下文。
5. 失败不能产生假成功、半提交或无记录自动重试。
6. Trace只保存可观察事件和证据，不保存模型隐藏推理。
7. Product Session、Product Run、Run Attempt、Workflow Run、Workflow Checkpoint、pi Runtime Session和Realtime Connection不能合并。

## 9. 工程规则

1. TypeScript开启`strict`，网络边界和外部结果必须运行时校验。
2. Router、DSH Client插件和Workflow Step不直接写产品数据库；Application Coordinator拥有用例事务。
3. 不建立万能Service、Repository-per-table、Service-per-method或无真实替换价值的接口。
4. 日志放在命令入口、状态转换、外部调用、暂停/恢复、对账和失败边界；不得记录密钥、完整Provider Payload或隐藏推理。
5. 修改行为同时更新合同测试、状态机测试和端到端场景。
6. 新依赖必须说明用途、所有权边界、退出方式和许可证。
7. 密钥、数据库、运行事件、构建产物和本地配置不得进入Git。
8. 关键跨层路径、数据结构、身份转换、事务/幂等和结果未知边界必须有解释“是什么、为什么、怎样失败”的中文注释；行为变化同步更新对应as-built交互与调试文档，不能只留在任务书或聊天里。

详细标准见[工程规范](./docs/engineering-standards.md)。

## 10. 源码证据

涉及Pi或DeepSeek Harness能力时，先使用第2.1节登记的Later Fork稳定集成分支及其`AGENTS.md`、类型、测试和示例；Fork checkout是当前本地开发与测试的运行依赖，不得用官方npm包或本地patch替代。官方仓库只作为只读`upstream`和同步来源；维护与汇合规则见`docs/architecture/dsh-frontend-maintenance.md`及`docs/architecture/pi-coding-executor-service.md`。涉及Vercel Workflow、Hono、React和Vite时使用匹配版本官方文档或固定源码，不凭模型记忆猜API。

把开发、调研或复核任务委派给外部Pi Agent时，使用已安装的`pi-delegate` Skill和Chat同级的`../pi-taskd`共享服务；Pi源码仍只负责能力证据。Pi必须先读取受管worktree内的本文件和任务相关项目合同，不能直接写Chat主checkout，其结果必须由当前Codex按Chat完成门验证后才可采用。

参考项目只为真实覆盖范围背书，不决定Chat的产品对象和事实所有权。

## 11. 变更与安全

1. 保留用户已有改动；不重置、不覆盖、不删除任务范围外的数据。
2. 删除、迁移、推送、部署和外部副作用必须在用户授权范围内执行。
3. 私有配置只检查存在性和合同，不读取到回复、文档、日志或Git。
4. 默认中文沟通，先给结论，再给证据和下一步。
