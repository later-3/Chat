# Chat 项目状态

> 更新日期：2026-08-20

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | Chat公开仓库`later-3/deepseek-harness-chat`维护固定`DeepSeek Harness Web rc.6`窄派生；当前只维护Trajectory Location/标签/紧凑预览扩展，Chat仓库以固定pnpm补丁消费；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`通过DSH公开Slot把原生会话、Composer行内Workflow选择与服务端描述的发送级配置、Prompt Region选择/语义预览、只读上下文注入、Prompt Studio与人工审核接到Chat公开API；Composer「调试审核」提供独立DSH→Bridge与Bridge→Chat开关，分别审核真实GenerateOptions和实际HTTP Command body，关闭时自动放行；当前Direct Workflow还可按会话配置是否逐次审核Provider提示词；Prompt Studio管理Git内置来源及全局/Workspace用户Revision，Composer按会话和Region选择默认/覆盖/追加；原生侧栏作为唯一会话入口，Bridge首轮只提交Message，Chat Application在同一事务内创建Product Session、标题、Run与Outbox，Bridge仅保存DSH→Chat身份映射；“会话记录”以独立分页完整展示Chat正式Message与DSH原始事件；实时Pi工具调用与完整Workflow执行树继续进入原生Trajectory |
| 开发工作台 | Beta、可选、当前暂停进入CI/CD；固定`code-server@4.132.0`与DSH全屏Surface实现继续保留，供需要时人工验证Files、Editor、Terminal、Git/Diff与扩展系统 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | `chat-product-store.v16`版本化JSON Adapter；用户Prompt Revision正文位于可见Markdown文件，Store只留版本/Scope/Hash引用，并拥有每个Direct Run唯一Prompt Assembly冻结快照；Git内置Prompt仍由只读Catalog拥有 |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint；发送级节点配置由Node Catalog字段、Blueprint白名单和具体Definition默认值共同描述并由Compiler冻结；系统目录的单节点“执行 Agent（逐次提示词审核）”开放`promptReviewMode`，Prompt Review是该节点在`manual`模式下的内部等待状态；它与“规划执行工作流”和“Memory 增强规划与执行”并存 |
| Agent Runtime | Planner复用`pi-agent-core`；完整Executor由独立Pi Coding Executor Service承载真实`AgentSession`、多轮Tool loop、Session与安全Journal，不拥有产品会话或完成事实；Direct Agent使用Prompt Assembly v2接收冻结的System追加段、近期正式历史、当前User、Tools与Options，明确关闭Pi的Context/Skill/Template自动发现，并以Extension链外Provider Gate执行`manual/off`；两种模式都保留派发栅栏、禁用自动重试并按结果未知政策收敛；Chat显式`DASHSCOPE_API_KEY`只注册为Pi进程内runtime override，不进入Prompt/Session/Store |
| 执行轨迹 | DSH Trajectory同时保留实时Pi工具调用，并展示实际Workflow NodeRun、动态Execution Step及其Pi Agent/模型/工具子过程；节点输入/输出由Product Store现有Manifest引用与当前严格Trace组合，不新增Prompt存储；Vercel Run/Step/Hook/Sleep只作为后端证据。Bridge以真实DSH user/message保存Run绑定，把Workflow树贡献到随后同一原生Step；DSH窄扩展保留Location、语义标签和紧凑预览，Session utility可选显示时间范围 |
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
4. Prompt管理与Direct Assembly v2纵向已经实现：用户正文位于可见的全局/Workspace Markdown；每轮按Region选择默认/覆盖/追加并预览；Direct提交原子冻结System、正式历史Messages、当前User、Tools、Options与预算，审核易读页关联精确来源。真实两轮付费E2E已验证组件复制/新Revision/选择、每轮三道审批、正式历史恢复及两次成功Assistant提交。
5. 当前只接Direct固定Profile；下一步仍需用户另行授权Provider前编辑、Conversation Summary/压缩、用户Profile或Planning/Executor迁移。
6. Browser Provider与长期Project/Memory/Rules路线继续保留，但不是本轮自动授权。

以上是阶段顺序，不是Agent可自行领取的任务。当前实现只能来自当前对话中用户的明确请求；历史任务书只约束范围，不能替代授权。在授权前允许做只读源码审计和方案收敛，不得先添加依赖、下载PoC工件、调用外部服务或开始编码。

## 当前明确没有

1. 没有第二套自研Chat页面或Agent Canvas运行依赖。
2. 没有把DSH Session当成Chat权威Session。
3. 没有浏览器到Workflow、Hook或pi的直连。
4. 没有多实例生产数据库、完整SSE Cursor Journal或通用插件市场。
5. 没有把本地code-server包装成多用户远程沙箱；当前Terminal与扩展仍以本机用户权限运行。
6. 当前默认选择独立的“规划执行工作流”，其冻结Definition只有规划、审核、执行、验证和提交，根本不声明Memory节点；历史完整上下文Planning Definition继续保留。第三方MemoryCore服务不会被Chat自动启动，未配置Provider时只有显式Memory Workflow安全失败并留下轨迹证据。
7. 没有把静态Workflow Definition节点、Workflow Run ID、Hook Token或Pi Session ID伪装成公开执行轨迹事实。
8. 没有继续在产品工作流目录展示旧“默认规划工作流”和“默认笔记工作流”；其稳定ID和运行代码为历史Run、迁移、兼容调用与证据恢复保留。
9. 没有为本次Prompt管理改动运行真实付费Provider门；Direct Prompt Profile v2固定`read_only`，可使用当前映射的单一目标Workspace，尚无Memory、写入或Shell。

## 当前仓库基线门

- 固定DSH版本与完整许可证/版本证据进入仓库。
- 全仓build、typecheck、test、lint和依赖审计通过。
- 真实DSH Host启动，原生界面不是临时Adapter页。
- 浏览器真实完成发送、Plan/HITL、Note审核、执行结果与刷新恢复。
- 浏览器在DSH原生Trajectory真实展开唯一Workflow主线及其Pi子过程；Vercel Runtime证据不混入该表面，默认Run因Definition不含Memory而没有任何Memory轨迹，不靠前端过滤。
- 浏览器可从同一DSH会话切换到“会话记录”，分页查看未裁剪的Chat正式Message与DSH原始事件；刷新或重开
  未归档历史会话后仍恢复同一Product Session并可继续发送，空白草稿不得提前创建Product Session。
- DSH派生仓库保持Public，`origin/main`与当前维护分支保存派生源码，官方仓库作为只读`upstream`；升级按[DSH前端派生与维护](./docs/architecture/dsh-frontend-maintenance.md)汇合并重跑门。
- Workbench处于Beta，不属于当前通用CI/CD基线门；单独启用、修改或准备发布时，仍须人工运行Files、Terminal、Git/Diff、浏览器Origin、WebSocket和子进程生命周期验证。
