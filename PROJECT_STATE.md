# Chat 项目状态

> 更新日期：2026-08-18

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | 固定版本DeepSeek Harness Web；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`通过DSH公开Slot把原生会话、Composer行内Workflow选择、Plan审批与Note Candidate审核接到Chat公开API；手机和桌面共用同一产品投影与Command |
| 开发工作台 | Beta、可选、当前暂停进入CI/CD；固定`code-server@4.132.0`与DSH全屏Surface实现继续保留，供需要时人工验证Files、Editor、Terminal、Git/Diff与扩展系统 |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | 版本化JSON Adapter；拥有Session、Message、Run、Plan、Approval、Decision、Memory和Project事实 |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint |
| Agent Runtime | Planner复用`pi-agent-core`；完整Executor由独立Pi Coding Executor Service承载真实`AgentSession`、多轮Tool loop、Session与安全Journal，不拥有产品会话或完成事实 |
| Memory | memmy与Tencent MemoryCore代码、合同和历史事实保留；当前默认不启动服务，也不向API/Workflow装配Adapter |
| 调试 | `pnpm dev/dev:debug`启动Pi Executor、Workflow、API、可选code-server与Web Gateway/DSH；当前没有Memory启用Profile |
| PWA | DSH Web可安装PWA：Bridge覆盖manifest/sw.js并注入图标与注册脚本；SW只缓存同源静态外壳，/api//lifeos永不缓存 |
| 移动端布局 | 固定`dsh-mobile-hanui@0.2.4`（MIT）作为DSH profile bundle提供移动端外壳（抽屉/FAB/弹窗全屏/Composer修复）；版本、integrity、上游提交、所有权和人工更新政策进入`config/dsh-plugins.json`，Chat唯一自建控件是workflow选择器。合同测试`dsh-mobile-hanui-real.spec.ts` |
| 远程部署 | 拓扑A：Chat常驻Mac（LaunchAgent），云端只做Nginx+Cloudflare网关；公网入口强制版本化scrypt、登录节流与App签名Cookie认证；Workbench不进远程部署。见[远程部署合同](./docs/deployment/remote-pwa-gateway.md) |

## 当前实施顺序

1. DSH已经成为唯一前端，原生对话已通过Session、Message、Plan/HITL、Note Candidate审核、执行、正式结果和刷新恢复合同纵向。
2. Code Workbench首期纵向已经作为独立Hosted App接入，但当前标记为Beta，不参与通用CI/CD；不复制或拆分code-server UI。
3. 下一纵向是带实时人机共用视图的Browser Provider。
4. 随后继续长期Project/Memory/Rules和更多受治理插件能力。

以上是阶段顺序，不是Agent可自行领取的任务。当前实现只能来自当前对话中用户的明确请求；历史任务书只约束范围，不能替代授权。在授权前允许做只读源码审计和方案收敛，不得先添加依赖、下载PoC工件、调用外部服务或开始编码。

## 当前明确没有

1. 没有第二套自研Chat页面或Agent Canvas运行依赖。
2. 没有把DSH Session当成Chat权威Session。
3. 没有浏览器到Workflow、Hook或pi的直连。
4. 没有多实例生产数据库、完整SSE Cursor Journal或通用插件市场。
5. 没有把本地code-server包装成多用户远程沙箱；当前Terminal与扩展仍以本机用户权限运行。
6. 没有在当前默认服务图中启动或连接memmy/MemoryCore；默认Planning只会跳过未选择的可选Memory节点。

## 当前仓库基线门

- 固定DSH版本与完整许可证/版本证据进入仓库。
- 全仓build、typecheck、test、lint和依赖审计通过。
- 真实DSH Host启动，原生界面不是临时Adapter页。
- 浏览器真实完成发送、Plan/HITL、Note审核、执行结果与刷新恢复。
- Workbench处于Beta，不属于当前通用CI/CD基线门；单独启用、修改或准备发布时，仍须人工运行其真实浏览器与生命周期验证。
