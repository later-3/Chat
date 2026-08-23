# Chat 项目状态

> 更新日期：2026-08-24

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | Chat公开仓库`later-3/deepseek-harness-chat`维护固定`DeepSeek Harness Web rc.6`窄派生；当前只维护Trajectory Location/标签/紧凑预览扩展，Chat直接链接`codex/chat-trajectory-location-rc6`源码构建；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`通过DSH公开Slot把原生会话、Composer行内Workflow选择与服务端描述的发送级配置、会话Prompt Region选择/语义预览、独立Agent设置、只读上下文注入、Prompt Studio与人工审核接到Chat公开API；Prompt Composer只管理会话上下文，Workflow配置页展示并编辑“Pi运行基线→不可变Agent Version/Workflow精确绑定→当前DSH Session临时覆盖”，可保存新的Agent Version或个人Workflow Revision；Bridge只做同源合同代理，不拥有Agent/Workflow配置事实；Composer「调试审核」提供独立DSH→Bridge与Bridge→Chat开关，当前Direct Workflow还可按会话配置是否逐次审核Provider提示词；原生侧栏作为唯一会话入口，Bridge首轮只提交Message，Chat Application在同一事务内创建Product Session、标题、Run与Outbox，Bridge仅保存DSH→Chat身份映射；“会话记录”页签和对话头部“Chat Session”弹窗复用同一双源Query，完整展示Chat正式Message与DSH原始事件；实时Pi工具调用与完整Workflow执行树继续进入原生Trajectory |
| 开发工作台 | Beta、可选、当前暂停进入CI/CD；固定`code-server@4.132.0`与DSH全屏Surface实现继续保留，供需要时人工验证Files、Editor、Terminal、Git/Diff与扩展系统 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | `chat-product-store.v19`版本化JSON Adapter；v19只新增固定“Memory 增强执行 Agent”Definition/Revision/View，v18历史事实原样保留并原子迁移。Store继续拥有不可变`AgentVersion`、Provider中立`WorkflowMemoryQuery/Snapshot/Context`及Memory Write事实；Memory Direct Attempt把Context ID/Revision/Hash纳入Direct Input Manifest。用户会话Prompt与兼容Agent Prompt Revision正文仍位于可见Markdown文件；Direct Run以Prompt Assembly v2冻结System、正式Messages、显式能力或`inherit_runtime_default`解析模式和Options，完成Extension绑定后的真实Provider Payload由Prompt Review冻结，实际Runtime Manifest Hash进入Pi Journal；多节点Run继续用v3冻结各节点有效Prompt与同一份会话上下文 |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint；发送级节点配置由Node Catalog字段、Blueprint白名单和具体Definition默认值共同描述并由Compiler冻结。既有`direct@1 / direct-agent.v1`仍是单节点“执行 Agent（逐次提示词审核）”；新增独立`direct@2 / memory-direct.v1`固定执行`memory.query → agent.direct → memory.write`，不修改也不隐式包裹旧Direct。Pi Direct Agent节点可精确绑定`AgentVersion ID + Hash`；系统Definition保存时派生个人已发布版本，个人Definition原子发布下一Revision；当前DSH Session临时差异只进入结构化`agent_configuration`并在每个Run冻结，不写回Agent或Workflow |
| Agent Runtime | Planner复用`pi-agent-core`；完整Executor由独立Pi Coding Executor Service承载真实`AgentSession`、多轮Tool loop、Session与安全Journal，不拥有产品会话或完成事实。Direct默认`pi_cli_default`不追加Chat只读限制、不手写Tools，也不关闭Context/Skill/Prompt Template/Extension；目录投影与真实Run使用同一个受管`agentDir + Settings + ResourceLoader`构造路径，无Root时生成空Workspace全局基线，带受权`workspaceRootId`时由Executor解析真实canonical cwd并读取scoped Settings/Extension/资源。投影不跨请求缓存；Run完成`bindExtensions`后钉住Resolved Manifest Hash，恢复漂移在Provider前失败。只有用户显式派生的Version或专用Workflow才冻结受限Tool/资源策略；Coding Executor仍按已批准Execution Contract隔离能力。Prompt、Tool可见性、调用审批、Workspace授权、预算与产品终态是独立合同，不能互相冒充 |
| Plane CE项目管理 | 可选Plane Community Edition 1.4.1纵向：侧栏专用入口预选Direct Workflow的`project_bootstrap`运行配置，Application据此引用独立项目初始化Agent；Bridge不再向会话Prompt注入Agent身份。显式确认后创建Plane Project/Modules和本地Git Workspace，双侧对账成功才建立Binding并允许进入Workspace/打开Plane。Plane拥有项目管理事实，Chat只拥有会话、确认、外部操作Journal与绑定 |
| Session与执行轨迹 | Chat Session按`Product Session → Message → Run → Node/Attempt → Pi Operation/Session/Turn/Tool`分层组合DSH、Product Store、Workflow与Pi原生记录；独立Run Activity Journal只保存按Run有序、幂等、有界的Agent/模型/工具展示活动。DSH Trajectory按`RUN → DSH → BRIDGE → BACKEND → WORKFLOW → NODE → STEP → AGENT → MODEL/TOOL`投影Product事实、边界摘要与Activity；远端Pi工具不再通过`lifeos_trace`伪造成DSH原生工具事件。Debug Trace完全退出Session/轨迹热路径，默认全部关闭，可用`CHAT_TRACE_MODE`与`CHAT_TRACE_SCOPES`按模块显式开启 |
| Memory | 运行基础与首条产品纵向已交付。统一setup/dev接受显式`off / memorycore / memmy / compare`：`off`不准备工件、不检查Memory端口、不启动Sidecar且API/Workflow Registry严格为空；启用模式才准备固定源码并按production `18960/18970`、debug `19960/19970`及各自数据根启动选中的本地HTTP Sidecar。memmy与Tencent MemoryCore都实现同一Workflow Query/Write/Reconcile Port，API与Workflow在打开Store/恢复Run前冻结同一`CHAT_MEMORY_MODE`。用户显式选择“Memory 增强执行 Agent”后，Query结果先冻结为Context，再作为当前请求前的不可信历史交给同一Pi Direct Agent；`promptReviewMode=manual`时Context正文进入Provider发送前Prompt Review，但正文始终不进入Workflow Checkpoint、Operation Journal或Trace，组合Token预算超限失败关闭；候选成功后才按节点配置写回来源Message。memmy写入为`synchronous`且当前只允许绑定单Principal的Chat专属数据库；本地无模型MemoryCore为`accepted_only`。Chat/Codex Session导入、双Provider评测、Memory Agent与管理表面尚未交付 |
| 调试 | `pnpm dev`用`431xx`与主`.data`启动Pi Executor、Workflow、API、可选Memory Sidecar/code-server与Web Gateway/DSH；VS Code F5/`pnpm dev:debug`用`441xx`、可选`19960/19970`与worktree私有`.data/instances/vscode-debug`启动同一服务图，并为API、Workflow、Pi Executor和DSH Host/LifeOS Bridge开放固定Inspector；Bridge Host/Client使用外置source map，Workflow VM/Step bundle使用带完整源码的内联source map，4个Node调试进程统一启用Source Map并由VS Code映射回TypeScript源码；debug可与LaunchAgent常驻实例并行并固定关闭Workbench，Memory仍须显式选择 |
| PWA | DSH Web可安装PWA：Bridge覆盖manifest/sw.js并注入图标与注册脚本；SW只缓存同源静态外壳，/api//lifeos永不缓存 |
| 移动端布局 | 固定`dsh-mobile-hanui@0.2.4`（MIT）作为DSH profile bundle提供移动端外壳（抽屉/FAB/弹窗全屏/Composer修复）；版本、integrity、上游提交、所有权和人工更新政策进入`config/dsh-plugins.json`，Chat自有Workflow选择、上下文查看和审核控件继续使用DSH公开Slot。合同测试`dsh-mobile-hanui-real.spec.ts` |
| 远程部署 | 拓扑A：Chat常驻Mac（LaunchAgent），云端只做Nginx+Cloudflare网关；公网入口强制版本化scrypt、登录节流与App签名Cookie认证；Workbench不进远程部署。见[远程部署合同](./docs/deployment/remote-pwa-gateway.md) |

## 当前实施顺序

1. DSH已经成为唯一前端，原生对话已通过Session、Message、Plan/HITL、Note Candidate审核、执行、正式结果和刷新恢复合同纵向。
   DSH侧栏统一承载新建、历史切换与原生归档；Product Session仍是独立产品事实。归档仅隐藏DSH入口并保留
   双侧记录，不级联修改Product Session；固定rc.6没有永久删除/恢复归档公开能力，当前不伪造这两项语义。
2. Code Workbench首期纵向已经作为独立Hosted App接入，但当前标记为Beta，不参与通用CI/CD；不复制或拆分code-server UI。
3. “执行 Agent（逐次提示词审核）”单节点纵向已经实现；DSH可选择并配置该Workflow。Provider审核开启时在Pi真实发送前展示原始请求/易读视图与批准/拒绝，关闭时直接发送但仍保留派发与结果未知安全边界；DSH→Bridge和Bridge→Chat两道调试审核也可独立开关。
4. 系统级Prompt与首个Agent管理纵向已经实现：会话上下文正文位于可见的全局/Workspace Markdown；Direct可从真实Pi基线创建不可变Agent Version，Workflow精确绑定Version，当前会话还能结构化临时覆盖。Application按`Run临时配置 > Workflow Version > Agent Catalog/Pi Runtime默认`解析并冻结v2/v3 Assembly；默认Pi能力由Executor真实解析，受限版本才冻结显式Tool集合。Project Bootstrap、Coding Executor等尚未逐字段消费完整Version的Agent只读展示真实基线，不提供假保存入口。Prompt Review只有在Workflow节点绑定同一Request Revision/Hash后才对Query和Decision开放。
5. 下一步仍需用户另行授权Provider审核页编辑、Conversation Summary/压缩、用户可命名完整Profile，以及非Direct节点的Provider逐请求审核与来源映射。
6. Plane CE项目初始化纵向已经实现：固定CE工件、受控Agent工具、显式确认、本地Git Workspace、Plane Project/Modules、结果未知对账、DSH进入Workspace与打开Plane；后续日常Work Item/状态推进工具仍需逐项授权和交付。
7. Memory是当前已授权纵向。运行基础和独立Memory Direct Workflow已完成；下一步依次交付受控Chat/Codex Session导入、双Provider对比、Retrieval/Write Agent与DSH管理表面。不得让旧Memory Planning形态限制当前目标。Browser Provider顺延为下一候选纵向。

以上是阶段顺序，不是Agent可自行领取的任务。当前实现只能来自当前对话中用户的明确请求；历史任务书只约束范围，不能替代授权。在授权前允许做只读源码审计和方案收敛，不得先添加依赖、下载PoC工件、调用外部服务或开始编码。

## 当前明确没有

1. 没有第二套自研Chat页面或Agent Canvas运行依赖。
2. 没有把DSH Session当成Chat权威Session。
3. 没有浏览器到Workflow、Hook或pi的直连。
4. 没有多实例生产数据库、完整SSE传输或通用插件市场；当前Run Activity Journal是单机单写者JSONL。
5. 没有把本地code-server包装成多用户远程沙箱；当前Terminal与扩展仍以本机用户权限运行。
6. 当前默认“规划执行工作流”和既有`direct@1`仍不声明Memory节点；只有显式Memory运行模式才准备/启动Sidecar，且只有用户选择独立Memory Workflow才调用Memory。整Session导入、双Provider评测、Memory Agent和管理表面尚未实现，不能因Memory Direct已可运行就宣称完整产品能力已完成。
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
- DSH派生仓库保持Public，`origin/main`与当前维护分支保存派生源码，官方仓库作为只读`upstream`；升级按[DSH前端派生与维护](./docs/architecture/dsh-frontend-maintenance.md)汇合并重跑门。
- Workbench处于Beta，不属于当前通用CI/CD基线门；单独启用、修改或准备发布时，仍须人工运行Files、Terminal、Git/Diff、浏览器Origin、WebSocket和子进程生命周期验证。
