# Chat 状态与运行时边界

> 文档类型：目标状态与恢复边界。当前已经实现的链路见[前后端交互](./frontend-backend-interaction.md)和[Workflow运行设计](./runtime-workflows.md)。本文件中的SSE Cursor/Runtime Journal是冻结目标；当前Web仍使用Query轮询，不能据此宣称SSE已经交付。

## 1. 核心原则

一次用户操作会经过多种对象。它们可以互相引用，但不能因为ID暂时相同就合并所有权。

## 2. 对象所有权

| 对象 | 创建者 | 权威Store | 浏览器可见 | 结束条件 |
|---|---|---|---|---|
| Product Session | Chat Application | Product Store | 是 | 归档或删除 |
| Interaction | Chat Application | Product Store | 是 | 本轮协作进入终态 |
| Message | Chat Application | Product Store | 是 | 不可变内容被修订关系替代 |
| Product Run | Chat Application | Product Store | 是 | succeeded/failed/cancelled/outcome_unknown |
| Run Attempt | Runtime Coordinator | Product Store | 诊断可见 | 一次Worker尝试终结 |
| Workflow Run | Vercel Workflow Adapter | Workflow Store | 否 | Workflow终结 |
| Workflow Checkpoint | Vercel Workflow | Workflow Store | 否 | 被继续、终结或按策略清理 |
| Approval Request | Chat Application | Product Store | 是 | resolved/rejected/cancelled/expired/superseded |
| Workflow Hook Token | Vercel Workflow Adapter | 后端私有映射 | 否 | Hook恢复或失效 |
| pi Runtime Session | pi Adapter | pi Runtime Store | 否 | Agent步骤终结或按策略保留 |
| Realtime Connection | Hono/SSE | 进程连接状态 | 只见连接状态 | 断开 |
| Runtime Event | Runtime Journal | Journal Store | 是 | 按保留策略清理 |

## 3. 浏览器允许知道的身份

允许：

- `productSessionId`
- `interactionId`
- `messageId`
- `productRunId`
- `attemptId`（仅诊断需要）
- `approvalRequestId`
- `eventId`、`sequence`和不透明`cursor`

禁止作为前端权威身份：

- Workflow Run ID
- Workflow Hook Token
- Workflow Checkpoint ID
- pi Runtime Session ID
- Provider Request Credential
- Tool内部幂等密钥或执行凭据

## 4. 一次发送的完整链路

1. 用户在React输入草稿并选择Workflow Definition。
2. React提交`SendMessageCommand`，包含`commandId`和当前Product Session revision。
3. Hono终止HTTP，建立Principal并校验DTO。
4. Application Coordinator在一个产品事务中保存User Message、Interaction和Product Run。
5. 事务提交Outbox，响应产品ID和事件订阅位置。
6. 后端Worker根据Outbox启动Vercel Workflow，并保存Product Run到Workflow Run的私有映射。
7. Workflow读取不可变Run输入和产品资源引用。
8. Agent Step通过`PiRuntimePort`调用pi。
9. pi通过`pi-ai`调用Provider，并把可见Agent事件交给Adapter。
10. Adapter把事件归一为AG-UI兼容Payload，Runtime Journal分配sequence。
11. Hono SSE按cursor把有序事件发送给React。
12. React reducer只更新活动投影，不写产品事实。
13. pi结果返回Workflow，Workflow执行验证和产品提交活动。
14. Application Coordinator提交Assistant Message和Product Run终态。
15. Runtime Journal发布终态及资源失效事件。
16. TanStack Query刷新权威Message和Run，React完成最终渲染。

## 5. HITL链路

1. Workflow Step发现需要人工输入或批准。
2. Workflow创建Hook；Adapter保存私有Token映射。
3. Product Application创建Approval Request并把Product Run置为`waiting_human`。
4. Runtime Journal发布AG-UI Interrupt投影。
5. 用户提交Decision Command，而不是调用Workflow Hook。
6. Application校验权限、Request revision、内容Hash、过期和幂等。
7. 产品事务提交Decision和Outbox。
8. Worker消费Outbox并恢复私有Hook。
9. Workflow从耐久点继续；事件流开始新的Agent运行段。

## 6. 失败与恢复矩阵

| 失败 | 必须保留 | 恢复 |
|---|---|---|
| 浏览器刷新 | Product事实、事件cursor | Query Hydrate + Cursor Replay |
| SSE断开 | Workflow继续、Journal继续 | 重新订阅，不取消Run |
| API进程退出 | Product事实、Outbox、Workflow映射 | 新进程继续分发和查询 |
| Workflow Worker退出 | Workflow Checkpoint | Runtime接管并继续 |
| pi在Provider发送前退出 | Attempt与未发送事实 | 可在安全点重新执行 |
| pi在Provider发送后失联 | Provider Attempt为未知 | 查询、对账或人工处置 |
| Tool请求后失联 | Tool Ledger与幂等Key | 查询、对账、补偿或人工处置 |
| Decision重复提交 | commandId与唯一Decision | 返回原结果，不重复Resume |
| Product提交失败 | Runtime结果候选与未提交事实 | 重试产品提交，不伪造成功 |

## 7. 不变量

1. 连接断开不等于取消Product Run。
2. Workflow成功不等于Product Run成功。
3. pi成功不等于Workflow或Work完成。
4. AG-UI `RUN_FINISHED`是Agent运行段投影，产品终态仍由Product Store决定。
5. Runtime Snapshot不能覆盖产品事实。
6. 浏览器不得从事件缺失、超时或本地缓存推断成功。
