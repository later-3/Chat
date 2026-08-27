# Chat 项目状态

> 更新日期：2026-08-27

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | Chat公开仓库`later-3/deepseek-harness-chat`维护固定`DeepSeek Harness Web rc.6`窄派生；当前只维护Trajectory Location/标签/紧凑预览扩展，Chat直接链接`codex/chat-trajectory-location-rc6`源码构建；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`通过DSH公开Slot把原生会话、Composer行内Workflow选择与服务端描述的发送级配置、会话Prompt Region选择/语义预览、独立Agent设置、只读上下文注入、Prompt Studio与人工审核接到Chat公开API；Prompt Composer只管理会话上下文，Workflow配置页展示“Pi运行基线→不可变Agent Version/Workflow精确绑定→当前DSH Session临时覆盖”，Version、Temporary与Prompt Override互斥。Bridge状态为v16：完整保留v15的当前/新会话Workflow、首轮/既有Session目标、`prepared/outcome_unknown/bound/definitely_uncommitted`和bootstrap lifecycle，只新增同一Tool Decision Command的本地重试投影；Product Intent/Decision仍由Application拥有。Tool Review显示qualified Capability、来源、effect、scope和参数Hash；Prompt批准不自动批准write/bash。Bridge只做同源合同代理，不拥有Agent/Workflow/Tool产品事实 |
| 开发工作台 | Beta、可选、当前暂停进入CI/CD；固定`code-server@4.132.0`与DSH全屏Surface实现继续保留，供需要时人工验证Files、Editor、Terminal、Git/Diff与扩展系统 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | 当前写代为`chat-product-store.v27`，不再包含Project实体集合。旧v10–v26快照经单一兼容入口保留仍属于Chat的Session、Message、Run、Workflow、Prompt、Rule与Memory事实，并删除退出产品的Project事实；v1–v9需先在备用分支升级到v10。仍绑定已退役能力且无法可信重签的历史执行证据会失败关闭，并给出备用分支导出/归档动作。Application继续重验确定性Validation、Evidence、Prompt与独立治理Attempt。监督基础见[监督执行v24基础](./docs/architecture/supervised-execution-v24-foundation-as-built.md)，治理事实见[Capability治理](./docs/architecture/capability-governance-as-built.md) |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint；发送级节点配置由Node Catalog字段、Blueprint白名单和具体Definition默认值共同描述并由Compiler冻结。Pi Direct Agent节点可精确绑定`AgentVersion ID + Hash`；系统Definition保存时派生个人已发布版本，个人Definition原子发布下一Revision；当前DSH Session临时差异只进入结构化`agent_configuration`并在每个Run冻结，不写回Agent或Workflow。单节点“执行 Agent（逐次提示词审核）”另开放`promptReviewMode`。API通用终态监督器对所有已确认Product Workflow读取脱敏Runtime状态：active不操作并清除连续未知标记，failed/cancelled按产品语义收敛，Runtime成功但缺Product Commit或连续unknown超出耐久宽限期一律`outcome_unknown`；首次unknown不使用旧Start时间直接结算。每条acknowledged意图独立监督，单条事务失败不阻断后续；终态Run与活动Node原子收敛，未知状态只进入外部执行节点，Note终态Candidate不再公开审核动作；稳定命令、同一Start Binding且绝不启动第二个Workflow |
| Agent Runtime | Planner复用`pi-agent-core`；完整Executor由独立Pi Coding Executor Service承载真实`AgentSession`、多轮Tool loop、Session与安全Journal，不拥有产品会话或完成事实。Direct Store v2与通用`pi-executor-operation-store.v2/full-operation.v3`分别拥有共享完整Journal Validator；新代际删除身份、settled、visible hash或Capability均不能降级。Runtime Manifest Hash和首次绑定比较完整Canonical Capability Snapshot。Planning Evidence只由真实Journal派生，Application经窄Runtime Receipt Port复核。 |
| Runtime完整性诊断 | `pnpm debug:runtime-integrity-scan`只读组合Product Snapshot、已确认Start Outbox与Runtime安全状态；扫描器无Store写端口，不输出Runtime ID、正文、Prompt或Provider数据。单次unknown或未超过耐久连续未知宽限只建议检查分发，只有超期标记才建议结算；Start Outbox引用缺失Product Run会显式报告。2026-08-27退役Project纵向时先把原始Store v19/335与一次错误迁移产生的v27/325分别备份到仓库外；停服后从原始备份重新迁移并原子替换为v27/335，335条Receipt、25个Session和44条Message均保持，47条Outbox只删除1条已确认的退役事项，完整性门通过 |
| Session与执行轨迹 | Chat Session按`Product Session → Message → Run → Node/Attempt → Pi Operation/Session/Turn/Tool`分层组合DSH、Product Store、Workflow与Pi原生记录；Run Activity每次启动幂等扫描Operation/source sequence，耐久sourceKey补齐“Journal已写、Activity未写”窗口并拒绝同key不同payload。DSH Trajectory按`RUN → DSH → BRIDGE → BACKEND → WORKFLOW → NODE → STEP → AGENT → MODEL/TOOL`投影Product事实、边界摘要与Activity；投影失败不回滚或重执行Provider/Tool |
| Memory | Memory Agent基线已接入：显式Workflow覆盖Memory增强执行、检索Agent、写入候选Agent、只查询和只整理；检索/整理模型只能提交证据绑定结果或候选，外部写仍需人工Decision并经Outbox、`outcome_unknown`与对账闭环。默认`CHAT_MEMORY_MODE=off`，普通启动不装配Provider、不读取凭据、不启动第三方服务；真实Provider部署仍需显式配置 |
| 调试 | `pnpm dev`用`431xx`与主`.data`启动Pi Executor、Workflow、API、可选code-server与Web Gateway/DSH；VS Code F5/`pnpm dev:debug`用`441xx`与worktree私有`.data/instances/vscode-debug`启动同一服务图，并为API、Workflow、Pi Executor和DSH Host/LifeOS Bridge开放固定Inspector；Bridge Host/Client使用外置source map，Workflow VM/Step bundle使用带完整源码的内联source map，4个Node调试进程统一启用Source Map并由VS Code映射回TypeScript源码；debug可与LaunchAgent常驻实例并行，且固定关闭Workbench与Memory |
| PWA | DSH Web可安装PWA：Bridge覆盖manifest/sw.js并注入图标与注册脚本；SW只缓存同源静态外壳，/api//lifeos永不缓存 |
| 移动端布局 | 固定`dsh-mobile-hanui@0.2.4`（MIT）作为DSH profile bundle提供移动端外壳（抽屉/FAB/弹窗全屏/Composer修复）；版本、integrity、上游提交、所有权和人工更新政策进入`config/dsh-plugins.json`，Chat自有Workflow选择、上下文查看和审核控件继续使用DSH公开Slot。合同测试`dsh-mobile-hanui-real.spec.ts` |
| 工程基线 | Pi/DSH受管源码由`config/managed-sources.json`冻结来源、commit、构建输入、marker和4个精确链接；两个Fork分别运行自己的CI，Chat普通PR/main只运行一个稳定`ci` Job并只准备一次固定源码，随后执行根build/lint/format/typecheck/test、Capability Governance系统接缝及安装后启动/健康/停止。完整Browser与标准生产依赖Audit属于定时/手工`maintenance`；paid、external和Beta不进入普通CI。当前没有Release或Linux自动Deploy，事实与进入条件见[CI/CD基线](./docs/architecture/ci-cd.md) |
| 远程部署 | 当前拓扑A仍是Chat常驻Mac（LaunchAgent），云端只做Nginx+Cloudflare网关；它不是GitHub CD。家用Linux尚未冻结发布制品、Supervisor和数据回滚合同，因此没有自动Deploy；Workbench不进远程部署。见[远程部署合同](./docs/deployment/remote-pwa-gateway.md)与[CI/CD基线](./docs/architecture/ci-cd.md) |

## 当前实施顺序

1. DSH已经成为唯一前端，原生对话已通过Session、Message、Plan/HITL、Note Candidate审核、执行、正式结果和刷新恢复合同纵向。
   DSH侧栏统一承载新建、历史切换与原生归档；Product Session仍是独立产品事实。归档仅隐藏DSH入口并保留
   双侧记录，不级联修改Product Session；固定rc.6没有永久删除/恢复归档公开能力，当前不伪造这两项语义。
2. Code Workbench首期纵向已经作为独立Hosted App接入，但当前标记为Beta，不参与通用CI/CD；不复制或拆分code-server UI。
3. “执行 Agent（逐次提示词审核）”单节点纵向已经实现；DSH可选择并配置该Workflow。Provider审核开启时在Pi真实发送前展示原始请求/易读视图与批准/拒绝，关闭时直接发送但仍保留派发与结果未知安全边界；DSH→Bridge和Bridge→Chat两道调试审核也可独立开关。
4. 系统级Prompt与首个Agent管理纵向已经实现：会话上下文正文位于可见的全局/Workspace Markdown；Direct可从真实Pi基线创建不可变Agent Version，Workflow精确绑定Version，当前会话还能结构化临时覆盖。Application先把本次Run明确选择为“完整Version / 结构化Temporary / 无版本默认”中的唯一来源，再为Direct冻结v4 Assembly、为多节点Workflow冻结v3 Assembly；普通`node_config`不能替换Version Prompt，默认Pi能力由Executor真实解析，受限版本冻结显式qualified Capability Ref。Coding Executor等尚未逐字段消费完整Version的Agent只读展示真实基线，不提供假保存入口。Prompt Review只有在Workflow节点绑定同一Request Revision/Hash后才对Query和Decision开放。
5. 下一步仍需用户另行授权Provider审核页编辑、Conversation Summary/压缩、用户可命名完整Profile，以及非Direct节点的Provider逐请求审核与来源映射。
6. Browser Provider仍是下一候选纵向；Memory产品与Workflow基线已经恢复，但运行默认关闭。真实Provider部署、长期记忆策略与默认启用仍须新的用户场景和明确授权。
7. 四个标杆案例提炼出的三个治理组件已经在DSH按规则、要求、经验分类展示并可按会话勾选；同一选择进入Planner、Executor和独立Governance Reviewer。确定性纵向覆盖治理通过提交、blocking阻断、Runtime重启恢复；真实DSH浏览器覆盖展示、勾选、Git来源和治理节点完整Prompt预览。

以上是阶段顺序，不是Agent可自行领取的任务。当前实现只能来自当前对话中用户的明确请求；历史任务书只约束范围，不能替代授权。在授权前允许做只读源码审计和方案收敛，不得先添加依赖、下载PoC工件、调用外部服务或开始编码。

## 当前明确没有

1. 没有第二套自研Chat页面或Agent Canvas运行依赖。
2. 没有把DSH Session当成Chat权威Session。
3. 没有浏览器到Workflow、Hook或pi的直连。
4. 没有多实例生产数据库、完整SSE传输或通用插件市场；当前Run Activity Journal是单机单写者JSONL。
5. 没有把本地code-server包装成多用户远程沙箱；当前Terminal与扩展仍以本机用户权限运行。
6. 当前默认“规划执行工作流”不声明Memory节点；只有显式选择Memory Workflow且部署方显式装配Provider时才使用Memory。普通安装和CI不会准备、启动或调用第三方Memory服务。
7. 没有把静态Workflow Definition节点、Workflow Run ID、Hook Token或Pi Session ID伪装成公开执行轨迹事实。
8. 没有继续在产品工作流目录展示旧“默认规划工作流”和“默认笔记工作流”；其稳定ID和运行代码为历史Run、迁移、兼容调用与证据恢复保留。
9. 普通Direct默认继承Pi CLI真实编码能力。DSH Tool/Skill/Plugin尚未接成Pi可执行能力，页面不得把目录可见性冒充执行能力。

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
- `pnpm test:browser`在唯一Harness中连续运行PWA/Mobile、Planning Faux、Prompt Studio、Trajectory和Capability Governance；Provider只使用进程内Faux，普通CI不加载Memory、Workbench、Provider凭据或外部写。
- GitHub普通流水线使用一个稳定`ci` Job：只准备一次固定Pi/DSH，运行Chat根级构建、静态检查、
  全部确定性测试、Capability Governance系统接缝以及安装后的启动/健康/停止；完整Browser与标准
  `pnpm audit --prod`由定时/手工`maintenance`运行。Pi/DSH全量CI只属于各自Fork。
