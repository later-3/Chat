# Chat 项目状态

> 更新日期：2026-08-21

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | Chat公开仓库`later-3/deepseek-harness-chat`维护固定`DeepSeek Harness Web rc.6`窄派生；当前只维护Trajectory Location/标签/紧凑预览扩展，Chat直接链接`codex/chat-trajectory-location-rc6`源码构建；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`通过DSH公开Slot把原生会话、Composer行内Workflow选择与服务端描述的发送级配置、会话Prompt Region选择/语义预览、独立Agent设置、只读上下文注入、Prompt Studio与人工审核接到Chat公开API；Prompt Composer只管理会话上下文，Workflow配置页展示并编辑“Agent默认模板→Workflow节点实例→本次Session/Run临时覆盖”三层关系，可保存个人Workflow Revision或提升为Agent默认；Bridge只做同源合同代理，不拥有Agent/Workflow配置事实；Composer「调试审核」提供独立DSH→Bridge与Bridge→Chat开关，当前Direct Workflow还可按会话配置是否逐次审核Provider提示词；原生侧栏作为唯一会话入口，Bridge首轮只提交Message，Chat Application在同一事务内创建Product Session、标题、Run与Outbox，Bridge仅保存DSH→Chat身份映射；“会话记录”页签和对话头部“Chat Session”弹窗复用同一双源Query，完整展示Chat正式Message与DSH原始事件；实时Pi工具调用与完整Workflow执行树继续进入原生Trajectory |
| 开发工作台 | Beta、可选、当前暂停进入CI/CD；固定`code-server@4.132.0`与DSH全屏Surface实现继续保留，供需要时人工验证Files、Editor、Terminal、Git/Diff与扩展系统 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | `chat-product-store.v17`版本化JSON Adapter；用户会话Prompt与Agent Prompt Revision正文位于可见Markdown文件，Store只留版本/Scope/Hash引用；Direct Run冻结Chat交给Pi的System追加层、正式Messages、Capability Tool清单和Options为Prompt Assembly v2，最终Provider Payload由Prompt Review冻结；多节点Run冻结各节点有效Agent Prompt与同一份会话上下文的v3，Planning/Execution Manifest绑定节点Hash；Plane CE纵向只新增项目初始化Candidate、Decision、Operation与Session Binding，不复制Plane项目当前态；Git内置Prompt、Agent定义与共享默认Profile仍由只读Catalog拥有 |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint；发送级节点配置由Node Catalog字段、Blueprint白名单和具体Definition默认值共同描述并由Compiler冻结。Agent节点可持久保存`agentKey`与可选`agentPromptOverride`；系统Definition保存时派生个人已发布版本，个人Definition原子发布下一Revision；Session/Run临时差异只进入Run Configuration。单节点“执行 Agent（逐次提示词审核）”另开放`promptReviewMode` |
| Agent Runtime | Planner复用`pi-agent-core`；完整Executor由独立Pi Coding Executor Service承载真实`AgentSession`、多轮Tool loop、Session与安全Journal，不拥有产品会话或完成事实；Planner、Direct、Project Bootstrap、Coding Executor和Note Extractor各有独立Agent Profile（System Prompt与Tool说明），Workflow节点只引用Agent，执行时采用“锁定Runtime Contract + Agent Profile + 冻结会话上下文”；其中Direct使用Prompt Assembly v2接收System、近期正式历史、当前User、Tools与Options，其他节点从同一Run的v3按节点取Prompt；Direct与Coding Executor明确关闭Pi的Context/Skill/Template/隐式System自动发现；工具、Schema、审批、安全、预算与产品事实边界不可被用户Prompt替换；Chat显式`DASHSCOPE_API_KEY`只注册为Pi进程内runtime override，不进入Prompt/Session/Store；`project_bootstrap`模式引用项目初始化Agent并只开放准备候选的受控工具，不能越过用户确认直接写Plane或Workspace |
| Plane CE项目管理 | 可选Plane Community Edition 1.4.1纵向：侧栏专用入口预选Direct Workflow的`project_bootstrap`运行配置，Application据此引用独立项目初始化Agent；Bridge不再向会话Prompt注入Agent身份。显式确认后创建Plane Project/Modules和本地Git Workspace，双侧对账成功才建立Binding并允许进入Workspace/打开Plane。Plane拥有项目管理事实，Chat只拥有会话、确认、外部操作Journal与绑定 |
| Session与执行轨迹 | Chat Session按`Product Session → Message → Run → Node/Attempt → Pi Operation/Session/Turn/Tool`分层组合DSH、Product Store、Workflow与Pi原生记录；独立Run Activity Journal只保存按Run有序、幂等、有界的Agent/模型/工具展示活动。DSH Trajectory按`RUN → DSH → BRIDGE → BACKEND → WORKFLOW → NODE → STEP → AGENT → MODEL/TOOL`投影Product事实、边界摘要与Activity；远端Pi工具不再通过`lifeos_trace`伪造成DSH原生工具事件。Debug Trace完全退出Session/轨迹热路径，默认全部关闭，可用`CHAT_TRACE_MODE`与`CHAT_TRACE_SCOPES`按模块显式开启 |
| Memory | Workflow Memory v1以独立“Memory 增强规划与执行”Definition交付：只有用户显式选择后才执行`memory.query → memory.write →`规划链，普通默认Simple Planning完全没有Memory节点。首个活动Adapter为Tencent MemoryCore；Chat不实现Memory引擎，也不自动启动第三方服务。Query/Write节点及安全结果进入DSH原生Trajectory |
| 调试 | `pnpm dev`用`431xx`与主`.data`启动Pi Executor、Workflow、API、可选code-server与Web Gateway/DSH；VS Code F5/`pnpm dev:debug`用`441xx`与worktree私有`.data/instances/vscode-debug`启动同一服务图，并为API、Workflow、Pi Executor和DSH Host/LifeOS Bridge开放固定Inspector；Bridge Host/Client使用外置source map，Workflow VM/Step bundle使用带完整源码的内联source map，4个Node调试进程统一启用Source Map并由VS Code映射回TypeScript源码；debug可与LaunchAgent常驻实例并行，且固定关闭Workbench与Memory |
| PWA | DSH Web可安装PWA：Bridge覆盖manifest/sw.js并注入图标与注册脚本；SW只缓存同源静态外壳，/api//lifeos永不缓存 |
| 移动端布局 | 固定`dsh-mobile-hanui@0.2.4`（MIT）作为DSH profile bundle提供移动端外壳（抽屉/FAB/弹窗全屏/Composer修复）；版本、integrity、上游提交、所有权和人工更新政策进入`config/dsh-plugins.json`，Chat自有Workflow选择、上下文查看和审核控件继续使用DSH公开Slot。合同测试`dsh-mobile-hanui-real.spec.ts` |
| 远程部署 | 拓扑A：Chat常驻Mac（LaunchAgent），云端只做Nginx+Cloudflare网关；公网入口强制版本化scrypt、登录节流与App签名Cookie认证；Workbench不进远程部署。见[远程部署合同](./docs/deployment/remote-pwa-gateway.md) |

## 当前实施顺序

1. DSH已经成为唯一前端，原生对话已通过Session、Message、Plan/HITL、Note Candidate审核、执行、正式结果和刷新恢复合同纵向。
   DSH侧栏统一承载新建、历史切换与原生归档；Product Session仍是独立产品事实。归档仅隐藏DSH入口并保留
   双侧记录，不级联修改Product Session；固定rc.6没有永久删除/恢复归档公开能力，当前不伪造这两项语义。
2. Code Workbench首期纵向已经作为独立Hosted App接入，但当前标记为Beta，不参与通用CI/CD；不复制或拆分code-server UI。
3. “执行 Agent（逐次提示词审核）”单节点纵向已经实现；DSH可选择并配置该Workflow。Provider审核开启时在Pi真实发送前展示原始请求/易读视图与批准/拒绝，关闭时直接发送但仍保留派发与结果未知安全边界；DSH→Bridge和Bridge→Chat两道调试审核也可独立开关。
4. 系统级Prompt纵向已经实现：会话上下文正文位于可见的全局/Workspace Markdown，Agent System Prompt通过独立Agent API版本化；Workflow节点实例可继承Agent默认或保存自己的Prompt差异，每次发送还可做Session/Run临时覆盖。Application按`Run > Workflow Node > Agent Default`原子冻结v2/v3 Assembly；共享默认组合与Agent默认定义由Catalog版本化，锁定Runtime Contract不允许Prompt覆盖。Direct的真实两轮付费E2E验证Agent完整覆盖、会话组件Revision/选择、每轮三道审批、正式历史恢复及两次成功Assistant提交；Prompt Review只有在Workflow节点绑定同一Request Revision/Hash后才对Query和Decision开放，消除了决定早于耐久Hook认领的竞态。
5. 下一步仍需用户另行授权Provider审核页编辑、Conversation Summary/压缩、用户可命名完整Profile，以及非Direct节点的Provider逐请求审核与来源映射。
6. Plane CE项目初始化纵向已经实现：固定CE工件、受控Agent工具、显式确认、本地Git Workspace、Plane Project/Modules、结果未知对账、DSH进入Workspace与打开Plane；后续日常Work Item/状态推进工具仍需逐项授权和交付。
7. Browser Provider与长期Memory/Rules路线继续保留，但不是本轮自动授权。

以上是阶段顺序，不是Agent可自行领取的任务。当前实现只能来自当前对话中用户的明确请求；历史任务书只约束范围，不能替代授权。在授权前允许做只读源码审计和方案收敛，不得先添加依赖、下载PoC工件、调用外部服务或开始编码。

## 当前明确没有

1. 没有第二套自研Chat页面或Agent Canvas运行依赖。
2. 没有把DSH Session当成Chat权威Session。
3. 没有浏览器到Workflow、Hook或pi的直连。
4. 没有多实例生产数据库、完整SSE传输或通用插件市场；当前Run Activity Journal是单机单写者JSONL。
5. 没有把本地code-server包装成多用户远程沙箱；当前Terminal与扩展仍以本机用户权限运行。
6. 当前默认选择独立的“规划执行工作流”，其冻结Definition只有规划、审核、执行、验证和提交，根本不声明Memory节点；历史完整上下文Planning Definition继续保留。第三方MemoryCore服务不会被Chat自动启动，未配置Provider时只有显式Memory Workflow安全失败并留下轨迹证据。
7. 没有把静态Workflow Definition节点、Workflow Run ID、Hook Token或Pi Session ID伪装成公开执行轨迹事实。
8. 没有继续在产品工作流目录展示旧“默认规划工作流”和“默认笔记工作流”；其稳定ID和运行代码为历史Run、迁移、兼容调用与证据恢复保留。
9. 没有为本次Plane CE改动运行真实付费模型门；普通Direct Prompt Profile v2固定`read_only`，项目创建Preset只把能力收窄为`project_bootstrap`且只能准备候选，外部创建必须经过产品决定；没有给Agent开放Plane原始REST、任意文件写入或Shell。

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
