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
| 代码状态 | P0骨架已交付（待审核）：pnpm Workspace、合同包、Web/API空应用、架构依赖测试与CI |
| 当前工作包 | P0已实现并通过本地完成门，PR审核中 |
| 唯一下一步 | 审核合并P0后，交付第一条无外部副作用的端到端纵向链（P1） |

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

这些选择必须服从已冻结状态所有权和前后端合同。

## 4. 当前没有的能力

- 没有业务Schema、Product Store实现或迁移。
- 没有Workflow Definition实现。
- 没有pi Adapter实现。
- 没有AG-UI事件适配实现（P0仅固定Envelope结构子集）。
- 没有HITL、Checkpoint或重连的可运行证明。

文档批准不等于软件已经实现；P0骨架也不等于纵向链已经打通。

## 5. 当前禁止事项

1. 新增实现必须从当前合同出发，不引入未获批准的兼容层、Schema或方案资产。
2. 不让浏览器保存Workflow Run ID、Hook Token或pi Session ID作为权威恢复身份。
3. 不并行建立AG-UI流、Workflow原始流和pi原始流三套前端通道。
4. 不在第一条纵向链之前预建完整Workflow编辑器、插件平台或多Runtime抽象。
5. 不提交密钥、本地数据库、运行事件、缓存和构建产物。
