# Chat 项目状态

> 更新日期：2026-08-06

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 产品身份 | 独立、完整、持续运营的Chat产品 |
| 当前分支 | `codex/chat-workflow-foundation` |
| 前端 | React + TypeScript + Vite；响应式PWA |
| 后端 | Node.js + TypeScript；Hono Web/API Adapter |
| 产品接口 | REST Query/Command + 运行时校验 |
| 实时接口 | Chat有序SSE事件流；Agent事件采用AG-UI兼容语义 |
| Workflow | Vercel Workflow |
| Agent Runtime | `pi-agent-core` + `pi-ai` + `pi-coding-agent` |
| 前端服务端状态 | TanStack Query；浏览器仅持有投影与草稿 |
| 代码状态 | P0已完成并合并：pnpm Workspace、合同包、Web/API空应用、架构依赖测试、CI与版本证据 |
| 当前阶段 | P1第一次可用的Chat闭环，已拆为8个独立任务 |
| 当前任务 | P1.1响应式Chat与工作流界面；实施中，首版范围经用户调整为会话区+模型选择+本地发送+双主题，工作流运行区延后 |

## 2. 已冻结决定

1. Product Store是产品事实源。
2. 浏览器不直接调用Vercel Workflow或pi。
3. Vercel Workflow负责耐久执行与Checkpoint。
4. pi作为Workflow中的Agent节点。
5. AG-UI负责Agent交互事件语义，不负责产品资源。
6. Chat拥有公开事件sequence、cursor、终态和重连合同。
7. Product Session、Product Run、Run Attempt、Workflow Run、Checkpoint和pi Session分别建模。
8. HITL先提交产品Decision，再恢复Workflow Hook。
9. 文件、语音、Canvas和通知使用各自适合的传输，不塞进Agent事件流。
10. 前端只投影服务端状态，PWA缓存不成为第二事实源。

## 3. 当前未决定

以下内容不属于本轮前后端技术选型，不得假装已经冻结：

1. Product Store的具体数据库与迁移工具。
2. Identity Provider与认证部署方式。
3. 对象存储、向量检索和Memory实现。
4. 单机、私有云或Vercel等具体部署拓扑。
5. UI组件库、视觉系统和Canvas协作引擎。
6. 语音媒体服务、日历Provider与通知Provider。
7. 本地、CI和未来部署怎样稳定使用同一份经过确认的pi代码；这个决定只在P1.7接入Agent前关闭，不阻塞前面的PWA、消息和Workflow任务。

这些选择必须服从已冻结状态所有权和前后端合同。

## 4. 当前没有的能力

- 没有业务Schema、Product Store实现或迁移。
- 没有从发送消息到正式Assistant Message的端到端纵向链。
- 没有Workflow Definition实现。
- 没有pi Adapter实现。
- 没有Runtime Journal、SSE Cursor重放或pi到AG-UI的运行时适配实现；P0只固定官方事件Schema与Envelope。
- 没有HITL、Checkpoint或重连的可运行证明。
- 现有Web仍是空应用，还没有响应式Chat与工作流界面、Manifest、Service Worker或离线草稿边界。

文档批准不等于软件已经实现；P0骨架也不等于纵向链已经打通。

## 5. 当前禁止事项

1. 新增实现必须从当前合同出发，不引入未获批准的兼容层、Schema或方案资产。
2. 不让浏览器保存Workflow Run ID、Hook Token或pi Session ID作为权威恢复身份。
3. 不并行建立AG-UI流、Workflow原始流和pi原始流三套前端通道。
4. 不在第一条纵向链之前预建完整Workflow编辑器、插件平台或多Runtime抽象。
5. 不提交密钥、本地数据库、运行事件、缓存和构建产物。
6. 技术决定只在对应子任务中关闭：P1.1～P1.2不提前安装Workflow/pi，P1.3不反向冻结未来数据库，P1.4不提前接pi，P1.7不夹带Tool能力。

## 6. P1任务状态

| 任务 | 结果 | 状态 |
|---|---|---|
| P1.1 | 响应式Chat与工作流界面 | 实施中（首版不含工作流区） |
| P1.2 | 可安装PWA与离线边界 | 待开始 |
| P1.3 | 消息由服务端保存并可读回 | 待开始 |
| P1.4 | 后台Workflow能独立跑通 | 待开始 |
| P1.5 | 网页显示后台状态 | 待开始 |
| P1.6 | 实时进度与断线续接 | 待开始 |
| P1.7 | 接入一次无工具的Agent回答 | 待开始 |
| P1.8 | 整条链验收与失败加固 | 待开始 |

每个任务的用户场景、范围和完成门以[项目计划](./PROJECT_PLAN.md)为准；当前详细执行边界见[P1.1任务书](./docs/tasks/p1.1-responsive-chat-workflow-shell.md)。
