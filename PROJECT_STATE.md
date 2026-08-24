# Chat 项目状态

> 更新日期：2026-08-25

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | Chat公开仓库`later-3/deepseek-harness-chat`维护固定`DeepSeek Harness Web rc.6`窄派生；当前只维护Trajectory Location/标签/紧凑预览扩展，Chat直接链接`codex/chat-trajectory-location-rc6`源码构建；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`通过DSH公开Slot把原生会话、Composer行内Workflow选择与服务端描述的发送级配置、会话Prompt Region选择/语义预览、独立Agent设置、只读上下文注入、Prompt Studio与人工审核接到Chat公开API；Prompt Composer只管理会话上下文，Workflow配置页展示“Pi运行基线→不可变Agent Version/Workflow精确绑定→当前DSH Session临时覆盖”，Version、Temporary与Prompt Override互斥。Bridge状态为v16：完整保留v15的当前/新会话Workflow、首轮/既有Session目标、`prepared/outcome_unknown/bound/definitely_uncommitted`和bootstrap lifecycle，只新增同一Tool Decision Command的本地重试投影；Product Intent/Decision仍由Application拥有。Tool Review显示qualified Capability、来源、effect、scope和参数Hash；Prompt批准不自动批准write/bash。Bridge只做同源合同代理，不拥有Agent/Workflow/Tool产品事实 |
| 开发工作台 | Beta、可选、当前暂停进入CI/CD；固定`code-server@4.132.0`与DSH全屏Surface实现继续保留，供需要时人工验证Files、Editor、Terminal、Git/Diff与扩展系统 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | `chat-product-store.v20`版本化JSON Adapter；真实v18→v19→v20保留历史Prompt Assembly v2的bootstrap五工具语义，v4才收窄为prepare-only。高影响Tool使用唯一状态矩阵：reject不可能授权，Run终结时waiting/approved→`not_executed`、dispatching→`outcome_unknown`，completed/failed精确绑定唯一Pi Journal Result。Agent Profile当前v3、Agent Version当前v2；Profile v2/Version v1严格只读，新Version显式冻结qualified refs且允许零Tool |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint；发送级节点配置由Node Catalog字段、Blueprint白名单和具体Definition默认值共同描述并由Compiler冻结。Pi Direct Agent节点可精确绑定`AgentVersion ID + Hash`；系统Definition保存时派生个人已发布版本，个人Definition原子发布下一Revision；当前DSH Session临时差异只进入结构化`agent_configuration`并在每个Run冻结，不写回Agent或Workflow。单节点“执行 Agent（逐次提示词审核）”另开放`promptReviewMode`。API通用终态监督器对所有已确认Product Workflow读取脱敏Runtime状态：active不操作并清除连续未知标记，failed/cancelled按产品语义收敛，Runtime成功但缺Product Commit或连续unknown超出耐久宽限期一律`outcome_unknown`；首次unknown不使用旧Start时间直接结算。每条acknowledged意图独立监督，单条事务失败不阻断后续；终态Run与活动Node原子收敛，未知状态只进入外部执行节点，Note终态Candidate不再公开审核动作；稳定命令、同一Start Binding且绝不启动第二个Workflow |
| Agent Runtime | Planner复用`pi-agent-core`；完整Executor由独立Pi Coding Executor Service承载真实`AgentSession`、多轮Tool loop、Session与安全Journal，不拥有产品会话或完成事实。Direct Store v2与通用`pi-executor-operation-store.v2/full-operation.v3`分别拥有共享完整Journal Validator；新代际删除身份、settled、visible hash或Capability均不能降级。Runtime Manifest Hash和首次绑定比较完整Canonical Capability Snapshot。Planning Evidence只由真实Journal派生，Application经窄Runtime Receipt Port复核。Project bootstrap首轮只启用受管prepare能力，真实来源导航到`project-bootstrap-tool.ts`，不获得Generic Tool Decision |
| Runtime完整性诊断 | `pnpm debug:runtime-integrity-scan`只读组合Product Snapshot、已确认Start Outbox与Runtime安全状态；扫描器无Store写端口，不输出Runtime ID、正文、Prompt或Provider数据。单次unknown或未超过耐久连续未知宽限只建议检查分发，只有超期标记才建议结算；Start Outbox引用缺失Product Run会显式报告。2026-08-23对主实例扫描了29组历史关系：尚未重启的旧Runtime API把唯一活动候选安全投影为unknown，随后只读核对既有Runtime元数据确认其实际已failed而Product仍pending；本任务未修改真实`.data`，等待单独人工修复授权 |
| Plane CE项目管理 | 可选Plane Community Edition 1.4.1纵向：专用入口冻结目标Workspace并使用DSH返回的精确Session ID预选系统Direct的显式单轮`project_bootstrap`；普通Message和普通Definition默认值不能授权该能力。Message/Candidate/Confirm/Reject/Retry Receipt均在Catalog、Runtime、Provider或Preflight前恢复；普通入口消费专用Receipt只保留既有Session的v12/v13历史恢复，专用入口拒绝普通Receipt，legacy缺RunSpec引用只允许普通existing-session严格恢复。当前Bridge v16完整保留v15的提交状态机：旧Request仅按是否已有`productRunId`迁为`bound/outcome_unknown`；新请求从`prepared`写前提升为`outcome_unknown`，2xx先验证Session/Message/Run跨对象身份再原子绑定。v16只叠加Tool Decision本地重试投影，不改变Bootstrap所有权。另一条消息由State Store串行门在任何Chat Query/Command及状态改写前阻止；transport、5xx和2xx合同损坏保持unknown，确定未提交的4xx才释放后续。Provider移除后仍可拒绝Candidate；确认原子创建Decision、queued Operation与pending Outbox，后台Dispatcher独立于浏览器执行并先对账，双侧完成后才建立Binding。Plane拥有项目事实；Product Store拥有Product Session↔Project/Workspace Binding，Bridge只拥有DSH Session↔Product Session映射 |
| Session与执行轨迹 | Chat Session按`Product Session → Message → Run → Node/Attempt → Pi Operation/Session/Turn/Tool`分层组合DSH、Product Store、Workflow与Pi原生记录；Run Activity每次启动幂等扫描Operation/source sequence，耐久sourceKey补齐“Journal已写、Activity未写”窗口并拒绝同key不同payload。DSH Trajectory按`RUN → DSH → BRIDGE → BACKEND → WORKFLOW → NODE → STEP → AGENT → MODEL/TOOL`投影Product事实、边界摘要与Activity；投影失败不回滚或重执行Provider/Tool |
| Memory | 当前暂停。历史Product Store合同、迁移、Adapter、独立Workflow与确定性测试为旧事实读取和后续重新接入保留；统一启动固定不准备、不启动第三方服务，也没有可用Provider。普通Workflow不含Memory节点，显式触达历史Memory Workflow会在Provider边界安全失败 |
| 调试 | `pnpm dev`用`431xx`与主`.data`启动Pi Executor、Workflow、API、可选code-server与Web Gateway/DSH；VS Code F5/`pnpm dev:debug`用`441xx`与worktree私有`.data/instances/vscode-debug`启动同一服务图，并为API、Workflow、Pi Executor和DSH Host/LifeOS Bridge开放固定Inspector；Bridge Host/Client使用外置source map，Workflow VM/Step bundle使用带完整源码的内联source map，4个Node调试进程统一启用Source Map并由VS Code映射回TypeScript源码；debug可与LaunchAgent常驻实例并行，且固定关闭Workbench与Memory |
| PWA | DSH Web可安装PWA：Bridge覆盖manifest/sw.js并注入图标与注册脚本；SW只缓存同源静态外壳，/api//lifeos永不缓存 |
| 移动端布局 | 固定`dsh-mobile-hanui@0.2.4`（MIT）作为DSH profile bundle提供移动端外壳（抽屉/FAB/弹窗全屏/Composer修复）；版本、integrity、上游提交、所有权和人工更新政策进入`config/dsh-plugins.json`，Chat自有Workflow选择、上下文查看和审核控件继续使用DSH公开Slot。合同测试`dsh-mobile-hanui-real.spec.ts` |
| 工程基线 | Pi/DSH受管源码由`config/managed-sources.json`冻结来源、commit、构建输入、许可证、marker和4个精确链接；正式测试按core/contract/integration/compat/beta/browser/paid/external唯一分类，普通核心门统一去凭据并在默认Node Heap分批运行；唯一Playwright Harness把18项非付费Chromium场景纳入browser lane；[0–15分钟接手](./docs/getting-started/quick-context.md)与14个Workspace README提供责任导航；106条公开HTTP、340个公共Schema、package exports、Problem Code与代际由真实组合根生成baseline并执行统一compat diff；3个轻量ADR记录Managed Fork、测试隔离和API兼容决定；最低供应链门检查三仓锁、Action SHA、secret、production license、lifecycle与三仓audit |
| 远程部署 | 拓扑A：Chat常驻Mac（LaunchAgent），云端只做Nginx+Cloudflare网关；公网入口强制版本化scrypt、登录节流与App签名Cookie认证；Workbench不进远程部署。见[远程部署合同](./docs/deployment/remote-pwa-gateway.md) |

## 当前实施顺序

1. DSH已经成为唯一前端，原生对话已通过Session、Message、Plan/HITL、Note Candidate审核、执行、正式结果和刷新恢复合同纵向。
   DSH侧栏统一承载新建、历史切换与原生归档；Product Session仍是独立产品事实。归档仅隐藏DSH入口并保留
   双侧记录，不级联修改Product Session；固定rc.6没有永久删除/恢复归档公开能力，当前不伪造这两项语义。
2. Code Workbench首期纵向已经作为独立Hosted App接入，但当前标记为Beta，不参与通用CI/CD；不复制或拆分code-server UI。
3. “执行 Agent（逐次提示词审核）”单节点纵向已经实现；DSH可选择并配置该Workflow。Provider审核开启时在Pi真实发送前展示原始请求/易读视图与批准/拒绝，关闭时直接发送但仍保留派发与结果未知安全边界；DSH→Bridge和Bridge→Chat两道调试审核也可独立开关。
4. 系统级Prompt与首个Agent管理纵向已经实现：会话上下文正文位于可见的全局/Workspace Markdown；Direct可从真实Pi基线创建不可变Agent Version，Workflow精确绑定Version，当前会话还能结构化临时覆盖。Application先把本次Run明确选择为“完整Version / 结构化Temporary / 无版本默认”中的唯一来源，再为Direct冻结v4 Assembly、为多节点Workflow冻结v3 Assembly；普通`node_config`不能替换Version Prompt，默认Pi能力由Executor真实解析，受限版本冻结显式qualified Capability Ref。Project Bootstrap、Coding Executor等尚未逐字段消费完整Version的Agent只读展示真实基线，不提供假保存入口。Prompt Review只有在Workflow节点绑定同一Request Revision/Hash后才对Query和Decision开放。
5. 下一步仍需用户另行授权Provider审核页编辑、Conversation Summary/压缩、用户可命名完整Profile，以及非Direct节点的Provider逐请求审核与来源映射。
6. Plane CE项目初始化纵向已经实现：固定CE工件、受控Agent工具、显式确认、本地Git Workspace、Plane Project/Modules、结果未知对账、DSH进入Workspace与打开Plane；后续日常Work Item/状态推进工具仍需逐项授权和交付。
7. Browser Provider是下一候选纵向；Memory及其他长期能力暂停，后续必须从新的用户场景、Provider选择与明确授权重新开始。

以上是阶段顺序，不是Agent可自行领取的任务。当前实现只能来自当前对话中用户的明确请求；历史任务书只约束范围，不能替代授权。在授权前允许做只读源码审计和方案收敛，不得先添加依赖、下载PoC工件、调用外部服务或开始编码。

## 当前明确没有

1. 没有第二套自研Chat页面或Agent Canvas运行依赖。
2. 没有把DSH Session当成Chat权威Session。
3. 没有浏览器到Workflow、Hook或pi的直连。
4. 没有多实例生产数据库、完整SSE传输或通用插件市场；当前Run Activity Journal是单机单写者JSONL。
5. 没有把本地code-server包装成多用户远程沙箱；当前Terminal与扩展仍以本机用户权限运行。
6. 当前默认“规划执行工作流”不声明Memory节点；第三方Memory服务不会被Chat准备或启动，Memory能力不属于当前产品完成门。
7. 没有把静态Workflow Definition节点、Workflow Run ID、Hook Token或Pi Session ID伪装成公开执行轨迹事实。
8. 没有继续在产品工作流目录展示旧“默认规划工作流”和“默认笔记工作流”；其稳定ID和运行代码为历史Run、迁移、兼容调用与证据恢复保留。
9. 没有为本次Agent管理与Plane CE改动运行真实付费模型门；普通Direct默认继承Pi CLI真实编码能力，项目创建Preset显式收窄为`project_bootstrap`且只能准备候选，外部创建必须经过产品决定；DSH Tool/Skill/Plugin尚未接成Pi可执行能力，页面不得把目录可见性冒充执行能力。

## 当前仓库基线门

- 固定DSH版本与完整许可证/版本证据进入仓库。
- 全仓build、typecheck、test、lint和依赖审计通过。
- 真实DSH Host启动，原生界面不是临时Adapter页。
- 浏览器真实完成发送、Plan/HITL、Note审核、执行结果与刷新恢复。
- 三类Prompt审核已改为右侧全高单滚动审查面；Agent设置能从受管Pi Fork的真实AgentSession预览Pi Coding Agent动态System、Chat追加层和Capability对应Tool Schema，不再把Chat追加Prompt冒充完整Pi Agent配置。
- 浏览器在DSH原生Trajectory真实展开唯一Workflow主线及其Pi子过程；Vercel Runtime证据不混入该表面，默认Run因Definition不含Memory而没有任何Memory轨迹，不靠前端过滤。
- 浏览器可从同一DSH会话切换到“会话记录”，分页查看未裁剪的Chat正式Message与DSH原始事件；刷新或重开
  未归档历史会话后仍恢复同一Product Session并可继续发送，空白草稿不得提前创建Product Session。
- `pnpm test:browser:project-bootstrap`以真实DSH Host/Client和确定性Provider验证首轮真实
  Router/Application形成Session/Run/Candidate绑定、单Command确认、关页后Outbox继续、重开仍见ready目标
  以及下一轮恢复普通Workflow；该门不伪造Message/Run Query，也不启动真实Plane或付费模型。
- DSH派生仓库保持Public，`origin/main`与当前维护分支保存派生源码，官方仓库作为只读`upstream`；升级按[DSH前端派生与维护](./docs/architecture/dsh-frontend-maintenance.md)汇合并重跑门。
- Workbench处于Beta，不属于当前通用CI/CD基线门；单独启用、修改或准备发布时，仍须人工运行Files、Terminal、Git/Diff、浏览器Origin、WebSocket和子进程生命周期验证。
- `pnpm test:browser`在唯一Harness中连续运行PWA/Mobile 7、Planning Faux 1、Prompt Studio 5、Trajectory 1、Project Bootstrap 1和Capability Governance 3；Provider只使用进程内Faux，普通CI不加载Memory、Workbench、Provider凭据或外部写。
- `pnpm api-surface:check`从真实API组合根、`@chat/contracts/public`和workspace manifest生成公共面；
  `pnpm compatibility:check`、`pnpm adr:check`与`pnpm supply-chain:check`分别固定兼容、决定记录与最低供应链政策。
