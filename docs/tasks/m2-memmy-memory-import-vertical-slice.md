# M2 任务书：memmy 显式 Memory 导入纵向闭环

| 项目 | 内容 |
|---|---|
| 状态 | 用户已批准；纵向代码、自审、确定性门与真实memmy门完成，待clean提交复跑最终百炼浏览器门 |
| 基线 | `main` @ `8acafb5638ea3cf4e3c7afaec9350419c12c9156`（M1 已合并） |
| 主要结果 | 用户从正式会话消息导入一条事实记忆到真实 memmy，并在新会话中让真实 `qwen3.7-plus` 规划采用它 |
| 交付方式 | 用户批准本任务书后，创建 1 个独立 worktree、1 个 `codex/` 分支、1 个 Draft PR；不拆等待型子 PR |
| Memory 服务 | 固定 `memmy-agent` 提交 `211d521b310fc23c63dd3d9ca848941173981c5e`、tree `c4b1e78046f10011dc28b0408fb1bb3b61a5c3a1` |
| Provider | 复用已存在的 pi 私有配置，真实百炼 `qwen3.7-plus`；缺少或失效时失败关闭 |
| Product Store | `chat-product-store.v2 -> chat-product-store.v3` 确定性迁移；继续单实例、单写者、原子快照 |
| 完成判定 | 真实浏览器、真实 Workflow、真实 memmy、真实查询和真实模型形成闭环；失败注入证明不会重复外部写入 |

## 1. 一句话目标

交付一条用户可以理解、可以确认、可以恢复、可以对账的真实 Memory 导入路径：

```text
正式会话消息或其明确选区
-> 用户检查目标、标题、标签和影响
-> Chat 原子提交 MemoryImportIntent + queued Result + Outbox
-> 独立 MemoryImportWorkflow
-> memmy 真实 add
-> accepted / materialized / failed / outcome_unknown
-> 刷新或进程重启后恢复同一产品事实
-> 新会话选择 memmy 查询
-> PlanningExecutionWorkflow 把命中写入 ContextPackage
-> 真实 qwen3.7-plus Plan 采用刚导入的事实
```

M2 不是“先写 Store，后续再接 Workflow/UI”的中间任务。上面任意一段缺失，都不能把 M2 标为完成。

## 2. 用户验收场景

固定真实场景使用每次运行生成的唯一标记，例如：

> 项目海鸥的发布窗口是 2026-09-17 14:30，验收口令是 M2_CANARY_7F3A。

用户必须能完成：

1. 在已有正式 User Message 或 Assistant Message 上选择整条消息，或选择其中一段文本。
2. 点击“导入记忆”，在确认界面看到来源预览、目标 memmy、事实记忆、标题和标签。
3. 确认后立即看到服务端状态，而不是前端假进度。
4. 正常路径最终显示“已写入并可查询”；页面刷新、API/Workflow 重启后状态不倒退、不丢失。
5. 重复点击、请求重放或 Worker 恢复不会制造第二条外部 Memory。
6. 新建会话，选择 memmy 和本次标签发送相关问题。
7. 真实 `qwen3.7-plus` Plan 明确使用发布窗口或验收口令；未选择 Memory 的对照运行不能知道该事实。
8. Trace 不包含原消息或选区正文；Replay 通过 Message、Intent、Result 和 Trace 引用重建过程。

## 3. 非半成品完成定义

M2 必须同时满足以下 12 项：

1. 导入来源必须是 Product Store 中已提交且属于当前 Principal 的正式 Message。
2. 局部选区由服务端依据不可变 Message 正文重新切片并验证，不能信任浏览器复制的正文。
3. 一个公开 Command 原子创建 Intent、初始 Result、Command Receipt 和 Outbox。
4. Outbox 派发真实 `MemoryImportWorkflow`，Router 和 Workflow Step 不直接写 JSON 文件。
5. 外部 add 使用固定 memmy HTTP 服务，不用 fake 服务冒充真实完成门。
6. `maxRetries=0`；一旦无法证明请求未发送，禁止普通自动重试。
7. 同一语义导入在并发、刷新、Outbox 重放和 Workflow 重放下最多产生一个外部对象。
8. `accepted` 和 `materialized` 是不同事实；没有读取/查询证据不能显示为“已完成”。
9. `outcome_unknown` 有真实对账路径；对账不能变成不受控的第二次 add。
10. 新会话能经现有 M1 Query 节点查到导入结果，并由真实模型使用。
11. 桌面和 390 x 844 手机浏览器均完成导入、状态恢复和再次查询。
12. Store 迁移、严格合同、状态机、故障注入、真实 E2E 和全量质量门全部通过。

以下均不算完成：

1. 只用脚本直接写 memmy，Chat 页面没有入口和状态。
2. 前端把用户选区正文直接当成权威来源。
3. memmy 返回 HTTP 成功就立即显示 materialized，不做读取或检索验证。
4. 网络超时后直接再次调用 add，依赖“应该没写进去”。
5. 用测试内存 Adapter、Mock Workflow、固定模型回答或人工编辑 JSON 通过验收。
6. 导入成功，但新会话无法查询或 Planner 没有采用证据。
7. 把消息正文复制进 Trace、Result、Outbox 或 Runtime Binding。

## 4. 背景与本次架构调整

M1 已经交付：

1. 服务端 Memory Registry 和窄查询 Port。
2. 固定 memmy HTTP Adapter。
3. Message Command 保存 Memory 选择，`PlanningExecutionWorkflow` 查询并冻结 ContextPackage。
4. 页面选择 Memory、展示采用来源，并由真实 `qwen3.7-plus` 完成查询规划闭环。

M1 尚未拥有外部写入事实。导入与查询不能共用同一失败模型：查询失败不会改变外部世界，而 add 可能在响应丢失前已经成功。如果普通重试，就可能产生重复记忆或假成功。因此 M2 增加独立副作用 Port、产品状态机和耐久 Workflow，不把 `import()` 随手加进查询接口。

当前架构文档把下一次 Product Store 版本升级预留给 Project，但 M2 新增 `MemoryImportIntent/Result` 权威集合，不能在 `chat-product-store.v2` 下静默扩充形状。M2 必须拥有 v2 -> v3 迁移，并同步修正文档中的后续编号：

```text
M2 Memory Import: v2 -> v3
P1 Project:       v3 -> v4
R1 Rules:         v4 -> v5
```

## 5. 研究依据：采用、调整与拒绝

### 5.1 memmy 固定源码证据

只认 `/Users/xulater/Code/opc-os/memmy-agent` 的固定 Git 对象 `211d521...`，通过 `git show/git archive` 读取和构建，不读取该工作树的未提交内容作为合同。

固定源码证明：

1. `Memory/src/types.ts` 的 add 请求包含 `content`，以及可选 `layer/title/tags/source/sessionId/turnId/createdAt/deferProcessing`。
2. 真实入口是 `POST /api/v1/memory/add`。
3. `Memory/src/service/memory-service.ts` 使用 `operation + adapterId + requestId` 作为幂等身份，同时保存请求正文指纹。
4. 同一幂等身份、同一正文返回已经保存的结果；同一身份、不同正文拒绝冲突。
5. add 结果包含真实外部 ID、层、状态、标题、标签与时间证据。
6. `GET /api/v1/memory/:id`、Processing Status 和 Search 可用于验证外部对象是否可读。
7. L1 后续处理可能异步；add 被接收不等于摘要和索引已经物化。

Chat 采用：

1. 原生 requestId 幂等和请求指纹冲突保护。
2. add 返回真实 ID 后按 ID/状态验证。
3. 真实服务物理隔离 SQLite 的 E2E 方式。

Chat 调整：

1. 浏览器只提交 `backendId`，`adapterId`、endpoint、namespace 和凭据由服务端配置。
2. Chat 保存自己的 canonical request Hash、Intent、Result 和对账事实，不把 memmy 数据库当 Product Store。
3. 外部调用一旦进入不确定区间，Chat 先写 `outcome_unknown`，再用相同幂等身份对账。
4. M2 只开放用户明确选择的 L2 事实记忆；L1 经历提炼和异步摘要留给后续具有对应语义的任务。

Chat 拒绝：

1. 自动导出全部会话。
2. 浏览器直连 Memory 服务。
3. 用 memmy namespace 宣称多租户隔离。
4. 把外部 injectedContext 或 add 响应未经 strict Schema 转成产品事实。
5. 通过重复 add 猜测第一次是否成功。

### 5.2 Tencent MemoryCore 作为下一后端约束

固定参考提交为 `3a9748d3c61c2a2feb38237c9b28992250c1804e`。它的 `conversation/add` 返回 accepted IDs/versions，后续 L1 物化异步；`atomic/update` 是 update-only，不能用作 create 或幂等重放。

M2 不实现 Tencent，但 Port 必须保持能力级、结果级和失败级边界，不能出现只为 memmy 私有 JSON 服务的任意字段。M3 会用真实 Tencent Adapter 验证该抽象；M2 不提前虚构未被真实服务证明的共同字段。

## 6. 范围

### 6.1 必须实现

1. `MemoryImportIntent`、`MemoryImportResult`、新 ID、严格 Schema、Hash 和状态机。
2. `chat-product-store.v2 -> v3` 确定性迁移与完整性校验。
3. `MemoryImportBackendPort`、服务端能力 Registry 和 memmy Import Adapter。
4. 创建导入、查询导入、按 Session 列表、请求对账的公开 Command/Query。
5. 类型化 `memory_import_start` 与 `memory_import_reconcile` Outbox。
6. 独立 `MemoryImportWorkflow` 和私有 Runtime Binding/HTTP 合同。
7. 消息操作、确认界面、导入状态、对账动作及刷新恢复。
8. 严格 Trace 事件与 Replay Assembler 支持。
9. 固定端口 VS Code 断点调试和安全进程清理回归。
10. 确定性测试、固定 memmy 真实 HTTP、响应丢失故障注入、真实浏览器与真实百炼 E2E。
11. 同步更新 `PROJECT_STATE.md`、`docs/project-session-handoff.md`、长期上下文架构和路线图的 M1/M2 状态与 Store 版本编号。

### 6.2 明确不做

1. 不实现 Tencent Adapter 或 MemOS Adapter。
2. 不做 L1 自动提炼、Skill 导入、批量导入或整段会话自动同步。
3. 不做 Memory 正文编辑、删除、外部版本合并或跨后端复制。
4. 不做后台无限轮询；只做有界自动对账和用户显式再次对账。
5. 不做 BMAD Project、Project Context、用户规则或标签规则选择。
6. 不新增第二个规划 Workflow；现有 `PlanningExecutionWorkflow` 仍是唯一规划执行链。
7. 不把 Product Run 强行改造成 Memory Import Run；Import Result 自己拥有生命周期。
8. 不部署服务器；弱服务器不安装依赖、不编译、不运行测试。

## 7. 事实所有权与模块边界

```text
React Message Action / Import Dialog
              |
              | REST Command / Query
              v
Hono Product Routes
              |
              v
Application Import Use Cases -----> ProductStorePort -----> JSON Product Store v3
              |                           |
              |                           +-- Intent + Result + Receipt + Outbox
              |
              +---- Outbox Dispatcher ----> Workflow Runtime
                                               |
                                               v
                                      MemoryImportWorkflow
                                               |
                          +--------------------+--------------------+
                          |                                         |
                          v                                         v
                Runtime API Client                         MemoryImportBackendPort
                          |                                         |
                          v                                         v
                  Application Commands                      memmy HTTP Adapter
```

所有权约束：

1. Product Store 拥有 Intent、Result、Command Receipt 和 Outbox。
2. memmy 拥有外部 Memory 对象与索引；Chat 只保存外部 ID、状态与验证证据。
3. Workflow Store 拥有 Step Checkpoint 和控制流，不拥有产品终态。
4. Runtime Binding Store 只保存 Outbox/Intent 与 Workflow Run 的私有映射。
5. Message 是 Chat 内唯一来源正文；Intent 保存引用和选区，不复制 Message 正文。
6. Trace 只保存系统路径；Replay 组合 Message + Intent + Result + Trace。
7. API 进程继续是 JSON Product Store 唯一写者；Workflow 进程只能调用私有 Runtime API。

模块不得越界：

1. `packages/contracts`：网络合同、产品实体、ID、Trace 和 strict Schema。
2. `packages/domain`：选区验证、canonical Hash、导入状态转换与不变量。
3. `packages/application`：创建导入、状态提交、对账请求、Query 和事务边界。
4. `packages/memory-runtime`：Import Port 的 memmy HTTP 实现与能力注册。
5. `packages/workflows`：Workflow 定义、Step 和 Runtime 私有映射。
6. `apps/api`：Hono 边界、组合根、Outbox Dispatcher；不得拥有领域规则。
7. `apps/web`：交互和服务端状态投影；不得推导权威终态。
8. `packages/realtime`：严格 Trace 写入与多源 Replay。

禁止建立 `MemoryService`、`ContextService` 或 `WorkflowService` 万能类；Query Port 与 Import Port 保持分离。

## 8. 产品合同

### 8.1 新产品身份

新增服务端生成的类型化 ID：

```text
mii_*  MemoryImportIntentId
mir_*  MemoryImportResultId
```

公开合同继续禁止 Workflow Run ID、Hook Token、Checkpoint ID、pi Session ID、memmy Token、endpoint 和 namespace。

### 8.2 来源选区

`MemoryImportSourceSelection` 是判别联合：

```ts
type MemoryImportSourceSelection =
  | {
      kind: "full_message";
      sourceMessageId: MessageId;
      sourceMessageSha256: Sha256;
    }
  | {
      kind: "utf16_range";
      sourceMessageId: MessageId;
      sourceMessageSha256: Sha256;
      startUtf16: number;
      endUtf16: number;
      selectedTextSha256: Sha256;
    };
```

规则：

1. Message 正文是 JavaScript 字符串，浏览器与 Node 都按 UTF-16 code unit 表示选区，因此范围语义可确定复现。
2. `0 <= startUtf16 < endUtf16 <= message.content.text.length`。
3. 服务端从已提交 Message 重新切片，计算 selectedText Hash；不接收浏览器正文作为权威内容。
4. Source Message 必须属于调用 Principal 可访问的 Session。
5. Message 当前不可变；Hash 不一致仍失败关闭，防止未来 Schema 演进后误导入。
6. 空白选区、只含控制字符、超过后端最大长度或切片 Hash 不一致返回稳定验证错误。

### 8.3 MemoryImportIntent

Intent 是不可变的用户决定，不承担不断变化的执行状态：

```text
schemaVersion: memory-import-intent.v1
memoryImportIntentId
requestedByPrincipalId
sourceSelection
backendId
backendDescriptor + backendDescriptorSha256
memoryLayer: L2
title
tags（trim、去重、稳定排序）
operationId（服务端稳定生成）
requestSha256
semanticDedupeSha256
revision: 1
createdAt / updatedAt
```

`requestSha256` 从真正发送给 Adapter 的规范化请求计算，但正文仍从 Message 引用重建，不在 Intent 再存一份。

`semanticDedupeSha256` 至少包含 Principal、sourceMessageSha256、选区、backendId、L2、规范化 title/tags。同一语义请求即使使用不同 commandId 并发提交，也返回已有 Intent/Result，避免双击或多标签页制造两个外部对象。

### 8.4 MemoryImportResult

Result 是权威生命周期对象，按 `status` 使用 strict 判别联合：

```text
queued
dispatching
accepted
materialized
failed
outcome_unknown
```

公共字段：

```text
schemaVersion: memory-import-result.v1
memoryImportResultId
memoryImportIntentId
status
dispatchAttempts
reconcileAttempts
revision
createdAt / updatedAt
```

状态特有字段：

1. `accepted`：`externalObjectId`、可用的 externalVersion、externalStatus、acceptedAt、responseSha256。
2. `materialized`：继承真实外部 ID，增加 materializedAt、verificationKind、verificationSha256。
3. `failed`：稳定 errorCode、safe summary、failedAt；不保存外部响应正文或 Stack。
4. `outcome_unknown`：稳定 errorCode、unknownSince、lastReconciledAt 可选；不能虚构 external ID。

Intent 与 Result 一对一。每次对账更新同一 Result revision，不为每次轮询制造一组新业务对象；历史路径由 Trace 和 Outbox 证据保存。

### 8.5 Outbox

现有 Outbox 从一个带大量可选字段的对象改为以 `kind` 判别的 strict 联合：

1. `workflow_start`：绑定 `productRunId`。
2. `workflow_resume`：绑定 `productRunId + approvalRequestId + decisionId`。
3. `memory_import_start`：绑定 `memoryImportIntentId + memoryImportResultId + expectedResultRevision`。
4. `memory_import_reconcile`：绑定同一 Import 引用和触发时的 expectedResultRevision。

Memory Import Outbox 不伪造 `productRunId`，也不把 Workflow 私有身份塞进 Product Store。

## 9. 领域状态机与不变量

### 9.1 合法转换

```text
queued -> dispatching
dispatching -> accepted
dispatching -> failed
dispatching -> outcome_unknown
accepted -> materialized
accepted -> failed
accepted -> outcome_unknown
outcome_unknown -> accepted
outcome_unknown -> materialized
outcome_unknown -> failed
```

`materialized` 与 `failed` 是终态；`outcome_unknown` 是需要对账的产品状态，不是假失败，也不允许直接回到 `dispatching` 再 add。

### 9.2 强制不变量

1. Result 必须引用存在且 Hash 完整的 Intent。
2. Intent Source Message 必须存在、归属正确且内容 Hash 可重算。
3. Result revision 每次合法转换严格加一；所有状态提交带 expectedRevision。
4. `accepted/materialized` 必须有真实 externalObjectId；其他状态不能伪造 ID。
5. materialized 必须引用同一 Intent 的 accepted 或对账证据。
6. failed/outcome_unknown 必须有稳定错误码，不能保存任意错误对象。
7. terminal Result 不得重新派发 start。
8. 同一 semanticDedupeSha256 只能存在一个非失败 Intent；并发创建最多提交一个。
9. 同一 operationId 永远绑定同一 requestSha256；不同 Hash 失败关闭。
10. 外部调用不能发生在 `ProductStorePort.transact()` 内。

## 10. Memory Import Port 与 Registry

查询和外部写入使用两个窄 Port：

```ts
interface MemoryImportBackendPort {
  describeImport(): MemoryImportCapabilities;
  import(input: MemoryImportInput): Promise<MemoryImportAccepted>;
  reconcile(input: MemoryImportReconcileInput): Promise<MemoryImportReconcileOutput>;
}
```

约束：

1. `MemoryImportInput` 只含稳定 operationId、规范化正文、L2、title、tags 和安全产品引用。
2. Port 不暴露 fetch Response、memmy 私有任意 JSON 或 `Record<string, unknown>`。
3. `import()` 只返回 strict accepted 结果，或抛出携带 `failurePhase` 的稳定 `MemoryImportBackendError`。
4. `failurePhase` 至少区分 `before_external_call`、`rejected_before_write` 和 `write_outcome_unknown`。
5. 一旦调用 `fetch` 且没有明确的拒绝前写入证据，超时、断连、5xx 或成功响应合同损坏均按 `write_outcome_unknown` 处理。
6. `reconcile()` 不是普通重试：有 external ID 时先按 ID/状态读取；没有 ID 时，memmy Adapter 只能使用相同 adapterId、requestId 和完全相同 requestSha256 做一次原生幂等对账。
7. 同一幂等身份出现不同正文冲突时终止并显示稳定错误，不修改 operationId 逃避冲突。
8. Registry 对每个 backend 分别注册 Query 和可选 Import 能力；UI 只对 import-capable backend 启用入口。

M2 扩展公开安全能力：

```text
capabilities.import.mode = explicit_fact
capabilities.import.layers = [L2]
capabilities.import.title = true
capabilities.import.tags = true
capabilities.import.maxContentChars = 固定合同值
```

endpoint、adapterId、namespace、Token 和 credential 内容仍不进入公开 Profile。

## 11. memmy Adapter 语义

### 11.1 请求映射

1. `content`：从 Source Message 及选区实时重建。
2. `layer`：固定 `L2`。
3. `title/tags`：使用服务端规范化后的值。
4. `source`：固定安全来源类型，例如 `chat.explicit_import`，不拼接正文。
5. `sessionId/turnId`：由服务端产品 ID 确定性映射；不接受浏览器覆盖。
6. `adapterId`：服务端固定配置。
7. `requestId`：使用 Intent 的稳定 operationId。

Chat 自己保存 canonical requestSha256；memmy 固定源码会计算自己的正文指纹。两者共同防止相同 requestId 被不同内容复用。

### 11.2 结果分类

1. 明确的输入、认证、授权或幂等正文冲突：`failed`。
2. add 返回 strict 合法对象和 external ID：先提交 `accepted`。
3. 按 ID 可读、状态满足固定源码的就绪条件，并能经真实 Search 命中：提交 `materialized`。
4. fetch 后超时、连接中断、5xx、非法成功响应：`outcome_unknown`。
5. accepted 后验证暂时不可用：保持 accepted 或进入 outcome_unknown，不显示 materialized。

M2 的 L2 正常路径应快速 materialized，但数据模型不能把 accepted 和 materialized 合并，为 M3 的异步后端保留真实语义。

## 12. Application 用例与公开 API

### 12.1 Command

```text
POST /api/memory-imports
POST /api/memory-imports/:memoryImportIntentId/reconcile
```

所有写请求继续使用现有 Command Envelope，携带 commandId；对账命令另带 expectedResultRevision。

创建导入 Payload 只允许：

```text
sourceSelection
backendId
title
tags
```

浏览器不能提交 layer、endpoint、adapterId、requestId、operationId、external ID、状态、凭据、Provider 或模型。

创建用例必须在一次事务中：

1. 校验 Principal、Session 和 Message 归属。
2. 验证 Message Hash 与选区。
3. 解析 Registry 的真实 Import 能力和冻结安全 Backend Descriptor。
4. 规范化 title/tags，生成 Intent、queued Result、Receipt 和 `memory_import_start` Outbox。
5. 命中 commandId 或 semanticDedupeSha256 时返回原 Intent/Result，不执行第二次 mutate。

对账用例只允许 accepted/outcome_unknown Result；它原子提交 Receipt 与 `memory_import_reconcile` Outbox，不直接从 Router 调 memmy。

### 12.2 Query

```text
GET /api/memory-imports/:memoryImportIntentId
GET /api/sessions/:sessionId/memory-imports
```

Query 返回浏览器需要的安全投影：来源 Message 引用、选区预览、backend 显示名、title/tags、用户可读状态、revision、时间和可用 externalObjectId。不得返回 endpoint、Token、namespace、requestSha256、Runtime ID、底层错误或完整外部 Payload。

选区预览从 Message 正文按引用组装；不在 DTO 复制第二份永久正文。列表提供稳定分页/上限，不能一次返回无限历史。

### 12.3 私有 Runtime API

Workflow 只通过带 Runtime 凭据的内部 API 调用 Application：

```text
POST /internal/runtime/v1/memory-import/load
POST /internal/runtime/v1/memory-import/mark-dispatching
POST /internal/runtime/v1/memory-import/commit-accepted
POST /internal/runtime/v1/memory-import/commit-materialized
POST /internal/runtime/v1/memory-import/commit-failed
POST /internal/runtime/v1/memory-import/commit-outcome-unknown
POST /internal/runtime/v1/memory-import/load-reconcile
```

每个内部 Payload 都是 strict Schema，绑定 Intent ID、Result ID、expectedRevision、requestSha256 和 Workflow 定义版本证据；正文只在 load 响应的受限 Step 输入中出现，不进入 Trace 或 Runtime Binding。

## 13. Workflow、Outbox 与 Runtime Binding

### 13.1 Workflow 定义

新增一个版本化 `MemoryImportWorkflow`：

```text
loadImportIntentStep
-> markImportDispatchingStep
-> callMemmyImportStep (maxRetries=0)
-> commitAcceptedStep
-> verifyMaterializedStep
-> commitMaterializedStep
```

异常分支：

```text
明确未调用或明确拒绝写入 -> commitFailedStep
可能已经写入             -> commitOutcomeUnknownStep
                            -> reconcileMemmyImportStep
                            -> commitAccepted / Materialized / Failed
                            -> 无法证明时保持 outcome_unknown
```

对账 Outbox 启动同一个 Workflow 定义的 `mode=reconcile` 输入，不复制第二套业务 Workflow。每个 Outbox 产生独立私有 Workflow Run，产品只看到同一 Result 的 revision 演进。

### 13.2 重放与外部边界

1. load、mark、commit 都是幂等 Application Command。
2. `callMemmyImportStep` 是 Vercel Workflow 的耐久 Step，`maxRetries=0`。
3. call Step 必须捕获 Adapter 的预期失败并返回 strict 判别结果（accepted / failed / outcome_unknown），不能让网络异常冒泡成框架默认重试。
4. Step 重放读取已保存输出，不重复运行 fetch。
5. Workflow Store 已保存 accepted 输出但 Product Store 未提交时，commit 命令可以幂等重放。
6. 外部写入已发生但 Step 输出未保存时进入 outcome_unknown；只走 reconcile。
7. 编程错误可以让 Workflow 失败，但在跨过外部调用边界后仍必须先提交 outcome_unknown，不能用崩溃绕过产品收敛。

### 13.3 Runtime Binding

Runtime Binding Store 增加以 Outbox kind 判别的私有映射：

```text
outboxId -> workflowRunId + workflowDefinitionVersion + dispatchState
```

Import 映射同时保存 Intent/Result 引用用于内部身份复核，但不保存正文、Token 或外部响应。Dispatcher 对 start/reconcile 分别执行 claim、dispatch 和 reconcile；未知派发只在 Runtime 明确证明未创建 Workflow 时重排队。

现有 Planning Workflow 的 `productRunId -> workflowRunId` 行为必须保持兼容；迁移私有 Binding Schema 时要有严格版本与恢复测试，不能删除活动 Run 的映射。

## 14. Product Store v2 -> v3

### 14.1 v3 顶层变化

在 `entities` 增加：

```text
memoryImportIntents: Record<MemoryImportIntentId, MemoryImportIntent>
memoryImportResults: Record<MemoryImportResultId, MemoryImportResult>
```

Outbox Schema 同步升级为类型化判别联合，但保留现有条目含义。

### 14.2 迁移要求

1. 输入必须是 strict `chat-product-store.v2`，未知字段或损坏引用失败关闭。
2. 输出固定为 `chat-product-store.v3`，两个新集合为空，所有旧对象逐字段保持语义不变。
3. v1 文件仍按既有 v1 -> v2，再串行 v2 -> v3；不能跳过中间校验。
4. 迁移确定性；相同 v2 字节得到相同 v3 产品内容和 Hash 语义。
5. 临时文件、0600、fsync、atomic rename 和父目录 fsync 规则不变。
6. 任意解析、完整性、写入、fsync 或 rename 故障不改原文件。
7. 真实 M1 Store Fixture 迁移后，会话、Run、Plan、ContextPackage 和 Memory Snapshot 全部可读。
8. 已经是 v3 的文件直接打开，不重复创建或重写。

### 14.3 启动完整性

启动时增加：

1. Intent -> Message/Principal/Backend Descriptor 引用和 Hash 校验。
2. Result -> Intent 一对一与状态字段校验。
3. Import Outbox -> Intent/Result/revision 校验。
4. semanticDedupeSha256 唯一性校验。
5. external ID 只允许出现在 accepted/materialized。

## 15. 前端最小统一交互

### 15.1 消息入口

每条正式 Message 增加一个与现有视觉系统一致的“导入记忆”操作。草稿、加载占位和未提交模型候选不显示入口。

支持：

1. 未选中文本：导入整条消息。
2. 有合法选区且选区属于该 Message：导入 UTF-16 范围。
3. 选区跨 Message、为空或已经失效：阻止提交并给出明确提示。

### 15.2 确认界面

使用响应式 Dialog 或手机 Drawer，展示：

1. 来源会话和安全截断预览。
2. 目标 Memory 后端；M2 只有配置且支持 Import 的 memmy 可选。
3. 记忆类型“事实记忆（L2）”，说明它会写入外部 Memory 服务。
4. 标题、标签和字符数量。
5. 明确的取消与“确认导入”按钮。

UI 不显示 endpoint、adapterId、namespace、requestId、operationId 或凭据。提交期间禁用重复确认；服务端幂等仍是最终防线。

### 15.3 状态与恢复

页面从 Query 投影显示：

| 产品状态 | 用户文案 | 可用动作 |
|---|---|---|
| queued | 等待写入 | 无 |
| dispatching | 正在写入 | 无 |
| accepted | 已接收，正在验证 | 刷新状态 |
| materialized | 已写入并可查询 | 在新会话中使用 |
| failed | 写入失败 | 查看安全原因；重新发起新的明确导入 |
| outcome_unknown | 写入结果未知 | 对账 |

TanStack Query 使用受控轮询；terminal 状态停止轮询。刷新页面、路由重建或 API 重启后只从服务端恢复，不从 localStorage 伪造状态。

### 15.4 响应式要求

1. 桌面和 390 x 844 使用同一组件与信息架构。
2. 无横向滚动，Dialog/Drawer 不遮挡主操作。
3. 触控目标至少 44px，键盘 Tab/Enter/Escape 行为正确。
4. 正文预览可换行且有长度上限，不能撑爆布局。
5. 导入状态不能与现有 Plan/Run 状态混淆。

## 16. Trace 与回放

### 16.1 严格事件

新增事件级 strict Schema：

```text
memory.import.intent_created
memory.import.started
memory.import.accepted
memory.import.materialized
memory.import.outcome_unknown
memory.import.failed
memory.import.reconcile.started
memory.import.reconcile.completed
memory.import.reconcile.failed
```

事件按类型要求必要关联：

1. memoryImportIntentId、memoryImportResultId、operationId。
2. backendId、Intent/Result revision 和 sha256 引用。
3. outboxId、attempt 序号、durationMs、outcome、稳定 errorCode。
4. accepted/materialized 事件可带 externalObjectId 的不可逆 Hash 或类型化安全引用；公开证据不要求暴露原始外部 ID。

禁止字段：Message 正文、selectedText、title、tags、Provider Prompt/Payload、Authorization、Token、endpoint、namespace、完整 argv、Workflow Run ID、Hook Token、pi Session ID 和隐藏推理。

Schema 必须证明正文哨兵在根、嵌套 error、数组和未声明字段中都无法写入，而不是写入后再 `[redacted]`。

### 16.2 Replay

扩展 Replay Assembler 和 CLI：

```text
pnpm debug:replay --import mii_...
```

回放组合：

```text
Message正文
+ MemoryImportIntent选区与Hash
+ MemoryImportResult状态
+ Outbox与Runtime安全证据
+ Trace路径
+ 新会话MemoryQuery/ContextPackage/Plan引用
```

默认导出仍不包含正文；显式本地调试视图可从 Product Store 读取用户本来就拥有的 Message 内容。Trace 缺口必须明确报告，不能补造事件。

## 17. 配置、安全与 VS Code 调试

### 17.1 固定端口

复用已冻结端口：

| 服务 | 端口 |
|---|---:|
| Web | 43110 |
| API | 43111 |
| Workflow Runtime | 43112 |
| API Inspector | 43120 |
| Workflow Inspector | 43121 |
| memmy Inspector | 43122 |
| memmy HTTP | 18960 |

不增加新的常驻端口。主 Compound 必须能在以下位置命中断点：

1. 创建 Import Application 用例。
2. Outbox 派发 Import Workflow。
3. `MemoryImportWorkflow` 的 call/reconcile Step。
4. memmy Import Adapter 的请求、结果分类和对账边界。
5. commit materialized/outcome_unknown 状态转换。

每次启动前运行现有安全 preclean：只终止本项目登记、命令片段与启动时间复核一致的旧进程；未知占用只报告 PID 和安全进程名，不杀、不输出完整 argv。停止后 7 个固定端口全部释放。

### 17.2 密钥

1. 百炼凭据复用 `/Users/xulater/.pi/agent/read-chat-provider-key.mjs` 或现有 `.env` 读取链，只进入需要调用 Provider 的子进程环境。
2. memmy 固定本地测试默认无远端凭据；若启用 Bearer，只从服务端环境变量读取并要求非秘密 credentialRevision。
3. 固定第三方 memmy 子进程不能继承百炼 Key 或无关父进程秘密。
4. 任何日志、PR 描述、Snapshot、Trace、Playwright artifact 和错误截图不得包含 Key。

## 18. 错误语义

公开 Problem Detail 使用已有错误族，并增加稳定 Memory Import code；不把底层库消息直接返回浏览器。

| 场景 | 产品结果 |
|---|---|
| Message 不存在或无权访问 | 404，不创建 Intent |
| Message/选区 Hash 不一致 | 409/422，不创建 Intent |
| backend 未配置或不支持 import | 409/422，不创建 Intent |
| 同 commandId 同请求 | 返回原 Intent/Result |
| 同 commandId 不同请求 | 409 `COMMAND_ID_REUSED` |
| 不同 commandId、同语义并发 | 返回 semanticDedupe 命中的原 Intent/Result |
| 外部调用前配置/Schema 失败 | failed，允许用户修正后新建明确导入 |
| memmy 明确拒绝且证明未写入 | failed |
| 调用后断连、超时、5xx 或坏成功响应 | outcome_unknown，只能对账 |
| 相同 requestId 不同正文 | failed_terminal，报告幂等冲突 |
| accepted 但暂时未验证 | accepted，不显示完成 |
| 对账确认对象存在并可查 | materialized |
| 对账仍无法证明 | 保持 outcome_unknown，不自动 add |
| Store/Binding 损坏 | 启动失败关闭，不改原文件 |

## 19. 测试设计

### 19.1 合同测试

1. Intent、Result、Source Selection、Import Capability、Outbox、Command/Query DTO 全部 strict。
2. 六种 Result 状态均有合法 Fixture；非法字段组合、未知字段和错误 ID 全部拒绝。
3. 浏览器提交 layer、endpoint、adapterId、requestId、状态、external ID、Provider/模型或凭据直接 400。
4. Import Trace 每个事件有合法 Fixture；正文哨兵在所有可能嵌套位置失败关闭。

### 19.2 Domain 测试

1. full message 与 UTF-16 选区，包括中文、Emoji、Markdown 和组合字符。
2. 越界、空白、失效 Message Hash、错误 selectedText Hash、跨 Message 选择。
3. title/tags trim、去重、排序、长度和 request Hash 稳定性。
4. 全部合法状态转换和反例；terminal 不可重开。
5. semantic dedupe、operationId/requestSha256 不变量。

### 19.3 Store 与 Application 集成

1. v1 -> v2 -> v3 与 v2 -> v3；真实 M1 Fixture 迁移。
2. 迁移可重复、未知版本、截断 JSON、悬空引用、Hash 篡改、非法状态失败关闭。
3. 写、fsync、rename、目录 fsync 故障保持旧快照逐字节不变。
4. 创建导入原子提交四类事实；任一校验失败零写入。
5. commandId 重放、不同正文冲突、不同 commandId 并发语义去重。
6. expectedRevision/CAS；两个并发对账命令最多一个成功。
7. Query 权限、分页和安全投影；秘密与内部 ID 泄漏扫描。

### 19.4 Adapter 合同

1. add 请求字段、服务端 adapterId/requestId 映射与 strict 响应解析。
2. 401/403/409/429/5xx、超时、断连、空响应、坏 JSON、超长响应。
3. fetch 前失败与 fetch 后结果未知分类。
4. 相同 requestId/相同正文返回同一外部 ID。
5. 相同 requestId/不同正文冲突失败。
6. 有 external ID 的 GET/Status 对账；无 ID 的单次原生幂等对账。
7. materialized 必须有真实验证证据。

### 19.5 Workflow 与 Outbox

1. 正常 start -> accepted -> materialized。
2. call Step `maxRetries=0` 配置合同。
3. Step 重放不产生第二次 fetch。
4. external write 后、Step 结果持久化前故障进入 outcome_unknown。
5. accepted 后、Product commit 前故障幂等恢复。
6. Outbox start 派发未知时 Runtime reconcile；只有明确 missing 才重排队。
7. 用户对账使用同一定义的 reconcile 模式，不重开普通 import。
8. API/Workflow/Binding 重启恢复，不覆盖现有 Planning Run。

### 19.6 Web 组件与确定性浏览器

1. 仅正式 Message 显示入口。
2. 整条消息、局部选区、失效选区和跨 Message 选择。
3. Dialog/Drawer 字段、可访问性、重复提交防护。
4. 六种状态文案和动作严格对应，不用本地计时器伪装。
5. 刷新、离线恢复、API 暂时不可用、恢复后重新查询。
6. 桌面和 390 x 844 无横向滚动、遮挡和焦点回归。

## 20. 真实完成门

### 20.1 固定 memmy 真实 HTTP

1. `git archive` 固定 commit/tree 到隔离缓存，不使用参考仓库脏工作树。
2. 每次真实门使用新的物理 SQLite 和测试目录，端口 18960 未知占用时失败，不杀进程。
3. 通过真实 `/memory/add` 导入唯一 canary，返回真实 external ID。
4. 按 ID 和 Search 读取；正文、L2、title/tags 与预期一致。
5. 相同 operationId 和相同请求再次提交，外部 ID 不变、数据库对象数不增加。
6. 相同 operationId 不同正文明确冲突。

### 20.2 真实响应丢失故障注入

使用仅负责转发和断开响应的测试代理，不伪造 memmy：

1. 请求真实到达 memmy 并成功写入。
2. 代理在响应回到 Chat 前断开连接。
3. Chat 提交 outcome_unknown，不显示失败或成功。
4. 对账使用相同 adapterId/requestId/requestSha256 找到原 external ID。
5. 最终 materialized，真实数据库对象数仍为 1。
6. Trace 记录不确定与对账路径，不含正文。

### 20.3 真实浏览器 + 真实模型

一次付费场景完成：

1. 从真实页面创建带唯一 canary 的正式消息。
2. 选择其中一段，确认导入到真实 memmy。
3. 等待 materialized，刷新页面并重启 API/Workflow 后恢复。
4. 新建无 Memory 对照会话，真实 Planner 不得知道 canary。
5. 新建选择 memmy 的会话，Query 命中刚导入的 external ID。
6. 真实 `qwen3.7-plus` Plan 明确使用 canary；Input Manifest 引用对应 ContextPackage Hash。
7. 使用 1 至 2 个 Plan Step 控制付费调用；批准后用最小 Executor Step 完成正式 Product Commit，证明共享 Outbox/Workflow 改动未破坏旧闭环。
8. 手机视口刷新后能看到同一 Import 状态和 Plan 来源。
9. Replay 无引用/Hash/Trace 缺口；Trace 与日志秘密扫描通过。

真实门缺少百炼凭据、固定源码、网络或 memmy 服务时必须失败，不 Skip、不切假 Provider。凭据读取沿用已批准 pi 配置，不再次要求用户手工发送 Key。

## 21. 代码质量与设计门

1. `pnpm build`、`lint`、`format:check`、`typecheck`、`test` 全绿。
2. `pnpm audit --prod` 记录 Chat 自身结果；固定第三方 memmy 的已知审计问题单独记录，不把它装入 Chat 生产依赖。
3. 架构测试继续验证 Domain 不依赖 Adapter，Application 不依赖 Hono/Workflow，Workflow Step 不直接写 Store。
4. 新增核心逻辑按“选区/状态机/用例/Adapter/Workflow/投影”分文件；不建立万能 Service、Repository-per-table 或任意 metadata 袋子。
5. 中文注释只解释状态所有权、外部副作用、幂等栅栏和失败分类的原因；不逐行翻译代码。
6. 外部结果和网络边界全部运行时校验；不使用未收窄的类型断言逃避合同。
7. 开发者自审重点删除重复 Hash 逻辑、跨层 DTO、过长条件分支、无价值接口、测试专用生产开关和临时兼容 TODO。
8. 既有 M1 Memory Query、B2 Planning/Decision/Execution、PWA 离线草稿和固定端口测试不得回归。

## 22. 实现顺序与验证节奏

以下是同一任务、同一分支、同一 PR 内的开发顺序，不是多个等待型任务，也不能在中途宣称 M2 完成：

1. 冻结合同、状态机、迁移和 Port；运行相关合同/Domain/Store 测试。
2. 实现 memmy Import Adapter、Application、Outbox 和 Workflow；运行 Adapter/Workflow 故障注入。
3. 接公开 API、Replay 和最小 UI；运行 API/Web/响应式测试。
4. 运行固定 memmy 真实 HTTP 和真实响应丢失门。
5. 最后只运行一次真实百炼浏览器闭环，再跑全量质量门和开发者自审。

简单修改不反复跑昂贵 E2E。真实 Provider 只在完整纵向链准备好后调用；故障注入和大多数状态覆盖使用确定性测试。

## 23. Git、PR 与交付规则

用户批准本任务书后：

1. 从最新 `origin/main` 创建 `/Users/xulater/Code/Chat-m2`。
2. 分支使用 `codex/m2-memmy-memory-import`。
3. 创建一个 Draft PR；开发完成、自审和真实门通过后才转 Ready。
4. PR 描述必须列出基线、固定源码 commit/tree、用户结果、状态机、迁移、失败注入、测试命令与脱敏真实证据。
5. 不提交 `.env`、Key、SQLite、Workflow 数据、Trace、Playwright artifact、构建缓存或参考项目文件。
6. 合并后同步本地 main，并删除本地/远端 M2 分支和 M2 worktree。

## 24. 开始、停止与完成条件

### 24.1 开始条件

1. 用户逐条审核并明确批准本任务书。
2. 开工前重新确认 main 与 origin/main 同步且主工作区无未处理改动。
3. 从固定源码证据复核 memmy add、幂等、get/status/search 合同；发现与本任务书冲突时先回报，不凭记忆实现。

### 24.2 必须停止并回报

1. 需要改变用户已批准的 L2-only 产品语义。
2. 固定 memmy 源码无法提供任务书要求的幂等或对账证据。
3. 需要引入新的生产依赖、云付费 Memory 服务、服务器部署或多租户认证。
4. 发现 Product Store v2 实际存在无法确定性迁移的脏数据。
5. 需要读取、输出或提交用户密钥才能继续。

### 24.3 完成条件

只有以下证据同时存在才可请求合并：

1. 全量确定性质量门通过。
2. 固定 memmy 正常导入与原生幂等真实证据通过。
3. 真实“写入成功但响应丢失”对账后外部对象仍为 1。
4. 真实浏览器导入、刷新/重启、新会话查询和真实模型采用通过。
5. Replay 完整、Trace 无正文、秘密扫描无泄漏。
6. 桌面与手机 E2E 通过。
7. 开发者自审问题全部修复，PR 保持一个完整用户结果且没有遗留“后续再接”的核心链路。

## 25. 本任务书审核项

审核时请重点确认：

1. M2 是一个完整 memmy 导入与再利用闭环，Tencent 留在 M3。
2. 只开放 L2 显式事实导入；不把 L1 异步提炼混入本任务。
3. Message 正文在 Chat 内只保存一次；选区以 Message 引用、UTF-16 范围和 Hash 重建。
4. Intent 不可变，Result 拥有 queued -> materialized/outcome_unknown 生命周期。
5. Import Port 与 Query Port 分离；Outbox 使用严格判别联合。
6. 任何 fetch 后不确定错误进入 outcome_unknown，只有原生幂等对账可以再次触达 add。
7. Product Store 由 v2 升级到 v3，Project/Rules 后续版本顺延。
8. 真实完成门包含响应丢失、外部对象数为 1、新会话真实查询和真实模型采用。

## 26. 执行证据（合入前更新）

1. 固定memmy commit/tree保持`211d521b310fc23c63dd3d9ca848941173981c5e` / `c4b1e78046f10011dc28b0408fb1bb3b61a5c3a1`。
2. `pnpm test:memory:memmy-real-import`已证明真实add、同身份同正文幂等、同身份异文冲突、GET+Search物化和SQLite唯一对象。
3. `pnpm test:memory:memmy-response-drop`已升级为完整Chat门：Product Store → Outbox → Workflow → 真实memmy 200落库后断响应 → `outcome_unknown` → 同身份reconcile → `materialized`；Replay零缺口、Trace无正文、SQLite对象数为1。
4. build、lint、format、typecheck、484项确定性测试和`pnpm audit --prod`已通过；生产依赖已知漏洞为0。
5. 最终百炼E2E首次预检因工作树非clean而在Provider调用前正确失败关闭；形成当前里程碑提交后再运行一次，不把旧提交证据冒充当前代码证据。
