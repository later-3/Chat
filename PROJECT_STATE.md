# Chat 项目状态

> 更新日期：2026-08-23

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | Chat公开仓库`later-3/deepseek-harness-chat`维护固定`DeepSeek Harness Web rc.6`窄派生；当前只维护Trajectory Location/标签/紧凑预览扩展，Chat直接链接`codex/chat-trajectory-location-rc6`源码构建；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`通过DSH公开Slot把原生会话、Composer行内Workflow选择与服务端描述的发送级配置、会话Prompt Region选择/语义预览、独立Agent设置、只读上下文注入、Prompt Studio与人工审核接到Chat公开API；Prompt Composer只管理会话上下文，Workflow配置页展示并编辑“Pi运行基线→不可变Agent Version/Workflow精确绑定→当前DSH Session临时覆盖”，可保存新的Agent Version或个人Workflow Revision；Bridge只做同源合同代理，不拥有Agent/Workflow配置事实；Composer「调试审核」提供独立DSH→Bridge与Bridge→Chat开关，当前Direct Workflow还可按会话配置是否逐次审核Provider提示词；原生侧栏作为唯一会话入口，Bridge首轮只提交Message，Chat Application在同一事务内创建Product Session、标题、Run与Outbox，Bridge仅保存DSH→Chat身份映射；“会话记录”页签和对话头部“Chat Session”弹窗复用同一双源Query，完整展示Chat正式Message与DSH原始事件；实时Pi工具调用与完整Workflow执行树继续进入原生Trajectory |
| 开发工作台 | Beta、可选、当前暂停进入CI/CD；固定`code-server@4.132.0`与DSH全屏Surface实现继续保留，供需要时人工验证Files、Editor、Terminal、Git/Diff与扩展系统 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | `chat-product-store.v18`版本化JSON Adapter；Store新增不可变`AgentVersion`，冻结Owner、Scope、Pi基线引用、System Prompt、显式Tools、资源策略与Hash；Workflow只绑定Version ID+Hash，旧Revision与旧Run不随新版本变义。用户会话Prompt与兼容Agent Prompt Revision正文仍位于可见Markdown文件；Direct Run保持Prompt Assembly v2 Schema，并由`direct-agent-prompt-compiler.v3`冻结System、正式Messages、显式能力或`inherit_runtime_default`解析模式、Options、scoped Runtime Profile Hash及可选Workspace Grant Hash。Contracts唯一来源分类器由Catalog、Draft/Publish、RunSpec、Assembly、Snapshot Integrity和Operation授权共用，Version、Temporary与普通Prompt Override配置严格互斥；显式本次Run Version/Temporary会完整替换Definition来源，合法Temporary Replace Prompt由Store从RunSpec结构化配置重建。Message Command用Command Type、Principal与规范化原始请求Hash精确匹配Receipt，在时间、全部ID和任何Workflow/Prompt/Catalog/Workspace/Runtime读取前重放；并发迟到者在Store事务内收敛到唯一胜者，rename前写失败不产生Receipt或半事实。完成Extension绑定后的真实Provider Payload由Prompt Review冻结，实际Runtime Manifest Hash进入Pi Journal；多节点Run继续用v3冻结各节点有效Prompt与同一份会话上下文 |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint；发送级节点配置由Node Catalog字段、Blueprint白名单和具体Definition默认值共同描述并由Compiler冻结。Pi Direct Agent节点可精确绑定`AgentVersion ID + Hash`；系统Definition保存时派生个人已发布版本，个人Definition原子发布下一Revision；当前DSH Session临时差异只进入结构化`agent_configuration`并在每个Run冻结，不写回Agent或Workflow。单节点“执行 Agent（逐次提示词审核）”另开放`promptReviewMode`。API通用终态监督器对所有已确认Product Workflow读取脱敏Runtime状态：active不操作并清除连续未知标记，failed/cancelled按产品语义收敛，Runtime成功但缺Product Commit或连续unknown超出耐久宽限期一律`outcome_unknown`；首次unknown不使用旧Start时间直接结算。每条acknowledged意图独立监督，单条事务失败不阻断后续；终态Run与活动Node原子收敛，未知状态只进入外部执行节点，Note终态Candidate不再公开审核动作；稳定命令、同一Start Binding且绝不启动第二个Workflow |
| Agent Runtime | Planner复用`pi-agent-core`；完整Executor由独立Pi Coding Executor Service承载真实`AgentSession`、多轮Tool loop、Session与安全Journal，不拥有产品会话或完成事实。Direct默认`pi_cli_default`不追加Chat只读限制、不手写Tools，也不关闭Context/Skill/Prompt Template/Extension；目录投影与真实Run使用同一个受管`agentDir + Settings + ResourceLoader`构造路径，无Root时生成空Workspace全局基线，带受权`workspaceRootId`时由Executor解析真实canonical cwd并读取scoped Settings/Extension/资源。投影不跨请求缓存；AgentVersion Run在Operation授权时重新读取精确Version/scoped Runtime Profile并比较Run冻结Hash，并以同一编译函数重证Assembly的Tools/Resources/System Prompt/Request Options；唯一来源语义贯穿Catalog、保存发布、RunSpec、Assembly、Store与Operation。Executor再以实际canonical root复核Grant；Run完成`bindExtensions`后钉住Resolved Manifest Hash，恢复漂移在Provider前失败。Planning Tool Intent先耐久追加再更新内存Map，同一Operation重复`toolCallId`会触发不可恢复fatal latch并穿透真实AgentSession；Result从真实Pi事件输入重新计算Hash，与耐久Intent五字段精确匹配且只有耐久追加后才闭合。新Operation标记`full-operation.v2`；Store持久化/启动和Executor Client复用同一五状态Journal Validator，验证全部Operation/Session/Turn/Provider/Tool身份、Hash、顺序、时间与唯一终态，Candidate正文还绑定确定性Contract投影和Assistant证据。旧v1缺失新证据可只读兼容但身份门不降级；矛盾记录不能启动或返回Candidate。终态复核或重启发现开放Intent均幂等收敛为Operation `outcome_unknown`，所有终态单调且迟到complete/fail不能改写。只有用户显式派生的Version或专用Workflow才冻结受限Tool/资源策略；Coding Executor仍按已批准Execution Contract隔离能力。Prompt、Tool可见性、调用审批、Workspace授权、预算与产品终态是独立合同，不能互相冒充 |
| Runtime完整性诊断 | `pnpm debug:runtime-integrity-scan`只读组合Product Snapshot、已确认Start Outbox与Runtime安全状态；扫描器无Store写端口，不输出Runtime ID、正文、Prompt或Provider数据。单次unknown或未超过耐久连续未知宽限只建议检查分发，只有超期标记才建议结算；Start Outbox引用缺失Product Run会显式报告。2026-08-23对主实例扫描了29组历史关系：尚未重启的旧Runtime API把唯一活动候选安全投影为unknown，随后只读核对既有Runtime元数据确认其实际已failed而Product仍pending；本任务未修改真实`.data`，等待单独人工修复授权 |
| Plane CE项目管理 | 可选Plane Community Edition 1.4.1纵向：侧栏专用入口预选Direct Workflow的`project_bootstrap`运行配置，Application据此引用独立项目初始化Agent；Bridge不再向会话Prompt注入Agent身份。显式确认后创建Plane Project/Modules和本地Git Workspace，双侧对账成功才建立Binding并允许进入Workspace/打开Plane。Plane拥有项目管理事实，Chat只拥有会话、确认、外部操作Journal与绑定 |
| Session与执行轨迹 | Chat Session按`Product Session → Message → Run → Node/Attempt → Pi Operation/Session/Turn/Tool`分层组合DSH、Product Store、Workflow与Pi原生记录；独立Run Activity Journal只保存按Run有序、幂等、有界的Agent/模型/工具展示活动。DSH Trajectory按`RUN → DSH → BRIDGE → BACKEND → WORKFLOW → NODE → STEP → AGENT → MODEL/TOOL`投影Product事实、边界摘要与Activity；远端Pi工具不再通过`lifeos_trace`伪造成DSH原生工具事件。Debug Trace完全退出Session/轨迹热路径，默认全部关闭，可用`CHAT_TRACE_MODE`与`CHAT_TRACE_SCOPES`按模块显式开启 |
| Memory | 当前暂停。历史Product Store合同、迁移、Adapter、独立Workflow与确定性测试为旧事实读取和后续重新接入保留；统一启动固定不准备、不启动第三方服务，也没有可用Provider。普通Workflow不含Memory节点，显式触达历史Memory Workflow会在Provider边界安全失败 |
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
4. 系统级Prompt与首个Agent管理纵向已经实现：会话上下文正文位于可见的全局/Workspace Markdown；Direct可从真实Pi基线创建不可变Agent Version，Workflow精确绑定Version，当前会话还能结构化临时覆盖。Application先把本次Run明确选择为“完整Version / 结构化Temporary / 无版本默认”中的唯一来源，再冻结v2/v3 Assembly；普通`node_config`不能替换Version Prompt，默认Pi能力由Executor真实解析，受限版本才冻结显式Tool集合。Project Bootstrap、Coding Executor等尚未逐字段消费完整Version的Agent只读展示真实基线，不提供假保存入口。Prompt Review只有在Workflow节点绑定同一Request Revision/Hash后才对Query和Decision开放。
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
- DSH派生仓库保持Public，`origin/main`与当前维护分支保存派生源码，官方仓库作为只读`upstream`；升级按[DSH前端派生与维护](./docs/architecture/dsh-frontend-maintenance.md)汇合并重跑门。
- Workbench处于Beta，不属于当前通用CI/CD基线门；单独启用、修改或准备发布时，仍须人工运行Files、Terminal、Git/Diff、浏览器Origin、WebSocket和子进程生命周期验证。
