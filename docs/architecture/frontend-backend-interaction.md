# DSH前端与Chat后端交互

> 文档类型：当前实现（as-built）

## 1. 拓扑

```text
Browser
  -> DSH Web Host
     -> DSH原生Client插件图
     -> LifeOS Client插件（Plan/HITL/Workbench表面）
     -> LifeOS Host插件（LLM Adapter、同源桥接路由）
        -> Chat Hono API
           -> Application
              -> Product Store + Outbox
                 -> Vercel Workflow -> pi-agent-core
```

浏览器只访问DSH Host的同源页面和LifeOS桥接路由。Client插件不读取Chat私有存储、不调用Workflow/pi，也不知道Workflow Run ID、Hook Token或pi Session ID。

## 2. 会话身份

DSH原生界面创建自己的`dshSessionId`。Host插件把它映射到一个`productSessionId`，映射只保存在本地Adapter状态中：

- DSH Session负责原生会话选择、消息轨迹和Composer体验。
- Product Session负责权威消息、Run、Plan、Approval、Decision和恢复。
- 映射不能作为授权；每次Chat请求仍经过API认证与合同校验。
- 映射或响应结果未知时，桥接层必须保留稳定命令身份并查询恢复，不能静默创建第二个Product Session或Message。

## 3. 发送链

1. 用户在DSH原生Composer提交消息。
2. DSH用固定`lifeos/workflow`模型调用LifeOS `LlmAdapter`，传入DSH Session和消息历史。
3. Adapter从本轮请求提取最新用户文本；`session-title`和`compaction`用途绝不写入Chat。
4. Adapter取得或幂等创建Product Session，以稳定`commandId`提交`POST /api/sessions/:id/messages`。
5. Chat原子提交User Message、Product Run、Receipt和Workflow Start Outbox。
6. Adapter轮询公开Run、Messages、Plans和Current Approval Query；它不从HTTP超时推断成功。
7. Run需要人工决定时，Client插件展示当前Plan/Approval；用户的修订、批准或拒绝经Host桥接为Chat Decision Command。
8. Run成功后，Adapter读取Product Store中的正式Assistant Message，并作为DSH文本流返回。DSH将它写入原生会话轨迹。

DSH显示出来的Assistant文本是Chat正式事实的副本，不是模型直接输出。Run失败、拒绝或结果未知必须返回明确状态，不能生成假交付。

## 4. 公开Chat API

主链使用：

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/sessions` | 幂等创建Product Session |
| `POST` | `/api/sessions/:sessionId/messages` | 幂等提交Message并创建Product Run |
| `GET` | `/api/sessions/:sessionId/messages` | 读取正式Message |
| `GET` | `/api/runs/:productRunId` | 读取Run状态、阶段与revision |
| `GET` | `/api/runs/:productRunId/plans` | 读取Plan revisions |
| `GET` | `/api/runs/:productRunId/approvals/current` | 读取当前可操作Approval |
| `POST` | `/api/runs/:productRunId/decisions` | 提交版本/Hash绑定的决定 |

字段真相以`@chat/contracts/public`的Zod Schema为准。Host插件必须运行时解析外部响应，不能用TypeScript断言跳过校验。

## 5. Command与恢复

所有写请求使用稳定`commandId`；修改已有事实时还携带`expectedRevision`。Decision绑定Approval、Plan ID、Plan revision和SHA-256。

桥接状态至少记录DSH Session映射、当前Product Run、发送/决定Command身份及最后已确认阶段。写状态使用原子替换。发生请求已发但响应丢失时，使用相同命令重试或Query恢复，不生成新身份。

## 6. Workbench边界

Code Workbench不是Chat API的一部分。DSH Host负责启动和代理固定版本code-server；Client插件只打开全屏Surface。code-server拥有编辑器临时状态和Workspace内进程，不拥有Chat Session、Run或完成事实。

## 7. 调试入口

- DSH Host/Client桥接：`packages/dsh-lifeos-bridge`
- DSH启动与Profile：`apps/dsh-web`、`scripts/dsh`
- Chat公开路由：`apps/api/src/product-routes.ts`
- Message用例：`packages/application/src/session-message-use-cases.ts`
- Decision用例：`packages/application/src/planning-use-cases.ts`
- Workflow：`packages/workflows`
- pi Adapter：`packages/pi-runtime`

本地固定端口与命令见[本地调试](../debug/local-debug.md)。
