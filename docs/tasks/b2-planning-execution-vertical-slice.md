# B2 任务书：可调试的真实规划—确认—执行纵向闭环

| 项目 | 内容 |
|---|---|
| 状态 | 用户已批准；M1～M4代码与确定性门完成，待真实百炼付费验收 |
| 主要结果 | 用户从现有 Chat 页面发送消息，在同一个真实 Workflow 中查看并修改计划、批准计划、等待执行，并收到正式 Assistant Message |
| 交付方式 | 1 个独立 Git worktree、1 个功能分支、1 个 Draft PR；PR 内按 4 个里程碑提交，不再等待多个小 PR 顺序合并 |
| 基线 | `main` @ `4f3c35b5f6013eda77c4a8d303c32dbaa4adf306`；B1 固定端口调试与严格 Trace 已在基线中 |
| Provider | 阿里云百炼按量付费或业务空间 API，真实模型 `qwen3.7-plus` |
| Product Store | 版本化 JSON 快照；单实例、单写者；通过 Port 可替换 |
| 前端范围 | 只完成这条纵向链所需的最小 Plan 审核、状态和结果界面，不重做现有 Workspace |
| 完成判定 | 严格 E2E 从浏览器入口贯穿 API、Product Store、Vercel Workflow、pi、百炼、Hook、Product Commit，再回到浏览器；不接受半链、手工改数据或 Mock 冒充 |

## 1. 一句话目标

交付一条可以在 VS Code 中逐层断点调试、由真实 `qwen3.7-plus` 驱动、刷新后仍能恢复正式状态的完整用户路径：

```text
用户发送消息
-> Chat提交正式Message与Product Run
-> 启动唯一PlanningExecutionWorkflow
-> pi规划并发布Plan v1
-> 前端展示Plan并等待用户决定
-> 用户提出修改意见
-> 同一Workflow恢复并发布Plan v2
-> 用户批准Plan v2
-> 同一Workflow执行并产生候选结果
-> 确定性验证
-> Product Commit提交正式Assistant Message
-> 前端显示正式结果
```

这不是 Store Demo、Workflow Demo、模型调用 Demo 或界面 Demo。上述路径缺少任意一段，都不能把 B2 标为完成。

## 2. 用户验收场景

第一条固定验收任务使用无外部副作用、结果可读且可验证的场景，例如：

> 根据我输入的项目进展，先规划怎样整理，再生成一份结构清楚的 Markdown 周报。计划必须包含“风险与下一步”。

用户必须真实完成：

1. 从现有 Chat 输入框发送原始要求。
2. 页面显示服务端状态“正在规划”，而不是本地计时器或 fixture。
3. 页面展示 Plan v1 的目标、摘要、步骤、成功标准、风险和版本。
4. 用户输入“把风险单独成节，并增加下周三个行动项”，点击“要求修改”。
5. 页面展示 Plan v2；v1 仍可作为历史事实读取，但不可再批准。
6. 用户批准 v2；页面显示执行和验证状态。
7. 页面收到正式 Assistant Message，内容满足已批准计划和确定性验证规则。
8. 在等待确认、执行中和完成后三个时点刷新页面，正式状态都从服务端恢复，不重复启动 Workflow 或模型调用。

## 3. 非半成品完成定义

B2 只有同时满足以下 10 项才完成：

1. 浏览器发送一次，只产生一个正式 User Message、一个 Product Run 和一个私有 Workflow Run 映射。
2. Plan v1 和 v2 均由真实 pi Agent loop 调用真实百炼 `qwen3.7-plus`产生。
3. “要求修改 / 通过 / 拒绝”全部经过 Chat Decision Command；浏览器不直接恢复 Hook。
4. 修改后恢复同一个 Workflow Run，而不是启动第二个 Workflow。
5. Executor 只得到已批准 Plan 与允许的无副作用 Capability。
6. 只有 Product Commit 成功才出现正式 Assistant Message 和 `succeeded`。
7. JSON Product Store 可在 API 正常重启后恢复全部正式事实与历史 revision。
8. Trace 与 Product Store 可以组合回放完整系统路径；Trace 不复制正文。
9. VS Code 主 Compound 能命中规定断点，重复启动会安全释放固定端口。
10. 严格真实 E2E、确定性质量门和人工调试证据全部通过。

以下均不算完成：

1. 只用 curl 或测试代码直接调用 Hook，页面没有走通。
2. 只调用模型生成文本，没有 Plan、Decision、Hash 和 Product Commit。
3. 前端用 fixture、延时器或本地状态伪装运行阶段。
4. 用 fake provider、固定回答或测试 Planner 代替真实百炼完成验收。
5. Workflow 返回成功，但正式 Message 或 Product Run 没有提交成功。
6. 依靠人工编辑 JSON、复制 Hook Token 或 Workflow 控制台推动流程。

## 4. 背景与本次调整

B1 已交付固定端口调试、进程身份校验、严格 Trace 合同和查询入口。当前仓库仍缺少业务 Product Store、规划/决定领域对象、Workflow Definition、pi Adapter、正式 API 和真实前端链路。

旧任务书把后续能力拆成 B2～B7 六个顺序 PR。这个粒度会造成大量等待，而这些模块只有组合后才能证明用户结果。因此本任务改为一个纵向 B2：

1. 保留清晰的模块边界、里程碑提交和内部完成门。
2. 去掉每个小模块合并后才能继续的等待。
3. 先过后端闭环门，再在同一任务中接最小前端。
4. 最终以一条严格真实 E2E 证明整体，而不是分别宣称局部完成。

用户批准本任务书后，它取代旧任务书中“B2～B7 必须拆成独立 PR”的执行安排；已冻结的单 Workflow、状态所有权、Trace、调试端口和安全规则不变。

## 5. 研究依据：采用、调整与拒绝

| 来源 | 采用 | 针对 Chat 的调整 | 拒绝 |
|---|---|---|---|
| pi 冻结源码 `10e99ae...` | 类型化历史、窄 Agent/Model 接口、结构化工具、可替换 Storage | pi Session 只保留 Runtime 上下文；工具入口和 Chat Adapter 各校验一次 | pi Session 冒充 Product Session；模型工具直写 Store；pi 完成事件直接宣布产品成功 |
| Hermes Session Storage | 单一权威存储、数据库适合并发与检索 | 当前先用单实例 JSON，未来通过 Port 换数据库 | JSON 与数据库同时成为事实源 |
| QwenPaw Context | 原始历史、工作上下文、Memory、归档分工 | 本次只实现产品历史与 Trace，Memory 后置 | 把 Memory 或 Trace 混进会话正文 |

JSONL 适合追加 Runtime Transcript，但本任务一次命令需要跨 Message、Run、Receipt 和 Outbox 原子提交，因此不照搬 pi 的 Session JSONL。Hermes/QwenPaw 的 SQLite 方向为未来迁移提供依据，不扩大当前 B2。

## 6. 范围

### 6.1 必须实现

1. Product Session、Message、Product Run、Run Attempt、Plan Revision、Revision Input、Approval Request、Decision、Execution Contract、Execution Candidate、Validation Result、Artifact、Command Receipt 和 Outbox 合同。
2. 版本化 JSON Product Store、私有 Runtime Binding Store 及其 Port。
3. 创建 Session、发送 Message、查询消息/运行/计划/审批和提交决定的 Application 用例与 API。
4. 唯一的 `PlanningExecutionWorkflow`，含规划、Hook 等待、修改循环、批准、执行、验证和 Product Commit。
5. pi Planner/Executor Adapter 与真实百炼 Provider。
6. 现有 Chat 输入框的正式发送接线。
7. 现有工作区中的最小 Plan 审核、修改/批准/拒绝、运行阶段和正式结果投影。
8. TanStack Query 受控轮询与刷新恢复；本任务不声称已经完成 SSE Cursor 实时流。
9. B1 Trace 事件扩展、Trace + Product Store 回放组装和固定断点调试。
10. 严格单元、合同、文件系统集成、Workflow 集成、真实 Provider 和真实浏览器 E2E。

### 6.2 明确不做

1. 不实现 Memory Adapter、腾讯 Memory、memory-agent、BMAD 或经验规则选择。
2. 不实现 Workflow 图形编辑器、任意节点编排或多 Runtime 平台。
3. 不开放发邮件、写仓库、写日历、扣费、删除等外部副作用 Tool。
4. 不生成真实文件、PPT、代码提交或白板；首版交付物是正式 Markdown Assistant Message。
5. 不实现生产数据库、多实例写入、备份、灾难恢复或跨主机共享文件。
6. 不完成 SSE Cursor 重放；本任务使用 Query 轮询恢复权威状态，合同不得阻碍后续 SSE 接入。
7. 不重做导航、主题、PPT、代码、白板和整体视觉系统。
8. 不部署到服务器；弱服务器不得安装依赖、编译或运行测试。

## 7. 状态所有权与架构

```text
React / TanStack Query
        |
        | REST Query / Command
        v
Hono Adapter
        |
        v
Application Use Cases ----> ProductStorePort ----> JSON Product Store
        |                         |
        |                         +---- facts + command receipts + outbox
        |
        +----> WorkflowStarterPort / WorkflowResumePort
                         |
                         v
             PlanningExecutionWorkflow
                         |
                         +----> PiRuntimePort ----> pi ----> Bailian qwen3.7-plus
                         |
                         +----> WorkflowProductClient
                                      |
                                      | private Application Command
                                      v
                               Hono / Application

RuntimeBindingStore <---- Workflow Adapter only
Trace Sink <--------- every system boundary, references product facts
```

所有权不可混淆：

1. Product Store 拥有用户可恢复的正式事实。
2. Vercel Workflow Store 拥有控制流、Step 结果和 Checkpoint。
3. Runtime Binding Store 只保存产品身份与私有 Runtime 身份的映射。
4. pi Session 只属于 Agent Runtime。
5. Trace 只保存系统路径、关联、耗时、错误和对象引用。
6. 浏览器只拥有投影、未提交草稿和安全的公开定位 ID。
7. API 进程是 JSON Product Store 的唯一 Owner 和唯一写者；Workflow 进程不得打开产品 JSON 文件。

## 8. JSON 存储方案

### 8.1 为什么选完整快照

一次 Message Command 必须原子提交 User Message、Product Run、Command Receipt 和 Workflow Start Outbox。一次 Decision Command 必须原子提交 Decision、状态转换和 Resume Outbox。

如果按 Session 拆文件或只用 JSONL，跨对象原子提交需要额外实现事件溯源、事务日志、崩溃恢复和投影重建，复杂度与本阶段目标不匹配。单文件快照能用最少机制提供当前单实例所需的原子性，并保持未来替换数据库的 Port。

### 8.2 三类物理数据

```text
.data/product/chat-product-store.v1.json
.data/runtime/runtime-bindings.v1.json
.data/traces/chat-trace-YYYY-MM-DD.jsonl
```

1. `product/` 是产品事实源。
2. `runtime/` 是后端私有映射，不属于产品 Query。
3. `traces/` 是 B1 已建立的系统 Trace。
4. 三类文件均进入 `.gitignore`，默认权限 `0600`。
5. 不建立 `.bak` 作为第二事实源；故障时保留旧正式快照和孤立临时文件供诊断。

### 8.3 Product Snapshot 顶层合同

```json
{
  "schemaVersion": "chat-product-store.v1",
  "storeRevision": 27,
  "committedAt": "2026-08-07T12:00:00.000Z",
  "entities": {
    "sessions": {},
    "messages": {},
    "runs": {},
    "attempts": {},
    "plans": {},
    "revisionInputs": {},
    "approvalRequests": {},
    "decisions": {},
    "executionContracts": {},
    "executionCandidates": {},
    "validationResults": {},
    "artifacts": {}
  },
  "commandReceipts": {},
  "outbox": {}
}
```

约束：

1. 所有集合使用 `ID -> 对象` 的 Map 形态，不把整个历史嵌套进 Session。
2. 每个持久对象包含自己的 `schemaVersion`、ID、revision、创建/更新时间和必要关联引用。
3. Message 顺序由单调递增的 `sessionSequence` 固定；不能依赖对象键或时间戳排序。
4. 所有 Plan revision 永久保留；`planId + revision` 可精确读取历史内容。
5. Decision 必须绑定 `approvalRequestId + planId + planRevision + planSha256`。
6. Execution Contract 必须绑定 Approved Plan 与 Decision，创建后不可修改。
7. Command Receipt 保存 `commandId + commandType + requestSha256 + resultRefs + committedStoreRevision`。
8. 同一 `commandId` 和相同请求 Hash 返回原结果；同一 ID 不同请求返回 `409 COMMAND_ID_REUSED`。
9. Outbox 与产品事实同一次快照提交；Outbox 只保存逻辑目标和公开对象引用，不保存 Hook Token。
10. 不保存 API Key、Cookie、Authorization、完整 Provider Payload、隐藏推理或 Workflow 私有 ID。
11. 不持久化可以从权威对象确定性计算的重复索引；当前数据量下启动时构建内存索引，避免双份数据不一致。

### 8.4 Runtime Binding 合同

`runtime-bindings.v1.json` 至少保存：

```text
productRunId -> workflowRunId, workflowDefinitionVersion, startDispatchState
approvalRequestId -> hookToken, hookClaimState, resumeDispatchState
```

要求：

1. 只有 Workflow Adapter 可以读写。
2. 产品层只保存对应的逻辑 Outbox ID，不依赖 Token 内容。
3. Runtime ID 和 Hook Token 不进入 API、浏览器、URL、localStorage、Trace 或 PR 证据。
4. 文件缺失、损坏、版本未知或映射冲突时失败关闭，不猜测或重新创建可能重复的 Workflow。
5. 当前实现明确是单进程/单机 Adapter，不宣称跨进程事务与 Product Snapshot 原子一致；两者间的不确定区间由 Outbox 派发状态和对账规则处理。
6. API 只用 `productRunId/approvalRequestId/decisionRef` 调用 Workflow Runtime；Workflow Runtime 在自己的 Adapter 内解析私有映射。

### 8.5 原子提交算法

每次 `ProductStorePort.transact()` 必须执行：

```text
进入单写队列
-> 读取当前内存快照
-> 校验commandId、expectedRevision、CAS和领域不变量
-> 克隆快照并应用产品事实 + Command Receipt + Outbox
-> 对完整新快照执行strict Zod和跨对象不变量校验
-> 同目录创建唯一临时文件，权限0600
-> 写完整字节并fsync临时文件
-> atomic rename替换正式文件
-> fsync父目录
-> 替换内存中的已提交快照
```

任一步失败：

1. 对调用方返回稳定内部错误，不能返回成功。
2. 内存仍指向旧已提交快照。
3. 正式文件保持旧内容逐字节不变。
4. 临时文件只报告和隔离，不自动覆盖正式文件。
5. 启动遇到损坏 JSON、未知 Schema、悬空引用、Hash 不一致或非法状态时失败关闭并保留原文件。

### 8.6 Canonical Hash

Plan、Command Request、Execution Contract 和候选证据使用稳定 canonical JSON 序列化后计算 SHA-256：

1. 对象键按规范排序。
2. 数组保持业务顺序。
3. 禁止 `undefined`、非有限数字、函数、Symbol 和循环引用。
4. 日期使用已校验的 ISO 字符串。
5. Hash 输入必须有 Schema 版本域，防止跨版本误比较。
6. 禁止直接对未规范化对象使用依赖插入顺序的 `JSON.stringify()` 作为审批 Hash。

## 9. 领域对象与不变量

### 9.1 Product Run 状态

```text
pending/queued
-> running/planning
-> waiting_human/plan_review
   -> running/planning       request_revision
   -> running/executing      approve
   -> cancelled/rejected     reject
-> running/validating
-> succeeded/completed | failed/* | outcome_unknown/*
```

`status` 是权威生命周期，`phase` 解释当前用户可见阶段；不得建立第二套竞争终态。

### 9.2 强制不变量

1. 一个 Message Command 最多创建一个 User Message 和一个 Product Run。
2. 一个 Product Run 最多有一个活动 Workflow 映射。
3. 一个 Product Run 任意时刻最多有一个 `under_review` Plan 和一个活动 Approval Request。
4. 新 Plan 产生时，上一版必须进入 `superseded`；旧版本不删除。
5. `request_revision`、`approve`、`reject` 都绑定当前 Plan revision 和 Hash。
6. 过期、旧 revision、错误 Hash、错误 Principal 和已决定 Request 全部失败关闭。
7. 规划修订最多 5 轮；第 6 次不再调用模型，Run 进入明确失败并给出重新开始动作。
8. Approved Plan 不可变；Execution Contract 只从 Approved Plan 与已提交 Decision 生成。
9. Provider 或 pi 成功只产生候选，不能直接产生正式 Message 或成功终态。
10. Product Commit 同时提交 Assistant Message、Run 终态和 Outbox；失败时三者都不提交。
11. Product Commit 重试只能重用已验证候选，不得再次调用已成功的付费 Executor。
12. Workflow replay 不得重复模型调用、Hook resume 或产品提交。

## 10. Port 与 Application 用例

只建立有真实替换价值或所有权边界的窄接口：

```ts
interface ProductStorePort {
  read(query: ProductReadRequest): Promise<ProductReadResult>;
  transact(command: ProductTransaction): Promise<ProductTransactionResult>;
}

interface WorkflowStarterPort {
  start(input: StartPlanningExecutionInput): Promise<StartDispatchResult>;
}

interface WorkflowResumePort {
  resume(input: ResumeCommittedDecisionInput): Promise<ResumeDispatchResult>;
}

interface PiRuntimePort {
  plan(input: PlanningInput): Promise<PlanCandidateResult>;
  execute(input: ExecutionStepInput): Promise<ExecutionCandidateResult>;
}

interface WorkflowProductClientPort {
  compilePlanningInput(input: CompilePlanningInput): Promise<PlanningInput>;
  publishPlanForReview(input: PublishPlanInput): Promise<PublishedPlanReview>;
  loadCommittedDecision(input: LoadDecisionInput): Promise<CommittedDecision>;
  compileExecutionContract(input: CompileExecutionInput): Promise<ExecutionContract>;
  commitRejectedRun(input: CommitRejectedInput): Promise<CommittedRun>;
  commitExecutionResult(input: CommitResultInput): Promise<CommittedResult>;
}
```

Port 表达语义而非文件或 SDK 方法；最终签名由合同测试冻结。禁止：

1. `Repository<T>`、Repository-per-table。
2. 一个包含所有动作的万能 `ChatService`。
3. Service-per-method 但没有事务或领域价值的空包装。
4. 把 Hono Context、Workflow 对象、pi Agent 或文件路径传入 Application/Domain。

Application 用例按用户动作和事务边界命名：

1. `CreateProductSession`。
2. `SubmitUserMessage`。
3. `PublishPlanForReview`。
4. `SubmitPlanDecision`。
5. `CompileExecutionContract`。
6. `CommitExecutionResult`。
7. `GetSessionMessages`、`GetProductRun`、`GetRunPlans`、`GetCurrentApproval`。

Application 在产品事务外调用 Workflow Port；Outbox 负责跨边界派发与结果未知恢复。

由于 API 与 Workflow Runtime 使用两个固定端口，它们不能各自实例化 JSON Adapter。API 进程独占 `ProductStorePort`；Workflow Step 通过后端私有、版本化的 Application Command 调用 API。开发环境只监听 loopback，并使用仅服务端持有的 Runtime 凭据；浏览器 CORS、公开 Router 和前端 Bundle 都不能获得该凭据。私有命令仍经过 Zod、稳定 `commandId`、CAS、Trace 和 Application Coordinator，不能成为绕过产品事务的后门。

## 11. 模块与依赖设计

| 模块 | 责任 | 禁止 |
|---|---|---|
| `packages/contracts` | Zod 网络/持久化/Workflow DTO 与推导类型 | 事务、文件 IO、Hono、pi |
| `packages/domain` | 纯状态机、不变量、canonical hash 输入规则 | SDK、网络、文件、时间/随机全局读取 |
| `packages/application` | 用例、Port、事务与 Outbox 协调 | Hono、React、Vercel/pi 具体类型 |
| `packages/product-store-json` | JSON Product Store 基础设施 Adapter，只由 API 组合根实例化 | 业务路由、Workflow、Provider、多进程打开同一文件 |
| `packages/workflows` | Workflow Definition、Hook、Runtime Binding、派发 Adapter、私有 Product Client | 直接改产品文件、返回私有 ID |
| `packages/pi-runtime` | pi、百炼配置、Planner/Executor、事件归一化 | 产品事务、Hook、Hono |
| `packages/realtime` | Trace、Replay Assembler 所需系统时间线 | 保存产品正文、拥有产品状态 |
| `apps/api` | Hono 协议、Principal、DTO、组合根 | 领域状态机、直接文件写入、直接 pi/Hook |
| `apps/web` | Query/Command 客户端和最小投影 | Workflow/pi 直连、权威状态、fixture 假成功 |
| `packages/testing` | Fixture builder、failure injection、架构合同 | 生产业务规则的唯一实现 |

新增 `packages/product-store-json` 的理由：它是可替换的文件系统 Adapter；把它塞进 Router 或 Application 会反转依赖。它只依赖 Contracts、Domain、Application Port 和 Node 文件系统，并且只能由 API 组合根创建一个实例。

## 12. Query、Command 与错误接口

### 12.1 API

```text
POST /api/sessions
GET  /api/sessions/:sessionId
POST /api/sessions/:sessionId/messages
GET  /api/sessions/:sessionId/messages?cursor=&limit=
GET  /api/runs/:productRunId
GET  /api/runs/:productRunId/plans
GET  /api/runs/:productRunId/approvals/current
POST /api/runs/:productRunId/decisions
```

第一版前端在没有服务端 Session 时，通过 `POST /api/sessions` 幂等创建调试用户的真实 Product Session。浏览器可以保存公开 `sessionId` 用于重新定位，但它不是授权凭据；不得使用隐藏的魔法 Session ID。

### 12.2 Command 通用字段

```json
{
  "commandId": "cmd_...",
  "expectedRevision": 7,
  "payload": {}
}
```

Message Command 的正文只进入 Product Store。服务端固定模型配置，忽略并拒绝浏览器试图指定 Provider、模型或 Runtime 参数。

Decision Command 至少包含：

```text
commandId
expectedRunRevision
approvalRequestId
planId
planRevision
planSha256
kind: request_revision | approve | reject
revisionInstruction?  // request_revision必填、非空、有长度上限
reason?               // reject可选、有长度上限
```

### 12.3 Query 规则

1. Query 返回 `schemaVersion`、对象 `revision`、`updatedAt` 和允许的动作。
2. Plan Query 返回可阅读内容、历史版本和当前状态，不返回 Provider 原文。
3. Run Query 返回 `status + phase`、当前 Plan/Approval 引用、最终 Message 引用和安全错误。
4. Message 列表按服务端 cursor 分页，顺序由 `sessionSequence` 固定。
5. Query 不返回 Workflow Run ID、Hook Token、pi Session ID、百炼 Request ID 或服务器路径。

### 12.4 后端私有接口

API 与 Workflow Runtime 之间另有版本化私有合同，用于：启动/恢复 Workflow，以及 Workflow 调用 `PublishPlanForReview`、读取已提交 Decision、提交取消和 Product Commit。它必须：

1. 只接受产品对象引用和稳定命令身份，不接受浏览器原始决定。
2. 使用仅服务端持有的 Runtime 凭据；开发环境只监听 `127.0.0.1`。
3. 与公开 API 分 Router、分 DTO、分授权测试，不进入 OpenAPI/前端客户端或浏览器 Bundle。
4. 始终调用 Application Coordinator，不能直接访问 Store。
5. 所有重放调用保持幂等；原始 Workflow/Hook/pi 身份不进入产品合同。

### 12.5 Problem Detail

至少冻结以下稳定错误族：

```text
VALIDATION_FAILED
NOT_FOUND
REVISION_CONFLICT
PLAN_HASH_CONFLICT
APPROVAL_EXPIRED
APPROVAL_ALREADY_DECIDED
COMMAND_ID_REUSED
FORBIDDEN
WORKFLOW_DISPATCH_UNKNOWN
WORKFLOW_RESUME_UNKNOWN
PROVIDER_AUTH_FAILED
PROVIDER_RATE_LIMITED
PROVIDER_TIMEOUT
PROVIDER_STREAM_INTERRUPTED
MODEL_CANDIDATE_INVALID
PRODUCT_COMMIT_FAILED
STORE_CORRUPTED
INTERNAL_ERROR
```

响应使用 Problem Detail：`type/title/status/code/requestId/retryable/recoveryAction`。浏览器只根据 `code + recoveryAction` 呈现可执行动作，不解析错误文本。

## 13. Workflow Definition

唯一 Workflow：`PlanningExecutionWorkflow.v1`。

```text
compile_planning_input
-> pi.plan(maxRetries=0)
-> publish_plan_review
-> claim_and_wait_decision_hook
-> load_committed_decision
   -> request_revision: 回到compile_planning_input
   -> reject: commit_cancelled_run -> end
   -> approve: compile_execution_contract
-> pi.execute per approved step(maxRetries=0)
-> validate_execution
-> product_commit
-> end
```

要求：

1. 每个 Product Run 只启动一个 Workflow Run。
2. Workflow 只传递可序列化、经 Zod 校验的值或对象引用。
3. Application Step 使用稳定幂等 `commandId`。
4. 模型 Step 禁止 Workflow 自动重试，避免重复费用和不同候选。
5. Hook Payload 只携带已提交 `decisionRef`，Workflow 恢复后重新读取产品事实并复核绑定。
6. Resume Outbox 区分 `pending/dispatched/acknowledged/outcome_unknown/failed_terminal`。
7. Workflow Definition、Prompt Template、Model Config 和代码 Git SHA 都进入版本证据。
8. 既有 Run 固定原 Definition 语义，新部署只影响新 Run。
9. Workflow 返回值只用于诊断；Product Store 终态才是产品成功。
10. Workflow Step 的产品读写全部经过私有 Application Command；Workflow 进程不得导入或实例化 JSON Store。

## 14. pi 与百炼 Adapter

### 14.1 Provider

1. Provider 名：`bailian`。
2. 模型：`qwen3.7-plus`。
3. 默认 Base URL：`https://dashscope.aliyuncs.com/compatible-mode/v1`。
4. 环境变量：`DASHSCOPE_API_KEY`，可选 `DASHSCOPE_BASE_URL`。
5. Base URL 必须是 HTTPS 且符合允许的百炼域名合同。
6. Token Plan/Coding Plan Key 和 Endpoint 禁止用于后端服务。
7. 凭据只检查存在性，不打印、不持久化、不进入 Trace 或浏览器。

### 14.2 Planner

Planner 只得到原始 User Message、选定上下文引用、上版 Plan 与本轮 Revision Input，并只暴露内部 `submit_plan_candidate` 工具。

候选包含：

```text
objective, summary, assumptions, openQuestions,
steps[{stepId,title,purpose,dependsOn,inputRefs,expectedOutput,
       successCriteria,requestedCapabilities,risk}],
completionCriteria, warnings
```

候选没有调用、调用多次、结构非法、超限或请求能力越界时失败，不发布 Plan。

### 14.3 Executor

Executor 只得到不可变 Execution Contract 和当前 Approved Step。第一版 Capability 仅允许在内存中整理文本并生成 Markdown 候选，不开放文件、Shell、Git、网络、邮件、日历或删除能力。

执行候选使用结构化合同：`approvedPlanRef`、有序 `stepResults`、`finalOutput`、逐条 `completionCriteriaEvidence` 和 warnings。`finalOutput` 第一版只允许 Markdown section 数据；服务端确定性渲染 Markdown。真实 E2E 断言 Schema、批准版本、必需 section 和证据覆盖，不对模型自然语言做脆弱的全文快照比较。

Executor 不得修改 Plan、增加步骤或宣布 Product Run 成功。所有候选经过确定性验证与 Product Commit。

### 14.4 Provider 可观察性

Trace 只记录：Provider、模型、Endpoint host、百炼请求 ID、HTTP 状态、耗时、usage、输入 manifest Hash、结果对象引用和稳定错误码。不得记录 Prompt、消息数组、工具参数正文、响应正文或隐藏推理。

## 15. 最小前端

### 15.1 数据策略

1. 使用 TanStack Query 读取 Session、Message、Run、Plans 和 Current Approval。
2. 活动 Run 使用受控短轮询；终态或页面不可见时停止。
3. Command 成功后使相关 Query 失效并重新读取权威状态。
4. 网络结果未知时保留相同 `commandId` 供用户手动重试。
5. 后续接入 SSE 时只负责通知失效和活动投影，不改变产品对象或命令语义。

### 15.2 界面范围

复用现有工作区，只增加：

1. Plan 卡片：revision、目标、摘要、步骤、成功标准、风险和状态。
2. Revision 输入框。
3. “要求修改 / 通过 / 拒绝”三个动作。
4. `planning / waiting_human / executing / validating / succeeded / failed / cancelled / outcome_unknown` 状态投影。
5. 正式结果作为 Assistant Message 进入对话区。

要求：

1. 桌面沿用对话 + 工作区双栏。
2. 375px 沿用“对话 / 工作”切换，无横向滚动，触控目标至少 44px。
3. 状态使用文字、图标/形状和颜色三通道。
4. 键盘可操作，焦点可见，错误有 `aria-live` 且不过度播报。
5. 不新增视觉体系、流程图编辑器、花哨动画或大面积装饰。
6. 不再保留与真实链竞争的本地成功 fixture；未接入的示例区域必须明确标注演示数据。

## 16. Trace、回放与隐私

B1 严格判别联合继续作为唯一 Trace 合同。新增事件必须先定义专属 `.strict()` Schema 和合法/非法 Fixture，不得重新引入 `attributes`、`metadata` 或任意字典。

完整回放由以下来源组装：

```text
Trace系统时间线
+ Product Store正文与版本对象
+ Workflow/Prompt/Model/Git版本证据
-> RunReplayView
```

要求：

1. `pnpm debug:trace --run` 只展示脱敏系统路径。
2. `pnpm debug:replay --run` 在本地授权环境按对象 ID/revision/Hash 读取产品正文并组装回放。
3. 对象缺失、revision 缺失、Hash 不一致、Trace 缺口或版本证据缺失必须显式标红并失败退出。
4. 回放不是重新执行；重新调用模型必须创建新 Attempt，不能覆盖历史。
5. PR、CI、截图与导出证据默认不含正文。
6. 密钥、Hook Token、Workflow Run ID、pi Session ID、完整 Provider Payload 和隐藏推理永不进入公开证据。

## 17. VS Code 调试合同

继续使用 B1 固定端口：

| 用途 | 端口 |
|---|---|
| Web | `127.0.0.1:43110` |
| API | `127.0.0.1:43111` |
| Workflow Runtime | `127.0.0.1:43112` |
| API Inspector | `127.0.0.1:43120` |
| Workflow Inspector | `127.0.0.1:43121` |

“Chat：完整后端闭环”主 Compound 必须：

1. 启动前安全清理上次登记且身份复核通过的 Chat 调试进程。
2. 未知占用只报告端口、PID 和安全进程名，不杀进程、不打印完整 argv、不自动换端口。
3. 按 Workflow Ready -> API Ready -> Web Ready -> Browser 顺序启动。
4. 任一启动失败，清理本轮已经启动的全部进程。
5. 停止调试后释放全部固定端口。

必须可命中的断点：

1. Message Command 协议入口。
2. `SubmitUserMessage` 产品事务。
3. Workflow start dispatch。
4. `pi.plan` Adapter。
5. `PublishPlanForReview`。
6. `SubmitPlanDecision`。
7. Hook resume dispatch 与 Workflow resumed。
8. `pi.execute` Adapter。
9. `CommitExecutionResult`。

Source Map 必须指向 TypeScript 源码；不得要求开发者在生成后的 `dist` 中调试。

## 18. 代码质量硬门

### 18.1 设计原则

1. 代码围绕所有权、事务和失败恢复拆分，不按技术名词堆目录。
2. 使用窄接口、判别联合和明确结果类型；避免布尔参数控制多个行为。
3. 核心路径优先直线式表达；抽象只在存在真实第二实现、隔离 SDK 或保护事务边界时引入。
4. 领域规则只实现一次；测试 Fixture 不复制生产状态机。
5. 注释解释“为什么有这个不变量/失败边界”，不逐行翻译代码。
6. 错误必须在边界归一化，不把 Provider、文件系统或 Workflow 原始异常穿透到浏览器。

### 18.2 禁止的代码形态

1. `any`、未缩窄 `unknown`、边界上的强制类型断言。
2. `Record<string, unknown>` 作为产品、Trace、Hook 或 Provider 扩展口袋。
3. 超级 Service、万能 `utils.ts`、Repository-per-table、Service-per-method。
4. Router、Workflow Step 或 pi Tool 直接写 JSON 文件。
5. Domain 依赖 Hono、React、Vercel Workflow、AG-UI、pi 或 Node 文件系统。
6. 用轮询次数、超时或 UI 文本猜测产品成功。
7. 捕获异常后继续提交成功、静默 Skip 或自动创建新事实“修复”损坏数据。
8. 为未来可能需要的能力提前构建插件框架、通用 DAG、ORM 或事件溯源系统。

### 18.3 审查触发线

按工程规范，模块超过 800 行、React 组件/Hook 超过 500 行、函数超过 80 行时必须说明责任是否混杂；不是机械拆文件，但不能以“之后再重构”通过审核。

新增依赖必须记录用途、所在 Adapter、标准库为何不足、许可证/维护状态和退出方式。锁定实际版本并补架构测试。

## 19. 实施方式：一个 PR，四个里程碑

用户批准任务书后才允许：

1. 从最新 `main` 创建一个独立 worktree。
2. 创建 `codex/b2-planning-execution-vertical-slice` 分支。
3. 创建一个 Draft PR；实现期间持续更新完成门证据。

### M1：合同、领域、JSON Store 与 API 基础

交付：持久化 Schema、状态机、Application 用例、JSON Adapter、Session/Message/Run Query/Command、文件系统失败注入测试。

里程碑门：不用 Workflow 也能证明原子提交、重启读取、幂等、CAS、Plan/Decision 不变量和损坏失败关闭。

### M2：真实 Workflow、pi、百炼与后端闭环

交付：Workflow Definition、Hook、Runtime Binding、Outbox Dispatcher、Planner/Executor、真实 Provider、调试客户端、Replay Assembler。

里程碑门：调试客户端只通过 Chat API，完成真实 Plan v1 -> 修改 -> Plan v2 -> 批准 -> 执行 -> Product Commit。没有通过本门，不得开始前端接线。

### M3：最小前端闭环

交付：真实发送、Plan 审核、Decision 动作、状态轮询、正式结果与 375px 适配。

里程碑门：桌面和 375px 浏览器都能完成完整链路；刷新恢复且不出现本地假成功。

### M4：严格 E2E、失败加固与证据

交付：自动化 E2E、Provider 实证、秘密扫描、重复/并发/故障场景、文档和 PR 证据。

里程碑门：第 21 节全部完成门通过，PR 才能从 Draft 请求最终审核。

每个里程碑形成一个可审查提交；允许为修复测试追加小提交，但禁止把四个边界压成一个不可读巨型提交。若实现发现必须改变已冻结架构或扩大范围，停止并请求用户审核，不以“先做出来”为理由偷偷扩张。

## 20. 测试策略

### 20.1 确定性质量门

普通 CI 不使用付费凭据，必须覆盖：

1. 所有 Zod 合同合法 Fixture 与关键非法 Fixture。
2. Domain 状态机、修订上限、Hash 绑定和非法转换。
3. Application 幂等、CAS、事务、Outbox 和 Product Commit。
4. Canonical JSON 与 SHA-256 跨键顺序稳定性。
5. JSON Store 真实临时目录、并发写、重启、损坏、临时文件、rename/fsync 失败注入。
6. Runtime Binding 丢失、损坏、冲突和私有字段泄漏测试。
7. 使用真实 `workflow` 测试运行时与确定性 Pi Port 的 Hook、Resume、Replay 和分支控制流。
8. pi Adapter 的工具权限、候选次数、Schema、限额、取消和错误归一化。
9. Hono API 合同、Problem Detail、公开 DTO 秘密扫描。
10. 私有 Runtime Router 的认证、loopback、重放和“浏览器不可调用”测试。
11. React 加载、空态、错误、重复点击、键盘、可访问性和 375px 测试。
12. 架构依赖、循环依赖、JSON Adapter 单实例和私有 Runtime 类型不穿透合同的检查。
13. B1 Trace 39 类既有事件及新增事件的严格白名单回归。

### 20.2 真实 Provider 门

提供：

```text
pnpm test:provider:bailian
```

要求：

1. 缺少 `DASHSCOPE_API_KEY` 时明确失败并给出配置方法，不能 Skip。
2. 真实调用 `qwen3.7-plus` 完成 Planner 和 Executor。
3. 验证模型 ID、候选 Schema、工具调用、usage、耗时和安全 Trace。
4. 设置明确的 turn、token、timeout 和最大费用边界。
5. 认证、429、超时、流中断和非法候选分别进入稳定错误族。
6. 付费调用不自动重试；报告实际调用次数。

### 20.3 Workflow 集成门

必须使用真实 Vercel Workflow 本地运行时或官方测试能力，不以手写状态机替代：

1. v1 后真实等待 Hook。
2. Revision Decision 恢复同一 Run 并再次规划。
3. Approve 进入 Executor；Reject 不进入 Executor。
4. 重复 Decision 只发生一次有效 Resume。
5. Replay 不重复已完成模型 Step 或 Application Commit。
6. Product Commit 失败后只重试提交，不再次调用 Executor。
7. Resume 派发结果未知由 Outbox 对账，不盲目新建 Hook 或 Workflow。

### 20.4 真实浏览器 E2E 门

提供：

```text
pnpm test:e2e:planning-execution:real
```

这个命令必须启动真实 Web、Hono、Workflow Runtime、JSON Store、pi 和百炼，从 Playwright 操作页面；禁止在 E2E 中直接读写 Store、调用 Hook、调用 pi 或绕过 API。

## 21. 严格 E2E 场景矩阵

### 21.1 完整正常路径

1. 从干净 `.data` 启动 VS Code 等价服务栈并创建真实 Product Session。
2. 浏览器发送验收消息。
3. 断言恰好一个 User Message、Product Run、Workflow start 和 Planner 调用。
4. 真实 `qwen3.7-plus` 返回 Schema 合法 Plan v1。
5. 页面显示 `waiting_human/plan_review` 与 Plan v1。
6. 在等待页刷新，页面从 Query 恢复同一 Plan 和 Approval。
7. 浏览器提交 Revision Instruction。
8. 断言同一 Product Run/Workflow 产生 v2，v2 Hash 与 v1 不同，v1 状态为 `superseded`。
9. 尝试批准 v1，必须以稳定冲突失败且不恢复 Hook。
10. 浏览器批准 v2。
11. 真实 Executor 执行 Approved Plan；没有任何外部副作用 Capability。
12. 确定性验证通过，Product Commit 原子生成一个 Assistant Message 和 `succeeded`。
13. 页面显示正式结果，内容来源为 Message Query，不是 Workflow Return Value。
14. 重启 API 后重新打开页面，Session、Messages、Plans、Decision 和结果全部恢复。
15. 断言 Planner 2 次、Executor 按批准步骤次数调用，没有额外付费调用。

### 21.2 幂等、并发与网络未知

1. 相同 Message `commandId + payload` 重试返回原结果，不新增 Message/Run/Workflow。
2. 相同 `commandId` 不同 payload 返回 `409 COMMAND_ID_REUSED`。
3. 客户端在响应丢失后用同一 commandId 手动重试，不重复执行。
4. 两个并发 Decision 只有一个提交成功；另一个得到明确冲突。
5. 重复点击批准只产生一个 Decision、一个 Resume 和一组 Executor 调用。
6. 相同 Product Commit 命令重放只返回原正式 Message。

### 21.3 Workflow 与提交恢复

1. Workflow replay 不重复 Planner、Executor、Plan 发布或 Product Commit。
2. Hook resume 派发结果未知时进入 `outcome_unknown`/对账路径，不启动第二个 Workflow。
3. Hook Token 映射缺失、损坏或冲突时失败关闭。
4. Product Commit 在 Provider 已成功后失败，保留验证通过候选；重试只提交产品事实，Provider 调用计数不增加。
5. Reject 恢复同一 Workflow 并进入 `cancelled`，Executor 调用数为 0。
6. 达到第 5 版后再次要求修改，不再调用 Planner，返回明确恢复动作。

### 21.4 Provider 与候选失败

1. Planner 认证失败、429、超时、流中断、无工具调用、多次工具调用和非法候选均不发布 Plan。
2. Executor 对应失败均不生成正式 Assistant Message 或 `succeeded`。
3. Provider 调用失败不被 Workflow 自动重试。
4. Trace 有稳定错误码、请求边界和耗时，不含错误原文中的用户内容或 Provider Payload。

### 21.5 Store 与进程失败

1. 截断 JSON、未知 Schema、悬空引用和 Hash 不一致时 API 启动失败，原文件不变。
2. 临时文件写入、fsync、rename、目录 fsync 任一失败时旧快照逐字节不变。
3. 并发写入按单写队列序列化，CAS 失败者不能覆盖成功者。
4. 等待决定时正常重启 API，Query 恢复产品事实；Runtime Binding 恢复后只允许对当前 Approval 继续。
5. 孤立临时文件不被误当正式快照，也不被静默删除。

### 21.6 浏览器、安全与调试

1. 页面在 planning、waiting_human、executing、validating、succeeded、failed 各阶段刷新不产生假成功或重复工作。
2. 发送失败保留草稿；Decision 失败保留修改意见并展示 `recoveryAction`。
3. 公开响应、页面、URL、localStorage、Query Cache、Trace 和测试附件扫描不到 API Key、Hook Token、Workflow Run ID、pi Session ID 或完整正文副本。
4. 桌面和 375px 完整路径可操作；无横向滚动，触控目标和键盘焦点合格。
5. 连续两次启动调试，第二次先释放旧 Chat 进程并复用固定端口。
6. 未知应用占用固定端口时拒绝启动且不杀未知进程。
7. 停止调试后 5 个固定端口全部释放。
8. 9 个规定断点均有一次真实路径命中记录。

## 22. 完成门与交付证据

PR 只有在以下条件全部满足后才可请求最终审核：

1. `build`、`lint`、`format:check`、`typecheck`、全部确定性测试通过。
2. 真实 Workflow 集成测试通过。
3. `pnpm test:provider:bailian` 使用真实 `qwen3.7-plus` 通过。
4. `pnpm test:e2e:planning-execution:real` 完整通过。
5. 第 21 节矩阵每项有自动证据，无法自动化的 VS Code 断点项有可复核人工记录。
6. Plan v1/v2 revision 与 Hash、唯一 Workflow 私有断言、Provider 调用次数、正式 Message Query 和 API 重启恢复证据齐全。
7. Trace + Replay 能重建同一 Product Run，且对象引用 revision/Hash 全部匹配。
8. 秘密/正文重复扫描通过；证据中不暴露私有 Runtime 身份。
9. 架构测试证明依赖方向正确，无 Router/Workflow/pi 直接写 Store。
10. 现有 PWA、主题、对话、PPT、代码、白板和 375px 回归测试通过。
11. 新依赖清单、许可证、退出方式和冻结版本已记录。
12. PR 描述逐项列出已保证、未保证、测试命令、测试数量和真实付费调用次数。

任何真实凭据缺失、真实 E2E 未运行、失败场景被 Skip、质量门不绿或证据不完整，都只能保持 Draft，不能宣称 B2 完成。

## 23. 开始条件与停止条件

### 23.1 开始条件

1. 用户明确批准本任务书。
2. `DASHSCOPE_API_KEY` 是按量付费或业务空间 Key；不要写入任务书、聊天、Git 或日志。
3. 用户接受真实 Provider 测试产生少量费用和外网依赖。
4. 从批准时最新 `main` 创建独立 worktree 和功能分支。
5. 再次确认 43110～43112、43120～43121 的 B1 固定端口合同没有被其他项目永久占用。

### 23.2 必须停止并请求审核

1. 需要改变“一个 Product Run 对应一个 Workflow Run”。
2. 需要让浏览器接触 Runtime 私有 ID 或直接调用 Workflow/pi。
3. JSON 单实例方案无法满足已列完成门，必须引入数据库或事件溯源。
4. 必须开放外部副作用 Tool 才能完成验收场景。
5. 需要扩大到 Memory、BMAD、经验规则、Workflow 编辑器或完整 SSE。
6. 真实 Provider 能力与冻结 pi/百炼依据不一致，需要更换模型、Provider 或接入方式。
7. 主分支出现与本任务重叠的大范围变更，无法安全 rebase。

## 24. 服务器与发布边界

1. 所有依赖安装、编译、测试和产物生成只在开发机或 CI 完成。
2. 现有弱服务器不得运行 `pnpm install`、`pnpm build`、`tsc`、Vitest、Playwright 或 Provider 测试。
3. B2 完成不等于获得部署授权；服务器发布是审核后的独立任务。
4. 后续如发布，只上传由已审核 Git SHA 构建并带 SHA-256 的产物，使用可回滚原子切换。
5. 服务器地址、账号、Key、业务空间和私有 Base URL 不进入 Git、Trace 或 PR 证据。

## 25. 依据

1. [Chat 技术合同](../architecture/technology-contract.md)。
2. [单 Workflow 规划与执行设计](../architecture/planning-execution-workflow.md)。
3. [Chat 工程规范](../engineering-standards.md)。
4. [Chat 设计规范](../product/design-guidelines.md)。
5. [Vercel Workflow Hooks](https://useworkflow.dev/docs/foundations/hooks)。
6. [Vercel Workflow Testing](https://useworkflow.dev/docs/testing)。
7. [百炼文本生成模型](https://help.aliyun.com/zh/model-studio/text-generation-model)。
8. [百炼 Base URL](https://help.aliyun.com/zh/model-studio/base-url)。
9. pi 冻结源码：`/Users/xulater/Code/opc-os/pi` @ `10e99ae9914cd34f622633fac42f9a90714e9cf4`。
10. pi Session JSONL：`packages/coding-agent/docs/session-format.md`、`packages/agent/src/harness/session/jsonl-storage.ts`。
11. Hermes Session Storage：`/Users/xulater/Code/reference-agent-sources/hermes-agent/website/docs/developer-guide/session-storage.md`。
12. QwenPaw Context：`/Users/xulater/Code/reference-agent-sources/QwenPaw/website/public/docs/context.zh.md`。

## 26. 实施结论区

用户已批准本任务书并要求一次完成后合入。当前证据：

| 里程碑 | 结果 | 自动证据 |
|---|---|---|
| M1 | 合同、领域、JSON Store、Query/Command完成 | 原子提交、幂等/CAS、Plan/Decision不变量、损坏与fsync/rename失败关闭 |
| M2 | 真实Vercel Workflow定义、Hook、Runtime Binding、pi Adapter、百炼配置、Product Commit完成 | 真实Workflow Local World + 确定性pi闭环；Provider替身仅用于非付费控制流测试 |
| M3 | 默认真实前端、Plan修改/批准/拒绝、轮询恢复、375px完成 | React合同测试与10项PWA/移动端Playwright回归 |
| M4 | Trace/Replay、版本证据、结果未知栅栏、错误/安全加固完成 | 全仓确定性测试、架构测试、Replay严格校验、公开响应秘密扫描 |

真实门保持失败关闭：本worktree没有读取或输出私有Key；缺少`DASHSCOPE_API_KEY`时`test:provider:bailian`与真实浏览器E2E明确失败，不Skip、不切换假Provider。用户随后明确授权先合入已通过确定性门的代码、再由其配置Key进行实际验收；这只改变合入时机，不改变§22的B2产品完成定义。合入代码不等于声称真实付费验收已通过。
