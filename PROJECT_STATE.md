# Chat 项目状态

> 更新日期：2026-08-16

## 当前事实

| 领域 | 当前状态 |
|---|---|
| 产品身份 | 独立、完整、持续演进的个人Agent协作产品 |
| 唯一前端 | 固定版本DeepSeek Harness Web；旧`apps/web`与Agent Canvas均不属于当前架构 |
| 前端桥接 | `@chat/dsh-lifeos-bridge`把DSH原生会话、Composer与HITL表面接到Chat公开API |
| 后端 | Node.js + TypeScript；Hono协议入口；Application拥有用例事务 |
| Product Store | 版本化JSON Adapter；拥有Session、Message、Run、Plan、Approval、Decision、Memory和Project事实 |
| Workflow | Vercel Workflow解释不可变RunSpec，承担耐久步骤、暂停、恢复与Checkpoint |
| Agent Runtime | `pi-agent-core`作为Planner/Executor节点，不拥有产品会话或完成事实 |
| Memory | 已接memmy与Tencent MemoryCore，Chat保存采用、来源与导入/对账事实 |
| 调试 | `pnpm dev/dev:debug`统一启动Memory、Workflow、API与DSH Web，使用固定端口和安全回收 |

## 当前实施顺序

1. DSH成为唯一前端，删除旧UI、旧Agent Canvas材料和过期视觉归档。
2. 验证DSH原生对话能够创建Chat Product Session、发送消息、展示Plan、提交人工决定并显示正式结果。
3. 接入Code Workbench，使同一页面可打开成熟的Files、Editor、Terminal、Git与Diff工作台。
4. 再推进Browser Provider、长期Project/Memory/Rules和更多插件能力。

## 当前明确没有

1. 没有第二套自研Chat页面或Agent Canvas运行依赖。
2. 没有把DSH Session当成Chat权威Session。
3. 没有浏览器到Workflow、Hook或pi的直连。
4. 没有多实例生产数据库、完整SSE Cursor Journal或通用插件市场。
5. Code Workbench完成前，不宣称主界面已经提供Files、Terminal或Git/Diff。

## 完成门

- 固定DSH版本与完整许可证/版本证据进入仓库。
- 全仓build、typecheck、test、lint和依赖审计通过。
- 真实DSH Host启动，原生界面不是临时Adapter页。
- 浏览器真实完成发送、Plan/HITL、执行结果与刷新恢复。
- Workbench真实打开同一Workspace，并验证Files、Terminal、Git与Diff。
