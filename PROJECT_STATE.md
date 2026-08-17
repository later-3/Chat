# Chat 项目状态

> 更新日期：2026-08-18

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | Chat私有仓库`later-3/deepseek-harness-chat`维护固定`DeepSeek Harness Web rc.6`窄派生；当前只维护Trajectory Location/标签扩展，Chat仓库以固定pnpm补丁消费；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`通过DSH公开Slot把原生会话、Composer行内Workflow选择与HITL表面接到Chat公开API |
| 开发工作台 | 固定`code-server@4.132.0`；DSH全屏Surface打开Files、Editor、Terminal、Git/Diff与扩展系统 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | 版本化JSON Adapter；拥有Session、Message、Run、Plan、Approval、Decision、Memory和Project事实 |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint |
| Agent Runtime | `pi-agent-core`作为Planner/Executor节点，不拥有产品会话或完成事实 |
| 执行轨迹 | DSH Trajectory只展示实际Workflow NodeRun及其Pi Agent/模型/工具子过程；Vercel Run/Step/Hook/Sleep继续保留为后端证据但不混入；Bridge以真实DSH user/message保存Run绑定，再把树贡献到随后同一原生Step的request/header位置；DSH窄扩展保留Contribution Location并显示WORKFLOW/NODE/AGENT/MODEL/TOOL语义标签，原生Tool/Subtool行为不变；树线恢复可见深度，Session utility可选显示本地时间范围；终态摘要含角色、Token、耗时 |
| Memory | memmy与Tencent MemoryCore代码、合同和历史事实保留；当前默认不启动服务，也不向API/Workflow装配Adapter |
| 调试 | `pnpm dev/dev:debug`只启动Workflow、API、code-server与Web Gateway/DSH；当前没有Memory启用Profile |
| PWA | DSH Web可安装PWA：Bridge覆盖manifest/sw.js并注入图标与注册脚本；SW只缓存同源静态外壳，/api//lifeos永不缓存 |
| 远程部署 | 拓扑A：Chat常驻Mac（LaunchAgent），云端只做Nginx+Cloudflare网关；公网入口强制App签名Cookie认证；Workbench不进远程部署。见[远程部署合同](./docs/deployment/remote-pwa-gateway.md) |

## 当前实施顺序

1. DSH已经成为唯一前端，原生对话已真实通过Session、Message、Plan/HITL、执行、正式结果和刷新恢复。
2. Code Workbench已经作为独立Hosted App接入，不复制或拆分code-server UI。
3. 下一纵向是带实时人机共用视图的Browser Provider。
4. 随后继续长期Project/Memory/Rules和更多受治理插件能力。

以上是阶段顺序，不是Agent可自行领取的任务。当前实现只能来自当前对话中用户的明确请求；历史任务书只约束范围，不能替代授权。在授权前允许做只读源码审计和方案收敛，不得先添加依赖、下载PoC工件、调用外部服务或开始编码。

## 当前明确没有

1. 没有第二套自研Chat页面或Agent Canvas运行依赖。
2. 没有把DSH Session当成Chat权威Session。
3. 没有浏览器到Workflow、Hook或pi的直连。
4. 没有多实例生产数据库、完整SSE Cursor Journal或通用插件市场。
5. 没有把本地code-server包装成多用户远程沙箱；当前Terminal与扩展仍以本机用户权限运行。
6. 当前默认选择独立的“规划执行工作流”，其冻结Definition只有规划、审核、执行、验证和提交，根本不声明Memory节点；带Memory/Project/Rules的完整上下文Planning Definition继续保留，但Memory服务与Adapter在默认服务图中不启动、不装配。
7. 没有把静态Workflow Definition节点、Workflow Run ID、Hook Token或Pi Session ID伪装成公开执行轨迹事实。

## 当前仓库基线门

- 固定DSH版本与完整许可证/版本证据进入仓库。
- 全仓build、typecheck、test、lint和依赖审计通过。
- 真实DSH Host启动，原生界面不是临时Adapter页。
- 浏览器真实完成发送、Plan/HITL、执行结果与刷新恢复。
- 浏览器在DSH原生Trajectory真实展开唯一Workflow主线及其Pi子过程；Vercel Runtime证据不混入该表面，默认Run因Definition不含Memory而没有任何Memory轨迹，不靠前端过滤。
- DSH私有仓库保持Private，`origin/main`与当前维护分支保存派生源码，官方仓库作为只读`upstream`；升级按[DSH前端派生与维护](./docs/architecture/dsh-frontend-maintenance.md)汇合并重跑门。
- Workbench真实打开同一Workspace，并验证Files、Terminal、Git与Diff。
- Workbench与DSH使用不同浏览器Origin；WebSocket、Service Worker作用域和停止后的子进程回收通过。
